// Client-side cache of parts and settings, with change notifications.
import { api, toast, showError } from './lib.js';

const listeners = new Set();

export const state = {
  session: null,
  settings: {},
  parts: [],
  byId: new Map(),
  groups: { categories: [], locations: [] },
  /** partId -> { need, projects: [{ id, name, status, need }] } for projects that aren't done or archived */
  usage: new Map(),
  loaded: false,
};

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(what) {
  for (const fn of listeners) fn(what);
}

function rebuildGroups() {
  const count = field => {
    const m = new Map();
    for (const p of state.parts) {
      const k = p[field];
      if (!k) continue;
      const g = m.get(k) || { name: k, parts: 0, pieces: 0 };
      g.parts++;
      g.pieces += p.qty;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  };
  state.groups = { categories: count('category'), locations: count('location') };
}

let loading = null;
export function loadParts() {
  // Callers that ask at the same moment share one request.
  loading ??= (async () => {
    try {
      const r = await api('/parts');
      state.parts = r.parts;
      state.byId = new Map(r.parts.map(p => [p.id, p]));
      state.usage = new Map(Object.entries(r.usage || {}).map(([k, v]) => [Number(k), v]));
      rebuildGroups();
      state.loaded = true;
      state.loadedAt = Date.now();
      emit('parts');
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Replace or insert parts in the cache after the server returns them. */
export function upsertParts(list, { silent = false } = {}) {
  for (const p of list) {
    const i = state.parts.findIndex(x => x.id === p.id);
    if (i >= 0) state.parts[i] = p; else state.parts.push(p);
    state.byId.set(p.id, p);
  }
  state.parts.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  rebuildGroups();
  if (!silent) emit('parts');
}

export function removePart(id) {
  state.parts = state.parts.filter(p => p.id !== id);
  state.byId.delete(id);
  rebuildGroups();
  emit('parts');
}

/** What active (planned or building) projects need of a part. */
export const needOf = p => state.usage.get(p.id)?.need || 0;

/**
 * How many more of a part your active projects need than you have, or 0.
 * Plenty and Some count as enough; Low and Out with any need count as short.
 */
export function shortfall(p) {
  const need = needOf(p);
  if (!need) return 0;
  if (p.stockLevel) return p.stockLevel === 'low' || p.stockLevel === 'out' ? need : 0;
  return Math.max(0, Math.round((need - p.qty) * 1000) / 1000);
}

export async function saveSettings(patch) {
  state.settings = await api('/settings', { method: 'PUT', body: patch });
  applyTheme();
  emit('settings');
  return state.settings;
}

export function applyTheme() {
  const t = state.settings.theme || 'system';
  document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute('content', dark ? '#0f0f11' : '#f2f2f5');
}

export const costOn = () => Boolean(state.settings.costTracking);

/** Undo the most recent change to your parts, wherever it was made. */
export async function undoLast() {
  try {
    const r = await api('/history/undo', { method: 'POST', body: {} });
    await loadParts();
    emit('undo');
    toast(`Undid: ${r.summary}`);
    return r;
  } catch (e) {
    showError(e);
    return null;
  }
}
