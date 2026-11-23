/** "Continue": the next episode to watch for each show, with a link back to it. */
import { getSession, NotSignedInError } from './auth.js';
import { rest } from './folio.js';

/** Saves (or replaces) the next episode for a show. One row per show. */
export async function saveContinue(ref, meta, url) {
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
    },
  });
}

/** The episode currently saved for a show, or null. */
export async function getContinue(ref) {
  const rows = await rest(`continue_watching?media_id=eq.${ref.tmdbId}&select=season,episode&limit=1`);
  return rows[0] ?? null;
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
