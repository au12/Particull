// Boot, sign-in, navigation.
import { h, clear, icon, api, showError, setUnauthorizedHandler } from './lib.js';
import { state, loadParts, applyTheme } from './state.js';
import { renderParts } from './parts.js';
import { renderProjects, renderProject } from './projects.js';
import { renderSettings } from './settings.js';

const NAV = [
  { key: 'parts', label: 'Parts', icon: 'parts', href: '#/parts' },
  { key: 'projects', label: 'Projects', icon: 'projects', href: '#/projects' },
  { key: 'settings', label: 'Settings', icon: 'settings', href: '#/settings' },
];

const app = document.getElementById('app');
let main;
let cleanup = null;

function brand() {
  return h('a.brand', { href: '#/parts', 'aria-label': 'Particull home' },
    h('img.brand-mark', { src: '/icons/icon.svg', alt: '', width: '28', height: '28' }),
    h('span.brand-name', 'Particull'));
}

function shell() {
  main = h('main.view', { id: 'main', tabindex: '-1' });
  clear(app,
    h('a.skip-link', { href: '#main', onclick: e => { e.preventDefault(); main.focus(); } }, 'Skip to content'),
    h('div.shell',
      h('aside.rail',
        brand(),
        h('nav.rail-nav', { 'aria-label': 'Main' }, NAV.map(n => h('a.nav-link', { href: n.href, dataset: { key: n.key } }, icon(n.icon), h('span', n.label)))),
        h('div.rail-sub', { id: 'rail-sub' })),
      main),
    h('nav.tabbar', { 'aria-label': 'Main' }, NAV.map(n => h('a.tab-link', { href: n.href, dataset: { key: n.key } }, icon(n.icon), h('span', n.label)))));
}

function route() {
  const hash = location.hash.replace(/^#\/?/, '') || 'parts';
  const [section, id] = hash.split('/');
  const key = NAV.some(n => n.key === section) ? section : 'parts';
  document.querySelectorAll('.nav-link, .tab-link').forEach(a => {
    if (a.dataset.key === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.querySelectorAll('dialog[open]').forEach(d => { d.close(); d.remove(); });
  document.querySelector('.menu')?.remove();
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  document.getElementById('rail-sub')?.replaceChildren();
  window.scrollTo(0, 0);
  const titles = { parts: 'Parts', projects: 'Projects', settings: 'Settings' };
  document.title = `${titles[key]} · Particull`;
  if (key === 'parts') cleanup = renderParts(main);
  else if (key === 'projects' && id) { cleanup = renderProject(main, Number(id)); document.title = 'Project · Particull'; }
  else if (key === 'projects') renderProjects(main);
  else cleanup = renderSettings(main);
}

function loginScreen(message = '') {
  const pw = h('input.input.input-lg', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Password', placeholder: 'Password' });
  const err = h('p.login-error', { role: 'alert' }, message);
  const btn = h('button.btn.btn-primary.btn-block', { type: 'submit' }, 'Sign in');
  clear(app, h('div.login',
    h('form.login-card', {
      onsubmit: async e => {
        e.preventDefault();
        btn.disabled = true;
        err.textContent = '';
        try {
          const r = await api('/login', { method: 'POST', body: { password: pw.value } });
          state.settings = r.settings;
          start();
        } catch (ex) {
          err.textContent = ex.message;
          btn.disabled = false;
          pw.select();
        }
      },
    },
    h('img.login-mark', { src: '/icons/icon.svg', alt: '', width: '56', height: '56' }),
    h('h1', 'Particull'),
    h('p.login-sub', 'Enter the password set on this server.'),
    pw, err, btn)));
  pw.focus();
}

async function start() {
  shell();
  try {
    await loadParts();
  } catch (e) {
    if (e.status === 401) return;
    showError(e);
  }
  applyTheme();
  route();
}

async function boot() {
  setUnauthorizedHandler(() => loginScreen('Your session ended. Sign in again.'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  window.addEventListener('hashchange', route);
  try {
    state.session = await api('/session');
  } catch (e) {
    clear(app, h('div.login', h('div.login-card', h('h1', 'Particull'), h('p.login-error', e.message), h('button.btn', { type: 'button', onclick: () => location.reload() }, 'Try again'))));
    return;
  }
  if (state.session.passwordRequired && !state.session.signedIn) { loginScreen(); return; }
  state.settings = state.session.settings || {};
  applyTheme();
  start();
}

boot();
