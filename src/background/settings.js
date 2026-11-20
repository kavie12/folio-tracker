const DEFAULTS = { autoMark: true, notify: true };

export async function getSettings() {
  const { settings } = await browser.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings ?? {}) };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()) };
  for (const key of Object.keys(DEFAULTS)) if (typeof patch?.[key] === 'boolean') next[key] = patch[key];
  await browser.storage.local.set({ settings: next });
  return next;
}
