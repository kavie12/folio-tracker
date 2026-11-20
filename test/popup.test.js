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
async function open(state, tabUrl = 'https://cinejoy.pk/watch/tv/1622/8/4') {
  const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  dom.window.close = () => {};

  const sent = [];
  globalThis.browser = {
    runtime: {
      getURL: (p) => `moz-extension://x/${p}`,
      sendMessage: async (m) => { sent.push(m); return m.type === MSG.GET_STATE ? state : { ok: true }; },
    },
    tabs: { query: async () => [{ id: 7, url: tabUrl }], create: async () => {} },
  };
  globalThis.fetch = async () => new Response(JSON.stringify(SITES));

  mock.timers.enable({ apis: ['setInterval'] });
  await import(`../src/popup/popup.js?${Math.random()}`);
  await settle();
  return { dom, doc: dom.window.document, sent };
}

const settings = { autoMark: true, notify: true };
const tvState = (extra = {}) => ({
  signedIn: true, user: { id: 'u', email: 'me@example.com' }, settings,
  media: { mediaType: 'tv', tmdbId: 1622, season: 8, episode: 4 },
  meta: { title: 'Supernatural', posterPath: '/p.jpg', releaseYear: 2005 },
  entry: { watched: false, progress: null },
  video: { percent: 42, ratio: 0.42, paused: false, ended: false, playing: true },
  done: false, autoMarked: false, undoable: false, undone: false, lastError: null, ...extra,
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
