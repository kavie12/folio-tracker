# Folio Tracker

A Firefox extension that logs what you watch to your [Folio](../README.md) history automatically.

Open a movie or episode on a supported site and Folio Tracker recognises it, shows it in the toolbar popup, and adds it to your history at 80% played (or when you press **Mark as watched**). For TV shows it records the season and episode as your progress.

## Features

- Automatic tracking on supported streaming sites, one small module per site
- Marks a title as watched at 80%, or manually from the popup
- **Undo** for any mark
- TV progress: the latest season and episode, never moved backwards automatically. Finishing a season's last episode stores just the season (`S8`), using TMDB's episode counts
- **Continue**: the next episode of each show you follow, saved with a link, from the popup and the web app
- Popup showing what is playing, its progress, the Continue list, and the supported sites (click one to open it)
- Sign in with your Folio email and password; the extension keeps its own session
- Same dark theme as the web app

## Supported sites

| Site | Domain | How the title is identified |
| --- | --- | --- |
| Cinecat | `cinecat.eu` | TMDB id in the URL, season and episode from the page title (`Show - S8 - E4`) |
| Cinejoy | `cinejoy.pk` | TMDB id, season and episode in the URL (`/watch/tv/1622/8/3`) |

The same list is shown in the extension's **Sites** tab, and on the sign-in screen. Each site has an **Open** button that opens it in a new tab.

## Requirements

- Node 20 or newer
- Firefox 128 or newer
- A running Folio setup: Supabase project and the Cloudflare Worker, **redeployed with the `/details` route** (see [Folio backend](#folio-backend))

## Setup

```bash
npm install
cp .env.example .env     # fill in the Supabase, Worker and app values
npm run build            # creates dist/
```

## Run in Firefox

These steps use the Firefox you already have, with your own profile, themes and logins.

### Development (temporary)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on** and choose `dist/manifest.json`.
3. While you work, keep `npm run watch` running. It rebuilds on every change in `src/`; then click **Reload** next to the extension in `about:debugging`.

A temporary add-on is removed when Firefox closes, so repeat step 2 next session.

> `npm start` also works, but it opens a **separate Firefox with a clean profile** (no themes, no logins, nothing synced). Use it only for quick tests.

### Install permanently

Regular Firefox only keeps **signed** add-ons. Mozilla signs private ("unlisted") add-ons for free, and nothing is published. `scripts/release.sh` does the whole release: it tests, bumps the version, builds, lints, signs, and commits and tags.

**One-time setup**

1. Create a free account at [addons.mozilla.org](https://addons.mozilla.org) and generate API keys at [addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/).
2. Put your own add-on ID in `.env` (unique, email-style, chosen once; it can't change later):
   ```
   EXTENSION_ID=folio-tracker@yourname.dev
   ```
3. Store the API key and secret in your system keyring. They are never written to the repository or `.env`:
   ```bash
   sudo pacman -S libsecret      # provides secret-tool (KWallet and GNOME Keyring both work with it)
   npm run release -- setup      # asks for the key, then the secret (hidden)
   ```

**Every release**

```bash
npm run release                  # patch: 1.0.0 -> 1.0.1
npm run release -- minor --install
```

| Option | Does |
| --- | --- |
| `patch` (default), `minor`, `major`, or `X.Y.Z` | Version to release |
| `--dry-run` | Test, build and lint only. Signs nothing and leaves the version unchanged |
| `--install` | Open the signed `.xpi` in Firefox (same ID, so it updates in place and keeps your sign-in) |
| `--push` | Push the release commit and tag |
| `--no-git` | Skip the commit and tag |

Other commands: `npm run release -- status` (where credentials come from; never prints them) and `npm run release -- forget` (delete them from the keyring).

**How the credentials are protected**

- They live in the system keyring (encrypted at rest), or you are asked for them with hidden input. Nothing goes in `.env`, in shell history, or in the repository.
- They are handed only to the signing command, as environment variables. They are never passed as arguments (those are visible in `ps`), and `npm test`, the build and the linter do not receive them.
- The signing command runs with `--no-install`, so nothing new is downloaded while the secret is present.
- The script refuses to run with uncommitted changes or if `.env` is not git-ignored.
- In CI, set `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` as repository secrets and the script uses them instead of the keyring.
- If a key is ever pasted somewhere it shouldn't be, regenerate it on the same Mozilla page and run `setup` again.

The extension now persists across restarts. If signing says the version already exists, run the release again (it bumps again).

**Without signing:** Firefox Developer Edition, Nightly and ESR can run unsigned add-ons. Set `xpinstall.signatures.required` to `false` in `about:config`, run `npm run package`, then install `artifacts/*.zip` the same way. This does not work in regular Firefox.

### After installing

Firefox may not give a new extension access to sites automatically. If nothing is detected on a supported site, open `about:addons`, click Folio Tracker, open **Permissions**, and allow access to the sites listed there.

## Usage

1. Click the toolbar icon and **sign in** with your Folio account (**Create an account** and **Forgot password?** open the web app).
2. Open a movie or episode on a supported site. The popup shows the title, a `S8E4` label for TV, and the playback progress.
3. At 80% it is added to your history and the icon badge shows ✓. You get a notification, and the popup offers **Undo**.
4. **Mark as watched** records it immediately, or updates a show's progress to the open episode.

### Season progress

Progress is a season and, optionally, an episode. **A season with no episode means that season is finished.** The extension stores it that way when you finish the last episode of a season that is over (it asks TMDB how many episodes the season has), so `S8E23` becomes `S8`, and Continue then points at `S9E1`. A season counts as over if it is before the latest season, or if the show has ended. **The newest season of a show that is still airing keeps its episode number**, because TMDB may list only the episodes aired so far and the latest one would otherwise look like the finale. If TMDB's data is not available the episode number is simply kept. Rewatching an old episode never moves a finished season back.

### Continue

Continue keeps one **episode to continue from** per show, with a link to open it. An entry gets there in one of three ways.

**1. After you finish an episode.** When a TV show's progress is updated (at 80%, or by **Mark as watched**), the extension asks TMDB whether a next episode exists:

| Progress becomes | Saved to Continue |
| --- | --- |
| S8E4, season 8 has more episodes | S8E5 |
| The last episode of season 8 (stored as `S8`) | S9E1, if season 9 exists |
| The last episode of the show | nothing |
| S8E4, and S8E5 is listed on TMDB but has not aired yet | nothing (see below) |

The link is the episode's own address when the site's addresses can be built from ids (Cinejoy: `/watch/tv/{id}/{season}/{episode}`), otherwise the page you are watching. **When you open that episode, the record is updated to its real link**, silently. An entry already holding that episode keeps its link, and an entry for a different episode (for example one you added yourself) is left alone. You get one notification covering the update and the next episode.

**2. When you open the next episode.** If you open the episode right after your recorded progress (S8E5 after S8E4, or S9E1 after a finished season 8), it is saved with the page address. This covers shows whose progress was updated somewhere else, such as the web app.

**3. By hand.** On a TV episode, **Add to Continue** in the popup saves the open episode, whether or not the show is tracked in your history and whether or not it is the next one. Manual entries are kept when a show is removed from your history or its progress is cleared. They are removed when your progress reaches them.

Automatic saves only happen for shows tracked in your history (a season recorded), and the database enforces it. If an episode is already in the list nothing is written and no notification is shown, except that its link is refreshed when you open it.

**How it leaves.** When your progress reaches that episode, or finishes its season (here or on the website), it is removed. Clearing a show's progress or removing the show from your history removes automatic entries too. Database triggers do this, so it works whichever app made the change. **Undo** also puts Continue back in step: undoing S8E4 makes S8E4 the next episode again.

**Where you see it.** The **Continue** tab in the popup (the **Continue** button opens the saved link) and the **Continue** page of the web app, where entries can be removed. The current episode shows "Saved to Continue" and, after a mark, "Next up, S8E5, saved to Continue".

**Not aired yet.** TMDB lists upcoming episodes. The extension only saves an episode that has already aired, so an entry never links to something you can't watch yet. TMDB data is refreshed every 12 hours for shows that are still airing (3 days otherwise), so a brand new episode can take a while to appear; opening it still saves it (rule 2).

Turn all of this off with **Save to Continue** in Settings.

## Undo

- A title that was added is removed. A show whose progress moved goes back to its previous season and episode.
- It is refused if later progress was recorded since (undoing S8E4 after S8E5 would lose S8E5).
- Kept for 24 hours, including across reloads and restarts.
- After an undo the title is not marked automatically again; use **Mark as watched** if you change your mind.

### Settings

| Setting | Default | Does |
| --- | --- | --- |
| Mark automatically | On | Add a title once 80% has played |
| Notifications | On | Notify when a title is added to your history, progress changes, or an episode is saved to Continue |
| Save to Continue | On | Save the next episode, and keep its link up to date |

The 80% threshold and the 2-minute minimum video length are constants in `src/shared/media.js`.

## Adding a site

One file per site in `src/sites/`. The build generates the content script, the manifest permissions and the Sites list from it.

1. Copy `src/sites/_template.js` to `src/sites/<id>.js` (the id must match the file name).
2. Fill in `meta` (`id`, `name`, `domains`).
3. Implement `extract({ url, title, document })`. Return `null` for pages that aren't watch pages, otherwise:
   - movie: `{ mediaType: 'movie', tmdbId }`
   - TV: `{ mediaType: 'tv', tmdbId, season, episode }` (season and episode optional)
4. Optional: if the address of an episode can be built from its ids, add `episodeUrl` to `meta`, for example `'https://example.com/watch/tv/{tmdbId}/{season}/{episode}'` (it needs all three placeholders, https, and a host from `domains`; the build checks this). Continue then links to the next episode before you open it. Leave it out if the address contains anything else, such as a slug or other ids: Continue then uses the page you are watching until you open the episode.
5. Add tests to `test/sites.test.js` with real URLs and titles, then run `npm test && npm run build`.

```js
// src/sites/example.js
export const meta = { id: 'example', name: 'Example', domains: ['example.com'], frameDomains: [] };

export function extract({ url }) {
  const m = url.pathname.match(/^\/watch\/(movie|tv)\/(\d+)(?:\/(\d+)\/(\d+))?/);
  if (!m) return null;
  return m[1] === 'movie'
    ? { mediaType: 'movie', tmdbId: Number(m[2]) }
    : { mediaType: 'tv', tmdbId: Number(m[2]), season: Number(m[3]), episode: Number(m[4]) };
}
```

Errors inside `extract` are caught and treated as "nothing playing", so a broken module can't affect the page.

### When the player is on another domain

Many sites embed the video in an `<iframe>` from a different domain. The extension only runs on domains it lists, so it can identify the title there but not follow playback: no progress bar and no automatic mark (the manual button still works).

To fix it:

1. Play a title, open developer tools (F12), and search the **Inspector** for `iframe`. Note the hostname in its `src`.
2. Add it to the site's module: `frameDomains: ['player.example.net']`.
3. Rebuild and reload.

The two default modules ship with `frameDomains: []` because those sites' player domains were not verified. If progress never appears, check this first.

## How it works

```
 supported site tab                          background page                       Folio
┌──────────────────────┐   media (TMDB id)  ┌────────────────────────┐  REST     ┌──────────────┐
│ top frame            │ ─────────────────▶ │ one state object per   │ ────────▶ │ Supabase     │
│  site module extract │                    │ tab: what + how far    │           │ watch_history│
├──────────────────────┤   video progress   │ marks at 80%, undo     │  /details │              │
│ any frame with video │ ─────────────────▶ │ badge + notification   │ ────────▶ │ Worker (TMDB)│
└──────────────────────┘                    └───────────▲────────────┘           └──────────────┘
                                                        │ state / mark / undo / sign in
                                                  toolbar popup
```

## Privacy and permissions

- The extension runs only on the listed sites and reads the page address, title and `<video>` playback position. Nothing else from the page.
- TMDB id, season and episode go to your own Supabase project, and the TMDB id to your Worker. No analytics, no third parties.
- Permissions: `storage`, `notifications`, and host access to the listed sites, your Supabase project and your Worker.
- The manifest declares `authenticationInfo` and `browsingActivity` (`data_collection_permissions`). Check them against Mozilla's current policy before publishing.
- Sign-in uses its own Supabase session, separate from the website's, so neither signs the other out.

## Scripts

| Command | Does |
| --- | --- |
| `npm run build` | Build `dist/` from `src/` and `.env` |
| `npm run watch` | Rebuild automatically when `src/` changes |
| `npm start` | Build and run in a separate, clean Firefox profile |
| `npm run release` | Test, bump, build, sign (private `.xpi` from Mozilla), commit and tag |
| `npm run package` | Build and create an unsigned `artifacts/*.zip` |
| `npm test` | Run the unit and DOM tests |
| `npm run lint` | Lint `dist/` with Mozilla's validator |

## Folio backend

The extension talks to the web app's backend directly and depends only on:

| Dependency | Used for |
| --- | --- |
| `watch_history` columns `user_id, media_id, media_type, title, poster_path, release_year, last_season, last_episode, watched_at` | Reading and writing history (Row Level Security applies) |
| Unique `(user_id, media_id, media_type)` | Idempotent inserts |
| `continue_watching` table (migrations `005`, `006` and `007_continue_manual_and_season_complete.sql`) with unique `(user_id, media_id)`, the `manual` flag, and the triggers that guard and prune it | The Continue list |
| A progress with a season and no episode means the season is finished | Season progress, Continue clean-up |
| Worker `GET /details/{movie\|tv}/{id}` (TMDB's details, including `seasons` and `last_episode_to_air`) | Title, poster, year, episodes per season, last aired episode |
| Worker accepts `moz-extension://` origins | Requests from the extension |

If you change one of these in the web app, change the extension in the same pull request.

## Project structure

```
folio-extension/
├─ src/
│  ├─ sites/          One module per streaming site (the part you edit most)
│  ├─ content/        tracker.js: identifies media, follows <video>
│  ├─ background/     Tab state, auto-marking, undo, auth, Folio and TMDB calls
│  ├─ popup/          Toolbar popup (HTML, CSS, vanilla JS)
│  ├─ shared/         Constants, message types, media helpers
│  ├─ icons/          Logo (SVG and PNG)
│  └─ manifest.base.json
├─ scripts/           build.mjs (esbuild + manifest), release.sh (signing), env.mjs
└─ test/              Site modules, helpers, Folio calls, undo, tracker and popup
```

## Publishing on addons.mozilla.org (optional)

For a public listing, upload the output of `npm run package` at [addons.mozilla.org/developers](https://addons.mozilla.org/developers/). Because `dist/` is bundled, Mozilla also asks for the **source code**: upload this repository as a zip and give `npm ci && npm run build` as the build command (Node 20, values from `.env.example`). Raise `version` in `package.json` for every release.

## Known limits

- Detection depends on each site's URL and title format. If a site changes them, update its module.
- Playback can only be followed on domains the extension runs on (see above).
- Automatic progress only moves forward; setting an earlier episode by hand from the popup does lower it.
- Knowing whether a next episode exists depends on TMDB's data. For shows still airing it can lag behind by up to a day (the Worker caches it for 24 hours).
- If a site can't build episode links, a freshly saved next episode points at the page you were watching until you open it.
- Firefox only (Manifest V3, Firefox 128+).
