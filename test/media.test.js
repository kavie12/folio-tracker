import test from 'node:test';
import assert from 'node:assert/strict';
import { isAhead, isNextEpisode, mediaKey, normalizeRef, progressLabel, qualifiesForContinue } from '../src/shared/media.js';

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
  assert.equal(isAhead(at(2, 1), at(2, null)), true);
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
  assert.equal(isNextEpisode(ep(8, 5), ep(8, null)), false);
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
