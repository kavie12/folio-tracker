/**
 * Runs inside every frame of a supported site (and its player domains).
 *  - top frame:  asks the site module "what is open?" and tells the background page
 *  - every frame: watches <video> elements and reports playback progress
 * It never reads or sends anything else from the page.
 */
import { MSG } from '../shared/messages.js';
import { MIN_DURATION, normalizeRef } from '../shared/media.js';

const MEDIA_POLL_MS = 1000; // detect SPA navigation and title changes
const MEDIA_HEARTBEAT_MS = 5000; // re-announce so the background state never goes stale
const VIDEO_REPORT_MS = 4000; // throttle for timeupdate
const VIDEO_SCAN_MS = 3000; // fallback scan for players that add <video> late

function send(message) {
  try {
    browser.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    /* extension was reloaded; this script is orphaned */
  }
}

function watchMedia(site) {
  let lastKey = '';
  let lastSent = 0;
  let ref = null;

  const tick = () => {
    const key = `${location.href}\n${document.title}`;
    const now = Date.now();
    if (key === lastKey && now - lastSent < MEDIA_HEARTBEAT_MS) return;

    if (key !== lastKey) {
      lastKey = key;
      try {
        ref = normalizeRef(site.extract({ url: new URL(location.href), title: document.title, document }));
      } catch {
        ref = null; // a broken site module must never break the page
      }
    }
    lastSent = now;
    send({ type: MSG.MEDIA, site: site.meta.id, host: location.hostname, ref, pageTitle: document.title });
  };

  setInterval(tick, MEDIA_POLL_MS);
  tick();
}

function watchVideo() {
  const attached = new WeakSet();
  let lastReport = 0;

  const report = (video, force) => {
    const now = Date.now();
    if (!force && now - lastReport < VIDEO_REPORT_MS) return;
    if (!Number.isFinite(video.duration) || video.duration < MIN_DURATION) return;
    lastReport = now;
    send({
      type: MSG.VIDEO,
      video: { currentTime: video.currentTime, duration: video.duration, paused: video.paused, ended: video.ended },
    });
  };

  const attach = (video) => {
    if (attached.has(video)) return;
    attached.add(video);
    for (const ev of ['play', 'pause', 'ended', 'seeked', 'loadedmetadata']) video.addEventListener(ev, () => report(video, true));
    video.addEventListener('timeupdate', () => report(video, false));
    report(video, true);
  };

  const scan = () => document.querySelectorAll('video').forEach(attach);
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(scan, VIDEO_SCAN_MS);
  scan();
}

export function runTracker(site) {
  if (window === window.top) watchMedia(site);
  watchVideo();
}
