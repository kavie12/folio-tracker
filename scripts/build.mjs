/**
 * Builds dist/ : one content-script bundle per site module, the background page, the popup,
 * and a manifest.json generated from the site modules' `meta`.
 */
import { build } from 'esbuild';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (...p) => path.join(root, 'src', ...p);
const dist = (...p) => path.join(root, 'dist', ...p);

// ── environment ─────────────────────────────────────────────
async function loadEnv() {
  const env = { ...process.env };
  const file = path.join(root, '.env');
  if (existsSync(file)) {
    for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#') && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

const env = await loadEnv();
const missing = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'TMDB_PROXY_URL', 'FOLIO_APP_URL'].filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
  process.exit(1);
}
const trim = (u) => u.replace(/\/+$/, '');
const config = {
  SUPABASE_URL: trim(env.SUPABASE_URL),
  SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
  TMDB_PROXY_URL: trim(env.TMDB_PROXY_URL),
  FOLIO_APP_URL: trim(env.FOLIO_APP_URL),
};
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

// ── discover site modules ───────────────────────────────────
const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const files = (await readdir(src('sites'))).filter((f) => f.endsWith('.js') && !f.startsWith('_')).sort();
const sites = [];

for (const file of files) {
  const id = path.basename(file, '.js');
  const mod = await import(pathToFileURL(src('sites', file)).href);
  const { meta } = mod;
  const fail = (msg) => { console.error(`sites/${file}: ${msg}`); process.exit(1); };

  if (!meta || typeof mod.extract !== 'function') fail('must export `meta` and `extract`.');
  if (meta.id !== id || !/^[a-z0-9-]+$/.test(meta.id)) fail(`meta.id must equal the file name ("${id}").`);
  if (!meta.name) fail('meta.name is required.');
  const domains = meta.domains ?? [];
  const frameDomains = meta.frameDomains ?? [];
  if (!domains.length) fail('meta.domains needs at least one hostname.');
  for (const d of [...domains, ...frameDomains]) if (!HOST.test(d)) fail(`"${d}" is not a bare hostname (no scheme, path or wildcard).`);

  sites.push({ id, name: meta.name, domains, frameDomains });
}
if (!sites.length) { console.error('No site modules found in src/sites.'); process.exit(1); }

// ── bundle ──────────────────────────────────────────────────
await rm(dist(), { recursive: true, force: true });
await mkdir(dist('content'), { recursive: true });

const common = {
  bundle: true,
  format: 'iife',
  target: 'firefox128',
  logLevel: 'warning',
  define: {
    __SUPABASE_URL__: JSON.stringify(config.SUPABASE_URL),
    __SUPABASE_ANON_KEY__: JSON.stringify(config.SUPABASE_ANON_KEY),
    __TMDB_PROXY_URL__: JSON.stringify(config.TMDB_PROXY_URL),
    __FOLIO_APP_URL__: JSON.stringify(config.FOLIO_APP_URL),
    __VERSION__: JSON.stringify(pkg.version),
  },
};

await build({ ...common, entryPoints: [src('background/index.js')], outfile: dist('background.js') });
await build({ ...common, entryPoints: [src('popup/popup.js')], outfile: dist('popup.js') });

// One content bundle per site: the tracker core plus that site's module, nothing else.
for (const s of sites) {
  await build({
    ...common,
    stdin: {
      contents: `import * as site from './sites/${s.id}.js';\nimport { runTracker } from './content/tracker.js';\nrunTracker(site);\n`,
      resolveDir: src(),
      sourcefile: `content-${s.id}.js`,
    },
    outfile: dist('content', `${s.id}.js`),
  });
}

// ── static files ────────────────────────────────────────────
await cp(src('popup', 'popup.html'), dist('popup.html'));
await cp(src('popup', 'popup.css'), dist('popup.css'));
await cp(src('icons'), dist('icons'), { recursive: true });

await mkdir(dist('fonts'), { recursive: true });
const fonts = [
  ['@fontsource/instrument-sans', 'instrument-sans-latin-400-normal.woff2'],
  ['@fontsource/instrument-sans', 'instrument-sans-latin-500-normal.woff2'],
  ['@fontsource/instrument-sans', 'instrument-sans-latin-600-normal.woff2'],
  ['@fontsource/bricolage-grotesque', 'bricolage-grotesque-latin-700-normal.woff2'],
];
for (const [pkgName, file] of fonts) {
  const from = path.join(root, 'node_modules', pkgName, 'files', file);
  if (existsSync(from)) await cp(from, dist('fonts', file));
  else console.warn(`Font ${file} not found (run npm install); the popup will use system fonts.`);
}

// ── manifest and site list ──────────────────────────────────
const patterns = (hosts) => hosts.flatMap((h) => [`*://${h}/*`, `*://*.${h}/*`]);
const manifest = JSON.parse(await readFile(src('manifest.base.json'), 'utf8'));
manifest.version = pkg.version;
if (env.EXTENSION_ID) manifest.browser_specific_settings.gecko.id = env.EXTENSION_ID;

manifest.content_scripts = sites.map((s) => ({
  matches: patterns([...s.domains, ...s.frameDomains]),
  js: [`content/${s.id}.js`],
  all_frames: true,
  run_at: 'document_idle',
}));
manifest.host_permissions = [
  ...new Set([...sites.flatMap((s) => patterns([...s.domains, ...s.frameDomains])), `${config.SUPABASE_URL}/*`, `${config.TMDB_PROXY_URL}/*`]),
];

await writeFile(dist('manifest.json'), JSON.stringify(manifest, null, 2));
await writeFile(dist('sites.json'), JSON.stringify(sites, null, 2));

console.log(`Built Folio Tracker ${pkg.version}: ${sites.map((s) => s.name).join(', ')} -> dist/`);
