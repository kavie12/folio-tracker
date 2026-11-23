# Folio Tracker

A Firefox extension that logs what you watch to your [Folio](../README.md) history automatically.

Open a movie or episode on a supported site and Folio Tracker recognises it, shows it in the toolbar popup, and adds it to your history at 80% played (or when you press **Mark as watched**). For TV shows it records the season and episode as your progress.

## Features

- Automatic tracking on supported streaming sites, one small module per site
- Marks a title as watched at 80%, or manually from the popup
- **Undo** for any mark
- TV progress: the latest season and episode, never moved backwards automatically
- Popup showing what is playing, its progress, and the list of supported sites
- Sign in with your Folio email and password; the extension keeps its own session
- Same dark theme as the web app

## Supported sites

| Site | Domain | How the title is identified |
| --- | --- | --- |
| Cinecat | `cinecat.eu` | TMDB id in the URL, season and episode from the page title (`Show - S8 - E4`) |
| Cinejoy | `cinejoy.pk` | TMDB id, season and episode in the URL (`/watch/tv/1622/8/3`) |

The same list is shown in the extension's **Sites** tab.

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

Regular Firefox only keeps **signed** add-ons. Mozilla signs private ("unlisted") add-ons for free, and nothing is published.

1. Create a free account at [addons.mozilla.org](https://addons.mozilla.org) and generate API keys at [addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/).
2. Add these to `.env`:
   ```
   EXTENSION_ID=folio-tracker@yourname.dev
   AMO_JWT_ISSUER=user:12345:67
   AMO_JWT_SECRET=your-api-secret
   ```
   `EXTENSION_ID` is your own unique, email-style ID. Choose it once; it can't change later.
3. Run:
   ```bash
   npm run sign
   ```
   It builds, uploads, waits for Mozilla's automatic signing (usually a few minutes) and saves `artifacts/*.xpi`.
4. In Firefox open `about:addons`, click the gear icon, choose **Install Add-on From File**, and select the `.xpi`.

The extension now persists across restarts. **To update:** raise `version` in `package.json`, run `npm run sign` again and install the new `.xpi` over the old one (same ID, so your settings and sign-in are kept).

**Without signing:** Firefox Developer Edition, Nightly and ESR can run unsigned add-ons. Set `xpinstall.signatures.required` to `false` in `about:config`, run `npm run package`, then install `artifacts/*.zip` the same way. This does not work in regular Firefox.

### After installing

Firefox may not give a new extension access to sites automatically. If nothing is detected on a supported site, open `about:addons`, click Folio Tracker, open **Permissions**, and allow access to the sites listed there.

## Usage

1. Click the toolbar icon and **sign in** with your Folio account (**Create an account** and **Forgot password?** open the web app).
2. Open a movie or episode on a supported site. The popup shows the title, a `S8E4` label for TV, and the playback progress.
3. At 80% it is added to your history and the icon badge shows ✓. You get a notification, and the popup offers **Undo**.
4. **Mark as watched** records it immediately, or updates a show's progress to the open episode.

### Continue

Continue keeps one **next episode to watch** per show, with the link to open it.

**How an episode gets saved.** When you open a TV episode, the extension looks at the progress recorded in Folio. If the page is the episode right after it, it is saved to Continue together with the page address:

| Recorded progress | Opened | Saved? |
| --- | --- | --- |
| S8E4 | S8E5 | Yes |
| S8E23 (last episode of season 8) | S9E1 | Yes |
| S8E4 | S9E1 | No, season 8 still has episodes (season lengths come from TMDB) |
| S8E4 | S8E7, S8E4 or S8E2 | No |
| Show in your history, but no season and episode recorded | anything | No |
| Show not in your history | anything | No |

**Only tracked shows.** A show goes to Continue only if it is in your history **with a season and episode recorded**. The database enforces this too, so no app can add anything else.

**No duplicates.** Before saving, the extension checks the Continue list itself. If that episode is already there (for example you opened it in another tab, or after restarting Firefox), nothing is written and no notification is shown. A different episode of the same show replaces the old one and does notify.

**How it leaves.** When your progress reaches that episode (marking it watched, here or on the website), it is removed from Continue automatically. Clearing a show's progress or removing the show from your history removes it too. Both are handled by database triggers, so they work whichever app made the change.

**Where you see it.** The **Continue** tab in the popup (a **Continue** button opens the saved link) and the **Continue** page of the web app, where entries can also be removed. The current episode also shows "Saved to Continue" in the popup, and a notification appears when an episode is added.

It is saved when the page opens, when you open the popup (this covers signing in after the page loaded), and after an undo. Turn it off with **Save to Continue** in Settings.

## Undo

- A title that was added is removed. A show whose progress moved goes back to its previous season and episode.
- It is refused if later progress was recorded since (undoing S8E4 after S8E5 would lose S8E5).
- Kept for 24 hours, including across reloads and restarts.
- After an undo the title is not marked automatically again; use **Mark as watched** if you change your mind.

### Settings

| Setting | Default | Does |
| --- | --- | --- |
| Mark automatically | On | Add a title once 80% has played |
| Notifications | On | Notify when something is added |

The 80% threshold and the 2-minute minimum video length are constants in `src/shared/media.js`.

## Adding a site

One file per site in `src/sites/`. The build generates the content script, the manifest permissions and the Sites list from it.

1. Copy `src/sites/_template.js` to `src/sites/<id>.js` (the id must match the file name).
2. Fill in `meta` (`id`, `name`, `domains`).
3. Implement `extract({ url, title, document })`. Return `null` for pages that aren't watch pages, otherwise:
   - movie: `{ mediaType: 'movie', tmdbId }`
   - TV: `{ mediaType: 'tv', tmdbId, season, episode }` (season and episode optional)
4. Add tests to `test/sites.test.js` with real URLs and titles, then run `npm test && npm run build`.

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
| `npm run sign` | Build and get a signed, private `.xpi` from Mozilla |
| `npm run package` | Build and create an unsigned `artifacts/*.zip` |
| `npm test` | Run the unit and DOM tests |
| `npm run lint` | Lint `dist/` with Mozilla's validator |

## Folio backend

The extension talks to the web app's backend directly and depends only on:

| Dependency | Used for |
| --- | --- |
| `watch_history` columns `user_id, media_id, media_type, title, poster_path, release_year, last_season, last_episode, watched_at` | Reading and writing history (Row Level Security applies) |
| Unique `(user_id, media_id, media_type)` | Idempotent inserts |
| `continue_watching` table (migrations `005_continue_watching.sql` and `006_continue_requires_history.sql`) with unique `(user_id, media_id)`, and the triggers that guard and prune it | The Continue list |
| Worker `GET /details/{movie\|tv}/{id}` | Title, poster and year |
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
├─ scripts/           build.mjs (esbuild + manifest), sign.mjs, env.mjs
└─ test/              Site modules, helpers, Folio calls, undo, tracker and popup
```

## Publishing on addons.mozilla.org (optional)

For a public listing, upload the output of `npm run package` at [addons.mozilla.org/developers](https://addons.mozilla.org/developers/). Because `dist/` is bundled, Mozilla also asks for the **source code**: upload this repository as a zip and give `npm ci && npm run build` as the build command (Node 20, values from `.env.example`). Raise `version` in `package.json` for every release.

## Known limits

- Detection depends on each site's URL and title format. If a site changes them, update its module.
- Playback can only be followed on domains the extension runs on (see above).
- Automatic progress only moves forward; setting an earlier episode by hand from the popup does lower it.
- Firefox only (Manifest V3, Firefox 128+).
