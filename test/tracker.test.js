import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import * as cinecat from '../src/sites/cinecat.js';
import * as cinejoy from '../src/sites/cinejoy.js';
import { MSG } from '../src/shared/messages.js';

/** Boots the tracker inside a fake page and returns the messages it sent. */
async function boot(site, url, title) {
  const dom = new JSDOM(`<!doctype html><title>${title}</title><body></body>`, { url });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, MutationObserver: dom.window.MutationObserver });

  const sent = [];
  globalThis.browser = { runtime: { sendMessage: async (m) => { sent.push(m); } } };

  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { runTracker } = await import(`../src/content/tracker.js?${Math.random()}`);
  runTracker(site);
  return { dom, sent };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0)); // let the MutationObserver run

async function addVideo(dom, { duration, currentTime, paused = false }) {
  const video = dom.window.document.createElement('video');
  Object.defineProperties(video, {
    duration: { value: duration, configurable: true },
    currentTime: { value: currentTime, configurable: true },
    paused: { value: paused, configurable: true },
    ended: { value: false, configurable: true },
  });
  dom.window.document.body.append(video);
  await settle();
  return video;
}

test('top frame announces the media found by the site module', async (t) => {
  t.after(() => mock.timers.reset());
  const { sent } = await boot(cinejoy, 'https://cinejoy.pk/watch/tv/1622/8/3', 'Cinejoy');

  const media = sent.filter((m) => m.type === MSG.MEDIA);
  assert.equal(media.length, 1);
  assert.deepEqual(media[0].ref, { mediaType: 'tv', tmdbId: 1622, season: 8, episode: 3 });
  assert.equal(media[0].site, 'cinejoy');
  assert.equal(media[0].host, 'cinejoy.pk');
  assert.equal(media[0].url, 'https://cinejoy.pk/watch/tv/1622/8/3'); // saved with Continue entries
});

test('re-announces on a heartbeat, and again when the page title changes', async (t) => {
  t.after(() => mock.timers.reset());
  const { dom, sent } = await boot(cinecat, 'https://cinecat.eu/media/tmdb-tv-1622-supernatural/6911/162698', 'Cinecat');
  const mediaMsgs = () => sent.filter((m) => m.type === MSG.MEDIA);

  assert.deepEqual(mediaMsgs()[0].ref, { mediaType: 'tv', tmdbId: 1622, season: null, episode: null }); // title not updated yet
  mock.timers.tick(2000);
  assert.equal(mediaMsgs().length, 1); // nothing changed, no heartbeat yet

  dom.window.document.title = 'Supernatural - S8 - E4';
  mock.timers.tick(1000);
  assert.equal(mediaMsgs().length, 2);
  assert.deepEqual(mediaMsgs()[1].ref, { mediaType: 'tv', tmdbId: 1622, season: 8, episode: 4 });

  mock.timers.tick(5000);
  assert.ok(mediaMsgs().length >= 3); // heartbeat
});

test('a page that is not a watch page announces null', async (t) => {
  t.after(() => mock.timers.reset());
  const { sent } = await boot(cinejoy, 'https://cinejoy.pk/', 'Home');
  assert.equal(sent.find((m) => m.type === MSG.MEDIA).ref, null);
});

test('reports playback of a long video and ignores short ones', async (t) => {
  t.after(() => mock.timers.reset());
  const { dom, sent } = await boot(cinejoy, 'https://cinejoy.pk/watch/movie/603', 'Cinejoy');

  const ad = await addVideo(dom, { duration: 30, currentTime: 5 });
  ad.dispatchEvent(new dom.window.Event('play'));
  assert.equal(sent.filter((m) => m.type === MSG.VIDEO).length, 0);

  const film = await addVideo(dom, { duration: 7200, currentTime: 5800 });
  film.dispatchEvent(new dom.window.Event('play'));
  const video = sent.filter((m) => m.type === MSG.VIDEO);
  assert.equal(video.length >= 1, true);
  assert.deepEqual(video.at(-1).video, { currentTime: 5800, duration: 7200, paused: false, ended: false });
});

test('a broken site module never throws into the page', async (t) => {
  t.after(() => mock.timers.reset());
  const broken = { meta: { id: 'broken' }, extract: () => { throw new Error('boom'); } };
  const { sent } = await boot(broken, 'https://cinejoy.pk/watch/movie/1', 'x');
  assert.equal(sent.find((m) => m.type === MSG.MEDIA).ref, null);
});
