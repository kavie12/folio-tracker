import test from 'node:test';
import assert from 'node:assert/strict';
import { extract as cinecat } from '../src/sites/cinecat.js';
import { extract as cinejoy } from '../src/sites/cinejoy.js';

const page = (url, title = '') => ({ url: new URL(url), title });

test('cinecat: TV id from the URL, season and episode from the title', () => {
  assert.deepEqual(
    cinecat(page('https://cinecat.eu/media/tmdb-tv-1622-supernatural/6911/162698', 'Supernatural - S8 - E4')),
    { mediaType: 'tv', tmdbId: 1622, season: 8, episode: 4 },
  );
});

test('cinecat: tolerates other title shapes', () => {
  const url = 'https://cinecat.eu/media/tmdb-tv-1622-supernatural/1/2';
  assert.deepEqual(cinecat(page(url, 'Supernatural S12E10 | Cinecat')), { mediaType: 'tv', tmdbId: 1622, season: 12, episode: 10 });
});

test('cinecat: TV page whose title has not updated yet still identifies the show', () => {
  assert.deepEqual(cinecat(page('https://cinecat.eu/media/tmdb-tv-1622-supernatural/1/2', 'Cinecat')), { mediaType: 'tv', tmdbId: 1622 });
});

test('cinecat: movie needs only the id; other pages are ignored', () => {
  assert.deepEqual(cinecat(page('https://cinecat.eu/media/tmdb-movie-603-the-matrix/1/2', 'The Matrix')), { mediaType: 'movie', tmdbId: 603 });
  assert.equal(cinecat(page('https://cinecat.eu/browse', 'Browse')), null);
});

test('cinejoy: TV id, season and episode from the URL', () => {
  assert.deepEqual(cinejoy(page('https://cinejoy.pk/watch/tv/1622/8/3')), { mediaType: 'tv', tmdbId: 1622, season: 8, episode: 3 });
});

test('cinejoy: movie, bare TV page and other pages', () => {
  assert.deepEqual(cinejoy(page('https://cinejoy.pk/watch/movie/603')), { mediaType: 'movie', tmdbId: 603 });
  assert.deepEqual(cinejoy(page('https://cinejoy.pk/watch/tv/1622')), { mediaType: 'tv', tmdbId: 1622 });
  assert.equal(cinejoy(page('https://cinejoy.pk/')), null);
});
