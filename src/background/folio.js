/**
 * Reads and writes the user's watch_history through Supabase's REST API.
 * Row Level Security scopes every call to the signed-in user.
 */
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../shared/config.js';
import { isAhead, normalizeProgress, progressMatches } from '../shared/media.js';
import { getAccessToken, getSession, NotSignedInError } from './auth.js';
import { getDetails } from './tmdb.js';

export async function rest(path, { method = 'GET', body, prefer } = {}, retry = true) {
  const token = await getAccessToken();
  if (!token) throw new NotSignedInError();

  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Couldn’t reach Folio. Check your connection.');
  }

  if (res.status === 401 && retry) {
    // Token rejected: force one refresh, then try again.
    if (await getAccessToken({ force: true })) return rest(path, { method, body, prefer }, false);
    throw new NotSignedInError();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const error = new Error('Folio couldn’t save that. Try again in a moment.');
    error.status = res.status;
    error.detail = String(body?.message ?? ''); // for example "Could not find the 'manual' column ..."
    throw error;
  }
  return method === 'GET' ? res.json() : null;
}

const filter = (ref) => `media_id=eq.${ref.tmdbId}&media_type=eq.${ref.mediaType}`;

/** Is this title in the user's history, and what progress is recorded? */
export async function fetchEntry(ref) {
  const rows = await rest(`watch_history?${filter(ref)}&select=last_season,last_episode,watched_at&limit=1`);
  if (!rows.length) return { watched: false, progress: null, watchedAt: null };
  const { last_season: season, last_episode: episode, watched_at: watchedAt } = rows[0];
  return { watched: true, progress: season == null ? null : { season, episode }, watchedAt };
}

/**
 * Can this undo record still be applied? For TV it must not have been overtaken:
 * undoing S8E4 after S8E5 was recorded would otherwise wipe out later progress.
 */
export function undoApplies(ref, entry, undo) {
  if (!undo || !entry?.watched) return false;
  // `written` is the progress the mark stored (a finished season is stored without its episode). Records
  // made before it existed fall back to the episode itself.
  const written = undo.written ?? (ref.mediaType === 'tv' && ref.season != null ? { season: ref.season, episode: ref.episode ?? null } : null);
  return written ? progressMatches(entry.progress, written) : true;
}

/**
 * Marks a title as watched. For TV, also records the season and episode.
 *  - new title: added (with progress for TV)
 *  - already in history, TV: progress moves forward only, unless `manual` (the user asked for it)
 *  - already in history, movie: nothing to do
 * The last episode of a season is stored as just the season (the season is finished), using TMDB's
 * episode counts. `undo` describes how to reverse what was written (null when nothing was written).
 * @returns {Promise<{ added: boolean, progressUpdated: boolean, progress: object|null, undo: object|null }>}
 */
export async function recordWatch(ref, { manual = false } = {}) {
  const session = await getSession();
  if (!session) throw new NotSignedInError();

  const hasProgress = ref.mediaType === 'tv' && ref.season != null;
  const existing = await fetchEntry(ref);

  const details = hasProgress ? await getDetails(ref).catch(() => null) : null;
  const counts = details?.episodeCounts;
  const progress = hasProgress ? normalizeProgress(ref, counts, details?.finishedSeasons) : null; // what will be stored

  if (!existing.watched) {
    const meta = details ?? (await getDetails(ref)); // a new row needs the title, so this one may throw
    await rest('watch_history?on_conflict=user_id,media_id,media_type', {
      method: 'POST',
      prefer: 'resolution=ignore-duplicates,return=minimal',
      body: {
        user_id: session.user.id,
        media_id: ref.tmdbId,
        media_type: ref.mediaType,
        title: meta.title,
        poster_path: meta.posterPath,
        release_year: meta.releaseYear,
        ...(progress ? { last_season: progress.season, last_episode: progress.episode } : {}),
      },
    });
    return { added: true, progressUpdated: hasProgress, progress, undo: { type: 'delete', written: progress } };
  }

  if (progress && (manual || isAhead(progress, existing.progress, counts)) && !progressMatches(existing.progress, progress)) {
    await rest(`watch_history?${filter(ref)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      // Bump watched_at so the show moves to the top of "recently watched".
      body: { last_season: progress.season, last_episode: progress.episode, watched_at: new Date().toISOString() },
    });
    return {
      added: false,
      progressUpdated: true,
      progress,
      undo: { type: 'restore', progress: existing.progress, watchedAt: existing.watchedAt, written: progress },
    };
  }
  return { added: false, progressUpdated: false, progress: null, undo: null };
}

/** Reverses a mark: removes a title that was added, or restores the previous progress. */
export async function undoWatch(ref, undo) {
  const current = await fetchEntry(ref);
  if (!current.watched) throw new Error('This title is no longer in your history.');
  if (!undoApplies(ref, current, undo)) throw new Error('Your progress has changed since, so this can’t be undone.');

  if (undo.type === 'delete') {
    await rest(`watch_history?${filter(ref)}`, { method: 'DELETE', prefer: 'return=minimal' });
    return;
  }
  await rest(`watch_history?${filter(ref)}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: {
      last_season: undo.progress?.season ?? null,
      last_episode: undo.progress?.episode ?? null,
      watched_at: undo.watchedAt,
    },
  });
}
