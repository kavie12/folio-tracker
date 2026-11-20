/**
 * Cinecat
 *   https://cinecat.eu/media/tmdb-tv-1622-supernatural/6911/162698   (TMDB id in the URL)
 *   Page title: "Supernatural - S8 - E4"                             (season and episode in the title)
 */
export const meta = {
  id: 'cinecat',
  name: 'Cinecat',
  domains: ['cinecat.eu'],
  // Domains of embedded players, if the video lives in a cross-origin iframe (see README).
  frameDomains: [],
};

/** @param {{ url: URL, title: string, document: Document }} page @returns {import('../shared/media.js').MediaRef | null} */
export function extract({ url, title }) {
  const m = url.pathname.match(/\/media\/tmdb-(tv|movie)-(\d+)/);
  if (!m) return null;

  const mediaType = m[1];
  const tmdbId = Number(m[2]);
  if (mediaType === 'movie') return { mediaType, tmdbId };

  const se = title.match(/\bS(\d{1,3})\s*[-–—]?\s*E(\d{1,4})\b/i);
  return se ? { mediaType, tmdbId, season: Number(se[1]), episode: Number(se[2]) } : { mediaType, tmdbId };
}
