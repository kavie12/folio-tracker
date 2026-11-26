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
let history; // rows of watch_history (writes below change them, like the real table)
let posts; // POSTs to continue_watching
let patches; // PATCHes to continue_watching (link updates)
let historyWrites; // writes to watch_history
let continueRows; // what is already in the Continue list
let continueError = null; // when set, writes to continue_watching fail with this body
let lastAired; // TMDB's latest aired episode
let gate = null; // when set, the Continue lookup waits for it (to simulate a slow request)
const SITES = [
  { id: 'cinejoy', name: 'Cinejoy', domains: ['cinejoy.pk'], episodeUrl: 'https://cinejoy.pk/watch/tv/{tmdbId}/{season}/{episode}' },
  { id: 'cinecat', name: 'Cinecat', domains: ['cinecat.eu'] }, // no template: its addresses cannot be built
];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(init.body) : undefined;
  if (u.endsWith('sites.json')) return new Response(JSON.stringify(SITES));
  if (u.includes('/details/tv/')) {
    return new Response(JSON.stringify({
      name: 'Supernatural', poster_path: '/p.jpg', first_air_date: '2005-09-13', status: 'Returning Series',
      seasons: [{ season_number: 8, episode_count: 23 }, { season_number: 9, episode_count: 23 }],
      last_episode_to_air: { season_number: lastAired.season, episode_number: lastAired.episode },
    }));
  }
  if (u.includes('/rest/v1/watch_history')) {
    if (method === 'GET') return new Response(JSON.stringify(history));
    historyWrites.push({ method, body });
    if (method === 'PATCH') Object.assign(history[0], body);
    if (method === 'POST') history.push({ last_season: body.last_season ?? null, last_episode: body.last_episode ?? null, watched_at: 't' });
    if (method === 'DELETE') history.length = 0;
    // like the database trigger: progress that reaches an entry (or finishes its season) removes it
    const p = history[0];
    if (p?.last_season != null) {
      continueRows = continueRows.filter((r) => !(r.season < p.last_season || (r.season === p.last_season && (p.last_episode == null || r.episode <= p.last_episode))));
    }
    return new Response(null, { status: 204 });
  }
  if (u.includes('/rest/v1/continue_watching')) {
    if (method === 'GET') {
      if (gate) await gate;
      return new Response(JSON.stringify(continueRows));
    }
    if (continueError) return new Response(JSON.stringify(continueError), { status: 400 });
    if (method === 'POST') {
      posts.push(body);
      continueRows = [{ season: body.season, episode: body.episode, url: body.url }]; // one row per show
    } else {
      patches.push(body);
      if (continueRows[0]) continueRows[0].url = body.url;
    }
    return new Response(null, { status: 201 });
  }
  return new Response(null, { status: 204 });
};

await import('../src/background/index.js');
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
const SENDER = (tabId) => ({ tab: { id: tabId }, frameId: 0, id: 'ext' });

let nextTab = 100;
/** Opens a page in a fresh tab and waits for the background to react. */
async function open({ season, episode, url, host = 'cinejoy.pk', site = 'cinejoy', mediaType = 'tv' }) {
  const tabId = nextTab++;
  const ref = mediaType === 'tv' ? { mediaType, tmdbId: 1622, season, episode } : { mediaType, tmdbId: 603 };
  await listener({ type: 'media', site, host, url, ref }, SENDER(tabId));
  await settle();
  return tabId;
}

const reset = (rows) => {
  history = rows;
  posts = [];
  patches = [];
  historyWrites = [];
  continueRows = [];
  continueError = null;
  lastAired = { season: 9, episode: 23 };
  notifications.length = 0;
  delete local.settings;
  for (const key of Object.keys(local)) if (key.startsWith('meta:') || key.startsWith('undo:')) delete local[key]; // fresh TMDB data and undo records per test
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

// ── no duplicates ───────────────────────────────────────────
test('the same episode already in Continue: nothing is written and no notification is sent', async () => {
  reset(progress(8, 4));
  continueRows = [{ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' }]; // saved earlier, e.g. from another tab or before a restart
  const tabId = await open({ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' });
  assert.equal(posts.length, 0);
  assert.equal(notifications.length, 0);

  // ...and the popup still says it is in Continue
  const state = await listener({ type: 'getState', tabId }, { id: 'ext' });
  assert.equal(state.continued, true);
});

test('opening the same episode again in a new tab does not notify again', async () => {
  reset(progress(8, 4));
  await open({ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' });
  assert.equal(notifications.length, 1);

  continueRows = [{ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' }]; // it is in the list now
  await open({ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' }); // a different tab
  assert.equal(posts.length, 1);
  assert.equal(notifications.length, 1);
});

test('a different episode of a show already in Continue replaces it and notifies', async () => {
  reset(progress(8, 5));
  continueRows = [{ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' }]; // old entry
  await open({ season: 8, episode: 6, url: 'https://cinejoy.pk/watch/tv/1622/8/6' });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].episode, 6);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].message, 'Supernatural, S8E6');
});

// ── only shows tracked in the history ───────────────────────
test('a show in the history but with no recorded progress is not saved', async () => {
  reset([{ last_season: null, last_episode: null, watched_at: 't' }]);
  await open({ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' });
  assert.equal(posts.length, 0);
  assert.equal(notifications.length, 0);
});

test('a show with a season but no episode recorded is not saved', async () => {
  reset([{ last_season: 8, last_episode: null, watched_at: 't' }]);
  await open({ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' });
  assert.equal(posts.length, 0);
});

test('the saved link is the episode that was opened, even if the tab moves on while saving', async () => {
  reset(progress(8, 4));
  let release;
  gate = new Promise((resolve) => { release = resolve; });

  const tabId = nextTab++;
  const page = (episode) => ({
    type: 'media', site: 'cinejoy', host: 'cinejoy.pk',
    url: `https://cinejoy.pk/watch/tv/1622/8/${episode}`,
    ref: { mediaType: 'tv', tmdbId: 1622, season: 8, episode },
  });
  await listener(page(5), SENDER(tabId));
  await settle(); // saving S8E5 is now waiting on the slow lookup
  await listener(page(6), SENDER(tabId)); // the tab moves on to S8E6 meanwhile
  release();
  gate = null;
  await settle();

  assert.equal(posts.length, 1);
  assert.equal(posts[0].episode, 5);
  assert.equal(posts[0].url, 'https://cinejoy.pk/watch/tv/1622/8/5'); // not the S8E6 page
});

// ═════════════ next episode after a progress update (TMDB) ═════════════
const VIDEO_AT = (ratio) => ({ type: 'video', video: { currentTime: 3000 * ratio, duration: 3000, paused: false, ended: false } });
/** Opens an episode, plays it past 80% and waits for the background to mark it. */
async function watchToTheEnd(opts) {
  const tabId = await open(opts);
  await listener(VIDEO_AT(0.85), SENDER(tabId));
  await settle();
  return tabId;
}
const markNotification = () => notifications.find((n) => /history|progress/i.test(n.title));

test('after progress moves, the next episode is saved to Continue with a link built from the site template', async () => {
  reset(progress(8, 3));
  const tabId = await watchToTheEnd({ season: 8, episode: 4, url: 'https://cinejoy.pk/watch/tv/1622/8/4' });

  assert.equal(historyWrites.find((w) => w.method === 'PATCH').body.last_episode, 4);
  // opening S8E4 saved it (the "open the next episode" rule); reaching it removed it and S8E5 took its place
  assert.deepEqual(continueRows, [{ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' }]); // built, not the page being watched
  const saved = posts.at(-1);
  assert.equal(saved.title, 'Supernatural');
  assert.equal('manual' in saved, false);

  assert.match(markNotification().message, /Next up: S8E5, saved to Continue/); // one notification covers both

  const state = await listener({ type: 'getState', tabId }, { id: 'ext' });
  assert.deepEqual(state.nextSaved, { season: 8, episode: 5 });
});

test('a site without a link template uses the page being watched until the episode is opened', async () => {
  reset(progress(8, 3));
  const page = 'https://cinecat.eu/media/tmdb-tv-1622-supernatural/6911/162698';
  await watchToTheEnd({ season: 8, episode: 4, url: page, host: 'cinecat.eu', site: 'cinecat' });
  assert.deepEqual(continueRows, [{ season: 8, episode: 5, url: page }]);
});

test('finishing a season saves episode 1 of the next season, and the season is stored without an episode', async () => {
  reset(progress(8, 22));
  await watchToTheEnd({ season: 8, episode: 23, url: 'https://cinejoy.pk/watch/tv/1622/8/23' });
  assert.equal(historyWrites.find((w) => w.method === 'PATCH').body.last_episode, null); // season 8 finished
  assert.deepEqual(continueRows, [{ season: 9, episode: 1, url: 'https://cinejoy.pk/watch/tv/1622/9/1' }]);
  assert.match(markNotification().message, /season 8 finished/);
  assert.match(markNotification().message, /Next up: S9E1/);
});

test('nothing is saved after the finale', async () => {
  reset(progress(9, 22));
  const tabId = await watchToTheEnd({ season: 9, episode: 23, url: 'https://cinejoy.pk/watch/tv/1622/9/23' }); // there is no season 10
  assert.deepEqual(continueRows, []); // S9E23 was removed when reached, and nothing follows
  assert.equal((await listener({ type: 'getState', tabId }, { id: 'ext' })).nextSaved, null);
  assert.doesNotMatch(markNotification().message, /Next up/);
});

test('nothing is saved while the next episode has not aired yet', async () => {
  reset(progress(9, 20));
  lastAired = { season: 9, episode: 21 }; // TMDB lists S9E22 but it has not aired
  await watchToTheEnd({ season: 9, episode: 21, url: 'https://cinejoy.pk/watch/tv/1622/9/21' });
  assert.deepEqual(continueRows, []);
});

test('an episode already in Continue keeps its link, and another episode there is not overwritten', async () => {
  // page S8E4 is not the "next" episode after S8E2, so only the progress update is under test
  reset(progress(8, 2));
  continueRows = [{ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5?real=1' }];
  let tabId = await open({ season: 8, episode: 4, url: 'https://cinejoy.pk/watch/tv/1622/8/4' });
  await listener({ type: 'markWatched', tabId }, { id: 'ext' });
  assert.deepEqual(continueRows, [{ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5?real=1' }]);
  assert.equal(posts.length, 0);

  reset(progress(8, 2));
  continueRows = [{ season: 8, episode: 9, url: 'https://cinejoy.pk/watch/tv/1622/8/9' }]; // one the user chose
  tabId = await open({ season: 8, episode: 4, url: 'https://cinejoy.pk/watch/tv/1622/8/4' });
  await listener({ type: 'markWatched', tabId }, { id: 'ext' });
  assert.deepEqual(continueRows, [{ season: 8, episode: 9, url: 'https://cinejoy.pk/watch/tv/1622/8/9' }]);
});

test('the Save to Continue setting also covers the next episode', async () => {
  reset(progress(8, 3));
  local.settings = { saveContinue: false };
  await watchToTheEnd({ season: 8, episode: 4, url: 'https://cinejoy.pk/watch/tv/1622/8/4' });
  assert.equal(historyWrites.some((w) => w.method === 'PATCH'), true); // still marked
  assert.equal(posts.length, 0);
});

test('a progress update that changes nothing saves nothing', async () => {
  reset(progress(8, 10)); // already ahead of S8E4
  await watchToTheEnd({ season: 8, episode: 4, url: 'https://cinejoy.pk/watch/tv/1622/8/4' });
  assert.equal(posts.length, 0);
});

test('marking by hand also saves the next episode (without a notification)', async () => {
  reset(progress(8, 2));
  const tabId = await open({ season: 8, episode: 4, url: 'https://cinejoy.pk/watch/tv/1622/8/4' });
  const result = await listener({ type: 'markWatched', tabId }, { id: 'ext' });
  assert.equal(result.ok, true);
  assert.deepEqual(continueRows, [{ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' }]);
  assert.equal(notifications.length, 0);
});

// ═════════════ the link follows the episode ═════════════
test('opening the saved episode points the record at the real page, silently', async () => {
  reset(progress(8, 4));
  continueRows = [{ season: 8, episode: 5, url: 'https://cinecat.eu/media/tmdb-tv-1622-supernatural/6911/162698' }]; // the link of the previous episode
  await open({ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' });
  assert.equal(patches.length, 1);
  assert.equal(patches[0].url, 'https://cinejoy.pk/watch/tv/1622/8/5');
  assert.equal(posts.length, 0);
  assert.equal(notifications.length, 0);
});

test('the same link is not written again', async () => {
  reset(progress(8, 4));
  continueRows = [{ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' }];
  await open({ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' });
  assert.equal(patches.length + posts.length, 0);
});

test('the link of an entry the user added by hand is updated too, even for an untracked show', async () => {
  reset([]); // not in the history
  continueRows = [{ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' }];
  await open({ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5?utm=x' });
  assert.equal(patches.length, 1);
});

test('opening a different episode does not touch the saved record', async () => {
  reset(progress(8, 3));
  continueRows = [{ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' }];
  await open({ season: 8, episode: 7, url: 'https://cinejoy.pk/watch/tv/1622/8/7' }); // S8E7 is not the next episode
  assert.equal(patches.length, 0);
  assert.deepEqual(continueRows, [{ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' }]);
});

// ═════════════ undo keeps Continue in step ═════════════
test('undoing a mark puts the previous episode back in Continue', async () => {
  reset(progress(8, 3));
  const page = 'https://cinejoy.pk/watch/tv/1622/8/4';
  const tabId = await watchToTheEnd({ season: 8, episode: 4, url: page });
  assert.deepEqual(continueRows.map((r) => r.episode), [5]); // S8E5 is next after the mark

  const result = await listener({ type: 'undoMark', tabId }, { id: 'ext' });
  assert.equal(result.ok, true);
  assert.equal(historyWrites.filter((w) => w.method === 'PATCH').at(-1).body.last_episode, 3); // progress restored
  // the next episode after S8E3 is S8E4, the one open in this tab, and its link is this page
  assert.deepEqual(continueRows, [{ season: 8, episode: 4, url: page }]);
});

// ═════════════ manual add ═════════════
test('Add to Continue saves the open episode for a show that is not tracked, marked as manual', async () => {
  reset([]); // not in the history
  const tabId = await open({ season: 2, episode: 3, url: 'https://cinejoy.pk/watch/tv/1622/2/3' });
  assert.equal(posts.length, 0); // not automatic

  let state = await listener({ type: 'getState', tabId }, { id: 'ext' });
  assert.equal(state.canAddContinue, true);

  const result = await listener({ type: 'addContinue', tabId }, { id: 'ext' });
  assert.deepEqual(result, { ok: true });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].manual, true);
  assert.equal(posts[0].season, 2);
  assert.equal(posts[0].episode, 3);
  assert.equal(posts[0].url, 'https://cinejoy.pk/watch/tv/1622/2/3');
  assert.equal(notifications.length, 0); // the user just pressed the button

  state = await listener({ type: 'getState', tabId }, { id: 'ext' });
  assert.equal(state.canAddContinue, false);
  assert.equal(state.continued, true);
});

test('Add to Continue is not offered for a movie, or an episode that is already in the history', async () => {
  reset(progress(8, 6));
  const movie = await open({ mediaType: 'movie', url: 'https://cinejoy.pk/watch/movie/603' });
  assert.equal((await listener({ type: 'getState', tabId: movie }, { id: 'ext' })).canAddContinue, false);
  assert.deepEqual(await listener({ type: 'addContinue', tabId: movie }, { id: 'ext' }), { ok: false, error: 'Open a TV episode first.' });

  const watched = await open({ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' }); // behind progress S8E6
  assert.equal((await listener({ type: 'getState', tabId: watched }, { id: 'ext' })).canAddContinue, false);
});

test('Add to Continue explains when the database update is missing', async () => {
  reset([]);
  continueError = { code: 'PGRST204', message: "Could not find the 'manual' column of 'continue_watching' in the schema cache" };
  const tabId = await open({ season: 2, episode: 3, url: 'https://cinejoy.pk/watch/tv/1622/2/3' });
  const result = await listener({ type: 'addContinue', tabId }, { id: 'ext' });
  assert.equal(result.ok, false);
  assert.match(result.error, /migration 007/);
});

// ═════════════ a finished season (season only) ═════════════
test('after a finished season, opening episode 1 of the next season is saved', async () => {
  reset([{ last_season: 8, last_episode: null, watched_at: 't' }]); // season 8 finished
  await open({ season: 9, episode: 1, url: 'https://cinejoy.pk/watch/tv/1622/9/1' });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].season, 9);
});

test('episodes inside a finished season count as already watched', async () => {
  reset([{ last_season: 8, last_episode: null, watched_at: 't' }]);
  const tabId = await open({ season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5' });
  const state = await listener({ type: 'getState', tabId }, { id: 'ext' });
  assert.equal(state.done, true);
  assert.equal(posts.length, 0);
});
