/** "Continue": the next episode to watch for each show, with a link back to it. */
import { getSession, NotSignedInError } from './auth.js';
import { rest } from './folio.js';

/**
 * Saves (or replaces) the episode to continue from for a show. One row per show.
 * `manual` marks an entry the user added themselves, which is allowed for shows not tracked in the history.
 */
export async function saveContinue(ref, meta, url, { manual = false } = {}) {
  const session = await getSession();
  if (!session) throw new NotSignedInError();

  await rest('continue_watching?on_conflict=user_id,media_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: {
      user_id: session.user.id,
      media_id: ref.tmdbId,
      title: meta.title,
      poster_path: meta.posterPath,
      release_year: meta.releaseYear,
      season: ref.season,
      episode: ref.episode,
      url,
      updated_at: new Date().toISOString(),
      ...(manual ? { manual: true } : {}), // left out otherwise, so automatic saves work before the migration is applied
    },
  });
}

/** The episode currently saved for a show (with its link), or null. */
export async function getContinue(ref) {
  const rows = await rest(`continue_watching?media_id=eq.${ref.tmdbId}&select=season,episode,url&limit=1`);
  return rows[0] ?? null;
}

/** Points the saved episode at a (better) link, for example the real page once the user opens it. */
export async function updateContinueLink(ref, url) {
  await rest(`continue_watching?media_id=eq.${ref.tmdbId}&season=eq.${ref.season}&episode=eq.${ref.episode}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: { url, updated_at: new Date().toISOString() },
  });
}

export async function listContinue() {
  const rows = await rest(
    'continue_watching?select=media_id,title,poster_path,release_year,season,episode,url,updated_at&order=updated_at.desc&limit=50',
  );
  return rows.map((r) => ({
    mediaId: r.media_id,
    title: r.title,
    posterPath: r.poster_path,
    releaseYear: r.release_year,
    season: r.season,
    episode: r.episode,
    url: r.url,
    updatedAt: r.updated_at,
  }));
}
