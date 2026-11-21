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

const { saveContinue, listContinue } = await import('../src/background/continue.js');
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
