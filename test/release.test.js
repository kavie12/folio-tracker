import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/release.sh');
const KEY = 'user:12345:67';
const SECRET = 'S3CR3T-never-print-me';

// ── stand-ins for npm, npx and secret-tool ──────────────────
const NPM = `#!/usr/bin/env bash
echo "npm $*" >> "$LOG"
[ -z "\${WEB_EXT_API_KEY:-}\${WEB_EXT_API_SECRET:-}" ] || echo "LEAK: npm saw the credentials" >> "$LOG"
case "$1" in
  test) [ "\${FAIL_TEST:-}" = 1 ] && exit 1; exit 0 ;;
  version) node -e "
    const fs = require('fs'); const p = JSON.parse(fs.readFileSync('package.json'));
    const [a, b, c] = p.version.split('.').map(Number); const bump = process.argv[1];
    p.version = bump === 'major' ? (a + 1) + '.0.0' : bump === 'minor' ? a + '.' + (b + 1) + '.0' : /^\\\\d/.test(bump) ? bump : a + '.' + b + '.' + (c + 1);
    fs.writeFileSync('package.json', JSON.stringify(p, null, 2));" "$2"
    exit 0 ;;
  run) [ "$2" = lint ] && [ "\${FAIL_LINT:-}" = 1 ] && exit 1; exit 0 ;;
esac
`;
const NPX = `#!/usr/bin/env bash
echo "npx $*" >> "$LOG"
echo "key=\${WEB_EXT_API_KEY:-} secret=\${WEB_EXT_API_SECRET:-}" >> "$ENVLOG"
[ "\${FAIL_SIGN:-}" = 1 ] && exit 1
sleep 0.05; mkdir -p artifacts; echo xpi > artifacts/folio_tracker-signed.xpi
`;
const SECRET_TOOL = `#!/usr/bin/env bash
cmd=$1; shift; account=""
while [ $# -gt 0 ]; do case "$1" in account) account=$2; shift ;; esac; shift; done
f="$KEYRING_DIR/$account"
case $cmd in
  store) cat > "$f" ;;
  lookup) [ -f "$f" ] && cat "$f" || exit 1 ;;
  clear) rm -f "$f" ;;
esac
`;

// only the real tools the script needs, so a secret-tool installed on THIS machine can never be picked up
const REAL = ['bash', 'env', 'node', 'git', 'find', 'grep', 'sed', 'mktemp', 'cp', 'rm', 'cat', 'head', 'dirname', 'sha256sum', 'realpath', 'sleep', 'mkdir', 'touch', 'printf', 'tr', 'stat', 'uname', 'id', 'date'];
const which = (tool) => { try { return execFileSync('which', [tool], { encoding: 'utf8' }).trim(); } catch { return null; } };

function sandbox({ git = false, keyringTool = true, envFile = 'EXTENSION_ID=folio-tracker@me.dev\n', version = '1.0.0' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'folio-release-'));
  const bin = path.join(dir, 'bin');
  const project = path.join(dir, 'project');
  const keyring = path.join(dir, 'keyring');
  for (const d of [bin, project, keyring, path.join(project, 'scripts'), path.join(project, 'node_modules/web-ext'), path.join(dir, 'home')]) mkdirSync(d, { recursive: true });

  for (const tool of REAL) { const real = which(tool); if (real) symlinkSync(real, path.join(bin, tool)); }
  const stub = (name, body) => { writeFileSync(path.join(bin, name), body); chmodSync(path.join(bin, name), 0o755); };
  stub('npm', NPM); stub('npx', NPX);
  if (keyringTool) stub('secret-tool', SECRET_TOOL);

  copyFileSync(SCRIPT, path.join(project, 'scripts/release.sh'));
  writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'x', version }, null, 2));
  if (envFile !== null) writeFileSync(path.join(project, '.env'), envFile);
  writeFileSync(path.join(project, '.gitignore'), '.env\nnode_modules\nartifacts\n');

  const logs = { log: path.join(dir, 'log'), envlog: path.join(dir, 'envlog') };
  writeFileSync(logs.log, ''); writeFileSync(logs.envlog, '');
  const baseEnv = {
    PATH: bin, HOME: path.join(dir, 'home'), LOG: logs.log, ENVLOG: logs.envlog, KEYRING_DIR: keyring,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  };
  const sh = (cmd, args) => spawnSync(cmd, args, { cwd: project, env: baseEnv, encoding: 'utf8' });
  if (git) { sh('git', ['init', '-q', '-b', 'main']); sh('git', ['add', '-A']); sh('git', ['commit', '-q', '-m', 'init']); }

  return {
    dir, project, keyring,
    run: (args = [], { input = '', env = {} } = {}) =>
      spawnSync('bash', ['scripts/release.sh', ...args], { cwd: project, env: { ...baseEnv, ...env }, input, encoding: 'utf8' }),
    log: () => readFileSync(logs.log, 'utf8'),
    envlog: () => readFileSync(logs.envlog, 'utf8'),
    version: () => JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8')).version,
    git: (...args) => sh('git', args).stdout.trim(),
  };
}

const storeCredentials = (sb) => { writeFileSync(path.join(sb.keyring, 'key'), KEY); writeFileSync(path.join(sb.keyring, 'secret'), SECRET); };
const combined = (r) => `${r.stdout}\n${r.stderr}`;

/** Every file under `dir` (except the stand-in keyring) that contains `needle`. */
function filesContaining(dir, needle, skip) {
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (skip.some((s) => p.startsWith(s)) || statSync(p).isSymbolicLink?.()) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (readFileSync(p, 'utf8').includes(needle)) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}

// ── tests ───────────────────────────────────────────────────
test('setup stores the key and secret in the keyring, and nowhere else', () => {
  const sb = sandbox();
  const r = sb.run(['setup'], { input: `${KEY}\n${SECRET}\n` });
  assert.equal(r.status, 0, combined(r));
  assert.equal(readFileSync(path.join(sb.keyring, 'key'), 'utf8'), KEY);
  assert.equal(readFileSync(path.join(sb.keyring, 'secret'), 'utf8'), SECRET);
  assert.deepEqual(filesContaining(sb.dir, SECRET, [sb.keyring, path.join(sb.dir, 'bin')]), []); // not in the project, HOME or logs
  assert.ok(!combined(r).includes(SECRET));
});

test('setup refuses empty values', () => {
  const sb = sandbox();
  assert.notEqual(sb.run(['setup'], { input: `${KEY}\n\n` }).status, 0);
  assert.equal(existsSync(path.join(sb.keyring, 'secret')), false);
});

test('without a keyring tool, setup says how to get one instead of writing secrets to a file', () => {
  const sb = sandbox({ keyringTool: false });
  const r = sb.run(['setup'], { input: `${KEY}\n${SECRET}\n` });
  assert.notEqual(r.status, 0);
  assert.match(combined(r), /libsecret/);
  assert.deepEqual(filesContaining(sb.dir, SECRET, [path.join(sb.dir, 'bin')]), []);
});

test('status reports where credentials are, without printing them', () => {
  const sb = sandbox();
  assert.match(sb.run(['status']).stdout, /nothing stored/);
  storeCredentials(sb);
  const r = sb.run(['status']);
  assert.match(r.stdout, /credentials stored/);
  assert.ok(!combined(r).includes(SECRET) && !combined(r).includes(KEY));
});

test('forget removes the stored credentials', () => {
  const sb = sandbox();
  storeCredentials(sb);
  assert.equal(sb.run(['forget']).status, 0);
  assert.equal(existsSync(path.join(sb.keyring, 'key')), false);
  assert.equal(existsSync(path.join(sb.keyring, 'secret')), false);
});

test('release: test, bump, build, lint, then sign with exactly the intended command', () => {
  const sb = sandbox();
  storeCredentials(sb);
  const r = sb.run([]);
  assert.equal(r.status, 0, combined(r));

  const log = sb.log().trim().split('\n');
  assert.deepEqual(log, [
    'npm test --silent',
    'npm version patch --no-git-tag-version',
    'npm run build --silent',
    'npm run lint --silent',
    'npx --no-install web-ext sign --source-dir dist --artifacts-dir artifacts --channel unlisted --no-input',
  ]);
  assert.equal(sb.version(), '1.0.1');
  assert.match(r.stdout, /Signed: artifacts\/folio_tracker-signed\.xpi/);
});

test('the credentials reach only the signing process, never an argument or another command', () => {
  const sb = sandbox();
  storeCredentials(sb);
  const r = sb.run([]);
  assert.equal(r.status, 0, combined(r));

  assert.equal(sb.envlog().trim(), `key=${KEY} secret=${SECRET}`); // the signer got them (as environment variables)
  assert.ok(!sb.log().includes(SECRET) && !sb.log().includes(KEY), 'not in any command line');
  assert.ok(!sb.log().includes('LEAK'), 'npm (tests, build, lint) never saw them');
  assert.ok(!combined(r).includes(SECRET), 'not printed');
});

test('credentials from the environment (CI) work, and still are not passed to npm', () => {
  const sb = sandbox({ keyringTool: false });
  const r = sb.run([], { env: { WEB_EXT_API_KEY: KEY, WEB_EXT_API_SECRET: SECRET } });
  assert.equal(r.status, 0, combined(r));
  assert.equal(sb.envlog().trim(), `key=${KEY} secret=${SECRET}`);
  assert.ok(!sb.log().includes('LEAK'));
});

test('no credentials and no terminal: stops before changing anything', () => {
  const sb = sandbox();
  const r = sb.run([]);
  assert.notEqual(r.status, 0);
  assert.match(combined(r), /release\.sh setup/);
  assert.equal(sb.version(), '1.0.0');
  assert.equal(sb.log(), ''); // not even the tests ran
});

test('a minor bump and an explicit version are supported; nonsense is refused', () => {
  const sb = sandbox();
  storeCredentials(sb);
  assert.equal(sb.run(['minor']).status, 0);
  assert.equal(sb.version(), '1.1.0');
  assert.equal(sb.run(['3.0.0']).status, 0);
  assert.equal(sb.version(), '3.0.0');
  const bad = sb.run(['banana']);
  assert.notEqual(bad.status, 0);
  assert.match(combined(bad), /patch, minor, major or X\.Y\.Z/);
});

test('dry run checks everything but signs nothing and leaves the version alone', () => {
  const sb = sandbox();
  const r = sb.run(['--dry-run']); // needs no credentials
  assert.equal(r.status, 0, combined(r));
  assert.equal(sb.version(), '1.0.0');
  assert.ok(!sb.log().includes('web-ext'));
});

test('a failing test or lint stops the release, and a bumped version is put back', () => {
  let sb = sandbox();
  storeCredentials(sb);
  assert.notEqual(sb.run([], { env: { FAIL_TEST: '1' } }).status, 0);
  assert.equal(sb.version(), '1.0.0');
  assert.ok(!sb.log().includes('web-ext'));

  sb = sandbox();
  storeCredentials(sb);
  const r = sb.run([], { env: { FAIL_LINT: '1' } });
  assert.notEqual(r.status, 0);
  assert.equal(sb.version(), '1.0.0'); // bumped, then undone
  assert.match(combined(r), /version bump was undone/);
});

test('if signing fails the version stays bumped, because Mozilla may already have it', () => {
  const sb = sandbox();
  storeCredentials(sb);
  const r = sb.run([], { env: { FAIL_SIGN: '1' } });
  assert.notEqual(r.status, 0);
  assert.equal(sb.version(), '1.0.1');
  assert.match(combined(r), /run the release again/);
});

test('refuses a missing or placeholder add-on id, and a missing .env', () => {
  let sb = sandbox({ envFile: 'SUPABASE_URL=x\n' });
  storeCredentials(sb);
  assert.match(combined(sb.run([])), /Set EXTENSION_ID/);

  sb = sandbox({ envFile: 'EXTENSION_ID=folio-tracker@example.com\n' });
  storeCredentials(sb);
  assert.match(combined(sb.run([])), /placeholder/);

  sb = sandbox({ envFile: null });
  storeCredentials(sb);
  assert.match(combined(sb.run([])), /\.env not found/);
});

test('in a git repository it commits the version bump and tags it, and does not push by default', () => {
  const sb = sandbox({ git: true });
  storeCredentials(sb);
  const r = sb.run(['minor']);
  assert.equal(r.status, 0, combined(r));
  assert.equal(sb.git('log', '-1', '--pretty=%s'), 'chore: release v1.1.0');
  assert.equal(sb.git('tag', '--list'), 'v1.1.0');
  assert.match(r.stdout, /Not pushed/);
});

test('uncommitted changes, or a .env that git would track, stop the release', () => {
  let sb = sandbox({ git: true });
  storeCredentials(sb);
  writeFileSync(path.join(sb.project, 'notes.txt'), 'x');
  sb.git('add', 'notes.txt');
  assert.match(combined(sb.run([])), /uncommitted changes/);

  sb = sandbox({ git: true });
  storeCredentials(sb);
  writeFileSync(path.join(sb.project, '.gitignore'), 'node_modules\n'); // .env no longer ignored
  sb.git('add', '-A'); sb.git('commit', '-q', '-m', 'oops');
  assert.match(combined(sb.run([])), /not ignored by git/);
});
