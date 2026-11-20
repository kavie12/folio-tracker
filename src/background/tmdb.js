import { TMDB_PROXY_URL } from '../shared/config.js';

/** Title, poster and year for a movie or show, via the Folio Worker. Cached in extension storage. */
export async function getDetails(ref) {
  const key = `meta:${ref.mediaType}:${ref.tmdbId}`;
  const cached = (await browser.storage.local.get(key))[key];
  if (cached) return cached;

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
  };
  await browser.storage.local.set({ [key]: meta });
  return meta;
}
