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

/**
 * Where a progress stands inside its season. A progress with a season but no episode means that
 * season is FINISHED (it is what we store after a season's last episode), so it sits at the season's end.
 */
const endOf = (progress, episodeCounts) => progress.episode ?? episodeCounts?.[progress.season] ?? Infinity;

/** True when `next` is later in the show than `current` (or there is no current progress). */
export function isAhead(next, current, episodeCounts) {
  if (next.season == null) return false;
  if (!current || current.season == null) return true;
  if (next.season !== current.season) return next.season > current.season;
  return endOf(next, episodeCounts) > endOf(current, episodeCounts);
}

/** Does the recorded progress stand at exactly this season and episode? */
export const progressMatches = (progress, target) =>
  progress?.season === target.season && (progress?.episode ?? null) === (target.episode ?? null);

/**
 * Is `ref` the last episode of a season that is over, according to TMDB? Both must hold: the episode reaches the
 * season's episode count, and the season is in `finishedSeasons`. The second part matters for a show that is
 * still airing, where the newest episode can equal TMDB's count without being the season's end.
 */
export function isLastEpisode(ref, episodeCounts, finishedSeasons) {
  const count = episodeCounts?.[ref.season];
  return (
    ref.mediaType === 'tv' && ref.season != null && ref.episode != null && count != null &&
    ref.episode >= count && !!finishedSeasons?.includes(ref.season)
  );
}

/**
 * The progress to store for `ref`. Finishing a season's last episode stores just the season, because the
 * season is done and the next thing to watch is episode 1 of the next one. If TMDB's data is not
 * available, or the season may still be airing, the episode is kept as it is.
 */
export function normalizeProgress(ref, episodeCounts, finishedSeasons) {
  return { season: ref.season, episode: isLastEpisode(ref, episodeCounts, finishedSeasons) ? null : (ref.episode ?? null) };
}

/**
 * Is `candidate` the episode right after `progress`?
 *  - progress S8E4:  S8E5 is next. S9E1 is next only once season 8 is finished (TMDB's episode count).
 *  - progress S8 (season finished, no episode): S9E1 is next.
 * Without TMDB's counts, S+1 E1 is accepted after any episode.
 */
export function isNextEpisode(candidate, progress, episodeCounts) {
  if (!progress || progress.season == null) return false;
  if (candidate.season == null || candidate.episode == null) return false;

  const count = episodeCounts?.[progress.season];
  const startsNextSeason = candidate.season === progress.season + 1 && candidate.episode === 1;

  if (progress.episode == null) {
    // The season is finished. Normally next is S+1 E1; an episode beyond TMDB's count means the count was outdated.
    return startsNextSeason || (count != null && candidate.season === progress.season && candidate.episode === count + 1);
  }
  if (candidate.season === progress.season) return candidate.episode === progress.episode + 1;
  return startsNextSeason && (count == null || progress.episode >= count);
}

/** Should opening `ref` put it in Continue? Only the episode right after recorded progress qualifies. */
export function qualifiesForContinue(ref, entry, episodeCounts) {
  return ref.mediaType === 'tv' && !!entry?.watched && isNextEpisode(ref, entry.progress, episodeCounts);
}

/**
 * The episode after `progress`, if TMDB says one exists and it has aired. Returns { season, episode } or null.
 *  - S8E4 -> S8E5 when season 8 has more than 4 episodes
 *  - the last episode of a season, or a finished season (S8, no episode) -> S9E1 when season 9 exists
 *  - null when the show has ended, TMDB has no counts, or the next episode has not aired yet
 * @param {{season:number, episode:number|null}} progress
 * @param {Object<number, number>} episodeCounts season -> number of episodes
 * @param {{season:number, episode:number}|null} [lastAired] the latest aired episode
 */
export function nextEpisodeAfter(progress, episodeCounts, lastAired) {
  if (!progress || progress.season == null || !episodeCounts) return null;

  const count = episodeCounts[progress.season];
  let next = null;
  if (progress.episode != null && count != null && progress.episode < count) {
    next = { season: progress.season, episode: progress.episode + 1 };
  } else if ((progress.episode == null || (count != null && progress.episode >= count)) && episodeCounts[progress.season + 1] != null) {
    next = { season: progress.season + 1, episode: 1 };
  }
  if (!next) return null;

  if (lastAired && (next.season > lastAired.season || (next.season === lastAired.season && next.episode > lastAired.episode))) {
    return null; // listed on TMDB but not aired yet: there is nothing to watch, and no link that works
  }
  return next;
}
