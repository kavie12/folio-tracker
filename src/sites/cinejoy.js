/**
 * Cinejoy
 *   https://cinejoy.pk/watch/tv/1622/8/3   (TMDB id, season, episode, all in the URL)
 *   https://cinejoy.pk/watch/movie/<id>
 */
export const meta = {
  id: 'cinejoy',
  name: 'Cinejoy',
  domains: ['cinejoy.pk'],
  frameDomains: [],
};

/** @param {{ url: URL, title: string, document: Document }} page @returns {import('../shared/media.js').MediaRef | null} */
export function extract({ url }) {
  const m = url.pathname.match(/^\/watch\/(tv|movie)\/(\d+)(?:\/(\d+)\/(\d+))?/);
  if (!m) return null;

  const mediaType = m[1];
  const tmdbId = Number(m[2]);
  if (mediaType === 'movie' || m[3] === undefined) return { mediaType, tmdbId };
  return { mediaType, tmdbId, season: Number(m[3]), episode: Number(m[4]) };
}
