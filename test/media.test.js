import test from 'node:test';
import assert from 'node:assert/strict';
import { isAhead, isLastEpisode, isNextEpisode, mediaKey, normalizeProgress, normalizeRef, progressLabel, progressMatches, qualifiesForContinue } from '../src/shared/media.js';

test('normalizeRef accepts valid refs and rejects junk', () => {
  assert.deepEqual(normalizeRef({ mediaType: 'movie', tmdbId: '603', season: 4 }), { mediaType: 'movie', tmdbId: 603 });
  assert.deepEqual(normalizeRef({ mediaType: 'tv', tmdbId: 1622, season: 8, episode: 4 }), { mediaType: 'tv', tmdbId: 1622, season: 8, episode: 4 });
  assert.deepEqual(normalizeRef({ mediaType: 'tv', tmdbId: 1622, episode: 4 }), { mediaType: 'tv', tmdbId: 1622, season: null, episode: null });
  for (const bad of [null, 'x', {}, { mediaType: 'tv' }, { mediaType: 'music', tmdbId: 1 }, { mediaType: 'movie', tmdbId: -3 }, { mediaType: 'movie', tmdbId: 1.5 }]) {
    assert.equal(normalizeRef(bad), null);
  }
});

test('mediaKey and progressLabel', () => {
  assert.equal(mediaKey({ mediaType: 'movie', tmdbId: 5 }), 'movie:5');
  assert.equal(mediaKey({ mediaType: 'tv', tmdbId: 5, season: 2, episode: 3 }), 'tv:5:2:3');
  assert.equal(progressLabel({ mediaType: 'tv', tmdbId: 1, season: 3, episode: 3 }), 'S3E3');
  assert.equal(progressLabel({ mediaType: 'tv', tmdbId: 1, season: 3, episode: null }), 'S3');
  assert.equal(progressLabel({ mediaType: 'movie', tmdbId: 1 }), null);
});

test('isAhead only moves forward', () => {
  const at = (season, episode) => ({ season, episode });
  assert.equal(isAhead(at(2, 5), null), true);
  assert.equal(isAhead(at(2, 5), at(2, 4)), true);
  assert.equal(isAhead(at(3, 1), at(2, 9)), true);
  assert.equal(isAhead(at(2, 4), at(2, 4)), false);
  assert.equal(isAhead(at(2, 3), at(2, 4)), false);
  assert.equal(isAhead(at(1, 9), at(2, 1)), false);
  // a progress with no episode means the season is finished: nothing inside that season is ahead of it
  assert.equal(isAhead(at(2, 1), at(2, null)), false);
  assert.equal(isAhead(at(3, 1), at(2, null)), true);
});

const ep = (season, episode) => ({ season, episode });

test('isNextEpisode: the following episode in the same season', () => {
  assert.equal(isNextEpisode(ep(8, 5), ep(8, 4)), true);
  assert.equal(isNextEpisode(ep(8, 6), ep(8, 4)), false); // skipped one
  assert.equal(isNextEpisode(ep(8, 4), ep(8, 4)), false); // the same episode
  assert.equal(isNextEpisode(ep(8, 3), ep(8, 4)), false); // earlier
});

test('isNextEpisode: episode 1 of the next season only after the season has ended', () => {
  const counts = { 8: 23, 9: 23 };
  assert.equal(isNextEpisode(ep(9, 1), ep(8, 23), counts), true);
  assert.equal(isNextEpisode(ep(9, 1), ep(8, 4), counts), false); // season 8 still has episodes left
  assert.equal(isNextEpisode(ep(9, 1), ep(8, 23)), true); // season lengths unknown: accept
  assert.equal(isNextEpisode(ep(10, 1), ep(8, 23), counts), false); // skipped a season
  assert.equal(isNextEpisode(ep(9, 2), ep(8, 23), counts), false);
});

test('isNextEpisode needs a known season and episode on both sides', () => {
  assert.equal(isNextEpisode(ep(8, 5), null), false);
  assert.equal(isNextEpisode(ep(8, 5), ep(8, null)), false); // season-only means finished: S8E5 is not next
  assert.equal(isNextEpisode(ep(null, null), ep(8, 4)), false);
});

test('qualifiesForContinue: only TV, only when the show is in the history', () => {
  const tv = { mediaType: 'tv', tmdbId: 1, season: 8, episode: 5 };
  const watched = { watched: true, progress: ep(8, 4) };
  assert.equal(qualifiesForContinue(tv, watched), true);
  assert.equal(qualifiesForContinue(tv, { watched: false, progress: null }), false);
  assert.equal(qualifiesForContinue(tv, null), false);
  assert.equal(qualifiesForContinue({ mediaType: 'movie', tmdbId: 1 }, watched), false);
  assert.equal(qualifiesForContinue({ ...tv, episode: 9 }, watched), false);
});

test('isAhead: a finished season (no episode) against TMDB counts', () => {
  const counts = { 8: 23 };
  assert.equal(isAhead(ep(8, 5), ep(8, null), counts), false); // rewatching an episode of a finished season
  assert.equal(isAhead(ep(8, 23), ep(8, null), counts), false);
  assert.equal(isAhead(ep(8, 24), ep(8, null), counts), true); // TMDB's count was outdated: a new episode exists
  assert.equal(isAhead(ep(8, null), ep(8, 22), counts), true); // finishing the season moves forward
  assert.equal(isAhead(ep(8, null), ep(8, null), counts), false);
  assert.equal(isAhead(ep(9, null), ep(8, 5), counts), true);
});

test('isLastEpisode and normalizeProgress use the episode count of a finished season', () => {
  const counts = { 8: 23, 9: 10 };
  const done = [8, 9]; // both seasons are over
  const tv = (season, episode) => ({ mediaType: 'tv', tmdbId: 1, season, episode });
  assert.equal(isLastEpisode(tv(8, 23), counts, done), true);
  assert.equal(isLastEpisode(tv(8, 24), counts, done), true); // beyond the count counts as the end too
  assert.equal(isLastEpisode(tv(8, 22), counts, done), false);
  assert.equal(isLastEpisode(tv(5, 3), counts, done), false); // season unknown to TMDB
  assert.equal(isLastEpisode(tv(8, 23), undefined, done), false); // no counts: cannot tell
  assert.equal(isLastEpisode({ mediaType: 'movie', tmdbId: 1 }, counts, done), false);

  assert.deepEqual(normalizeProgress(tv(8, 23), counts, done), { season: 8, episode: null }); // season only
  assert.deepEqual(normalizeProgress(tv(8, 22), counts, done), { season: 8, episode: 22 });
  assert.deepEqual(normalizeProgress(tv(8, 23), undefined, done), { season: 8, episode: 23 }); // kept without counts
  assert.deepEqual(normalizeProgress(tv(8, null), counts, done), { season: 8, episode: null });
});

test('progressMatches compares season and episode, treating a missing episode as null', () => {
  assert.equal(progressMatches({ season: 8, episode: null }, { season: 8, episode: null }), true);
  assert.equal(progressMatches({ season: 8, episode: undefined }, { season: 8, episode: null }), true);
  assert.equal(progressMatches({ season: 8, episode: 4 }, { season: 8, episode: null }), false);
  assert.equal(progressMatches(null, { season: 8, episode: 4 }), false);
});

test('isNextEpisode after a finished season (season only)', () => {
  const counts = { 8: 23 };
  assert.equal(isNextEpisode(ep(9, 1), ep(8, null), counts), true);
  assert.equal(isNextEpisode(ep(9, 1), ep(8, null)), true);
  assert.equal(isNextEpisode(ep(9, 2), ep(8, null), counts), false);
  assert.equal(isNextEpisode(ep(8, 5), ep(8, null), counts), false); // inside the finished season
  assert.equal(isNextEpisode(ep(8, 24), ep(8, null), counts), true); // an episode TMDB did not know about yet
  assert.equal(isNextEpisode(ep(8, 24), ep(8, null)), false); // no counts: cannot say
  assert.equal(isNextEpisode(ep(10, 1), ep(8, null), counts), false);
});

test('qualifiesForContinue works with a finished-season progress', () => {
  const tv = { mediaType: 'tv', tmdbId: 1, season: 9, episode: 1 };
  assert.equal(qualifiesForContinue(tv, { watched: true, progress: ep(8, null) }, { 8: 23 }), true);
});

test('isLastEpisode needs the season to be finished, not just the count to match', () => {
  const tv = (season, episode) => ({ mediaType: 'tv', tmdbId: 1, season, episode });
  const counts = { 1: 10, 2: 4 };
  assert.equal(isLastEpisode(tv(1, 10), counts, [1]), true);
  assert.equal(isLastEpisode(tv(1, 9), counts, [1]), false); // not the last episode
  assert.equal(isLastEpisode(tv(2, 4), counts, [1]), false); // the count matches, but season 2 is still airing
  assert.equal(isLastEpisode(tv(1, 10), counts), false); // finished seasons unknown: keep the episode
  assert.deepEqual(normalizeProgress(tv(1, 10), counts, [1]), { season: 1, episode: null });
  assert.deepEqual(normalizeProgress(tv(2, 4), counts, [1]), { season: 2, episode: 4 });
});
