import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(globalThis, {
  __SUPABASE_URL__: 'https://proj.supabase.co',
  __SUPABASE_ANON_KEY__: 'anon',
  __TMDB_PROXY_URL__: 'https://proxy.example.workers.dev',
  __FOLIO_APP_URL__: 'https://folio.example',
  __VERSION__: 'test',
});

const store = {
  session: { accessToken: 'tok', refreshToken: 'ref', expiresAt: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'a@b.c' } },
};
globalThis.browser = {
  storage: {
    local: {
      get: async (key) => (typeof key === 'string' ? { [key]: store[key] } : { ...store }),
      set: async (obj) => Object.assign(store, obj),
      remove: async (key) => { delete store[key]; },
    },
  },
};

const { getContinue, saveContinue, listContinue, updateContinueLink } = await import('../src/background/continue.js');
const { getDetails } = await import('../src/background/tmdb.js');

function fakeFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers };
    calls.push(call);
    return responder(call);
  };
  return calls;
}

const ref = { mediaType: 'tv', tmdbId: 1622, season: 8, episode: 5 };
const meta = { title: 'Supernatural', posterPath: '/p.jpg', releaseYear: 2005 };

test('saveContinue upserts one row per show, with the link', async () => {
  const calls = fakeFetch(() => new Response(null, { status: 201 }));
  await saveContinue(ref, meta, 'https://cinejoy.pk/watch/tv/1622/8/5');

  const post = calls[0];
  assert.equal(post.method, 'POST');
  assert.match(post.url, /continue_watching\?on_conflict=user_id,media_id/);
  assert.match(post.headers.Prefer, /merge-duplicates/);
  assert.equal(post.body.user_id, 'user-1');
  assert.equal(post.body.media_id, 1622);
  assert.equal(post.body.season, 8);
  assert.equal(post.body.episode, 5);
  assert.equal(post.body.url, 'https://cinejoy.pk/watch/tv/1622/8/5');
  assert.equal(post.body.title, 'Supernatural');
  assert.ok(post.body.updated_at);
});

test('getContinue returns the saved episode for a show, or null', async () => {
  let calls = fakeFetch(() => new Response(JSON.stringify([{ season: 8, episode: 5 }])));
  assert.deepEqual(await getContinue(ref), { season: 8, episode: 5 });
  assert.match(calls[0].url, /continue_watching\?media_id=eq\.1622&select=season,episode,url&limit=1/);

  calls = fakeFetch(() => new Response(JSON.stringify([])));
  assert.equal(await getContinue(ref), null);
});

test('manual is only sent for entries the user added themselves', async () => {
  let calls = fakeFetch(() => new Response(null, { status: 201 }));
  await saveContinue(ref, meta, 'https://x.test/a');
  assert.equal('manual' in calls[0].body, false);
  calls = fakeFetch(() => new Response(null, { status: 201 }));
  await saveContinue(ref, meta, 'https://x.test/a', { manual: true });
  assert.equal(calls[0].body.manual, true);
});

test('updateContinueLink changes only the link of that episode', async () => {
  const calls = fakeFetch(() => new Response(null, { status: 204 }));
  await updateContinueLink(ref, 'https://cinejoy.pk/watch/tv/1622/8/5');
  assert.equal(calls[0].method, 'PATCH');
  assert.match(calls[0].url, /continue_watching\?media_id=eq\.1622&season=eq\.8&episode=eq\.5$/);
  assert.equal(calls[0].body.url, 'https://cinejoy.pk/watch/tv/1622/8/5');
  assert.ok(calls[0].body.updated_at);
  assert.equal('season' in calls[0].body, false);
});

test("a failed write carries the server's reason", async () => {
  fakeFetch(() => new Response(JSON.stringify({ message: "Could not find the 'manual' column" }), { status: 400 }));
  await assert.rejects(saveContinue(ref, meta, 'https://x.test/a', { manual: true }), (err) => err.status === 400 && /manual/.test(err.detail));
});

test('listContinue maps rows, newest first', async () => {
  const calls = fakeFetch(() => new Response(JSON.stringify([
    { media_id: 1622, title: 'Supernatural', poster_path: '/p.jpg', release_year: 2005, season: 8, episode: 5, url: 'https://x.test/a', updated_at: '2026-01-02T00:00:00Z' },
  ])));
  const items = await listContinue();
  assert.match(calls[0].url, /order=updated_at\.desc/);
  assert.deepEqual(items[0], {
    mediaId: 1622, title: 'Supernatural', posterPath: '/p.jpg', releaseYear: 2005,
    season: 8, episode: 5, url: 'https://x.test/a', updatedAt: '2026-01-02T00:00:00Z',
  });
});

test('getDetails keeps episode counts per season (specials left out)', async () => {
  fakeFetch(() => new Response(JSON.stringify({
    name: 'Supernatural', poster_path: '/p.jpg', first_air_date: '2005-09-13',
    seasons: [{ season_number: 0, episode_count: 10 }, { season_number: 1, episode_count: 22 }, { season_number: 2, episode_count: 22 }],
  })));
  const details = await getDetails({ mediaType: 'tv', tmdbId: 999 });
  assert.deepEqual(details.episodeCounts, { 1: 22, 2: 22 });
});

test('details cached before episode counts existed are fetched again for TV', async () => {
  store['meta:tv:555'] = { title: 'Old', posterPath: null, releaseYear: 2000 }; // no episodeCounts
  const calls = fakeFetch(() => new Response(JSON.stringify({ name: 'Old', seasons: [{ season_number: 1, episode_count: 8 }] })));
  const details = await getDetails({ mediaType: 'tv', tmdbId: 555 });
  assert.equal(calls.length, 1);
  assert.deepEqual(details.episodeCounts, { 1: 8 });

  await getDetails({ mediaType: 'tv', tmdbId: 555 }); // now cached with counts
  assert.equal(calls.length, 1);
});

// ── TMDB details: last aired episode and refresh ────────────
const day = 24 * 60 * 60 * 1000;
const tvDetails = (extra = {}) => JSON.stringify({
  name: 'Show', first_air_date: '2020-01-01', status: 'Ended',
  seasons: [{ season_number: 1, episode_count: 8 }],
  last_episode_to_air: { season_number: 1, episode_number: 8 }, ...extra,
});

test('getDetails keeps the last aired episode and status', async () => {
  fakeFetch(() => new Response(tvDetails()));
  const details = await getDetails({ mediaType: 'tv', tmdbId: 3001 });
  assert.deepEqual(details.lastAired, { season: 1, episode: 8 });
  assert.equal(details.status, 'Ended');
  assert.ok(details.fetchedAt);
});

test('TV details are refreshed after three days, airing shows after twelve hours', async () => {
  store['meta:tv:3002'] = { finishedSeasons: [1], title: 'Ended show', episodeCounts: { 1: 8 }, status: 'Ended', fetchedAt: Date.now() - 2 * day };
  store['meta:tv:3003'] = { finishedSeasons: [1], title: 'Airing show', episodeCounts: { 1: 8 }, status: 'Returning Series', fetchedAt: Date.now() - 13 * 60 * 60 * 1000 };
  store['meta:tv:3004'] = { finishedSeasons: [1], title: 'Old show', episodeCounts: { 1: 8 }, status: 'Ended', fetchedAt: Date.now() - 4 * day };
  const calls = fakeFetch(() => new Response(tvDetails()));

  await getDetails({ mediaType: 'tv', tmdbId: 3002 });
  assert.equal(calls.length, 0); // two days old, ended: still fresh
  await getDetails({ mediaType: 'tv', tmdbId: 3003 });
  assert.equal(calls.length, 1); // airing and 13 hours old: refreshed
  await getDetails({ mediaType: 'tv', tmdbId: 3004 });
  assert.equal(calls.length, 2); // four days old: refreshed
});

test('if refreshing fails, the stale copy is used rather than failing', async () => {
  store['meta:tv:3005'] = { finishedSeasons: [1], title: 'Stale', episodeCounts: { 1: 8 }, status: 'Ended', fetchedAt: Date.now() - 10 * day };
  fakeFetch(() => { throw new TypeError('offline'); });
  assert.equal((await getDetails({ mediaType: 'tv', tmdbId: 3005 })).title, 'Stale');
  await assert.rejects(getDetails({ mediaType: 'tv', tmdbId: 3006 }), /reach/); // nothing cached: the error stands
});

test('movies are cached for good', async () => {
  store['meta:movie:603'] = { title: 'The Matrix', fetchedAt: 0 };
  const calls = fakeFetch(() => new Response(null, { status: 500 }));
  assert.equal((await getDetails({ mediaType: 'movie', tmdbId: 603 })).title, 'The Matrix');
  assert.equal(calls.length, 0);
});

// ── which seasons are definitely over ───────────────────────
const seasonsOf = (...counts) => counts.map((n, i) => ({ season_number: i + 1, episode_count: n }));

test('finishedSeasons: every season before the latest one, while the show is still airing', async () => {
  fakeFetch(() => new Response(tvDetails({ status: 'Returning Series', seasons: seasonsOf(10, 10, 4), last_episode_to_air: { season_number: 3, episode_number: 4 } })));
  assert.deepEqual((await getDetails({ mediaType: 'tv', tmdbId: 4001 })).finishedSeasons, [1, 2]);
});

test('finishedSeasons: all seasons once the show has ended or been cancelled', async () => {
  fakeFetch(() => new Response(tvDetails({ status: 'Ended', seasons: seasonsOf(10, 10, 4) })));
  assert.deepEqual((await getDetails({ mediaType: 'tv', tmdbId: 4002 })).finishedSeasons, [1, 2, 3]);
  fakeFetch(() => new Response(tvDetails({ status: 'Canceled', seasons: seasonsOf(8) })));
  assert.deepEqual((await getDetails({ mediaType: 'tv', tmdbId: 4003 })).finishedSeasons, [1]);
});

test('finishedSeasons: a season with an episode still to air is not finished', async () => {
  fakeFetch(() => new Response(tvDetails({ status: 'Ended', seasons: seasonsOf(10, 10), next_episode_to_air: { season_number: 2, episode_number: 9 } })));
  assert.deepEqual((await getDetails({ mediaType: 'tv', tmdbId: 4004 })).finishedSeasons, [1]);
});

test('details cached before finishedSeasons existed are fetched again', async () => {
  store['meta:tv:4005'] = { title: 'Old cache', episodeCounts: { 1: 8 }, status: 'Ended', fetchedAt: Date.now() }; // fresh, but no finishedSeasons
  const calls = fakeFetch(() => new Response(tvDetails()));
  assert.deepEqual((await getDetails({ mediaType: 'tv', tmdbId: 4005 })).finishedSeasons, [1]);
  assert.equal(calls.length, 1);
});
