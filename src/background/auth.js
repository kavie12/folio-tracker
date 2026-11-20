/**
 * Folio sign-in. Uses the same email and password as the web app, against Supabase Auth.
 * The extension keeps its own session (its own refresh token) in extension storage,
 * so signing in here never signs you out of the website, and vice versa.
 */
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../shared/config.js';

const EXPIRY_MARGIN = 60; // refresh a minute early
let refreshing = null; // de-duplicates concurrent refreshes

export class NotSignedInError extends Error {
  constructor() {
    super('Sign in to Folio first.');
    this.name = 'NotSignedInError';
  }
}

const headers = { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
const now = () => Math.floor(Date.now() / 1000);

async function post(path, body, extraHeaders = {}) {
  try {
    return await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
      method: 'POST',
      headers: { ...headers, ...extraHeaders },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Couldn’t reach Folio. Check your connection.');
  }
}

function friendly(body) {
  const code = body?.error_code || body?.error;
  const msg = body?.msg || body?.error_description || body?.message || '';
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return 'Incorrect email or password.';
  if (code === 'email_not_confirmed' || /not confirmed/i.test(msg)) return 'Confirm your email address first, then sign in.';
  return msg || 'Couldn’t sign you in. Try again.';
}

const toSession = (json) => ({
  accessToken: json.access_token,
  refreshToken: json.refresh_token,
  expiresAt: json.expires_at ?? now() + (json.expires_in ?? 3600),
  user: { id: json.user.id, email: json.user.email },
});

export async function getSession() {
  const { session } = await browser.storage.local.get('session');
  return session ?? null;
}

export async function getUser() {
  return (await getSession())?.user ?? null;
}

export async function signIn(email, password) {
  const res = await post('token?grant_type=password', { email: email.trim(), password });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(friendly(body));
  const session = toSession(body);
  await browser.storage.local.set({ session });
  return session.user;
}

export async function signOut() {
  const session = await getSession();
  await browser.storage.local.remove('session');
  if (session) {
    // Best effort: revoke the refresh token server-side.
    post('logout?scope=local', {}, { Authorization: `Bearer ${session.accessToken}` }).catch(() => undefined);
  }
}

async function doRefresh(session) {
  const res = await post('token?grant_type=refresh_token', { refresh_token: session.refreshToken });
  if (res.status === 400 || res.status === 401) {
    // Revoked or expired for good: this device must sign in again.
    await browser.storage.local.remove('session');
    return null;
  }
  if (!res.ok) throw new Error('Couldn’t refresh your Folio session. Try again.');
  const next = toSession(await res.json());
  await browser.storage.local.set({ session: next });
  return next.accessToken;
}

/** A valid access token, refreshing if needed. Null when signed out. */
export async function getAccessToken({ force = false } = {}) {
  const session = await getSession();
  if (!session) return null;
  if (!force && session.expiresAt - EXPIRY_MARGIN > now()) return session.accessToken;
  refreshing ??= doRefresh(session).finally(() => { refreshing = null; });
  return refreshing;
}
