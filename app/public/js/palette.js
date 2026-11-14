// Quick jump (⌘K): parts, projects, locations and actions from one search box.
// Also the keyboard shortcuts sheet (?) and undo (⌘Z) from anywhere.
import { h, clear, icon, api, sheet, kbd, modKey, isTyping, plural } from './lib.js';
import { state, undoLast } from './state.js';
import { searchParts, openPartAnywhere, openPartEditor } from './parts.js';
import { openNewProject } from './projects.js';
import { openExport } from './exporter.js';
import { openPasteList, openKit } from './addmany.js';
import { formatStock } from '../shared/stock.js';

const go = hash => { location.hash = hash; };

let projectCache = { at: 0, list: [] };
async function loadProjects() {
  if (Date.now() - projectCache.at < 20000) return projectCache.list;
  try {
    const { projects } = await api('/projects');
    projectCache = { at: Date.now(), list: projects };
  } catch { /* offline: parts and actions still work */ }
  return projectCache.list;
}

function projectMeta(p) {
  if (p.archived) return 'Archived';
  const sm = p.summary;
  if (!sm?.lines) return 'No parts listed';
  if (sm.ready) return 'Everything in stock';
  return [sm.review && `${sm.review} to check`, sm.short + sm.missing && `${sm.short + sm.missing} to buy`].filter(Boolean).join(', ');
}

const actions = () => [
  { label: 'Add part', icon: 'plus', keys: ['N'], run: () => openPartEditor() },
  { label: 'New project', icon: 'projects', run: () => openNewProject() },
  { label: 'Export parts for chat', icon: 'share', run: () => openExport() },
  { label: 'Paste a list of parts', icon: 'paste', run: () => openPasteList() },
  { label: 'Add a kit', icon: 'kit', run: () => openKit() },
  { label: 'Print location labels', icon: 'qr', words: 'qr code drawer bin', run: () => go('#/labels') },
  { label: 'Undo last change', icon: 'undo', keys: [modKey(), 'Z'], run: () => undoLast() },
  { label: 'Go to Parts', icon: 'parts', run: () => go('#/parts') },
  { label: 'Go to Projects', icon: 'projects', run: () => go('#/projects') },
  { label: 'Go to Settings', icon: 'settings', words: 'backup theme cost', run: () => go('#/settings') },
  { label: 'Keyboard shortcuts', icon: 'keyboard', keys: ['?'], run: () => openShortcuts() },
];

let current = null;

export function openPalette() {
  if (current) { current.focus(); return; }
  const input = h('input.palette-input', {
    type: 'text', placeholder: 'Jump to a part, project or action', autocomplete: 'off', spellcheck: 'false',
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', 'aria-label': 'Jump to',
  });
  const list = h('div.palette-list', { id: 'palette-list', role: 'listbox', 'aria-label': 'Results' });
  const el = h('dialog.palette', { 'aria-label': 'Jump to' },
    h('div.palette-panel',
      h('label.palette-search', icon('search'), input, kbd('esc')),
      list,
      h('div.palette-foot',
        h('span', kbd('↑'), kbd('↓'), 'to move'),
        h('span', kbd('↵'), 'to open'),
        h('span', kbd('esc'), 'to close'))));
  document.body.append(el);
  el.showModal();

  let items = [];
  let active = 0;
  let projects = projectCache.list;
  loadProjects().then(l => { projects = l; if (el.isConnected) draw(); });

  const close = () => { if (el.open) el.close(); el.remove(); current = null; };
  el.addEventListener('cancel', e => { e.preventDefault(); close(); });
  el.addEventListener('click', e => { if (e.target === el) close(); });

  function draw() {
    const q = input.value.trim();
    const lower = q.toLowerCase();
    const sections = [];
    if (q) {
      const parts = searchParts(q, 7);
      if (parts.length) sections.push(['Parts', parts.map(p => ({ label: p.name, meta: [formatStock(p), p.location].filter(Boolean).join(' · '), icon: 'parts', run: () => openPartAnywhere(p.id) }))]);
      const found = projects.filter(p => p.name.toLowerCase().includes(lower)).slice(0, 5);
      if (found.length) sections.push(['Projects', found.map(p => ({ label: p.name, meta: projectMeta(p), icon: 'projects', run: () => go(`#/projects/${p.id}`) }))]);
      const locs = state.groups.locations.filter(l => l.name.toLowerCase().includes(lower)).slice(0, 5);
      if (locs.length) sections.push(['Locations', locs.map(l => ({ label: l.name, meta: plural(l.parts, 'part'), icon: 'pin', run: () => go(`#/parts/loc/${encodeURIComponent(l.name)}`) }))]);
      const acts = actions().filter(a => `${a.label} ${a.words || ''}`.toLowerCase().includes(lower));
      if (acts.length) sections.push(['Actions', acts]);
    } else {
      const open = projects.filter(p => !p.archived && p.status !== 'done').slice(0, 4);
      if (open.length) sections.push(['Projects', open.map(p => ({ label: p.name, meta: projectMeta(p), icon: 'projects', run: () => go(`#/projects/${p.id}`) }))]);
      sections.push(['Actions', actions()]);
    }
    items = sections.flatMap(([, rows]) => rows);
    active = Math.min(active, Math.max(0, items.length - 1));
    let n = 0;
    clear(list, items.length
      ? sections.map(([title, rows]) => [
        h('div.palette-section', { role: 'presentation' }, title),
        rows.map(it => {
          const i = n++;
          return h('button.palette-item', {
            type: 'button', role: 'option', id: `pal-${i}`, tabindex: '-1', 'aria-selected': String(i === active),
            onclick: () => choose(i),
            onmousemove: () => { if (active !== i) { active = i; mark(); } },
          }, icon(it.icon), h('span.palette-name', it.label), it.meta && h('span.palette-meta', it.meta), it.keys && h('span.palette-keys', it.keys.map(kbd)));
        })])
      : h('div.palette-empty', `Nothing matches “${q}”.`));
    input.setAttribute('aria-activedescendant', items.length ? `pal-${active}` : '');
  }

  function mark() {
    list.querySelectorAll('.palette-item').forEach((b, i) => b.setAttribute('aria-selected', String(i === active)));
    list.querySelector(`#pal-${active}`)?.scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', `pal-${active}`);
  }

  function choose(i) {
    const it = items[i];
    if (!it) return;
    close();
    it.run();
  }

  input.addEventListener('input', () => { active = 0; draw(); });
  input.addEventListener('keydown', e => {
    if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
  });
  draw();
  input.focus();
  current = { focus: () => input.focus() };
}

export function openShortcuts() {
  const s = sheet({ title: 'Keyboard shortcuts', size: 'sm', footer: false });
  const row = (name, ...keys) => [h('span.shortcut-name', name), h('span.shortcut-keys', keys.map(k => (k === 'or' ? h('span', 'or') : kbd(k))))];
  const mod = modKey();
  s.body.append(h('div.shortcut-list',
    h('p.shortcut-group', 'Anywhere'),
    row('Jump to a part, project or action', mod, 'K'),
    row('Undo the last change to your parts', mod, 'Z'),
    row('Show these shortcuts', '?'),
    h('p.shortcut-group', 'Parts'),
    row('Search', '/'),
    row('Add a part', 'N'),
    row('Move between parts', '↑', '↓'),
    row('Open a part', '↵'),
    row('Add or take away one', '+', '−'),
    row('Select a part', 'X'),
    row('Close details or stop selecting', 'esc'),
    row('Add the parts in a list you copied', mod, 'V'),
    h('p.shortcut-group', 'Adding a part'),
    row('Add it and start another', '⇧', '↵'),
    row('Save', mod, '↵'),
    h('p.shortcut-group', 'A project'),
    row('Import a BOM you copied', mod, 'V')));
}

/** Shortcuts that work on every page. */
export function installShortcuts() {
  document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && !e.shiftKey && key === 'k') {
      e.preventDefault();
      if (!document.querySelector('dialog.sheet[open]')) openPalette();
      return;
    }
    if (document.querySelector('dialog[open]')) return;
    if (mod && !e.altKey && !e.shiftKey && key === 'z') {
      // In a text field, undo belongs to the text.
      if (isTyping()) return;
      e.preventDefault();
      undoLast();
      return;
    }
    if (e.key === '?' && !mod && !isTyping()) {
      e.preventDefault();
      openShortcuts();
    }
  });
}
