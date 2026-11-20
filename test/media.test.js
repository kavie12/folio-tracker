import test from 'node:test';
import assert from 'node:assert/strict';
import { isAhead, mediaKey, normalizeRef, progressLabel } from '../src/shared/media.js';

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
