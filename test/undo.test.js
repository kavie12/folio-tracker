import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.browser = {
  storage: {
    local: {
      get: async (key) => (key === null ? { ...store } : { [key]: store[key] }),
      set: async (obj) => Object.assign(store, obj),
      remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
    },
  },
};
const { clearUndo, getUndo, saveUndo } = await import('../src/background/undo.js');

const ref = { mediaType: 'tv', tmdbId: 1622, season: 8, episode: 4 };
const DAY = 24 * 60 * 60 * 1000;

test('a saved undo record can be read and cleared', async () => {
  await saveUndo(ref, { type: 'delete' });
  assert.deepEqual(await getUndo(ref), { type: 'delete' });
  await clearUndo(ref);
  assert.equal(await getUndo(ref), null);
});

test('records are per episode', async () => {
  await saveUndo(ref, { type: 'delete' });
  assert.equal(await getUndo({ ...ref, episode: 5 }), null);
  await clearUndo(ref);
});

test('records expire after a day', async (t) => {
  const real = Date.now();
  t.after(() => mock.restoreAll());
  await saveUndo(ref, { type: 'delete' });
  mock.method(Date, 'now', () => real + DAY + 1000);
  assert.equal(await getUndo(ref), null);
  assert.equal(Object.keys(store).some((k) => k.startsWith('undo:')), false);
});
