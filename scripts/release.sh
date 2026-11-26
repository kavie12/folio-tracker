#!/usr/bin/env bash
#
# Release a new version of Folio Tracker: test, bump the version, build, lint, sign with Mozilla
# (unlisted), then commit and tag. Credentials come from the system keyring, never from the repo.
#
#   scripts/release.sh setup            store your addons.mozilla.org API key and secret in the keyring
#   scripts/release.sh [patch|minor|major|X.Y.Z] [--dry-run] [--no-git] [--push] [--install]
#   scripts/release.sh status           show where credentials would come from (never prints them)
#   scripts/release.sh forget           delete the stored credentials
#
set -euo pipefail
umask 077
cd "$(dirname "${BASH_SOURCE[0]}")/.."

KEYRING_SERVICE="folio-tracker-amo"
STAGE="start"
BUMPED=0
BACKUP_DIR=""
MARK_FILE=""
BUMP="patch"
DRY_RUN=0 NO_GIT=0 PUSH=0 INSTALL=0
API_KEY="" API_SECRET=""
NEW_VERSION=""

# Take any credentials out of the environment straight away. Everything this script runs
# (npm test, the build, esbuild, the linter) must not inherit them; only the signing command gets them.
ENV_KEY="${WEB_EXT_API_KEY:-}"
ENV_SECRET="${WEB_EXT_API_SECRET:-}"
unset WEB_EXT_API_KEY WEB_EXT_API_SECRET

# ── helpers ─────────────────────────────────────────────────
info() { printf '==> %s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() { sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# ── keyring (libsecret: KWallet and GNOME Keyring both provide it) ──
keyring_get() { secret-tool lookup service "$KEYRING_SERVICE" account "$1" 2>/dev/null || true; }
keyring_set() { secret-tool store --label="Folio Tracker (addons.mozilla.org $1)" service "$KEYRING_SERVICE" account "$1"; } # value on stdin
keyring_clear() { secret-tool clear service "$KEYRING_SERVICE" account "$1" 2>/dev/null || true; }

need_keyring() {
  have secret-tool || die "secret-tool not found. Install libsecret (Arch/CachyOS: sudo pacman -S libsecret) and make sure KWallet or GNOME Keyring is running."
}

prompt_credentials() {
  read -rp "API key (JWT issuer, like user:12345:67): " API_KEY
  read -rsp "API secret (hidden): " API_SECRET
  echo
  [[ -n $API_KEY && -n $API_SECRET ]] || die "Both values are required."
}

cmd_setup() {
  need_keyring
  echo "Create or rotate keys at https://addons.mozilla.org/developers/addon/api/key/"
  prompt_credentials
  printf '%s' "$API_KEY" | keyring_set key
  printf '%s' "$API_SECRET" | keyring_set secret
  info "Stored in the system keyring. They are not written anywhere else."
}

cmd_forget() {
  need_keyring
  keyring_clear key
  keyring_clear secret
  info "Credentials removed from the system keyring."
}

cmd_status() {
  if have secret-tool; then
    if [[ -n $(keyring_get key) && -n $(keyring_get secret) ]]; then
      echo "System keyring: credentials stored."
    else
      echo "System keyring: available, nothing stored (run: scripts/release.sh setup)."
    fi
  else
    echo "System keyring: secret-tool not installed (Arch/CachyOS: sudo pacman -S libsecret)."
  fi
  if [[ -n $ENV_KEY && -n $ENV_SECRET ]]; then
    echo "Environment: WEB_EXT_API_KEY and WEB_EXT_API_SECRET are set here and would be used."
  fi
  return 0
}

load_credentials() {
  if [[ -n $ENV_KEY && -n $ENV_SECRET ]]; then
    API_KEY=$ENV_KEY API_SECRET=$ENV_SECRET
    info "Using credentials from the environment (CI)."
    return
  fi
  if have secret-tool; then
    API_KEY=$(keyring_get key)
    API_SECRET=$(keyring_get secret)
    if [[ -n $API_KEY && -n $API_SECRET ]]; then
      info "Using credentials from the system keyring."
      return
    fi
  fi

  [[ -t 0 ]] || die "No credentials found and no terminal to ask on. Run: scripts/release.sh setup (or set WEB_EXT_API_KEY and WEB_EXT_API_SECRET in CI)."
  info "No stored credentials. Enter them now (nothing is written to disk)."
  prompt_credentials
  if have secret-tool; then
    local answer
    read -rp "Save them to the system keyring for next time? [y/N] " answer
    if [[ $answer =~ ^[Yy]$ ]]; then
      printf '%s' "$API_KEY" | keyring_set key
      printf '%s' "$API_SECRET" | keyring_set secret
    fi
  fi
}

# ── safety checks ───────────────────────────────────────────
check_prereqs() {
  for tool in node npm npx; do have "$tool" || die "'$tool' is not installed."; done
  [[ -d node_modules/web-ext ]] || die "Dependencies are missing. Run: npm install"
  [[ -f .env ]] || die ".env not found. Copy .env.example to .env and fill it in."
  grep -Eq '^[[:space:]]*EXTENSION_ID=.+' .env || die "Set EXTENSION_ID in .env. Signing needs a stable add-on id (for example folio-tracker@yourname.dev)."
  if grep -Eq '^[[:space:]]*EXTENSION_ID=.*@example\.com' .env; then die "EXTENSION_ID is still the example placeholder. Use your own id."; fi

  if have git && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git check-ignore -q .env || die ".env is not ignored by git. Add it to .gitignore before releasing."
    if ! git diff --quiet || ! git diff --cached --quiet; then
      die "You have uncommitted changes. Commit or stash them first, so the release commit only contains the version bump."
    fi
  else
    NO_GIT=1
    info "Not a git repository: skipping commit and tag."
  fi
}

bump_version() {
  BACKUP_DIR=$(mktemp -d)
  cp package.json "$BACKUP_DIR/"
  if [[ -f package-lock.json ]]; then cp package-lock.json "$BACKUP_DIR/"; fi
  BUMPED=1
  npm version "$BUMP" --no-git-tag-version >/dev/null
  NEW_VERSION=$(node -p "require('./package.json').version")
}

restore_version_files() {
  [[ $BUMPED == 1 && -n $BACKUP_DIR ]] || return 0
  cp "$BACKUP_DIR/package.json" package.json
  if [[ -f $BACKUP_DIR/package-lock.json ]]; then cp "$BACKUP_DIR/package-lock.json" package-lock.json; fi
  BUMPED=0
}

cleanup() {
  local code=$?
  API_KEY="" API_SECRET="" ENV_KEY="" ENV_SECRET=""
  if (( code != 0 )); then
    if [[ $STAGE == signing ]]; then
      warn "Signing did not finish. The version stays bumped because Mozilla may already have received $NEW_VERSION; if it says that version exists, just run the release again."
    elif (( BUMPED == 1 )); then
      restore_version_files
      warn "The version bump was undone."
    fi
  fi
  [[ -z $BACKUP_DIR ]] || rm -rf "$BACKUP_DIR"
  [[ -z $MARK_FILE ]] || rm -f "$MARK_FILE"
  exit "$code"
}
trap cleanup EXIT

# ── release ─────────────────────────────────────────────────
cmd_release() {
  check_prereqs
  (( DRY_RUN )) || load_credentials   # fail early, before the slow steps

  STAGE="testing";  info "Running tests";           npm test --silent
  STAGE="building"; info "Bumping version ($BUMP)"; bump_version
  info "Building $NEW_VERSION";                     npm run build --silent
  info "Linting";                                   npm run lint --silent

  if (( DRY_RUN )); then
    restore_version_files
    info "Dry run finished: tests, build and lint pass for $NEW_VERSION. Nothing was signed or committed, and the version is unchanged."
    return
  fi

  STAGE="signing"
  info "Signing $NEW_VERSION with Mozilla (unlisted). This can take a few minutes."
  MARK_FILE=$(mktemp)
  # The credentials are handed to this one process only, as environment variables: never as arguments
  # (those would show up in `ps`), and --no-install means nothing new is downloaded while they are present.
  WEB_EXT_API_KEY="$API_KEY" WEB_EXT_API_SECRET="$API_SECRET" \
    npx --no-install web-ext sign --source-dir dist --artifacts-dir artifacts --channel unlisted --no-input
  API_KEY="" API_SECRET=""

  STAGE="done"
  local xpi
  xpi=$(find artifacts -maxdepth 1 -name '*.xpi' -newer "$MARK_FILE" | head -n 1)
  [[ -n $xpi ]] || die "Signing reported success but no new .xpi was found in artifacts/."
  info "Signed: $xpi"
  sha256sum "$xpi"

  if (( ! NO_GIT )); then
    git add package.json
    [[ ! -f package-lock.json ]] || git add package-lock.json
    git commit -q -m "chore: release v$NEW_VERSION"
    git tag -a "v$NEW_VERSION" -m "Folio Tracker $NEW_VERSION"
    info "Committed and tagged v$NEW_VERSION"
    if (( PUSH )); then
      git push --follow-tags
    else
      info "Not pushed. When ready: git push --follow-tags"
    fi
  fi

  if (( INSTALL )); then
    local abs
    abs=$(realpath "$xpi")
    if have firefox; then
      (nohup firefox "$abs" >/dev/null 2>&1 &)
      info "Opened in Firefox: confirm the install prompt. Same add-on id, so it updates in place and keeps your sign-in and settings."
    elif have xdg-open; then
      xdg-open "$abs" >/dev/null 2>&1 || true
    else
      info "Open $abs in Firefox to install it."
    fi
  else
    info "To install: drag $xpi onto Firefox, or re-run with --install next time."
  fi
}

# ── arguments ───────────────────────────────────────────────
case "${1:-}" in
  setup)  cmd_setup;  exit 0 ;;
  forget) cmd_forget; exit 0 ;;
  status) cmd_status; exit 0 ;;
  -h|--help|help) usage; exit 0 ;;
esac

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-git)  NO_GIT=1 ;;
    --push)    PUSH=1 ;;
    --install) INSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    -*)        die "Unknown option: $arg (see --help)" ;;
    *)         BUMP="$arg" ;;
  esac
done
[[ $BUMP =~ ^(patch|minor|major|[0-9]+\.[0-9]+\.[0-9]+)$ ]] || die "Version must be patch, minor, major or X.Y.Z (got '$BUMP')."

cmd_release
