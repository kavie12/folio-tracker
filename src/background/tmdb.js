import { TMDB_PROXY_URL } from '../shared/config.js';

// Episode counts and the last aired episode change while a show is airing, and we rely on them to tell
// when a season is finished and whether a next episode exists, so TV details are refreshed now and then
// (more often while the show is still airing). Movies never change.
const TV_REFRESH_MS = 3 * 24 * 60 * 60 * 1000;
const AIRING_REFRESH_MS = 12 * 60 * 60 * 1000;
const STILL_AIRING = new Set(['Returning Series', 'In Production', 'Planned', 'Pilot']);
const OVER = new Set(['Ended', 'Canceled']);

/**
 * Seasons that are definitely over: every season before the latest one, or all of them once the show has
 * ended. The latest season of a show that is still airing never counts, because TMDB may list only the
 * episodes aired so far, which would make the newest episode look like the season's last.
 */
function finishedSeasons(d, counted) {
  const latest = Math.max(0, ...counted.map((x) => x.season_number));
  const stillToAir = d.next_episode_to_air?.season_number ?? null; // an episode is scheduled in it
  return counted.map((x) => x.season_number).filter((n) => n !== stillToAir && (OVER.has(d.status) || n < latest));
}

const isFresh = (meta) => Date.now() - (meta.fetchedAt ?? 0) < (STILL_AIRING.has(meta.status) ? AIRING_REFRESH_MS : TV_REFRESH_MS);

/** Title, poster, year (and for TV, episodes per season) via the Folio Worker. Cached in extension storage. */
export async function getDetails(ref) {
  const key = `meta:${ref.mediaType}:${ref.tmdbId}`;
  const cached = (await browser.storage.local.get(key))[key];

  const usable =
    cached && (ref.mediaType === 'movie' || (cached.episodeCounts && cached.finishedSeasons && isFresh(cached)));
  if (usable) return cached;

  try {
    let res;
    try {
      res = await fetch(`${TMDB_PROXY_URL}/details/${ref.mediaType}/${ref.tmdbId}`);
    } catch {
      throw new Error('Couldn’t reach Folio’s title service.');
    }
    if (!res.ok) throw new Error(res.status === 404 ? 'TMDB doesn’t know this title.' : 'Couldn’t look up this title.');

    const d = await res.json();
    const date = d.release_date || d.first_air_date;
    const year = date ? parseInt(date.slice(0, 4), 10) : NaN;
    const counted = (d.seasons ?? []).filter((x) => x.season_number >= 1 && x.episode_count > 0); // specials (season 0) left out
    const meta = {
      title: d.title || d.name || 'Untitled',
      posterPath: d.poster_path ?? null,
      releaseYear: Number.isNaN(year) ? null : year,
      fetchedAt: Date.now(),
      // season number -> episodes in it, which seasons are over, and the latest episode that has aired
      ...(ref.mediaType === 'tv' && {
        status: d.status ?? null,
        lastAired: d.last_episode_to_air
          ? { season: d.last_episode_to_air.season_number, episode: d.last_episode_to_air.episode_number }
          : null,
        episodeCounts: Object.fromEntries(counted.map((x) => [x.season_number, x.episode_count])),
        finishedSeasons: finishedSeasons(d, counted),
      }),
    };
    await browser.storage.local.set({ [key]: meta });
    return meta;
  } catch (err) {
    if (cached) return cached; // a stale copy beats failing when the title service is unreachable
    throw err;
  }
}
