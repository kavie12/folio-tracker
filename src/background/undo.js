/**
 * Remembers how to reverse each mark, so it can be undone from the popup even after the tab is
 * reloaded or the browser restarts. Records expire after a day.
 */
import { mediaKey } from '../shared/media.js';

const TTL_MS = 24 * 60 * 60 * 1000;
const PREFIX = 'undo:';
const storageKey = (ref) => `${PREFIX}${mediaKey(ref)}`;

export async function saveUndo(ref, undo) {
  await browser.storage.local.set({ [storageKey(ref)]: { undo, at: Date.now() } });
  await prune();
}

export async function getUndo(ref) {
  const key = storageKey(ref);
  const record = (await browser.storage.local.get(key))[key];
  if (!record) return null;
  if (Date.now() - record.at > TTL_MS) {
    await browser.storage.local.remove(key);
    return null;
  }
  return record.undo;
}

export async function clearUndo(ref) {
  await browser.storage.local.remove(storageKey(ref));
}

async function prune() {
  const all = await browser.storage.local.get(null);
  const expired = Object.entries(all)
    .filter(([key, value]) => key.startsWith(PREFIX) && Date.now() - value.at > TTL_MS)
    .map(([key]) => key);
  if (expired.length) await browser.storage.local.remove(expired);
}
