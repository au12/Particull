// Small UI toolkit: element builder, API client, sheets, toasts, icons.

/** h('div.cls#id', {attrs}, ...children) */
export function h(tag, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    if (attrs != null) children.unshift(attrs);
    attrs = {};
  }
  const [, name = 'div', rest = ''] = tag.match(/^([a-z0-9-]*)(.*)$/i);
  const el = document.createElement(name || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'open' || k === 'hidden' || k === 'required' || k === 'autofocus' || k === 'readOnly') el[k] = Boolean(v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// ---------- icons (24px grid, 1.75 stroke) ----------
const P = {
  parts: '<path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
  projects: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9 3.5h6v3H9zM8.5 11h7M8.5 14.5h7M8.5 18h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.3-4.3"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
  download: '<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14"/>',
  upload: '<path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M5 19.5h14"/>',
  paste: '<rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 4.5V3.5h6v1M9 10h6M9 13.5h6M9 17h3"/>',
  chat: '<path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z"/><path d="M8.5 10.5h7M8.5 13.5h4.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  trash: '<path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l.8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7M9 7V4.5h6V7"/>',
  cart: '<circle cx="9.5" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/><path d="M3 4h2.2l2.3 11.2a1.5 1.5 0 0 0 1.5 1.3h8.3a1.5 1.5 0 0 0 1.5-1.2L20.5 8H6.1"/>',
  build: '<path d="M14.5 5.5a4 4 0 0 0 4.9 4.9l1.1 1.1-2.1 2.1-1.2-1.2-7.7 7.7a1.8 1.8 0 0 1-2.6-2.6l7.7-7.7-1.2-1.2 2.1-2.1z"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  back: '<path d="M15 5.5 8.5 12l6.5 6.5"/>',
  chevron: '<path d="m9 5.5 6.5 6.5L9 18.5"/>',
  down: '<path d="m6 9.5 6 6 6-6"/>',
  refresh: '<path d="M19.5 8A8 8 0 0 0 5 7.4M4.5 16a8 8 0 0 0 14.5.6"/><path d="M19.5 3.5V8H15M4.5 20.5V16H9"/>',
  sort: '<path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  swap: '<path d="M4 8h14m0 0-3.5-3.5M18 8l-3.5 3.5M20 16H6m0 0 3.5-3.5M6 16l3.5 3.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  warn: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  file: '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-10z"/><path d="M14 3.5v5h5"/>',
};

export function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', `icon ${cls}`.trim());
  s.innerHTML = P[name] || '';
  return s;
}

// ---------- API ----------
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = fn => { onUnauthorized = fn; };

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, "Can't reach Particull. Check that the container is running.");
  }
  if (res.status === 401 && !path.startsWith('/login')) {
    onUnauthorized();
    throw new ApiError(401, 'Sign in to continue.');
  }
  if (raw && res.ok) return res.text();
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new ApiError(res.status, data?.error || `The server answered ${res.status}.`);
  return data;
}

// ---------- toasts ----------
let toastHost;
export function toast(message, { action, onAction, timeout = 5000, kind = '' } = {}) {
  if (!toastHost) {
    toastHost = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const dialogs = [...document.querySelectorAll('dialog[open]:not(.closing):not([data-gone])')];
  const host = dialogs.at(-1) || document.body;
  if (toastHost.parentNode !== host) host.append(toastHost);
  const t = h(`div.toast${kind ? `.toast-${kind}` : ''}`, h('span', message));
  let timer;
  const close = () => {
    clearTimeout(timer);
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 180);
  };
  if (action) {
    t.append(h('button.toast-action', { type: 'button', onclick: () => { close(); onAction?.(); } }, action));
  }
  toastHost.append(t);
  timer = setTimeout(close, timeout);
  return close;
}

export function showError(e) {
  toast(e?.message || String(e), { kind: 'error', timeout: 7000 });
}

// ---------- sheets (dialogs) ----------
/**
 * Open a sheet. Bottom sheet on phones, side panel or centered dialog on wider screens.
 * @returns {{el: HTMLDialogElement, body: HTMLElement, footer: HTMLElement, close: Function}}
 */
export function sheet({ title, subtitle, size = 'md', onClose, footer: withFooter = true } = {}) {
  const body = h('div.sheet-body');
  const footer = h('div.sheet-footer');
  const titleId = `sheet-title-${Math.random().toString(36).slice(2, 8)}`;
  const closeBtn = h('button.icon-btn.sheet-close', { type: 'button', 'aria-label': 'Close', onclick: () => close() }, icon('x'));
  const el = h(`dialog.sheet.sheet-${size}`, { 'aria-labelledby': titleId },
    h('div.sheet-panel',
      h('header.sheet-head',
        h('div.sheet-titles', h('h2', { id: titleId }, title), subtitle && h('p.sheet-sub', subtitle)),
        closeBtn),
      body,
      withFooter && footer));
  let closed = false;
  let asking = false;
  async function close(result, force = false) {
    if (closed || asking) return;
    if (!force && ctl.beforeClose) {
      asking = true;
      const ok = await ctl.beforeClose(result);
      asking = false;
      if (!ok) return;
    }
    closed = true;
    el.classList.add('closing');
    const done = () => {
      // Toasts shown while this sheet was open live inside it; keep them on screen.
      const toasts = el.querySelector('.toasts');
      if (toasts) (document.querySelector('dialog[open]:not(.closing):not([data-gone])') || document.body).append(toasts);
      el.close();
      el.remove();
      onClose?.(result);
    };
    el.dataset.gone = '1';
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) done(); else setTimeout(done, 160);
  }
  el.addEventListener('cancel', e => { e.preventDefault(); close(); });
  el.addEventListener('mousedown', e => { if (e.target === el) el.dataset.down = '1'; });
  el.addEventListener('click', e => { if (e.target === el && el.dataset.down) close(); delete el.dataset.down; });
  document.body.append(el);
  el.showModal();
  // Start focus on the sheet itself, not its close button; callers move it to the first field.
  const panel = el.querySelector('.sheet-panel');
  panel.tabIndex = -1;
  panel.focus({ preventScroll: true });
  const ctl = { el, body, footer, close, beforeClose: null, setTitle: t => { el.querySelector('h2').textContent = t; } };
  return ctl;
}

export function confirmSheet({ title, message, confirm = 'Confirm', danger = false, cancel = 'Cancel' }) {
  return new Promise(resolve => {
    const s = sheet({ title, size: 'sm', onClose: r => resolve(Boolean(r)) });
    s.body.append(h('p.confirm-text', message));
    s.footer.append(
      h('button.btn', { type: 'button', onclick: () => s.close(false) }, cancel),
      h(`button.btn.${danger ? 'btn-danger' : 'btn-primary'}`, { type: 'button', onclick: () => s.close(true) }, confirm));
    s.footer.lastChild.focus();
  });
}

export function promptSheet({ title, label, value = '', confirm = 'Save', list }) {
  return new Promise(resolve => {
    let result = null;
    const s = sheet({ title, size: 'sm', onClose: () => resolve(result) });
    const listId = list ? `dl-${Math.random().toString(36).slice(2, 7)}` : null;
    const input = h('input.input', { value, list: listId, autocomplete: 'off' });
    const form = h('form', { onsubmit: e => { e.preventDefault(); result = input.value.trim(); s.close(); } },
      h('label.field', h('span.field-label', label), input),
      list && h('datalist', { id: listId }, list.map(v => h('option', { value: v }))));
    s.body.append(form);
    s.footer.append(
      h('button.btn', { type: 'button', onclick: () => s.close() }, 'Cancel'),
      h('button.btn.btn-primary', { type: 'button', onclick: () => form.requestSubmit() }, confirm));
    input.focus();
    input.select();
  });
}

// ---------- menus ----------
export function menu(anchor, items) {
  document.querySelector('.menu')?.remove();
  const m = h('div.menu', { role: 'menu' },
    items.filter(Boolean).map(it => it === '-' ? h('div.menu-sep') :
      h(`button.menu-item${it.danger ? '.danger' : ''}`, { type: 'button', role: 'menuitem', onclick: () => { close(); it.action(); } },
        it.icon && icon(it.icon), h('span', it.label))));
  const host = anchor.closest('dialog') || document.body;
  host.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  Object.assign(m.style, { left: `${left}px`, top: `${top}px` });
  m.querySelector('button')?.focus();
  const onDoc = e => { if (!m.contains(e.target) && e.target !== anchor) close(); };
  const onKey = e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const btns = $$('button', m);
      const i = btns.indexOf(document.activeElement);
      btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length].focus();
    }
  };
  function close() {
    m.remove();
    document.removeEventListener('pointerdown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  }
  setTimeout(() => {
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  });
  return close;
}

// ---------- misc ----------
export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and plain-http LAN addresses don't expose the clipboard API.
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0', top: '0' } });
    ta.value = text;
    (document.querySelector('dialog[open]') || document.body).append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
}

export function downloadUrl(url) {
  const a = h('a', { href: url, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

export const isTouch = () => matchMedia('(pointer: coarse)').matches;

export function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
    r.readAsText(file);
  });
}

export function money(n, currency = '$') {
  if (n == null || !Number.isFinite(n)) return '';
  return `${currency}${n < 1 && n > 0 ? n.toFixed(3).replace(/0$/, '') : n.toFixed(2)}`;
}

/** Quantity stepper: [−] [ n ] [+]. Calls onChange(delta) or onSet(value). */
export function stepper({ value, onDelta, onSet, label = 'Quantity', size = '' }) {
  const out = h('input.stepper-value', {
    type: 'text', inputmode: 'numeric', pattern: '[0-9]*', value: String(value), 'aria-label': label, autocomplete: 'off',
    onfocus: e => e.target.select(),
    onkeydown: e => {
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
      if (e.key === 'Escape') { e.target.value = String(value); e.target.blur(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); onDelta(1); }
      if (e.key === 'ArrowDown') { e.preventDefault(); onDelta(-1); }
    },
    onchange: e => {
      const n = parseInt(e.target.value.replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(n) && n !== value) onSet(n); else e.target.value = String(value);
    },
  });
  const btn = (d, ic, name) => h('button.stepper-btn', {
    type: 'button', 'aria-label': `${name} one`, tabindex: '-1',
    onclick: e => { e.stopPropagation(); onDelta(d); },
  }, icon(ic));
  const el = h(`div.stepper${size ? `.stepper-${size}` : ''}`, { onclick: e => e.stopPropagation() }, btn(-1, 'minus', 'Remove'), out, btn(1, 'plus', 'Add'));
  el.update = v => { value = v; if (document.activeElement !== out) out.value = String(v); };
  return el;
}
