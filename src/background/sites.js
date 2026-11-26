/**
 * Some sites put the TMDB id, season and episode straight in the address, so the link to any episode can be
 * built without visiting it. A site module declares this with `meta.episodeUrl`, for example
 * "https://cinejoy.pk/watch/tv/{tmdbId}/{season}/{episode}". The build writes it to sites.json.
 */
let sites;
const loadSites = () =>
  (sites ??= fetch(browser.runtime.getURL('sites.json'))
    .then((res) => res.json())
    .catch(() => {
      sites = undefined; // try again next time
      return [];
    }));

/** The link to an episode on a site, or null when that site cannot build one. */
export async function buildEpisodeUrl(siteId, ref) {
  const site = (await loadSites()).find((s) => s.id === siteId);
  if (!site?.episodeUrl || ref.season == null || ref.episode == null) return null;

  const raw = site.episodeUrl
    .replaceAll('{tmdbId}', String(ref.tmdbId))
    .replaceAll('{season}', String(ref.season))
    .replaceAll('{episode}', String(ref.episode));
  try {
    const url = new URL(raw);
    const onSite = site.domains.some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`));
    return url.protocol === 'https:' && onSite ? url.href : null;
  } catch {
    return null;
  }
}
