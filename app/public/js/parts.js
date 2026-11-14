// Parts page: the list (a sortable table on wide screens, two-line rows on phones), quick
// amount changes, search and filters, the inspector beside the list, and selecting parts to
// change many at once. Only the rows on screen are drawn, so thousands of parts stay quick.
import { h, clear, icon, api, toast, showError, confirmSheet, promptSheet, menu, debounce, plural, isTouch, isTyping, money, stepper, kbd } from './lib.js';
import { state, onChange, upsertParts, loadParts, costOn, needOf, shortfall, undoLast } from './state.js';
import { analyze } from '../shared/match.js';
import { LEVELS, LEVEL_LABELS, LEVEL_SHORT, UNITS, isLow, isOut, stockRank, formatStock, formatNumber, unitLabel, isCountUnit } from '../shared/stock.js';
import { openPartEditor } from './editor.js';
import { openPasteList, openKit } from './addmany.js';
import { openExport } from './exporter.js';
import { openMerge } from './merge.js';
import { virtualList } from './vlist.js';
import { createInspector } from './inspector.js';
import { acceptDropAndPaste } from './drop.js';

export { openPartEditor };

const wide = matchMedia('(min-width: 1200px)');
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name, b.name);
const cls = list => list.filter(Boolean).join(' ');

// ---------- what's shown ----------
const DEFAULT_DIR = { name: 1, package: 1, mpn: 1, location: 1, cost: -1, amount: 1, recent: -1 };
const view = { query: '', filter: 'all', sort: { key: 'name', dir: 1 }, selecting: false, selected: new Set(), current: null };
try {
  const saved = JSON.parse(localStorage.getItem('particull.partsView') || '{}');
  if (typeof saved.filter === 'string') view.filter = saved.filter;
  const older = { name: ['name', 1], most: ['amount', -1], least: ['amount', 1], recent: ['recent', -1], location: ['location', 1] };
  if (typeof saved.sort === 'string' && older[saved.sort]) view.sort = { key: older[saved.sort][0], dir: older[saved.sort][1] };
  else if (saved.sort?.key in DEFAULT_DIR) view.sort = { key: saved.sort.key, dir: saved.sort.dir === -1 ? -1 : 1 };
} catch { /* private mode */ }
// A location (often from scanning a label) is for this visit only.
const saveView = () => {
  try { localStorage.setItem('particull.partsView', JSON.stringify({ filter: view.filter.startsWith('loc:') ? 'all' : view.filter, sort: view.sort })); } catch { /* ignore */ }
};

// ---------- search ----------
// Plain text matching, plus values: "4k7" finds "4.7k resistor", "0.1u" finds "100nF".
const searchIndex = new Map();
function indexed(p) {
  let e = searchIndex.get(p.id);
  if (!e || e.at !== p.updatedAt) {
    const a = analyze(`${p.name} ${(p.aliases || []).join(' ')}`, { package: p.package });
    e = {
      at: p.updatedAt,
      hay: `${p.name} ${p.mpn} ${p.package} ${p.category} ${p.location} ${p.notes} ${(p.aliases || []).join(' ')}`.toLowerCase(),
      values: new Set(a.values.values()),
    };
    searchIndex.set(p.id, e);
  }
  return e;
}

function queryTerms(q) {
  return q.toLowerCase().split(/\s+/).filter(Boolean).map(t => {
    const vals = [...analyze(t).values.values()].filter(v => /^(res|cap|ind|v):/.test(v));
    return { text: t, value: vals[0] || null };
  });
}

function matches(p, terms) {
  if (!terms.length) return true;
  const e = indexed(p);
  return terms.every(t => e.hay.includes(t.text) || (t.value && e.values.has(t.value)));
}

/** Parts matching a search, best first, for the quick-jump box. */
export function searchParts(q, limit = 8) {
  const terms = queryTerms(q);
  if (!terms.length) return [];
  const lower = q.trim().toLowerCase();
  return state.parts.filter(p => matches(p, terms))
    .map(p => {
      const n = p.name.toLowerCase();
      return { p, rank: n === lower ? 0 : n.startsWith(lower) ? 1 : n.includes(lower) ? 2 : 3 };
    })
    .sort((a, b) => a.rank - b.rank || byName(a.p, b.p))
    .slice(0, limit)
    .map(x => x.p);
}

// ---------- sorting ----------
const SORT = {
  name: { label: 'Name', cmp: byName },
  package: { label: 'Package', field: 'package' },
  mpn: { label: 'Part number', field: 'mpn' },
  location: { label: 'Location', field: 'location' },
  cost: { label: 'Cost', cmp: (a, b) => (a.cost ?? 0) - (b.cost ?? 0), empty: p => p.cost == null },
  amount: { label: 'Amount', cmp: (a, b) => stockRank(a) - stockRank(b) },
  recent: { label: 'Recently changed', cmp: (a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || '') },
};
const SORT_MENU = [['Name', 'name', 1], ['Location', 'location', 1], ['Fewest in stock', 'amount', 1], ['Most in stock', 'amount', -1], ['Recently changed', 'recent', -1]];

function sortParts(list) {
  const { key, dir } = view.sort;
  const s = SORT[key] || SORT.name;
  const cmp = s.cmp || ((a, b) => collator.compare(a[s.field], b[s.field]));
  const empty = s.empty || (s.field ? p => !p[s.field] : null);
  return list.sort((a, b) => {
    // Parts without the value go last either way.
    if (empty) { const d = empty(a) - empty(b); if (d) return d; }
    return dir * cmp(a, b) || byName(a, b);
  });
}

function sortLabel() {
  const { key, dir } = view.sort;
  if (key === 'amount') return dir === 1 ? 'Fewest in stock' : 'Most in stock';
  if (key === 'name' && dir === -1) return 'Name, Z to A';
  return SORT[key]?.label || 'Name';
}

// ---------- quick amount changes ----------
let page = null;
const pending = new Map();
let closeQtyToast = null;

function offerUndo(text) {
  closeQtyToast?.();
  closeQtyToast = toast(text, { action: 'Undo', timeout: 4500, onAction: () => undoLast() });
}

function changeQty(part, { delta, set }) {
  const next = Math.max(0, Math.round((set != null ? set : part.qty + delta) * 1000) / 1000);
  if (next === part.qty) return;
  const p = pending.get(part.id) || { base: part.qty };
  part.qty = next;
  part.updatedAt = new Date().toISOString();
  upsertParts([part], { silent: true });
  page?.partChanged(part);
  // Quick taps become one save, and one undo.
  clearTimeout(p.timer);
  p.timer = setTimeout(async () => {
    pending.delete(part.id);
    try {
      const saved = await api(`/parts/${part.id}/qty`, { method: 'POST', body: { set: part.qty } });
      upsertParts([saved], { silent: true });
      page?.partChanged(saved);
      if (saved.qty !== p.base) offerUndo(`${saved.name}: ${formatNumber(p.base)} → ${formatStock(saved).toLowerCase()}`);
    } catch (e) {
      part.qty = p.base;
      upsertParts([part], { silent: true });
      page?.partChanged(part);
      showError(e);
    }
  }, 350);
  pending.set(part.id, p);
}

async function setLevel(part, level) {
  if (part.stockLevel === level) return;
  try {
    const saved = await api(`/parts/${part.id}`, { method: 'PUT', body: { stockLevel: level } });
    upsertParts([saved]);
    offerUndo(`${saved.name}: ${part.stockLevel ? LEVEL_LABELS[part.stockLevel] : 'counted'} → ${saved.stockLevel ? LEVEL_LABELS[saved.stockLevel].toLowerCase() : 'counted exactly'}`);
  } catch (e) { showError(e); }
}

function levelMenu(anchor, part) {
  menu(anchor, [
    ...LEVELS.map(l => ({ label: LEVEL_LABELS[l], icon: part.stockLevel === l ? 'check' : null, action: () => setLevel(part, l) })),
    '-',
    { label: 'Count exactly', icon: part.stockLevel ? null : 'check', action: () => setLevel(part, null) },
  ]);
}

function amountEl(p) {
  if (p.stockLevel) {
    return h(`button.level-pill.level-${p.stockLevel}`, {
      type: 'button', 'aria-label': `${p.name}: ${LEVEL_LABELS[p.stockLevel]}. Change`,
      onclick: e => { e.stopPropagation(); levelMenu(e.currentTarget, state.byId.get(p.id)); },
    }, h('span.level-dot'), LEVEL_SHORT[p.stockLevel], icon('updown'));
  }
  // Just the number: click it to type a new amount. Arrow keys and +/- on the row nudge it.
  return stepper({
    value: p.qty,
    buttons: false,
    label: `Quantity of ${p.name}. Type a new amount.`,
    onDelta: d => changeQty(state.byId.get(p.id), { delta: d }),
    onSet: v => changeQty(state.byId.get(p.id), { set: v }),
  });
}

function rowLabel(p, short) {
  let s = `${p.name}, ${formatStock(p).toLowerCase()}${isCountUnit(p.unit) && !p.stockLevel ? ' on hand' : ''}`;
  if (short > 0) s += `, ${formatNumber(short)} short for projects`;
  return `${s}.`;
}

/** Open a part from anywhere: in the inspector on the parts page, otherwise in a sheet. */
export function openPartAnywhere(id) {
  const p = state.byId.get(id);
  if (!p) return;
  if (page) page.open(id); else openPartEditor(p);
}

// ---------- page ----------
export function renderParts(root, params = []) {
  view.selecting = false;
  view.selected.clear();
  view.current = null;
  if (params[0] === 'loc') {
    // A location label was scanned: show what's in it.
    view.filter = `loc:${decodeURIComponent(params.slice(1).join('/'))}`;
    view.query = '';
    history.replaceState(null, '', '#/parts');
  }
  let visible = [];
  let heights = null;

  // ---- header ----
  const summaryEl = h('p.page-sub');
  const addSeveral = [
    { label: 'Paste a list', icon: 'paste', action: () => openPasteList() },
    { label: 'Add a kit', icon: 'kit', action: () => openKit() },
  ];
  const headActions = h('div.page-actions',
    h('button.btn.btn-quiet.hide-sm', { type: 'button', onclick: openExport }, icon('share'), 'Export for chat'),
    h('button.btn.btn-quiet.hide-sm', { type: 'button', onclick: e => menu(e.currentTarget, addSeveral) }, icon('layers'), 'Add several'),
    h('button.btn.btn-primary.hide-sm', { type: 'button', onclick: () => openPartEditor(), title: 'Add part (N)' }, icon('plus'), 'Add part'),
    h('button.icon-btn.show-sm', { type: 'button', 'aria-label': 'Export for chat', onclick: openExport }, icon('share')),
    h('button.icon-btn.icon-btn-primary.show-sm', { type: 'button', 'aria-label': 'Add parts', onclick: e => menu(e.currentTarget, [
      { label: 'Add part', icon: 'plus', action: () => openPartEditor() }, ...addSeveral]) }, icon('plus')));

  // ---- toolbar ----
  const searchEl = h('input.search-input', {
    type: 'search', placeholder: 'Search, e.g. 4k7 or ESP32', value: view.query, 'aria-label': 'Search parts', enterkeyhint: 'search', autocomplete: 'off',
    oninput: debounce(e => { view.query = e.target.value; renderList(); window.scrollTo({ top: 0 }); }, 60),
    onkeydown: e => {
      if (e.key === 'Escape' && searchEl.value) { e.stopPropagation(); searchEl.value = ''; view.query = ''; renderList(); }
      if (e.key === 'Enter') { if (isTouch()) searchEl.blur(); else move(1, { from: 'top' }); }
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1, { from: 'top' }); }
    },
  });
  const sortLabelEl = h('span.hide-xs', sortLabel());
  const sortBtn = h('button.btn.btn-quiet.sort-btn', {
    type: 'button', 'aria-label': 'Sort', onclick: e => menu(e.currentTarget, SORT_MENU.map(([label, key, dir]) => ({
      label, icon: view.sort.key === key && view.sort.dir === dir ? 'check' : null, action: () => setSort(key, dir),
    }))),
  }, icon('sort'), sortLabelEl);
  const selectBtn = h('button.btn.btn-quiet.select-btn', { type: 'button', 'aria-pressed': 'false', 'aria-label': 'Select parts', title: 'Select parts to change several at once', onclick: () => setSelecting(!view.selecting) }, icon('select'), h('span.hide-xs', 'Select'));
  const colHead = h('div.col-head');
  const toolbar = h('div.toolbar',
    h('div.toolbar-row', h('label.search', icon('search'), searchEl, h('span.search-kbd', kbd('/'))), sortBtn, selectBtn));

  const chipsEl = h('div.chips', { role: 'tablist', 'aria-label': 'Filter parts' });
  const emptyEl = h('div.list-empty');
  const listEl = h('div.part-list');
  const barEl = h('div.select-bar', { role: 'toolbar', 'aria-label': 'Selected parts', hidden: true });
  const pane = h('div.parts-pane', toolbar, chipsEl, colHead, emptyEl, listEl);
  const inspector = createInspector({ onClose: () => { view.current = null; refreshItems(); } });

  root.classList.add('view-parts');
  clear(root,
    h('header.page-head', h('div', h('h1', 'Parts'), summaryEl), headActions),
    h('div.parts-layout', pane, inspector.el),
    barEl);
  const vl = virtualList(listEl);

  // ---- column headings ----
  function drawColHead() {
    const col = (key, label, c) => {
      const active = view.sort.key === key;
      const dir = active ? view.sort.dir : 0;
      return h(`button.col.${c}`, {
        type: 'button', dataset: active ? { sort: dir === 1 ? 'asc' : 'desc' } : {},
        'aria-label': `${label}${active ? `, sorted ${dir === 1 ? 'ascending' : 'descending'}` : ''}. Sort by ${label.toLowerCase()}`,
        onclick: () => setSort(key, active ? -dir : DEFAULT_DIR[key]),
      }, label, active && icon(dir === 1 ? 'up' : 'down'));
    };
    clear(colHead,
      col('name', 'Name', 'col-name'),
      col('package', 'Package', 'col-pkg'),
      col('mpn', 'Part number', 'col-mpn'),
      col('location', 'Location', 'col-loc'),
      costOn() && col('cost', 'Cost', 'col-cost'),
      col('amount', 'Amount', 'col-amt'));
  }

  function setSort(key, dir) {
    view.sort = { key, dir };
    saveView();
    sortLabelEl.textContent = sortLabel();
    drawColHead();
    renderList();
  }

  // ---- filters ----
  function applyFilter(list) {
    const f = view.filter;
    if (f === 'low') return list.filter(isLow);
    if (f === 'short') return list.filter(p => shortfall(p) > 0);
    if (f.startsWith('cat:')) return list.filter(p => p.category === f.slice(4));
    if (f.startsWith('loc:')) return list.filter(p => p.location === f.slice(4));
    return list;
  }

  function checkFilter() {
    const f = view.filter;
    // A location stays even when empty, so a label for an empty drawer says so.
    const gone = (f === 'low' && !state.parts.some(isLow))
      || (f === 'short' && !state.parts.some(p => shortfall(p) > 0))
      || (f.startsWith('cat:') && f !== 'cat:' && !state.groups.categories.some(c => c.name === f.slice(4)))
      || (f === 'cat:' && !state.parts.some(p => !p.category))
      || (f === 'loc:' && !state.parts.some(p => !p.location));
    if (gone) view.filter = 'all';
  }

  function pick(key) {
    view.filter = key;
    saveView();
    renderFilters();
    renderList();
    window.scrollTo({ top: 0 });
  }

  function renderFilters() {
    checkFilter();
    const cats = state.groups.categories;
    const locs = state.groups.locations;
    const lowCount = state.parts.filter(isLow).length;
    const shortCount = state.parts.filter(p => shortfall(p) > 0).length;
    const uncategorized = state.parts.filter(p => !p.category).length;
    const unplaced = state.parts.filter(p => !p.location).length;

    // Phones and iPads: chips across the top.
    const chip = (key, label, count) => h('button.chip', {
      type: 'button', role: 'tab', 'aria-selected': String(view.filter === key), onclick: () => pick(key),
    }, label, count != null && h('span.chip-count', count.toLocaleString()));
    const locActive = view.filter.startsWith('loc:');
    const locChip = locs.length > 0 && h('button.chip', {
      type: 'button', 'aria-selected': String(locActive), 'aria-haspopup': 'menu',
      onclick: e => menu(e.currentTarget, [
        { label: 'Any location', icon: locActive ? null : 'check', action: () => pick('all') },
        '-',
        ...locs.map(l => ({ label: `${l.name}  ·  ${l.parts}`, icon: view.filter === `loc:${l.name}` ? 'check' : null, action: () => pick(`loc:${l.name}`) })),
        unplaced > 0 && { label: `No location  ·  ${unplaced}`, icon: view.filter === 'loc:' ? 'check' : null, action: () => pick('loc:') },
        '-',
        { label: 'Print location labels', icon: 'qr', action: () => { location.hash = '#/labels'; } },
      ]),
    }, icon('pin', 'icon-sm'), locActive ? (view.filter.slice(4) || 'No location') : 'Location', icon('down', 'icon-sm'));
    clear(chipsEl,
      chip('all', 'All', state.parts.length),
      lowCount > 0 && chip('low', 'Low or out', lowCount),
      shortCount > 0 && chip('short', 'Short for projects', shortCount),
      locChip,
      cats.map(c => chip(`cat:${c.name}`, c.name, c.parts)),
      uncategorized > 0 && cats.length > 0 && chip('cat:', 'Uncategorized', uncategorized));
    chipsEl.hidden = state.parts.length === 0;

    // Wide screens: the same filters in the sidebar, under Parts.
    const rail = document.getElementById('rail-sub');
    if (!rail) return;
    const item = (key, label, count, c = '') => h(`button.rail-filter${c}`, {
      type: 'button', 'aria-pressed': String(view.filter === key), onclick: () => pick(key),
    }, h('span.rail-filter-name', label), h('span.rail-filter-count', count.toLocaleString()));
    clear(rail, state.parts.length > 0 && [
      item('all', 'All parts', state.parts.length),
      lowCount > 0 && item('low', 'Low or out', lowCount, '.rail-filter-low'),
      shortCount > 0 && item('short', 'Short for projects', shortCount, '.rail-filter-low'),
      cats.length > 0 && h('p.rail-head', h('span', 'Categories')),
      cats.map(c => item(`cat:${c.name}`, c.name, c.parts)),
      uncategorized > 0 && cats.length > 0 && item('cat:', 'Uncategorized', uncategorized),
      locs.length > 0 && h('p.rail-head', h('span', 'Locations'),
        h('button.rail-head-link', { type: 'button', title: 'Print a label with a QR code for each location', onclick: () => { location.hash = '#/labels'; } }, 'Labels')),
      locs.map(l => item(`loc:${l.name}`, l.name, l.parts)),
      unplaced > 0 && locs.length > 0 && item('loc:', 'No location', unplaced),
    ]);
  }

  function updateSummary() {
    const total = state.parts.length;
    const f = view.filter;
    const n = applyFilter(state.parts).length;
    let text;
    if (!total) text = 'Nothing here yet';
    else if (f === 'low') text = `${n.toLocaleString()} low or out, of ${plural(total, 'part')}`;
    else if (f === 'short') text = `${plural(n, 'part')} short for planned and building projects`;
    else if (f === 'cat:') text = `${plural(n, 'part')} without a category`;
    else if (f === 'loc:') text = `${plural(n, 'part')} without a location`;
    else if (f.startsWith('cat:') || f.startsWith('loc:')) text = `${plural(n, 'part')} in ${f.slice(4)}`;
    else {
      const low = state.parts.filter(isLow).length;
      text = plural(total, 'part');
      if (low) text += `, ${low} low or out`;
      if (costOn()) {
        const value = state.parts.reduce((s, p) => s + (p.cost != null && !p.stockLevel ? p.cost * p.qty : 0), 0);
        if (value) text += `, worth ${money(value, state.settings.currency)}`;
      }
    }
    summaryEl.textContent = text;
  }

  // ---- rows ----
  function readHeights() {
    const cs = getComputedStyle(listEl);
    const px = (name, d) => parseFloat(cs.getPropertyValue(name)) || d;
    return { row: px('--row-h', 58), row1: px('--row1-h', 46), head: px('--head-h', 50), headFirst: px('--head-first-h', 28) };
  }

  function groupHead(label, count, { first, tape, tapeOnly }) {
    return h(`div.group-head${first ? '.is-first' : ''}`,
      tapeOnly ? h('span.tape', label) : h('span.group-label', label),
      h('span.group-count', count.toLocaleString()),
      tape && h('span.tape', { title: `All of these are in ${tape}` }, tape));
  }

  function partRow(p, o) {
    const short = shortfall(p);
    const low = isLow(p);
    const out = isOut(p);
    const u = !p.stockLevel && unitLabel(p.unit, p.qty);
    const meta = [
      p.package && h('span.meta-pkg', p.package),
      p.mpn && h('span.meta-mpn', p.mpn),
      o.showCat && p.category && h('span.meta-cat', p.category),
      p.location && !o.hideLoc && h('span.tape', { title: 'Location' }, p.location),
      costOn() && p.cost != null && h('span.meta-cost', money(p.cost, state.settings.currency)),
    ].filter(Boolean);
    let flag = null;
    if (!p.stockLevel && short > 0) {
      flag = h(`span.low-flag${p.qty === 0 ? '.is-short-out' : ''}`, { title: `Planned and building projects need ${formatNumber(needOf(p))}` }, `Short ${formatNumber(short)}`);
    } else if (low && !p.stockLevel) flag = h('span.low-flag', out ? 'Out' : 'Low');
    const selected = view.selected.has(p.id);
    const current = view.current === p.id;
    const row = h('div.part-row', {
      tabindex: '0', role: view.selecting ? 'checkbox' : 'button',
      'aria-label': rowLabel(p, short) + (view.selecting ? '' : wide.matches ? ' Show details.' : ' Open to edit.'),
      'aria-checked': view.selecting ? String(selected) : null,
      'aria-current': current ? 'true' : null,
      class: cls([o.first && 'is-first', o.last && 'is-last', !meta.length && 'is-single', low && (out ? 'is-out' : 'is-low'), selected && 'is-selected', current && 'is-current']),
      dataset: { id: String(p.id) },
      onclick: () => {
        if (row.dataset.longpressed) { delete row.dataset.longpressed; return; }
        activate(p.id);
      },
      onkeydown: e => rowKey(e, row, p.id),
    },
    h('span.row-check', { 'aria-hidden': 'true' }, icon('check')),
    h('div.part-main', h('div.part-name', p.name), meta.length > 0 && h('div.part-meta', meta)),
    h('div.part-qty', flag, amountEl(p), u && h('span.unit-label', u)));
    longPress(row, p.id);
    return row;
  }

  function rowSig(p, o) {
    return [p.updatedAt, p.qty, p.stockLevel, o.first, o.last, o.hideLoc, o.showCat, view.selected.has(p.id), view.current === p.id,
      view.selecting, shortfall(p), costOn(), wide.matches].join('|');
  }

  function buildItems(list) {
    const H = heights || (heights = readHeights());
    const items = [];
    // Rows with only a name are shorter on phones; every height is known before drawing.
    const hasMeta = (p, o) => Boolean(p.package || p.mpn || (o.showCat && p.category) || (p.location && !o.hideLoc) || (costOn() && p.cost != null));
    const row = (p, o) => items.push({ key: `p:${p.id}`, height: hasMeta(p, o) ? H.row : H.row1, sig: rowSig(p, o), render: () => partRow(p, o) });
    const f = view.filter;
    const groupBy = view.sort.key === 'name' && !f.startsWith('cat:') && state.groups.categories.length > 0 ? 'category'
      : view.sort.key === 'location' && !f.startsWith('loc:') && state.groups.locations.length > 0 ? 'location' : null;
    if (!groupBy) {
      list.forEach((p, i) => row(p, { first: i === 0, last: i === list.length - 1, showCat: !f.startsWith('cat:') }));
      return items;
    }
    const groups = new Map();
    for (const p of list) {
      const k = p[groupBy] || '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    let keys = [...groups.keys()];
    if (groupBy === 'category') keys.sort((a, b) => (a === '') - (b === '') || collator.compare(a, b));
    else if (view.sort.dir === -1) keys = keys.filter(Boolean).reverse().concat(keys.includes('') ? [''] : []);
    keys.forEach((k, gi) => {
      const parts = groups.get(k);
      // When everything in a category lives in one place, say so once.
      const shared = groupBy === 'category' && parts.length > 1 && parts[0].location && parts.every(p => p.location === parts[0].location) ? parts[0].location : '';
      const label = k || (groupBy === 'category' ? 'Uncategorized' : 'No location');
      const first = gi === 0;
      items.push({
        key: `h:${groupBy}:${k}`, height: first ? H.headFirst : H.head, sig: [first, parts.length, shared, label].join('|'),
        render: () => groupHead(label, parts.length, { first, tape: shared, tapeOnly: groupBy === 'location' && Boolean(k) }),
      });
      parts.forEach((p, i) => row(p, { first: i === 0, last: i === parts.length - 1, hideLoc: groupBy === 'location' || Boolean(shared), showCat: groupBy === 'location' }));
    });
    return items;
  }

  function refreshItems() {
    vl.setItems(visible.length ? buildItems(visible) : []);
  }

  function renderList() {
    const terms = queryTerms(view.query);
    visible = sortParts(applyFilter(state.parts.filter(p => matches(p, terms))));
    for (const id of [...view.selected]) if (!state.byId.has(id)) view.selected.delete(id);
    // A column most parts leave empty isn't worth the room it takes from names.
    const share = f => state.parts.filter(p => p[f]).length / (state.parts.length || 1);
    pane.classList.toggle('no-pkg', share('package') < 0.12);
    pane.classList.toggle('no-mpn', share('mpn') < 0.12);
    pane.classList.toggle('has-cost', costOn());
    listEl.dataset.count = String(visible.length);
    listEl.setAttribute('aria-label', plural(visible.length, 'part'));

    if (!state.parts.length) {
      clear(emptyEl, h('div.empty',
        h('div.empty-art', icon('parts')),
        h('h2', 'No parts yet'),
        h('p', 'Add parts one at a time, add a whole resistor or capacitor kit in one go, or paste a list you already keep somewhere. You can also drop a CSV file on this page.'),
        h('div.empty-actions',
          h('button.btn.btn-primary', { type: 'button', onclick: () => openPartEditor() }, icon('plus'), 'Add part'),
          h('button.btn', { type: 'button', onclick: () => openKit() }, icon('kit'), 'Add a kit'),
          h('button.btn', { type: 'button', onclick: () => openPasteList() }, icon('paste'), 'Paste a list'))));
    } else if (!visible.length) {
      const where = view.filter.startsWith('loc:') && view.filter !== 'loc:' ? view.filter.slice(4) : '';
      clear(emptyEl, h('div.empty.empty-small',
        h('p', view.query ? `Nothing matches “${view.query}”${view.filter !== 'all' ? ' here' : ''}.` : where ? `Nothing is in ${where}.` : 'No parts here.'),
        h('div.empty-actions',
          view.query && !view.selecting && h('button.btn', { type: 'button', onclick: () => openPartEditor(null, { name: view.query, ...(where ? { location: where } : {}) }) }, icon('plus'), `Add “${view.query}”`),
          view.filter !== 'all' && h('button.btn.btn-quiet', { type: 'button', onclick: () => pick('all') }, 'Show all parts'))));
    } else clear(emptyEl);
    refreshItems();
    updateSummary();
  }

  // ---- opening parts and moving between them ----
  function activate(id) {
    if (view.selecting) { toggle(id); return; }
    if (wide.matches) setCurrent(id);
    else openPartEditor(state.byId.get(id));
  }

  function setCurrent(id) {
    if (view.current === id) return;
    view.current = id;
    if (id == null) inspector.clear(); else inspector.show(state.byId.get(id));
    refreshItems();
  }

  function insets() {
    const top = Math.max(0, toolbar.getBoundingClientRect().bottom, colHead.offsetParent ? colHead.getBoundingClientRect().bottom : 0);
    const tabbar = document.querySelector('.tabbar');
    // The tab bar is fixed, so check that it's showing rather than its offsetParent.
    let bottom = tabbar && tabbar.getClientRects().length ? tabbar.offsetHeight : 0;
    if (!barEl.hidden) bottom += barEl.offsetHeight + 16;
    return { top, bottom };
  }

  function focusRow(id) {
    const key = `p:${id}`;
    vl.reveal(vl.indexOf(key), insets());
    vl.node(key)?.focus({ preventScroll: true });
  }

  function move(delta, { from } = {}) {
    if (!visible.length) return;
    const focused = Number(document.activeElement?.closest?.('.part-row')?.dataset.id);
    let i = from === 'top' ? -1 : visible.findIndex(p => p.id === (focused || view.current));
    i = i < 0 ? (delta > 0 ? 0 : visible.length - 1) : Math.min(visible.length - 1, Math.max(0, i + delta));
    const p = visible[i];
    if (wide.matches && !view.selecting) setCurrent(p.id);
    focusRow(p.id);
  }

  function rowKey(e, row, id) {
    if (e.target !== row) return;
    const cur = state.byId.get(id);
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      // On a part already shown in the inspector, Enter goes to its name.
      if (e.key === 'Enter' && wide.matches && !view.selecting && view.current === id) inspector.el.querySelector('.input-lg')?.focus();
      else activate(id);
    } else if (!view.selecting && cur && !cur.stockLevel && (e.key === '+' || e.key === '=')) { e.preventDefault(); changeQty(cur, { delta: 1 }); }
    else if (!view.selecting && cur && !cur.stockLevel && e.key === '-') { e.preventDefault(); changeQty(cur, { delta: -1 }); }
    else if (e.key === 'x') { e.preventDefault(); toggle(id, true); }
  }

  // ---- selecting ----
  function longPress(row, id) {
    if (!isTouch()) return;
    let timer = null, x = 0, y = 0;
    row.addEventListener('pointerdown', e => {
      if (view.selecting || e.target.closest('.stepper, .level-pill')) return;
      x = e.clientX; y = e.clientY;
      timer = setTimeout(() => {
        timer = null;
        row.dataset.longpressed = '1';
        navigator.vibrate?.(12);
        setSelecting(true);
        toggle(id);
      }, 450);
    });
    const cancel = () => { clearTimeout(timer); timer = null; };
    row.addEventListener('pointermove', e => { if (timer && Math.hypot(e.clientX - x, e.clientY - y) > 8) cancel(); });
    row.addEventListener('pointerup', cancel);
    row.addEventListener('pointercancel', cancel);
    row.addEventListener('contextmenu', e => { if (row.dataset.longpressed) e.preventDefault(); });
  }

  function toggle(id, enter = false) {
    if (!view.selecting) { if (!enter) return; setSelecting(true); }
    if (view.selected.has(id)) view.selected.delete(id); else view.selected.add(id);
    refreshItems();
    drawBar();
  }

  function setSelecting(on) {
    view.selecting = on;
    if (!on) view.selected.clear();
    selectBtn.setAttribute('aria-pressed', String(on));
    pane.classList.toggle('selecting', on);
    document.body.classList.toggle('has-select-bar', on);
    refreshItems();
    drawBar();
  }

  const selectedParts = () => [...view.selected].map(id => state.byId.get(id)).filter(Boolean);

  function drawBar() {
    barEl.hidden = !view.selecting;
    if (!view.selecting) return;
    const n = view.selected.size;
    const allVisible = visible.length > 0 && visible.every(p => view.selected.has(p.id));
    const act = (ic, label, fn, opts = {}) => h(`button.bar-btn${opts.danger ? '.danger' : ''}`, { type: 'button', disabled: opts.disabled || n === 0, onclick: fn }, icon(ic), h('span', label));
    clear(barEl,
      h('div.bar-top',
        h('button.icon-btn', { type: 'button', 'aria-label': 'Stop selecting', onclick: () => setSelecting(false) }, icon('x')),
        h('span.bar-count', n ? `${n} selected` : isTouch() ? 'Tap parts to select them' : 'Click parts to select them'),
        h('button.btn.btn-quiet.btn-sm', { type: 'button', disabled: !visible.length, onclick: () => {
          if (allVisible) for (const p of visible) view.selected.delete(p.id); else for (const p of visible) view.selected.add(p.id);
          refreshItems();
          drawBar();
        } }, allVisible ? 'Clear' : `Select all ${visible.length.toLocaleString()}`)),
      h('div.bar-actions',
        act('pin', 'Location', bulkLocation),
        act('tag', 'Category', bulkCategory),
        act('gauge', 'Amount', e => bulkAmount(e.currentTarget)),
        act('merge', 'Merge', () => openMerge([...view.selected], { onDone: () => setSelecting(false) }), { disabled: n < 2 }),
        act('trash', 'Delete', bulkDelete, { danger: true })));
  }

  async function bulkPatch(patch, done) {
    try {
      const r = await api('/parts/bulk-update', { method: 'POST', body: { ids: [...view.selected], patch } });
      upsertParts(r.parts);
      toast(done(r.parts.length), { action: 'Undo', timeout: 6000, onAction: () => undoLast() });
    } catch (e) { showError(e); }
  }

  async function bulkLocation() {
    const parts = selectedParts();
    const common = parts.every(p => p.location === parts[0].location) ? parts[0].location : '';
    const v = await promptSheet({ title: `Move ${plural(parts.length, 'part')}`, label: 'Location. Leave empty to clear it.', value: common, confirm: 'Move', list: state.groups.locations.map(g => g.name) });
    if (v == null) return;
    bulkPatch({ location: v }, n => (v ? `Moved ${plural(n, 'part')} to ${v}.` : `Cleared the location of ${plural(n, 'part')}.`));
  }

  async function bulkCategory() {
    const parts = selectedParts();
    const common = parts.every(p => p.category === parts[0].category) ? parts[0].category : '';
    const v = await promptSheet({ title: `Set category for ${plural(parts.length, 'part')}`, label: 'Category. Leave empty to clear it.', value: common, confirm: 'Set category', list: state.groups.categories.map(g => g.name) });
    if (v == null) return;
    bulkPatch({ category: v }, n => (v ? `Put ${plural(n, 'part')} in ${v}.` : `Cleared the category of ${plural(n, 'part')}.`));
  }

  function bulkAmount(anchor) {
    menu(anchor, [
      ...LEVELS.map(l => ({ label: LEVEL_LABELS[l], action: () => bulkPatch({ stockLevel: l }, n => `${plural(n, 'part')} set to ${LEVEL_LABELS[l].toLowerCase()}.`) })),
      { label: 'Count exactly', action: () => bulkPatch({ stockLevel: null }, n => `${plural(n, 'part')} counted exactly again.`) },
      '-',
      { label: 'Set unit…', icon: 'ruler', action: async () => {
        const v = await promptSheet({ title: 'Set unit', label: 'Unit, like m, g or spool. Leave empty for pieces.', value: '', confirm: 'Set unit', list: UNITS });
        if (v == null) return;
        bulkPatch({ unit: v }, n => `${plural(n, 'part')} now counted in ${v || 'pieces'}.`);
      } },
    ]);
  }

  async function bulkDelete() {
    const n = view.selected.size;
    const ok = await confirmSheet({ title: `Delete ${plural(n, 'part')}?`, message: 'They come out of your parts list and any project lines using them go back to unmatched. You can undo right after.', confirm: `Delete ${plural(n, 'part')}`, danger: true });
    if (!ok) return;
    try {
      const r = await api('/parts/bulk-delete', { method: 'POST', body: { ids: [...view.selected] } });
      setSelecting(false);
      await loadParts();
      toast(`Deleted ${plural(r.removed.length, 'part')}.`, {
        action: 'Undo', timeout: 10000, onAction: async () => {
          try { await api('/parts/restore-many', { method: 'POST', body: { removed: r.removed } }); await loadParts(); } catch (e) { showError(e); }
        },
      });
    } catch (e) { showError(e); }
  }

  // ---- keeping up ----
  const rerender = () => { renderFilters(); renderList(); drawBar(); };
  drawColHead();
  rerender();
  const off = onChange(what => {
    if (what === 'settings') drawColHead();
    if (what === 'parts' || what === 'settings' || what === 'undo') rerender();
  });
  // The row height changes between the phone layout and the table.
  const ro = new ResizeObserver(() => {
    const next = readHeights();
    if (!heights || next.row !== heights.row || next.row1 !== heights.row1 || next.head !== heights.head || next.headFirst !== heights.headFirst) {
      heights = next;
      refreshItems();
    }
  });
  ro.observe(pane);
  const onWide = () => { if (!wide.matches && view.current != null) setCurrent(null); else refreshItems(); };
  wide.addEventListener('change', onWide);
  // Pick up changes made elsewhere (a build, another device) without waiting.
  if (Date.now() - (state.loadedAt || 0) > 3000) loadParts().catch(() => {});
  // Get the search ready in spare moments, so the first search is as quick as the rest.
  const idle = window.requestIdleCallback || (fn => setTimeout(() => fn({ timeRemaining: () => 8 }), 50));
  let warmed = 0;
  const warm = deadline => {
    while (warmed < state.parts.length && deadline.timeRemaining() > 2) indexed(state.parts[warmed++]);
    if (warmed < state.parts.length && page) idle(warm);
  };
  idle(warm);

  const onKey = e => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('dialog[open], .menu')) return;
    const typing = isTyping();
    const inInspector = inspector.el.contains(document.activeElement);
    if (e.key === 'Escape' && !typing) {
      if (view.selecting) { e.preventDefault(); setSelecting(false); } else if (view.current != null) { e.preventDefault(); setCurrent(null); }
      return;
    }
    if (typing || inInspector) return;
    if (e.key === '/') { e.preventDefault(); searchEl.focus(); searchEl.select(); }
    else if ((e.key === 'n' || e.key === 'N') && !view.selecting) { e.preventDefault(); openPartEditor(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1); }
  };
  document.addEventListener('keydown', onKey);
  const stopDrop = acceptDropAndPaste({ title: 'Drop to add parts', hint: 'A CSV, a spreadsheet saved as CSV, or one part per line', onText: text => openPasteList(text) });

  page = {
    partChanged(p) { refreshItems(); renderFilters(); updateSummary(); inspector.external(p); },
    open(id) {
      if (!state.byId.has(id)) return;
      if (!wide.matches) { openPartEditor(state.byId.get(id)); return; }
      if (!visible.some(p => p.id === id)) {
        view.query = ''; searchEl.value = '';
        view.filter = 'all';
        renderFilters();
        renderList();
      }
      setCurrent(id);
      focusRow(id);
    },
  };

  return () => {
    off();
    ro.disconnect();
    wide.removeEventListener('change', onWide);
    document.removeEventListener('keydown', onKey);
    stopDrop();
    vl.destroy();
    inspector.destroy();
    document.body.classList.remove('has-select-bar');
    root.classList.remove('view-parts');
    page = null;
  };
}
