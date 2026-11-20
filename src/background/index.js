/**
 * Background (event) page. Keeps one state object per tab, fed by the content scripts:
 *   - the top frame says WHAT is open (TMDB id, season, episode)
 *   - any frame with a <video> says HOW FAR it has played
 * and marks the title as watched at 80%.
 */
import { MSG } from '../shared/messages.js';
import { MIN_DURATION, WATCHED_THRESHOLD, isAhead, mediaKey, normalizeRef, progressLabel } from '../shared/media.js';
import { getUser, signIn, signOut } from './auth.js';
import { fetchEntry, recordWatch, undoApplies, undoWatch } from './folio.js';
import { getSettings, setSettings } from './settings.js';
import { getDetails } from './tmdb.js';
import { clearUndo, getUndo, saveUndo } from './undo.js';

const STALE_MS = 90_000; // content scripts re-announce every few seconds
const RETRY_MS = 30_000; // wait before retrying a failed automatic mark
const PLAYING_MS = 15_000; // a video reporting this recently counts as playing

/** @type {Map<number, any>} tabId -> state. Mirrored to storage.session because event pages get unloaded. */
const tabs = new Map();

const ready = (async () => {
  const { tabs: saved } = await browser.storage.session.get('tabs');
  for (const [id, state] of Object.entries(saved ?? {})) tabs.set(Number(id), state);
  browser.action.setBadgeBackgroundColor({ color: '#E3A857' });
  browser.action.setBadgeTextColor?.({ color: '#1C150E' });
})();

let persistTimer;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => browser.storage.session.set({ tabs: Object.fromEntries(tabs) }), 300);
}

const blankTab = () => ({
  site: null, host: null, media: null, mediaAt: 0,
  videos: {}, entry: null,
  markedKey: null, markedAuto: false, undoneKey: null, marking: false, lastError: null, retryAt: 0,
});
const getTab = (id) => {
  if (!tabs.has(id)) tabs.set(id, blankTab());
  return tabs.get(id);
};

// ── derived state ───────────────────────────────────────────
/** The video that reported most recently (frames can differ: players, ads). */
function summarizeVideo(t) {
  const latest = Object.values(t.videos).sort((a, b) => b.at - a.at)[0];
  if (!latest) return null;
  return {
    percent: Math.min(100, Math.round((latest.currentTime / latest.duration) * 100)),
    ratio: latest.currentTime / latest.duration,
    paused: latest.paused,
    ended: latest.ended,
    playing: !latest.paused && !latest.ended && Date.now() - latest.at < PLAYING_MS,
  };
}

/** Already in the history at (or past) this point? */
function isDone(t, ref, entry) {
  if (t.markedKey === mediaKey(ref)) return true;
  if (!entry?.watched) return false;
  if (ref.mediaType === 'movie' || ref.season == null) return true;
  return !isAhead(ref, entry.progress);
}

function setBadge(tabId) {
  const t = tabs.get(tabId);
  const text = t?.media ? (isDone(t, t.media, t.entry) ? '✓' : '•') : '';
  browser.action.setBadgeText({ tabId, text }).catch(() => undefined);
}

// ── marking ─────────────────────────────────────────────────
async function notify(ref, result) {
  const settings = await getSettings();
  if (!settings.notify || (!result.added && !result.progressUpdated)) return;
  const meta = await getDetails(ref).catch(() => null);
  const label = progressLabel(ref);
  const name = `${meta?.title ?? 'Title'}${label ? `, ${label}` : ''}`;
  browser.notifications.create(`folio-${mediaKey(ref)}`, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('icons/icon-96.png'),
    title: result.added ? 'Added to your Folio history' : 'Folio progress updated',
    message: `${name}. Open the extension to undo.`,
  });
}

async function markNow(tabId, { manual }) {
  const t = tabs.get(tabId);
  if (!t?.media || t.marking) return { ok: false, error: 'Nothing to mark.' };

  const ref = t.media;
  const key = mediaKey(ref);
  t.marking = true;
  try {
    const result = await recordWatch(ref, { manual });
    if (result.undo) await saveUndo(ref, result.undo);
    if (tabs.get(tabId)?.media && mediaKey(tabs.get(tabId).media) === key) {
      t.markedKey = key;
      t.markedAuto = !manual;
      t.undoneKey = null;
      t.lastError = null;
    }
    if (!manual) await notify(ref, result);
    return { ok: true, ...result };
  } catch (err) {
    t.lastError = err.message;
    t.retryAt = Date.now() + RETRY_MS;
    return { ok: false, error: err.message };
  } finally {
    t.marking = false;
    setBadge(tabId);
    persist();
  }
}

/** Reverses the last mark for the title open in this tab. */
async function undoNow(tabId) {
  const t = tabs.get(tabId);
  if (!t?.media || t.marking) return { ok: false, error: 'Nothing to undo.' };

  const ref = t.media;
  const key = mediaKey(ref);
  const undo = await getUndo(ref);
  if (!undo) return { ok: false, error: 'Nothing to undo.' };

  t.marking = true;
  try {
    await undoWatch(ref, undo);
    await clearUndo(ref);
    if (tabs.get(tabId)?.media && mediaKey(tabs.get(tabId).media) === key) {
      // Playback is still past 80%, so without this the next progress update would mark it again.
      Object.assign(t, { markedKey: null, markedAuto: false, undoneKey: key, lastError: null });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    t.marking = false;
    t.entry = await fetchEntry(ref).catch(() => null);
    setBadge(tabId);
    persist();
  }
}

async function maybeAutoMark(tabId) {
  const t = tabs.get(tabId);
  if (!t?.media || t.marking || Date.now() < t.retryAt) return;
  if (t.markedKey === mediaKey(t.media) || t.undoneKey === mediaKey(t.media)) return;

  const video = summarizeVideo(t);
  if (!video || (video.ratio < WATCHED_THRESHOLD && !video.ended)) return;
  if (!(await getSettings()).autoMark || !(await getUser())) return;

  // recordWatch checks the history first, so a title that is already recorded is not written twice.
  await markNow(tabId, { manual: false });
}

// ── messages from content scripts ───────────────────────────
async function onMedia(msg, sender) {
  if (sender.frameId !== 0) return; // only the top frame knows what the page is
  const t = getTab(sender.tab.id);
  const ref = normalizeRef(msg.ref);
  const before = t.media ? mediaKey(t.media) : null;
  const after = ref ? mediaKey(ref) : null;

  t.site = String(msg.site ?? '').slice(0, 40);
  t.host = String(msg.host ?? '').slice(0, 253);
  t.media = ref;
  t.mediaAt = Date.now();

  if (before !== after) {
    // A different movie or episode: forget the previous one's playback.
    Object.assign(t, { videos: {}, entry: null, markedKey: null, markedAuto: false, undoneKey: null, lastError: null, retryAt: 0 });
    if (ref) {
      getDetails(ref).catch(() => undefined); // warm the cache so the popup opens instantly
      fetchEntry(ref)
        .then((entry) => {
          if (tabs.get(sender.tab.id)?.media && mediaKey(tabs.get(sender.tab.id).media) === after) {
            tabs.get(sender.tab.id).entry = entry;
            setBadge(sender.tab.id);
            persist();
          }
        })
        .catch(() => undefined); // signed out or offline: the badge just stays at the dot
    }
  }
  setBadge(sender.tab.id);
  persist();
}

async function onVideo(msg, sender) {
  const v = msg.video ?? {};
  const t = tabs.get(sender.tab.id);
  if (!t?.media || !Number.isFinite(v.currentTime) || !Number.isFinite(v.duration) || v.duration < MIN_DURATION) return;

  t.videos[sender.frameId] = {
    currentTime: Math.max(0, v.currentTime),
    duration: v.duration,
    paused: !!v.paused,
    ended: !!v.ended,
    at: Date.now(),
  };
  persist();
  await maybeAutoMark(sender.tab.id);
}

// ── messages from the popup ─────────────────────────────────
async function snapshot(tabId) {
  const [user, settings] = await Promise.all([getUser(), getSettings()]);
  const base = { signedIn: !!user, user, settings };
  if (!user) return base;

  const t = tabs.get(tabId);
  if (!t?.media || Date.now() - t.mediaAt > STALE_MS) return { ...base, media: null };

  const ref = t.media;
  const [meta, entry, undo] = await Promise.all([getDetails(ref).catch(() => null), fetchEntry(ref).catch(() => null), getUndo(ref)]);
  t.entry = entry;
  setBadge(tabId);

  return {
    ...base,
    media: ref,
    meta,
    entry,
    video: summarizeVideo(t),
    done: isDone(t, ref, entry),
    autoMarked: t.markedKey === mediaKey(ref) && t.markedAuto,
    undoable: undoApplies(ref, entry, undo),
    undone: t.undoneKey === mediaKey(ref),
    lastError: t.lastError,
  };
}

async function route(msg, sender) {
  await ready;
  const fromContent = !!sender.tab;
  const fromPopup = sender.id === browser.runtime.id && !sender.tab;

  switch (msg?.type) {
    case MSG.MEDIA:
      return fromContent ? onMedia(msg, sender) : undefined;
    case MSG.VIDEO:
      return fromContent ? onVideo(msg, sender) : undefined;
    default:
  }
  if (!fromPopup) return undefined;

  switch (msg?.type) {
    case MSG.GET_STATE:
      return snapshot(msg.tabId);
    case MSG.MARK:
      return markNow(msg.tabId, { manual: true });
    case MSG.UNDO:
      return undoNow(msg.tabId);
    case MSG.SIGN_IN:
      try {
        return { ok: true, user: await signIn(String(msg.email ?? ''), String(msg.password ?? '')) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    case MSG.SIGN_OUT:
      await signOut();
      for (const t of tabs.values()) t.entry = null;
      return { ok: true };
    case MSG.SET_SETTINGS:
      return setSettings(msg.patch);
    default:
      return undefined;
  }
}

browser.runtime.onMessage.addListener((msg, sender) => route(msg, sender));

// ── housekeeping ────────────────────────────────────────────
browser.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  persist();
});

// Navigating away from the site entirely: the content script is gone, so clear the tab ourselves.
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const t = tabs.get(tabId);
  if (!t || !changeInfo.url) return;
  try {
    if (new URL(changeInfo.url).hostname !== t.host) {
      tabs.delete(tabId);
      setBadge(tabId);
      persist();
    }
  } catch {
    /* ignore unparsable URLs */
  }
});
