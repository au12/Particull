// Client-side cache of parts and settings, with change notifications.
import { api } from './lib.js';

const listeners = new Set();

export const state = {
  session: null,
  settings: {},
  parts: [],
  byId: new Map(),
  groups: { categories: [], locations: [] },
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
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  };
  state.groups = { categories: count('category'), locations: count('location') };
}

export async function loadParts() {
  const r = await api('/parts');
  state.parts = r.parts;
  state.byId = new Map(r.parts.map(p => [p.id, p]));
  rebuildGroups();
  state.loaded = true;
  emit('parts');
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
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#14191b' : '#f2f4f3');
}

export const costOn = () => Boolean(state.settings.costTracking);
