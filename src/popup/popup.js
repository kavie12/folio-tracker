import { APP_URL, VERSION } from '../shared/config.js';
import { MSG } from '../shared/messages.js';
import { progressLabel } from '../shared/media.js';

const POLL_MS = 1500;
const send = (message) => browser.runtime.sendMessage(message);

// ── tiny DOM helper (text is always set as text, never as HTML) ──
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

// ── state ───────────────────────────────────────────────────
const app = document.getElementById('app');
let sites = [];
let tab = null;
let state = null; // last getState response
let view = 'now'; // 'now' | 'sites' | 'settings'
let panel = null; // the element that changes between views
let pollTimer = null;
let actionError = null; // error from the last button press (mark or undo)

const hostOf = (url) => {
  try { return new URL(url).hostname; } catch { return ''; }
};
const openLink = (url) => { browser.tabs.create({ url }); window.close(); };

async function refresh() {
  state = await send({ type: MSG.GET_STATE, tabId: tab?.id });
}

// ── pieces ──────────────────────────────────────────────────
const Header = () => el('div', { class: 'header' },
  el('span', { class: 'brand display' }, el('img', { src: 'icons/icon.svg', alt: '' }), 'Folio'),
  el('span', { class: 'small muted' }, 'Tracker'),
);

function Segmented(options, value, onChange) {
  const index = options.findIndex((o) => o.id === value);
  const root = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'View' },
    el('span', { class: 'seg-pill', 'aria-hidden': 'true' }),
    ...options.map((o) => el('button', {
      role: 'radio',
      'aria-checked': String(o.id === value),
      onclick: () => {
        root.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-checked', String(options[i].id === o.id)));
        root.style.setProperty('--i', options.findIndex((x) => x.id === o.id));
        onChange(o.id);
      },
    }, o.label)),
  );
  root.style.setProperty('--n', options.length);
  root.style.setProperty('--i', index);
  return root;
}

function Poster(meta) {
  const box = el('div', { class: 'poster' });
  if (meta?.posterPath) box.append(el('img', { src: `https://image.tmdb.org/t/p/w185${meta.posterPath}`, alt: '' }));
  else box.append(el('div', { class: 'ph' }, meta?.title ?? ''));
  return box;
}

function SiteList(highlightHost) {
  return el('ul', { class: 'list' },
    sites.map((s) => {
      const here = highlightHost && s.domains.some((d) => highlightHost === d || highlightHost.endsWith(`.${d}`));
      return el('li', { class: `site${here ? ' here' : ''}` },
        el('div', {},
          el('div', { class: 'display' }, s.name),
          s.domains.map((d) => el('a', { href: `https://${d}`, onclick: (e) => { e.preventDefault(); openLink(`https://${d}`); } }, d)),
        ),
        here && el('span', { class: 'tag' }, 'This tab'),
      );
    }),
  );
}

// ── views ───────────────────────────────────────────────────
function SignedOut() {
  const error = el('p', { class: 'small danger', role: 'alert' });
  const submit = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Sign in');
  const email = el('input', { class: 'input', type: 'email', required: true, autocomplete: 'username', name: 'email' });
  const password = el('input', { class: 'input', type: 'password', required: true, autocomplete: 'current-password', name: 'password' });

  const form = el('form', { class: 'panel', onsubmit: async (e) => {
    e.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    submit.textContent = 'Signing in';
    const res = await send({ type: MSG.SIGN_IN, email: email.value, password: password.value });
    if (res.ok) {
      await refresh();
      render();
    } else {
      error.textContent = res.error;
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  } },
    el('div', {},
      el('h1', { class: 'display', style: 'font-size:22px' }, 'Track what you watch'),
      el('p', { class: 'muted', style: 'margin-top:4px' }, 'Sign in with your Folio account and titles are logged automatically as you watch.'),
    ),
    el('label', { class: 'field' }, 'Email', email),
    el('label', { class: 'field' }, 'Password', password),
    error,
    submit,
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'linkbtn', onclick: () => openLink(`${APP_URL}/auth`) }, 'Create an account'),
      el('button', { type: 'button', class: 'linkbtn', onclick: () => openLink(`${APP_URL}/auth`) }, 'Forgot password?'),
    ),
  );

  return [
    Header(),
    form,
    el('div', { class: 'panel' }, el('h2', { class: 'display', style: 'font-size:15px' }, 'Supported sites'), SiteList(hostOf(tab?.url))),
  ];
}

function NowPlaying() {
  const s = state;
  if (!s) {
    return el('div', { class: 'card now' },
      el('div', { class: 'poster skeleton' }),
      el('div', { class: 'now-body' }, el('div', { class: 'skeleton', style: 'height:18px;width:70%' }), el('div', { class: 'skeleton', style: 'height:12px;width:40%;margin-top:6px' })),
    );
  }

  if (!s.media) {
    return el('div', { class: 'empty' },
      el('h2', { class: 'display' }, 'Nothing playing here'),
      el('p', { class: 'muted' }, 'Open a movie or episode on a supported site and it shows up here. See the Sites tab.'),
    );
  }

  const { media, meta, entry, video, done, autoMarked, undoable, undone, lastError, settings } = s;
  const label = progressLabel(media);
  const title = meta?.title ?? `TMDB #${media.tmdbId}`;

  // status line
  let status = 'Detected on this page';
  if (video?.ended) status = 'Finished';
  else if (video?.playing) status = `Playing, ${video.percent}%`;
  else if (video) status = `Paused at ${video.percent}%`;

  // action button
  let button;
  if (done) {
    const doneButton = el('button', { class: 'btn btn-done', disabled: true },
      el('span', { class: 'accent' }, '✓'),
      autoMarked ? 'Marked automatically' : `In your history${label ? `, ${label}` : ''}`);

    button = !undoable ? doneButton : el('div', { class: 'btn-row' },
      doneButton,
      el('button', { class: 'btn btn-ghost btn-undo', onclick: async (e) => {
        e.currentTarget.disabled = true;
        e.currentTarget.textContent = 'Undoing';
        actionError = null;
        const res = await send({ type: MSG.UNDO, tabId: tab.id });
        if (!res.ok) actionError = res.error;
        await refresh();
        renderPanel();
      } }, 'Undo'));
  } else {
    const text = entry?.watched && label ? `Update progress to ${label}` : 'Mark as watched';
    button = el('button', { class: 'btn btn-primary', onclick: async (e) => {
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = 'Saving';
      actionError = null;
      const res = await send({ type: MSG.MARK, tabId: tab.id });
      if (!res.ok) actionError = res.error;
      await refresh();
      renderPanel();
    } }, text);
  }

  return el('div', { class: 'panel' },
    el('div', { class: 'card' },
      el('div', { class: 'now' },
        Poster(meta),
        el('div', { class: 'now-body' },
          el('h2', { class: 'title display' }, title),
          el('p', { class: 'small muted' }, [meta?.releaseYear ?? 'Year unknown', media.mediaType === 'movie' ? 'Movie' : 'TV show'].join(', ')),
          label && el('span', { class: 'pill', key: label }, label),
          video && el('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': video.percent, 'aria-valuemin': 0, 'aria-valuemax': 100 },
            el('span', { style: `width:${video.percent}%` }), el('i')),
          el('div', { class: 'status' }, el('span', { class: `dot${video?.playing ? ' live' : ''}` }), status),
        ),
      ),
    ),
    button,
    actionError && el('p', { class: 'small danger', role: 'alert' }, actionError),
    !actionError && lastError && el('p', { class: 'small danger', role: 'alert' }, `${lastError} It will retry automatically.`),
    !done && undone && el('p', { class: 'small muted', style: 'text-align:center' },
      'Undone. It won’t be marked automatically again, but you can mark it yourself.'),
    !done && !undone && el('p', { class: 'small muted', style: 'text-align:center' },
      settings.autoMark ? 'Marked automatically at 80%.' : 'Automatic marking is off (see Settings).'),
  );
}

function Sites() {
  return el('div', { class: 'panel' },
    SiteList(hostOf(tab?.url)),
    el('p', { class: 'small muted' }, 'Titles are recognised from the page address and title, so only these sites are tracked.'),
  );
}

function Settings() {
  const { settings, user } = state;
  const toggle = (key, label, hint) => {
    const sw = el('button', { class: 'switch', role: 'switch', 'aria-checked': String(settings[key]), 'aria-label': label, onclick: async () => {
      const next = !(sw.getAttribute('aria-checked') === 'true');
      sw.setAttribute('aria-checked', String(next));
      state.settings = await send({ type: MSG.SET_SETTINGS, patch: { [key]: next } });
    } });
    return el('div', { class: 'row' }, el('div', {}, el('div', { style: 'font-weight:500' }, label), el('div', { class: 'small muted' }, hint)), sw);
  };

  return el('div', { class: 'panel' },
    el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:14px' },
      toggle('autoMark', 'Mark automatically', 'Add a title once 80% has played.'),
      toggle('notify', 'Notifications', 'Tell me when something is added.'),
    ),
    el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:10px' },
      el('div', {}, el('div', { class: 'small muted' }, 'Signed in as'), el('div', { style: 'font-weight:600;word-break:break-all' }, user.email)),
      el('div', { class: 'row' },
        el('button', { class: 'btn btn-ghost', style: 'width:auto', onclick: () => openLink(APP_URL) }, 'Open Folio'),
        el('button', { class: 'btn btn-ghost', style: 'width:auto', onclick: async () => { await send({ type: MSG.SIGN_OUT }); await refresh(); render(); } }, 'Sign out'),
      ),
    ),
    el('p', { class: 'small muted', style: 'text-align:center' }, `Folio Tracker ${VERSION}`),
  );
}

// ── rendering ───────────────────────────────────────────────
function renderPanel({ animate = true } = {}) {
  if (!panel) return;
  panel.toggleAttribute('data-still', !animate); // polling must not replay entrance animations
  const content = view === 'sites' ? Sites() : view === 'settings' ? Settings() : NowPlaying();
  panel.replaceChildren(content);
}

function render() {
  clearInterval(pollTimer);
  if (!state) {
    app.replaceChildren(Header(), NowPlaying()); // skeleton until the first state arrives
    return;
  }
  if (!state.signedIn) {
    app.replaceChildren(...SignedOut());
    return;
  }

  panel = el('div', { class: 'panel' });
  app.replaceChildren(
    Header(),
    Segmented(
      [{ id: 'now', label: 'Now playing' }, { id: 'sites', label: 'Sites' }, { id: 'settings', label: 'Settings' }],
      view,
      (next) => { view = next; renderPanel(); },
    ),
    panel,
  );
  renderPanel();

  // Keep progress fresh while the popup is open on the "Now playing" view.
  pollTimer = setInterval(async () => {
    if (view !== 'now') return;
    await refresh();
    renderPanel({ animate: false });
  }, POLL_MS);
}

async function init() {
  sites = await (await fetch(browser.runtime.getURL('sites.json'))).json();
  [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  render(); // skeleton first
  await refresh();
  render();
}

init();
