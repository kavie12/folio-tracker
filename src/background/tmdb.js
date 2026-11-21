import { TMDB_PROXY_URL } from '../shared/config.js';

/** Title, poster and year for a movie or show, via the Folio Worker. Cached in extension storage. */
export async function getDetails(ref) {
  const key = `meta:${ref.mediaType}:${ref.tmdbId}`;
  const cached = (await browser.storage.local.get(key))[key];
  // Entries cached before episode counts existed are refetched once for TV.
  if (cached && (ref.mediaType === 'movie' || cached.episodeCounts)) return cached;

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
  const meta = {
    title: d.title || d.name || 'Untitled',
    posterPath: d.poster_path ?? null,
    releaseYear: Number.isNaN(year) ? null : year,
    // season number -> episodes in it (specials, season 0, left out); lets us tell when a season has ended
    ...(ref.mediaType === 'tv' && {
      episodeCounts: Object.fromEntries(
        (d.seasons ?? []).filter((x) => x.season_number >= 1 && x.episode_count > 0).map((x) => [x.season_number, x.episode_count]),
      ),
    }),
  };
  await browser.storage.local.set({ [key]: meta });
  return meta;
}
