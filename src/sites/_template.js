/**
 * Template for a new site. Copy to src/sites/<id>.js (files starting with "_" are ignored by the build).
 * See "Adding a site" in the README.
 */
export const meta = {
  id: 'example', // must equal the file name: lowercase letters, digits and dashes
  name: 'Example', // shown in the extension's Sites list
  domains: ['example.com'], // bare hostnames; subdomains are included automatically
  frameDomains: [], // optional: hosts of embedded video players (cross-origin iframes)
};

/**
 * Runs on every page of the site, about once a second, and again when the URL or title changes.
 * Return null when the page is not a watch page.
 *
 * @param {{ url: URL, title: string, document: Document }} page
 * @returns {import('../shared/media.js').MediaRef | null}
 *   { mediaType: 'movie', tmdbId }  or  { mediaType: 'tv', tmdbId, season?, episode? }
 */
export function extract({ url, title, document }) {
  return null;
}
