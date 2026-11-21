import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(globalThis, {
  __SUPABASE_URL__: 'https://proj.supabase.co',
  __SUPABASE_ANON_KEY__: 'anon',
  __TMDB_PROXY_URL__: 'https://proxy.example.workers.dev',
  __FOLIO_APP_URL__: 'https://folio.example',
  __VERSION__: 'test',
});

// ── a fake browser ──────────────────────────────────────────
const local = {
  session: { accessToken: 'tok', refreshToken: 'ref', expiresAt: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'a@b.c' } },
};
const sessionStore = {};
const store = (obj) => ({
  get: async (key) => (key === null ? { ...obj } : typeof key === 'string' ? { [key]: obj[key] } : { ...obj }),
  set: async (v) => Object.assign(obj, v),
  remove: async (k) => { delete obj[k]; },
});
let listener;
const notifications = [];
globalThis.browser = {
  runtime: { id: 'ext', getURL: (p) => p, onMessage: { addListener: (fn) => { listener = fn; } } },
  storage: { local: store(local), session: store(sessionStore) },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: () => {}, setBadgeTextColor: () => {} },
  tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
  notifications: { create: (id, opts) => { notifications.push({ id, ...opts }); } },
};

// ── a fake backend ──────────────────────────────────────────
let history; // rows returned for watch_history
let posts; // writes to continue_watching
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method ?? 'GET';
  if (u.includes('/details/tv/')) {
    return new Response(JSON.stringify({
      name: 'Supernatural', poster_path: '/p.jpg', first_air_date: '2005-09-13',
      seasons: [{ season_number: 8, episode_count: 23 }, { season_number: 9, episode_count: 23 }],
    }));
  }
  if (u.includes('/rest/v1/watch_history') && method === 'GET') return new Response(JSON.stringify(history));
  if (u.includes('/rest/v1/continue_watching') && method === 'POST') {
    posts.push(JSON.parse(init.body));
    return new Response(null, { status: 201 });
  }
  return new Response(null, { status: 204 });
};

await import('../src/background/index.js');
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
const SENDER = (tabId) => ({ tab: { id: tabId }, frameId: 0, id: 'ext' });

let nextTab = 100;
/** Opens a page in a fresh tab and waits for the background to react. */
async function open({ season, episode, url, host = 'cinejoy.pk', mediaType = 'tv' }) {
  const tabId = nextTab++;
  const ref = mediaType === 'tv' ? { mediaType, tmdbId: 1622, season, episode } : { mediaType, tmdbId: 603 };
  await listener({ type: 'media', site: 'cinejoy', host, url, ref }, SENDER(tabId));
  await settle();
  return tabId;
}

const reset = (rows) => {
  history = rows;
  posts = [];
  notifications.length = 0;
  delete local.settings;
};
const progress = (season, episode) => [{ last_season: season, last_episode: episode, watched_at: 't' }];

test('opening the next episode saves it to Continue, with the link', async () => {
  reset(progress(8, 4));
  await open({ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' });

  assert.equal(posts.length, 1);
  assert.equal(posts[0].media_id, 1622);
  assert.equal(posts[0].season, 8);
  assert.equal(posts[0].episode, 5);
  assert.equal(posts[0].url, 'https://cinejoy.pk/watch/tv/1622/8/5');
  assert.equal(posts[0].title, 'Supernatural');
});

test('episode 1 of the next season counts once the season is finished', async () => {
  reset(progress(8, 23));
  await open({ season: 9, episode: 1, url: 'https://cinejoy.pk/watch/tv/1622/9/1' });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].season, 9);
});

test('an episode that is not the next one is not saved', async () => {
  reset(progress(8, 4));
  await open({ season: 8, episode: 7, url: 'https://cinejoy.pk/watch/tv/1622/8/7' }); // skipped ahead
  await open({ season: 8, episode: 4, url: 'https://cinejoy.pk/watch/tv/1622/8/4' }); // same as progress
  await open({ season: 9, episode: 1, url: 'https://cinejoy.pk/watch/tv/1622/9/1' }); // season 8 has 23 episodes
  assert.equal(posts.length, 0);
});

test('a show that is not in the history is not saved', async () => {
  reset([]);
  await open({ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' });
  assert.equal(posts.length, 0);
});

test('movies never go to Continue', async () => {
  reset(progress(8, 4));
  await open({ mediaType: 'movie', url: 'https://cinejoy.pk/watch/movie/603' });
  assert.equal(posts.length, 0);
});

test('the setting turns saving off', async () => {
  reset(progress(8, 4));
  local.settings = { saveContinue: false };
  await open({ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' });
  assert.equal(posts.length, 0);
});

test('a link that is not on the page’s own host is not stored', async () => {
  reset(progress(8, 4));
  await open({ season: 8, episode: 5, url: 'https://evil.example/watch/tv/1622/8/5' }); // host says cinejoy.pk
  await open({ season: 8, episode: 5, url: 'javascript:alert(1)' });
  assert.equal(posts.length, 0);
});

test('re-announcing the same page does not save twice', async () => {
  reset(progress(8, 4));
  const tabId = await open({ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' });
  for (let i = 0; i < 3; i++) {
    await listener({ type: 'media', site: 'cinejoy', host: 'cinejoy.pk', url: 'https://cinejoy.pk/watch/tv/1622/8/5', ref: { mediaType: 'tv', tmdbId: 1622, season: 8, episode: 5 } }, SENDER(tabId));
  }
  await settle();
  assert.equal(posts.length, 1);
});

test('opening the popup saves it if the first attempt could not (for example, signed in later)', async () => {
  reset([]); // not in history yet when the page opened
  const tabId = await open({ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' });
  assert.equal(posts.length, 0);

  history = progress(8, 4); // progress is recorded afterwards
  const state = await listener({ type: 'getState', tabId }, { id: 'ext' }); // popup
  await settle();
  assert.equal(posts.length, 1);
  assert.equal(state.signedIn, true);
});

test('a notification is shown when an episode is added to Continue', async () => {
  reset(progress(8, 4));
  await open({ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, 'Saved to Continue');
  assert.equal(notifications[0].message, 'Supernatural, S8E5');
});

test('no notification when nothing is saved, or when notifications are off', async () => {
  reset(progress(8, 4));
  await open({ season: 8, episode: 7, url: 'https://cinejoy.pk/watch/tv/1622/8/7' }); // not the next episode
  assert.equal(notifications.length, 0);

  local.settings = { notify: false };
  await open({ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' });
  assert.equal(posts.length, 1); // still saved...
  assert.equal(notifications.length, 0); // ...silently
});

test('re-announcing the same page does not notify again', async () => {
  reset(progress(8, 4));
  const tabId = await open({ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' });
  for (let i = 0; i < 3; i++) {
    await listener({ type: 'media', site: 'cinejoy', host: 'cinejoy.pk', url: 'https://cinejoy.pk/watch/tv/1622/8/5', ref: { mediaType: 'tv', tmdbId: 1622, season: 8, episode: 5 } }, SENDER(tabId));
  }
  await settle();
  assert.equal(notifications.length, 1);
});
