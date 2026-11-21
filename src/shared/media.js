/**
 * @typedef {Object} MediaRef What a site module returns for the page that is open.
 * @property {number} tmdbId
 * @property {'movie'|'tv'} mediaType
 * @property {number|null} [season]  TV only
 * @property {number|null} [episode] TV only
 */

/** A title counts as watched once this fraction of it has played. */
export const WATCHED_THRESHOLD = 0.8;
/** Videos shorter than this (seconds) are ignored: ads, previews, intros. */
export const MIN_DURATION = 120;

const positiveInt = (v) => {
  const n = Number(v);
  return v != null && v !== '' && Number.isInteger(n) && n >= 1 ? n : null;
};

/** Validates whatever a site module returned. Returns a clean MediaRef or null. */
export function normalizeRef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tmdbId = positiveInt(raw.tmdbId);
  if (tmdbId === null || (raw.mediaType !== 'movie' && raw.mediaType !== 'tv')) return null;
  if (raw.mediaType === 'movie') return { mediaType: 'movie', tmdbId };
  const season = positiveInt(raw.season);
  return { mediaType: 'tv', tmdbId, season, episode: season === null ? null : positiveInt(raw.episode) };
}

/** Identifies one thing you can watch: a movie, or one episode of a show. */
export function mediaKey(ref) {
  return ref.mediaType === 'tv' ? `tv:${ref.tmdbId}:${ref.season ?? '?'}:${ref.episode ?? '?'}` : `movie:${ref.tmdbId}`;
}

/** "S3E3", or "S3" without an episode. Null for movies and TV pages with no season. */
export function progressLabel(ref) {
  if (ref.mediaType !== 'tv' || ref.season == null) return null;
  return `S${ref.season}${ref.episode != null ? `E${ref.episode}` : ''}`;
}

/** True when `next` is later in the show than `current` (or there is no current progress). */
export function isAhead(next, current) {
  if (next.season == null) return false;
  if (!current || current.season == null) return true;
  if (next.season !== current.season) return next.season > current.season;
  return (next.episode ?? 0) > (current.episode ?? 0);
}

/**
 * Is `candidate` the episode right after `progress`?  Same season and the next episode number, or
 * episode 1 of the next season once the current season is finished. `episodeCounts` (season -> number
 * of episodes, from TMDB) tells us when a season is finished; without it we accept S+1 E1.
 */
export function isNextEpisode(candidate, progress, episodeCounts) {
  if (!progress || progress.season == null || progress.episode == null) return false;
  if (candidate.season == null || candidate.episode == null) return false;

  if (candidate.season === progress.season) return candidate.episode === progress.episode + 1;
  if (candidate.season === progress.season + 1 && candidate.episode === 1) {
    const count = episodeCounts?.[progress.season];
    return count == null || progress.episode >= count;
  }
  return false;
}

/** Should opening `ref` put it in Continue? Only the episode right after recorded progress qualifies. */
export function qualifiesForContinue(ref, entry, episodeCounts) {
  return ref.mediaType === 'tv' && !!entry?.watched && isNextEpisode(ref, entry.progress, episodeCounts);
}
