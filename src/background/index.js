/**
 * Background (event) page. Keeps one state object per tab, fed by the content scripts:
 *   - the top frame says WHAT is open (TMDB id, season, episode)
 *   - any frame with a <video> says HOW FAR it has played
 * and marks the title as watched at 80%.
 */
import { MSG } from '../shared/messages.js';
import { MIN_DURATION, WATCHED_THRESHOLD, isAhead, mediaKey, nextEpisodeAfter, normalizeRef, progressLabel, qualifiesForContinue } from '../shared/media.js';
import { getUser, signIn, signOut } from './auth.js';
import { fetchEntry, recordWatch, undoApplies, undoWatch } from './folio.js';
import { getSettings, setSettings } from './settings.js';
import { buildEpisodeUrl } from './sites.js';
import { getDetails } from './tmdb.js';
import { getContinue, listContinue, saveContinue, updateContinueLink } from './continue.js';
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
  site: null, host: null, url: null, media: null, mediaAt: 0, continueKey: null, nextSaved: null, counts: null,
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
  return !isAhead(ref, entry.progress, t.counts); // t.counts: episodes per season, so a finished season counts as done
}

function setBadge(tabId) {
  const t = tabs.get(tabId);
  const text = t?.media ? (isDone(t, t.media, t.entry) ? '✓' : '•') : '';
  browser.action.setBadgeText({ tabId, text }).catch(() => undefined);
}

// ── marking ─────────────────────────────────────────────────
async function notify(ref, result, next) {
  const settings = await getSettings();
  if (!settings.notify || (!result.added && !result.progressUpdated)) return;
  const meta = await getDetails(ref).catch(() => null);
  // A season's last episode is stored as just the season: say so.
  const finished = result.progress && result.progress.episode === null && ref.episode != null;
  const label = finished ? `season ${result.progress.season} finished` : progressLabel(ref);
  const name = `${meta?.title ?? 'Title'}${label ? `, ${label}` : ''}`;
  const lines = [name];
  if (next) lines.push(`Next up: ${progressLabel({ mediaType: 'tv', ...next })}, saved to Continue`);
  lines.push('Open the extension to undo.');
  browser.notifications.create(`folio-${mediaKey(ref)}`, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('icons/icon-96.png'),
    title: result.added ? 'Added to your Folio history' : 'Folio progress updated',
    message: lines.join('\n'),
  });
}

const sameEpisode = (a, b) => !!a && !!b && a.season === b.season && a.episode === b.episode;

/**
 * Progress just moved to `progress`. If TMDB says a next episode exists (and has aired), put it in Continue.
 * The link is the episode's own address when the site's address can be built from ids, otherwise the page the
 * user is on; it is replaced by the real one as soon as they open that episode (see syncContinue).
 *
 * An entry already in Continue is left alone unless it is the one we saved earlier (`replace`, used by undo):
 * the same episode keeps its link, and a different episode may be one the user chose themselves.
 * @returns {Promise<{season:number, episode:number}|null>} the next episode now in Continue, or null
 */
async function saveNextEpisode(tabId, ref, progress, { replace = null } = {}) {
  const t = tabs.get(tabId);
  if (!progress || ref.mediaType !== 'tv') return null;
  if (!(await getSettings()).saveContinue) return null;

  const meta = await getDetails(ref).catch(() => null);
  const next = meta?.episodeCounts ? nextEpisodeAfter(progress, meta.episodeCounts, meta.lastAired) : null;
  if (!next) return null;

  const nextRef = { mediaType: 'tv', tmdbId: ref.tmdbId, ...next };
  try {
    const saved = await getContinue(nextRef);
    if (saved) {
      if (sameEpisode(saved, next)) return next; // already there: keep its link
      if (!sameEpisode(saved, replace)) return null; // the list holds another episode: do not overwrite it
    }

    // If the next episode is the page that is open, that address is the real link.
    const url = sameEpisode(t?.media, next) ? t.url : ((await buildEpisodeUrl(t?.site, nextRef)) ?? t?.url);
    if (!url) return null;
    await saveContinue(nextRef, meta, url);
  } catch {
    return null; // offline or signed out: the next episode is still saved when the user opens it
  }
  return next;
}

/**
 * The user's own choice: save the open episode to Continue, whether or not the show is tracked in the history
 * and whether or not it is the "next" episode.
 */
async function addToContinueNow(tabId) {
  const t = tabs.get(tabId);
  const ref = t?.media;
  if (!ref || ref.mediaType !== 'tv' || ref.season == null || ref.episode == null || !t.url) {
    return { ok: false, error: 'Open a TV episode first.' };
  }
  const key = mediaKey(ref);
  const url = t.url; // this episode's link, even if the tab moves on while we save

  try {
    const meta = await getDetails(ref);
    await saveContinue(ref, meta, url, { manual: true });
  } catch (err) {
    if (/manual/.test(err.detail ?? '')) return { ok: false, error: 'Continue needs the latest database update (migration 007).' };
    return { ok: false, error: err.message };
  }
  if (tabs.get(tabId)?.media && mediaKey(tabs.get(tabId).media) === key) {
    tabs.get(tabId).continueKey = key; // handled for this page, so the automatic rule leaves it alone
    persist();
  }
  return { ok: true };
}

async function notifyContinue(ref, meta) {
  if (!(await getSettings()).notify) return;
  browser.notifications.create(`folio-continue-${mediaKey(ref)}`, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('icons/icon-96.png'),
    title: 'Saved to Continue',
    message: `${meta.title}, ${progressLabel(ref)}`,
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

    // Progress moved: see whether TMDB has a next episode, and keep it in Continue.
    const next = result.progressUpdated && result.progress ? await saveNextEpisode(tabId, ref, result.progress) : null;

    if (tabs.get(tabId)?.media && mediaKey(tabs.get(tabId).media) === key) {
      t.markedKey = key;
      t.markedAuto = !manual;
      t.undoneKey = null;
      t.lastError = null;
      t.nextSaved = next;
    }
    if (!manual) await notify(ref, result, next);
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

/** The page URL if it is plain http(s) on the host the content script runs on. */
function safePageUrl(raw, host) {
  try {
    const url = new URL(String(raw));
    return /^https?:$/.test(url.protocol) && url.hostname === host && url.href.length <= 2000 ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Opening the episode right after your recorded progress saves it to Continue, with the page link.
 * Runs when the page changes, when the popup opens (covers signing in afterwards or an earlier failure),
 * and after an undo.
 */
async function syncContinue(tabId, entry) {
  const t = tabs.get(tabId);
  if (!t?.media || t.media.mediaType !== 'tv' || !t.url) return;

  const ref = t.media;
  if (ref.season == null || ref.episode == null) return; // Continue needs a season and an episode
  const url = t.url; // the link of THIS episode, even if the tab moves on while we wait below
  const key = mediaKey(ref);
  if (t.continueKey === key) return; // already handled for this episode (even if the user removed it since)
  if (!(await getSettings()).saveContinue) return;

  // What does the list say about this show? Ask the list itself: the tab's memory is lost when a tab is closed
  // or the browser restarts, and the same episode may be opened again later.
  let saved;
  try {
    saved = await getContinue(ref);
  } catch {
    return; // offline or signed out: tried again the next time the popup opens
  }
  const handled = () => {
    if (tabs.get(tabId)?.media && mediaKey(tabs.get(tabId).media) === key) {
      tabs.get(tabId).continueKey = key;
      persist();
    }
  };

  // This very episode is already in the list: opening it gives the real link, so keep the record pointing at it.
  // Nothing new was added, so there is no notification.
  if (sameEpisode(saved, ref)) {
    if (saved.url !== url) {
      try {
        await updateContinueLink(ref, url);
      } catch {
        return;
      }
    }
    handled();
    return;
  }

  // Otherwise the automatic rule: only the episode right after the recorded progress of a tracked show.
  const meta = await getDetails(ref).catch(() => null);
  if (!meta || !qualifiesForContinue(ref, entry, meta.episodeCounts)) return;
  try {
    await saveContinue(ref, meta, url);
  } catch {
    return;
  }
  handled();
  await notifyContinue(ref, meta);
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
    const hadNext = t.nextSaved;
    await undoWatch(ref, undo);
    await clearUndo(ref);

    // Progress went back, so the next episode changes with it. (If the show was removed or its progress cleared,
    // the database already dropped the automatic entry.)
    const next = undo.type === 'restore' && undo.progress
      ? await saveNextEpisode(tabId, ref, undo.progress, { replace: hadNext })
      : null;

    if (tabs.get(tabId)?.media && mediaKey(tabs.get(tabId).media) === key) {
      // Playback is still past 80%, so without this the next progress update would mark it again.
      Object.assign(t, { markedKey: null, markedAuto: false, undoneKey: key, lastError: null, nextSaved: next });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    t.marking = false;
    t.entry = await fetchEntry(ref).catch(() => null);
    setBadge(tabId);
    persist();
    if (t.entry && tabs.get(tabId)?.media && mediaKey(tabs.get(tabId).media) === key) {
      t.continueKey = null; // the database may have dropped it when this episode was marked
      syncContinue(tabId, t.entry);
    }
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
  t.url = safePageUrl(msg.url, t.host);
  t.media = ref;
  t.mediaAt = Date.now();

  if (before !== after) {
    // A different movie or episode: forget the previous one's playback.
    Object.assign(t, { videos: {}, entry: null, counts: null, nextSaved: null, markedKey: null, markedAuto: false, undoneKey: null, continueKey: null, lastError: null, retryAt: 0 });
    if (ref) {
      getDetails(ref) // warms the cache so the popup opens instantly, and tells us how long each season is
        .then((meta) => {
          const cur = tabs.get(sender.tab.id);
          if (cur?.media && mediaKey(cur.media) === after) {
            cur.counts = meta.episodeCounts ?? null;
            setBadge(sender.tab.id);
            persist();
          }
        })
        .catch(() => undefined);
      fetchEntry(ref)
        .then((entry) => {
          if (tabs.get(sender.tab.id)?.media && mediaKey(tabs.get(sender.tab.id).media) === after) {
            tabs.get(sender.tab.id).entry = entry;
            setBadge(sender.tab.id);
            persist();
            syncContinue(sender.tab.id, entry);
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
  t.counts = meta?.episodeCounts ?? t.counts ?? null;
  setBadge(tabId);
  syncContinue(tabId, entry); // fire and forget: the next poll reports the result

  const done = isDone(t, ref, entry);
  const isEpisode = ref.mediaType === 'tv' && ref.season != null && ref.episode != null && !!t.url;
  return {
    ...base,
    media: ref,
    meta,
    entry,
    video: summarizeVideo(t),
    done,
    continued: t.continueKey === mediaKey(ref) && !done,
    canAddContinue: isEpisode && !done && t.continueKey !== mediaKey(ref),
    nextSaved: t.nextSaved ?? null,
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
    case MSG.ADD_CONTINUE:
      return addToContinueNow(msg.tabId);
    case MSG.LIST_CONTINUE:
      try {
        return { ok: true, items: await listContinue() };
      } catch (err) {
        return { ok: false, error: err.message };
      }
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
