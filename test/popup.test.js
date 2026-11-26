import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { MSG } from '../src/shared/messages.js';

Object.assign(globalThis, {
  __SUPABASE_URL__: 'https://proj.supabase.co', __SUPABASE_ANON_KEY__: 'anon',
  __TMDB_PROXY_URL__: 'https://proxy.example', __FOLIO_APP_URL__: 'https://folio.example', __VERSION__: 'test',
});

const SITES = [
  { id: 'cinecat', name: 'Cinecat', domains: ['cinecat.eu'], frameDomains: [] },
  { id: 'cinejoy', name: 'Cinejoy', domains: ['cinejoy.pk'], frameDomains: [] },
];
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Opens the popup against a fake background that answers GET_STATE with `state`. */
async function open(state, tabUrl = 'https://cinejoy.pk/watch/tv/1622/8/4', continueItems = [], responses = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  dom.window.close = () => {};

  const sent = [];
  const opened = [];
  globalThis.browser = {
    runtime: {
      getURL: (p) => `moz-extension://x/${p}`,
      sendMessage: async (m) => {
        sent.push(m);
        if (m.type === MSG.GET_STATE) return state;
        if (m.type === MSG.LIST_CONTINUE) return { ok: true, items: continueItems };
        if (responses[m.type]) return responses[m.type](m);
        return { ok: true };
      },
    },
    tabs: { query: async () => [{ id: 7, url: tabUrl }], create: async (opts) => { opened.push(opts.url); } },
  };
  globalThis.fetch = async () => new Response(JSON.stringify(SITES));

  mock.timers.enable({ apis: ['setInterval'] });
  await import(`../src/popup/popup.js?${Math.random()}`);
  await settle();
  return { dom, doc: dom.window.document, sent, opened };
}

const settings = { autoMark: true, notify: true, saveContinue: true };
const tvState = (extra = {}) => ({
  signedIn: true, user: { id: 'u', email: 'me@example.com' }, settings,
  media: { mediaType: 'tv', tmdbId: 1622, season: 8, episode: 4 },
  meta: { title: 'Supernatural', posterPath: '/p.jpg', releaseYear: 2005 },
  entry: { watched: false, progress: null },
  video: { percent: 42, ratio: 0.42, paused: false, ended: false, playing: true },
  done: false, autoMarked: false, undoable: false, undone: false, continued: false, canAddContinue: false, nextSaved: null, lastError: null, ...extra,
});

test('signed out: shows the sign-in form and the supported sites', async (t) => {
  t.after(() => mock.timers.reset());
  const { doc } = await open({ signedIn: false, settings });
  assert.ok(doc.querySelector('input[type=email]'));
  assert.ok(doc.querySelector('input[type=password]'));
  const text = doc.body.textContent;
  assert.match(text, /Cinecat/);
  assert.match(text, /Cinejoy/);
  assert.ok(doc.querySelector('.site.here'), 'the site of the current tab is highlighted');
});

test('playing a TV episode: title, S8E4 label, progress and the mark button', async (t) => {
  t.after(() => mock.timers.reset());
  const { doc, sent } = await open(tvState());
  assert.match(doc.querySelector('.title').textContent, /Supernatural/);
  assert.equal(doc.querySelector('.pill').textContent, 'S8E4');
  assert.match(doc.querySelector('.status').textContent, /Playing, 42%/);

  const button = doc.querySelector('.btn-primary');
  assert.equal(button.textContent, 'Mark as watched');
  button.click();
  await settle();
  assert.ok(sent.some((m) => m.type === MSG.MARK && m.tabId === 7));
});

test('already in history at this point: the button is disabled', async (t) => {
  t.after(() => mock.timers.reset());
  const { doc } = await open(tvState({ done: true, entry: { watched: true, progress: { season: 8, episode: 4 } } }));
  const button = doc.querySelector('.btn-done');
  assert.equal(button.disabled, true);
  assert.match(button.textContent, /In your history, S8E4/);
});

test('show already in history at an earlier episode: offers to update progress', async (t) => {
  t.after(() => mock.timers.reset());
  const { doc } = await open(tvState({ entry: { watched: true, progress: { season: 8, episode: 3 } } }));
  assert.equal(doc.querySelector('.btn-primary').textContent, 'Update progress to S8E4');
});

test('nothing playing', async (t) => {
  t.after(() => mock.timers.reset());
  const { doc } = await open({ signedIn: true, user: { email: 'me@example.com' }, settings, media: null }, 'https://example.com/');
  assert.match(doc.querySelector('.empty').textContent, /Nothing playing here/);
});

test('Sites tab lists every supported site', async (t) => {
  t.after(() => mock.timers.reset());
  const { doc } = await open(tvState());
  [...doc.querySelectorAll('.seg button')].find((b) => b.textContent === 'Sites').click();
  assert.equal(doc.querySelectorAll('.site').length, 2);
});

test('Undo button appears next to the done state and sends the undo message', async (t) => {
  t.after(() => mock.timers.reset());
  const { doc, sent } = await open(tvState({ done: true, autoMarked: true, undoable: true, entry: { watched: true, progress: { season: 8, episode: 4 } } }));
  assert.equal(doc.querySelector('.btn-done').disabled, true);
  const undo = doc.querySelector('.btn-undo');
  assert.equal(undo.textContent, 'Undo');
  undo.click();
  await settle();
  assert.ok(sent.some((m) => m.type === MSG.UNDO && m.tabId === 7));
});

test('no Undo button when nothing can be undone', async (t) => {
  t.after(() => mock.timers.reset());
  const { doc } = await open(tvState({ done: true, undoable: false, entry: { watched: true, progress: { season: 8, episode: 4 } } }));
  assert.equal(doc.querySelector('.btn-undo'), null);
});

test('after an undo the popup explains that auto-marking is paused for this title', async (t) => {
  t.after(() => mock.timers.reset());
  const { doc } = await open(tvState({ undone: true }));
  assert.match(doc.body.textContent, /won’t be marked automatically again/);
  assert.equal(doc.querySelector('.btn-primary').textContent, 'Mark as watched');
});

const item = (extra = {}) => ({
  mediaId: 1622, title: 'Supernatural', posterPath: '/p.jpg', releaseYear: 2005,
  season: 8, episode: 5, url: 'https://cinejoy.pk/watch/tv/1622/8/5', updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), ...extra,
});
const tab = (doc, name) => [...doc.querySelectorAll('.seg button')].find((b) => b.textContent === name);

test('Continue tab lists saved episodes and opens the saved link', async (t) => {
  t.after(() => mock.timers.reset());
  const { doc, sent, opened } = await open(tvState(), undefined, [item()]);
  tab(doc, 'Continue').click();
  await settle();

  assert.ok(sent.some((m) => m.type === MSG.LIST_CONTINUE));
  const row = doc.querySelector('.cont');
  assert.match(row.textContent, /Supernatural/);
  assert.equal(row.querySelector('.pill').textContent, 'S8E5');
  assert.match(row.textContent, /cinejoy\.pk, saved/);

  assert.equal(row.querySelector('[aria-label^="Remove"]'), null, 'the extension has no remove button');
  row.querySelector('.btn-primary').click();
  assert.deepEqual(opened, ['https://cinejoy.pk/watch/tv/1622/8/5']);
});

test('Continue tab never opens a non-http link', async (t) => {
  t.after(() => mock.timers.reset());
  const { doc, opened } = await open(tvState(), undefined, [item({ url: 'javascript:alert(1)' })]);
  tab(doc, 'Continue').click();
  await settle();
  assert.equal(doc.querySelector('.cont .btn-primary'), null);
  assert.equal(opened.length, 0);
});

test('empty Continue tab explains how entries appear', async (t) => {
  t.after(() => mock.timers.reset());
  const { doc } = await open(tvState());
  tab(doc, 'Continue').click();
  await settle();
  assert.match(doc.querySelector('.empty').textContent, /open the next one/);
});

test('the current page says when it was saved to Continue', async (t) => {
  t.after(() => mock.timers.reset());
  const { doc } = await open(tvState({ continued: true }));
  assert.match(doc.body.textContent, /Saved to Continue/);
});

// ── Sites: open the streaming sites ─────────────────────────
test('every row in the Sites tab is a link that opens the site in a new tab', async (t) => {
  t.after(() => mock.timers.reset());
  const { doc, opened } = await open(tvState());
  tab(doc, 'Sites').click();
  await settle();

  const rows = [...doc.querySelectorAll('a.site')];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].getAttribute('href'), 'https://cinecat.eu');
  assert.equal(rows[0].getAttribute('aria-label'), 'Open Cinecat (cinecat.eu)');
  assert.match(rows[1].textContent, /Open/);

  rows[0].click();
  rows[1].click();
  assert.deepEqual(opened, ['https://cinecat.eu', 'https://cinejoy.pk']);
});

test('the sites listed on the sign-in screen open too', async (t) => {
  t.after(() => mock.timers.reset());
  const { doc, opened } = await open({ signedIn: false, settings }, 'https://example.com/');
  doc.querySelector('a.site').click();
  assert.deepEqual(opened, ['https://cinecat.eu']);
});

// ── Add to Continue ─────────────────────────────────────────
test('Add to Continue appears for an episode that is not in the list, and asks the background to save it', async (t) => {
  t.after(() => mock.timers.reset());
  const { doc, sent } = await open(tvState({ canAddContinue: true, entry: { watched: false, progress: null } }));
  const button = [...doc.querySelectorAll('.btn')].find((b) => b.textContent === 'Add to Continue');
  assert.ok(button);
  button.click();
  await settle();
  assert.ok(sent.some((m) => m.type === MSG.ADD_CONTINUE && m.tabId === 7));
});

test('Add to Continue shows why it failed', async (t) => {
  t.after(() => mock.timers.reset());
  const { doc } = await open(tvState({ canAddContinue: true }), undefined, [], {
    [MSG.ADD_CONTINUE]: () => ({ ok: false, error: 'Continue needs the latest database update (migration 007).' }),
  });
  [...doc.querySelectorAll('.btn')].find((b) => b.textContent === 'Add to Continue').click();
  await settle();
  assert.match(doc.querySelector('[role=alert]').textContent, /migration 007/);
});

test('Add to Continue is hidden when it is not offered', async (t) => {
  t.after(() => mock.timers.reset());
  const { doc } = await open(tvState({ canAddContinue: false, continued: true }));
  assert.equal([...doc.querySelectorAll('.btn')].some((b) => b.textContent === 'Add to Continue'), false);
  assert.match(doc.body.textContent, /Saved to Continue/);
});

// ── next up ─────────────────────────────────────────────────
test('after marking, the popup says which next episode was saved', async (t) => {
  t.after(() => mock.timers.reset());
  const { doc } = await open(tvState({ done: true, autoMarked: true, nextSaved: { season: 8, episode: 5 }, entry: { watched: true, progress: { season: 8, episode: 4 } } }));
  assert.match(doc.body.textContent, /Next up, S8E5, saved to Continue/);
});

test('no next-up line when nothing follows', async (t) => {
  t.after(() => mock.timers.reset());
  const { doc } = await open(tvState({ done: true, nextSaved: null, entry: { watched: true, progress: { season: 9, episode: null } } }));
  assert.doesNotMatch(doc.body.textContent, /Next up/);
});
