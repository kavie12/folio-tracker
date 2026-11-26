import test from 'node:test';
import assert from 'node:assert/strict';

// The modules expect build-time constants and the browser.* API; provide fakes.
Object.assign(globalThis, {
  __SUPABASE_URL__: 'https://proj.supabase.co',
  __SUPABASE_ANON_KEY__: 'anon',
  __TMDB_PROXY_URL__: 'https://proxy.example.workers.dev',
  __FOLIO_APP_URL__: 'https://folio.example',
  __VERSION__: 'test',
});

const store = {
  session: { accessToken: 'tok', refreshToken: 'ref', expiresAt: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'a@b.c' } },
  'meta:tv:1622': { title: 'Supernatural', posterPath: '/p.jpg', releaseYear: 2005, episodeCounts: { 8: 23 }, finishedSeasons: [8], fetchedAt: Date.now() },
  'meta:movie:603': { title: 'The Matrix', posterPath: '/m.jpg', releaseYear: 1999 },
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

const { fetchEntry, recordWatch, undoApplies, undoWatch } = await import('../src/background/folio.js');

/** Fakes Supabase REST: `rows` is the current content of watch_history for this user. */
function fakeRest(rows) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    if (method === 'GET') return new Response(JSON.stringify(rows), { status: 200 });
    return new Response(null, { status: 201 });
  };
  return calls;
}

test('fetchEntry reads progress and sends the auth headers', async () => {
  const calls = fakeRest([{ last_season: 8, last_episode: 3, watched_at: '2026-01-01T00:00:00Z' }]);
  assert.deepEqual(await fetchEntry({ mediaType: 'tv', tmdbId: 1622 }), { watched: true, progress: { season: 8, episode: 3 }, watchedAt: '2026-01-01T00:00:00Z' });
  assert.match(calls[0].url, /media_id=eq\.1622&media_type=eq\.tv/);
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].headers.apikey, 'anon');
});

test('new TV show is inserted with season and episode', async () => {
  const calls = fakeRest([]);
  const result = await recordWatch({ mediaType: 'tv', tmdbId: 1622, season: 8, episode: 4 });
  assert.deepEqual(result, { added: true, progressUpdated: true, progress: { season: 8, episode: 4 }, undo: { type: 'delete', written: { season: 8, episode: 4 } } });
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.body.user_id, 'user-1');
  assert.equal(post.body.title, 'Supernatural');
  assert.equal(post.body.last_season, 8);
  assert.equal(post.body.last_episode, 4);
  assert.match(post.headers.Prefer, /ignore-duplicates/);
});

test('new movie is inserted without progress', async () => {
  const calls = fakeRest([]);
  await recordWatch({ mediaType: 'movie', tmdbId: 603 });
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.body.media_type, 'movie');
  assert.equal('last_season' in post.body, false);
});

test('existing show: a later episode advances progress and bumps watched_at', async () => {
  const calls = fakeRest([{ last_season: 8, last_episode: 3, watched_at: '2026-01-01T00:00:00Z' }]);
  const result = await recordWatch({ mediaType: 'tv', tmdbId: 1622, season: 8, episode: 4 });
  assert.deepEqual(result, {
    added: false,
    progressUpdated: true,
    progress: { season: 8, episode: 4 },
    undo: { type: 'restore', progress: { season: 8, episode: 3 }, watchedAt: '2026-01-01T00:00:00Z', written: { season: 8, episode: 4 } },
  });
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.body.last_episode, 4);
  assert.ok(patch.body.watched_at);
});

test('existing show: an earlier episode does not move progress back (automatic)', async () => {
  const calls = fakeRest([{ last_season: 8, last_episode: 10 }]);
  const result = await recordWatch({ mediaType: 'tv', tmdbId: 1622, season: 2, episode: 1 });
  assert.deepEqual(result, { added: false, progressUpdated: false, progress: null, undo: null });
  assert.equal(calls.some((c) => c.method !== 'GET'), false);
});

test('existing show: a manual mark can set an earlier episode', async () => {
  const calls = fakeRest([{ last_season: 8, last_episode: 10 }]);
  const result = await recordWatch({ mediaType: 'tv', tmdbId: 1622, season: 2, episode: 1 }, { manual: true });
  assert.equal(result.progressUpdated, true);
  assert.equal(calls.find((c) => c.method === 'PATCH').body.last_season, 2);
});

test('existing movie: nothing is written', async () => {
  const calls = fakeRest([{ last_season: null, last_episode: null }]);
  assert.deepEqual(await recordWatch({ mediaType: 'movie', tmdbId: 603 }), { added: false, progressUpdated: false, progress: null, undo: null });
  assert.equal(calls.length, 1);
});

// ── undo ────────────────────────────────────────────────────
const tv = (season, episode) => ({ mediaType: 'tv', tmdbId: 1622, season, episode });

test('undo of an added movie deletes the row', async () => {
  const calls = fakeRest([{ last_season: null, last_episode: null, watched_at: 't' }]);
  await undoWatch({ mediaType: 'movie', tmdbId: 603 }, { type: 'delete' });
  const del = calls.find((c) => c.method === 'DELETE');
  assert.match(del.url, /media_id=eq\.603&media_type=eq\.movie/);
});

test('undo of advanced progress restores the previous season, episode and date', async () => {
  const calls = fakeRest([{ last_season: 8, last_episode: 4, watched_at: 'now' }]);
  await undoWatch(tv(8, 4), { type: 'restore', progress: { season: 8, episode: 3 }, watchedAt: '2026-01-01T00:00:00Z' });
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.deepEqual(patch.body, { last_season: 8, last_episode: 3, watched_at: '2026-01-01T00:00:00Z' });
});

test('undo restores "no progress" when the show had none before', async () => {
  const calls = fakeRest([{ last_season: 8, last_episode: 4, watched_at: 'now' }]);
  await undoWatch(tv(8, 4), { type: 'restore', progress: null, watchedAt: 'old' });
  assert.deepEqual(calls.find((c) => c.method === 'PATCH').body, { last_season: null, last_episode: null, watched_at: 'old' });
});

test('undo is refused once later progress was recorded', async () => {
  const calls = fakeRest([{ last_season: 8, last_episode: 5, watched_at: 'now' }]); // moved on to E5
  await assert.rejects(undoWatch(tv(8, 4), { type: 'delete' }), /can’t be undone/);
  await assert.rejects(undoWatch(tv(8, 4), { type: 'restore', progress: null, watchedAt: 'x' }), /can’t be undone/);
  assert.equal(calls.some((c) => c.method !== 'GET'), false);
});

test('undo of a title that was already removed explains why', async () => {
  fakeRest([]);
  await assert.rejects(undoWatch({ mediaType: 'movie', tmdbId: 603 }, { type: 'delete' }), /no longer in your history/);
});

test('undoApplies', () => {
  const entry = (season, episode) => ({ watched: true, progress: { season, episode } });
  assert.equal(undoApplies(tv(8, 4), entry(8, 4), { type: 'delete' }), true);
  assert.equal(undoApplies(tv(8, 4), entry(8, 5), { type: 'delete' }), false);
  assert.equal(undoApplies(tv(8, 4), { watched: false, progress: null }, { type: 'delete' }), false);
  assert.equal(undoApplies({ mediaType: 'movie', tmdbId: 1 }, { watched: true, progress: null }, { type: 'delete' }), true);
  assert.equal(undoApplies(tv(8, 4), entry(8, 4), null), false);
});

// ── the last episode of a season is stored as just the season ───
test('a new show whose last-season episode is marked is stored as just the season', async () => {
  const calls = fakeRest([]);
  const result = await recordWatch(tv(8, 23)); // TMDB: season 8 has 23 episodes
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.body.last_season, 8);
  assert.equal(post.body.last_episode, null);
  assert.deepEqual(result.progress, { season: 8, episode: null });
});

test('finishing a season on an existing show replaces the episode with just the season', async () => {
  const calls = fakeRest([{ last_season: 8, last_episode: 22, watched_at: '2026-01-01T00:00:00Z' }]);
  const result = await recordWatch(tv(8, 23));
  assert.equal(result.progressUpdated, true);
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.body.last_season, 8);
  assert.equal(patch.body.last_episode, null);
  assert.deepEqual(result.undo, { type: 'restore', progress: { season: 8, episode: 22 }, watchedAt: '2026-01-01T00:00:00Z', written: { season: 8, episode: null } });
});

test('an episode before the last one keeps its number', async () => {
  const calls = fakeRest([{ last_season: 8, last_episode: 21, watched_at: 't' }]);
  await recordWatch(tv(8, 22));
  assert.equal(calls.find((c) => c.method === 'PATCH').body.last_episode, 22);
});

test('a finished season does not move back when an earlier episode is rewatched', async () => {
  const calls = fakeRest([{ last_season: 8, last_episode: null, watched_at: 't' }]); // season 8 finished
  assert.equal((await recordWatch(tv(8, 10))).progressUpdated, false);
  assert.equal((await recordWatch(tv(8, 23))).progressUpdated, false); // the last episode again: already stored
  assert.equal(calls.some((c) => c.method !== 'GET'), false);
});

test('the next season moves a finished season forward', async () => {
  const calls = fakeRest([{ last_season: 8, last_episode: null, watched_at: 't' }]);
  const result = await recordWatch(tv(9, 1));
  assert.equal(result.progressUpdated, true);
  assert.deepEqual(calls.find((c) => c.method === 'PATCH').body.last_season, 9);
});

test('without TMDB counts the episode number is kept', async () => {
  // existing show, and the title service is down: nothing to compare against, so store the episode as is
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : undefined });
    if (String(url).includes('/details/')) return new Response(null, { status: 500 });
    if (method === 'GET') return new Response(JSON.stringify([{ last_season: 5, last_episode: 3, watched_at: 't' }]));
    return new Response(null, { status: 204 });
  };
  store['meta:tv:4242'] = { title: 'Other', episodeCounts: {}, fetchedAt: 0 }; // stale, and refreshing fails: the stale copy is used
  await recordWatch({ mediaType: 'tv', tmdbId: 4242, season: 5, episode: 4 });
  assert.equal(calls.find((c) => c.method === 'PATCH').body.last_episode, 4);
});

test('undo of a finished-season mark restores the previous episode', async () => {
  const calls = fakeRest([{ last_season: 8, last_episode: null, watched_at: 'now' }]); // stored as season only
  await undoWatch(tv(8, 23), { type: 'restore', progress: { season: 8, episode: 22 }, watchedAt: 'old', written: { season: 8, episode: null } });
  assert.deepEqual(calls.find((c) => c.method === 'PATCH').body, { last_season: 8, last_episode: 22, watched_at: 'old' });
});

test('undoApplies compares with the progress that was written, and still accepts older records', () => {
  const entry = (season, episode) => ({ watched: true, progress: { season, episode } });
  const written = { season: 8, episode: null };
  assert.equal(undoApplies(tv(8, 23), entry(8, null), { type: 'delete', written }), true);
  assert.equal(undoApplies(tv(8, 23), entry(8, 22), { type: 'delete', written }), false); // progress is not where the mark left it
  assert.equal(undoApplies(tv(9, 1), entry(9, null), { type: 'delete', written: { season: 9, episode: 1 } }), false);
  assert.equal(undoApplies(tv(8, 4), entry(8, 4), { type: 'delete' }), true); // record from before `written` existed
});

// ── a show that is still airing ─────────────────────────────
test('the latest aired episode of a show that is still airing is NOT stored as a finished season', async () => {
  // TMDB lists only the 5 episodes aired so far; season 1 is not over
  store['meta:tv:2001'] = { title: 'Airing', posterPath: null, releaseYear: 2025, episodeCounts: { 1: 5 }, finishedSeasons: [], status: 'Returning Series', fetchedAt: Date.now() };
  const calls = fakeRest([{ last_season: 1, last_episode: 4, watched_at: 't' }]);
  await recordWatch({ mediaType: 'tv', tmdbId: 2001, season: 1, episode: 5 });
  assert.equal(calls.find((c) => c.method === 'PATCH').body.last_episode, 5); // kept, not null
});

test('when that episode airs later it still counts as new progress', async () => {
  store['meta:tv:2002'] = { title: 'Airing', posterPath: null, releaseYear: 2025, episodeCounts: { 1: 6 }, finishedSeasons: [], status: 'Returning Series', fetchedAt: Date.now() };
  const calls = fakeRest([{ last_season: 1, last_episode: 5, watched_at: 't' }]);
  const result = await recordWatch({ mediaType: 'tv', tmdbId: 2002, season: 1, episode: 6 });
  assert.equal(result.progressUpdated, true);
  assert.equal(calls.find((c) => c.method === 'PATCH').body.last_episode, 6);
});

test('an earlier season of a show that is still airing is finished', async () => {
  store['meta:tv:2003'] = { title: 'Airing', posterPath: null, releaseYear: 2020, episodeCounts: { 1: 10, 2: 4 }, finishedSeasons: [1], status: 'Returning Series', fetchedAt: Date.now() };
  const calls = fakeRest([{ last_season: 1, last_episode: 9, watched_at: 't' }]);
  await recordWatch({ mediaType: 'tv', tmdbId: 2003, season: 1, episode: 10 });
  assert.equal(calls.find((c) => c.method === 'PATCH').body.last_episode, null);
});
