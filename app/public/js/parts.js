// Parts page: the list, quick quantity changes, search, filters, and selecting parts to change many at once.
import { h, clear, icon, api, toast, showError, confirmSheet, promptSheet, menu, debounce, plural, isTouch, money, stepper } from './lib.js';
import { state, onChange, upsertParts, loadParts, costOn } from './state.js';
import { analyze } from '../shared/match.js';
import { LEVELS, LEVEL_LABELS, LEVEL_SHORT, UNITS, isLow, isOut, stockRank, formatStock, unitLabel, isCountUnit } from '../shared/stock.js';
import { openPartEditor } from './editor.js';
import { openPasteList, openKit } from './addmany.js';
import { openExport } from './exporter.js';
import { openMerge } from './merge.js';

export { openPartEditor };

const view = { query: '', filter: 'all', sort: 'name', selecting: false, selected: new Set() };
try { Object.assign(view, JSON.parse(localStorage.getItem('particull.partsView') || '{}'), { query: '' }); } catch { /* private mode */ }
const saveView = () => { try { localStorage.setItem('particull.partsView', JSON.stringify({ filter: view.filter, sort: view.sort })); } catch { /* ignore */ } };

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

const SORTS = {
  name: { label: 'Name', fn: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) },
  most: { label: 'Most in stock', fn: (a, b) => stockRank(b) - stockRank(a) },
  least: { label: 'Fewest in stock', fn: (a, b) => stockRank(a) - stockRank(b) },
  recent: { label: 'Recently changed', fn: (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') },
  location: { label: 'Location', fn: (a, b) => (a.location || '￿').localeCompare(b.location || '￿', undefined, { numeric: true }) || a.name.localeCompare(b.name, undefined, { numeric: true }) },
};

// ---------- quantity changes ----------
const pending = new Map();
function changeQty(part, { delta, set }) {
  const next = Math.max(0, Math.round((set != null ? set : part.qty + delta) * 1000) / 1000);
  if (next === part.qty) return;
  const prev = part.qty;
  part.qty = next;
  part.updatedAt = new Date().toISOString();
  upsertParts([part], { silent: true });
  updateRow(part);
  // Coalesce quick taps into one request per part.
  const p = pending.get(part.id) || { base: prev };
  clearTimeout(p.timer);
  p.timer = setTimeout(async () => {
    pending.delete(part.id);
    try {
      const saved = await api(`/parts/${part.id}/qty`, { method: 'POST', body: { set: part.qty } });
      upsertParts([saved], { silent: true });
      updateRow(saved);
    } catch (e) {
      part.qty = p.base;
      upsertParts([part], { silent: true });
      updateRow(part);
      showError(e);
    }
  }, 350);
  pending.set(part.id, p);
}

async function setLevel(part, level) {
  try {
    const saved = await api(`/parts/${part.id}`, { method: 'PUT', body: { stockLevel: level } });
    upsertParts([saved]);
  } catch (e) { showError(e); }
}

function levelMenu(anchor, part) {
  menu(anchor, [
    ...LEVELS.map(l => ({ label: LEVEL_LABELS[l], icon: part.stockLevel === l ? 'check' : null, action: () => setLevel(part, l) })),
    '-',
    { label: 'Count exactly', icon: part.stockLevel ? null : 'check', action: () => setLevel(part, null) },
  ]);
}

// ---------- rows ----------
const rowEls = new Map();

function tape(text) {
  return h('span.tape', { title: 'Location' }, text);
}

function amountEl(p) {
  if (p.stockLevel) {
    return h(`button.level-pill.level-${p.stockLevel}`, {
      type: 'button', 'aria-label': `${p.name}: ${LEVEL_LABELS[p.stockLevel]}. Change`,
      onclick: e => { e.stopPropagation(); levelMenu(e.currentTarget, state.byId.get(p.id)); },
    }, h('span.level-dot'), LEVEL_SHORT[p.stockLevel], icon('updown'));
  }
  // Just the number: click it to type a new amount. Arrow keys and +/- on the row still nudge it.
  const st = stepper({
    value: p.qty,
    buttons: false,
    label: `Quantity of ${p.name}. Type a new amount.`,
    onDelta: d => changeQty(state.byId.get(p.id), { delta: d }),
    onSet: v => changeQty(state.byId.get(p.id), { set: v }),
  });
  return st;
}

function rowLabel(p) {
  return `${p.name}, ${formatStock(p).toLowerCase()}${isCountUnit(p.unit) && !p.stockLevel ? ' on hand' : ''}.`;
}

function partRow(p, ctx) {
  const amt = amountEl(p);
  const metaBits = [
    p.package && h('span.meta-pkg', p.package),
    p.mpn && h('span.meta-mpn', p.mpn),
    view.filter === 'all' && view.sort !== 'name' && p.category && h('span.meta-cat', p.category),
    p.location && tape(p.location),
    costOn() && p.cost != null && h('span.meta-cost', money(p.cost, state.settings.currency)),
  ].filter(Boolean);
  const low = isLow(p);
  const check = h('span.row-check', { 'aria-hidden': 'true' }, icon('check'));
  const u = !p.stockLevel && unitLabel(p.unit, p.qty);
  const row = h('div.part-row', {
    tabindex: '0', role: view.selecting ? 'checkbox' : 'button',
    'aria-label': rowLabel(p) + (view.selecting ? '' : ' Open to edit.'),
    'aria-checked': view.selecting ? String(view.selected.has(p.id)) : null,
    class: [low ? (isOut(p) ? 'is-out' : 'is-low') : '', view.selected.has(p.id) ? 'is-selected' : ''].join(' ').trim(),
    dataset: { id: String(p.id) },
    onclick: () => {
      if (row.dataset.longpressed) { delete row.dataset.longpressed; return; }
      if (view.selecting) ctx.toggle(p.id); else openPartEditor(state.byId.get(p.id));
    },
    onkeydown: e => {
      if (e.target !== row) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (view.selecting) ctx.toggle(p.id); else openPartEditor(state.byId.get(p.id));
      }
      const cur = state.byId.get(p.id);
      if (!view.selecting && !cur.stockLevel && (e.key === '+' || e.key === '=')) { e.preventDefault(); changeQty(cur, { delta: 1 }); }
      if (!view.selecting && !cur.stockLevel && e.key === '-') { e.preventDefault(); changeQty(cur, { delta: -1 }); }
      if (e.key === 'x') { e.preventDefault(); ctx.toggle(p.id, true); }
    },
  },
  check,
  h('div.part-main',
    h('div.part-name', p.name),
    metaBits.length > 0 && h('div.part-meta', metaBits)),
  h('div.part-qty',
    low && !p.stockLevel && h('span.low-flag', isOut(p) ? 'Out' : 'Low'),
    amt,
    u && h('span.unit-label', u)));
  if (!p.stockLevel) row._stepper = amt;
  ctx.longPress(row, p.id);
  rowEls.set(p.id, row);
  return row;
}

function updateRow(p) {
  const row = rowEls.get(p.id);
  if (!row || !row._stepper) return;
  row._stepper.update(p.qty);
  const low = isLow(p);
  row.classList.toggle('is-out', isOut(p));
  row.classList.toggle('is-low', low && !isOut(p));
  const qtyBox = row.querySelector('.part-qty');
  let flag = qtyBox.querySelector('.low-flag');
  if (low) {
    if (!flag) { flag = h('span.low-flag'); qtyBox.prepend(flag); }
    flag.textContent = isOut(p) ? 'Out' : 'Low';
  } else flag?.remove();
  const ul = qtyBox.querySelector('.unit-label');
  if (ul) ul.textContent = unitLabel(p.unit, p.qty);
  row.setAttribute('aria-label', `${rowLabel(p)} Open to edit.`);
  updateSummary();
}

let summaryEl;
function updateSummary() {
  if (!summaryEl) return;
  const low = state.parts.filter(isLow).length;
  let text = plural(state.parts.length, 'part');
  if (low) text += `, ${low} low or out`;
  if (costOn()) {
    const value = state.parts.reduce((s, p) => s + (p.cost != null && !p.stockLevel ? p.cost * p.qty : 0), 0);
    if (value) text += `, worth ${money(value, state.settings.currency)}`;
  }
  summaryEl.textContent = text;
}

function addSeveralMenu(anchor) {
  menu(anchor, [
    { label: 'Paste a list', icon: 'paste', action: () => openPasteList() },
    { label: 'Add a kit', icon: 'kit', action: () => openKit() },
  ]);
}

// ---------- page ----------
export function renderParts(root) {
  let listEl, chipsEl, searchEl, barEl;
  view.selecting = false;
  view.selected.clear();
  let visible = [];

  const headActions = h('div.page-actions',
    h('button.btn.btn-quiet.hide-sm', { type: 'button', onclick: openExport }, icon('chat'), 'Export for chat'),
    h('button.btn.btn-quiet.hide-sm', { type: 'button', onclick: e => addSeveralMenu(e.currentTarget) }, icon('layers'), 'Add several'),
    h('button.icon-btn.show-sm', { type: 'button', 'aria-label': 'Export for chat', onclick: openExport }, icon('chat')),
    h('button.icon-btn.show-sm', { type: 'button', 'aria-label': 'Add several parts', onclick: e => addSeveralMenu(e.currentTarget) }, icon('layers')),
    h('button.icon-btn.icon-btn-primary.show-sm', { type: 'button', 'aria-label': 'Add part', onclick: () => openPartEditor() }, icon('plus')),
    h('button.btn.btn-primary.hide-sm', { type: 'button', onclick: () => openPartEditor(), title: 'Add part (N)' }, icon('plus'), 'Add part'));

  summaryEl = h('p.page-sub');
  searchEl = h('input.search-input', {
    type: 'search', placeholder: 'Search, e.g. 4k7 or ESP32', value: view.query, 'aria-label': 'Search parts', enterkeyhint: 'search', autocomplete: 'off',
    oninput: debounce(e => { view.query = e.target.value; renderList(); }, 60),
    onkeydown: e => {
      if (e.key === 'Escape' && searchEl.value) { e.stopPropagation(); searchEl.value = ''; view.query = ''; renderList(); }
      if (e.key === 'Enter') { const first = listEl.querySelector('.part-row'); if (first && isTouch()) searchEl.blur(); else first?.focus(); }
    },
  });
  const sortBtn = h('button.btn.btn-quiet.sort-btn', { type: 'button', 'aria-label': 'Sort', onclick: e => menu(e.currentTarget, Object.entries(SORTS).map(([k, s]) => ({
    label: s.label, icon: view.sort === k ? 'check' : null, action: () => { view.sort = k; saveView(); sortBtn.lastChild.textContent = s.label; renderList(); },
  }))) }, icon('sort'), h('span.hide-xs', SORTS[view.sort]?.label || 'Name'));
  const selectBtn = h('button.btn.btn-quiet.select-btn', { type: 'button', 'aria-pressed': 'false', 'aria-label': 'Select parts', title: 'Select parts to change several at once', onclick: () => setSelecting(!view.selecting) }, icon('select'), h('span.hide-xs', 'Select'));

  chipsEl = h('div.chips', { role: 'tablist', 'aria-label': 'Filter by category' });
  listEl = h('div.part-list');
  barEl = h('div.select-bar', { role: 'toolbar', 'aria-label': 'Selected parts', hidden: true });

  clear(root,
    h('header.page-head',
      h('div', h('h1', 'Parts'), summaryEl),
      headActions),
    h('div.toolbar',
      h('label.search', icon('search'), searchEl),
      sortBtn,
      selectBtn),
    chipsEl,
    listEl,
    barEl);

  // ---- selection ----
  const ctx = {
    toggle(id, enter = false) {
      if (!view.selecting) { if (!enter) return; setSelecting(true); }
      if (view.selected.has(id)) view.selected.delete(id); else view.selected.add(id);
      const row = rowEls.get(id);
      row?.classList.toggle('is-selected', view.selected.has(id));
      row?.setAttribute('aria-checked', String(view.selected.has(id)));
      drawBar();
    },
    longPress(row, id) {
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
          ctx.toggle(id);
        }, 450);
      });
      const cancel = () => { clearTimeout(timer); timer = null; };
      row.addEventListener('pointermove', e => { if (timer && Math.hypot(e.clientX - x, e.clientY - y) > 8) cancel(); });
      row.addEventListener('pointerup', cancel);
      row.addEventListener('pointercancel', cancel);
      row.addEventListener('contextmenu', e => { if (row.dataset.longpressed) e.preventDefault(); });
    },
  };

  function setSelecting(on) {
    view.selecting = on;
    if (!on) view.selected.clear();
    selectBtn.setAttribute('aria-pressed', String(on));
    listEl.classList.toggle('selecting', on);
    document.body.classList.toggle('has-select-bar', on);
    renderList();
    drawBar();
  }

  function selectedParts() {
    return [...view.selected].map(id => state.byId.get(id)).filter(Boolean);
  }

  function drawBar() {
    barEl.hidden = !view.selecting;
    if (!view.selecting) return;
    const n = view.selected.size;
    const allVisible = visible.length > 0 && visible.every(p => view.selected.has(p.id));
    const act = (ic, label, fn, opts = {}) => h(`button.bar-btn${opts.danger ? '.danger' : ''}`, { type: 'button', disabled: opts.disabled || n === 0, onclick: fn }, icon(ic), h('span', label));
    clear(barEl,
      h('div.bar-top',
        h('button.icon-btn', { type: 'button', 'aria-label': 'Stop selecting', onclick: () => setSelecting(false) }, icon('x')),
        h('span.bar-count', n ? `${n} selected` : 'Tap parts to select them'),
        h('button.btn.btn-quiet.btn-sm', { type: 'button', disabled: !visible.length, onclick: () => {
          if (allVisible) for (const p of visible) view.selected.delete(p.id); else for (const p of visible) view.selected.add(p.id);
          renderList();
          drawBar();
        } }, allVisible ? 'Clear' : `Select all ${visible.length}`)),
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
      toast(done(r.parts.length));
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

  // ---- filters ----
  function renderChips() {
    const cats = state.groups.categories;
    const lowCount = state.parts.filter(isLow).length;
    if (view.filter.startsWith('cat:') && view.filter !== 'cat:' && !cats.some(c => `cat:${c.name}` === view.filter)) view.filter = 'all';
    if (view.filter === 'low' && !lowCount) view.filter = 'all';
    const chip = (key, label, count) => h('button.chip', {
      type: 'button', role: 'tab', 'aria-selected': String(view.filter === key),
      onclick: () => { view.filter = key; saveView(); renderChips(); renderList(); },
    }, label, count != null && h('span.chip-count', count));
    const uncategorized = state.parts.filter(p => !p.category).length;
    clear(chipsEl,
      chip('all', 'All', state.parts.length),
      lowCount > 0 && chip('low', 'Low or out', lowCount),
      cats.map(c => chip(`cat:${c.name}`, c.name, c.parts)),
      uncategorized > 0 && cats.length > 0 && chip('cat:', 'Uncategorized', uncategorized));
    chipsEl.hidden = state.parts.length === 0;

    // On wide screens the same filters live in the side rail, under Parts.
    const rail = document.getElementById('rail-sub');
    if (rail) {
      const item = (key, label, count, cls = '') => h(`button.rail-filter${cls}`, {
        type: 'button', 'aria-pressed': String(view.filter === key),
        onclick: () => { view.filter = key; saveView(); renderChips(); renderList(); window.scrollTo({ top: 0 }); },
      }, h('span.rail-filter-name', label), h('span.rail-filter-count', count));
      clear(rail, state.parts.length > 0 && [
        h('p.rail-head', 'Categories'),
        item('all', 'All parts', state.parts.length),
        lowCount > 0 && item('low', 'Low or out', lowCount, '.rail-filter-low'),
        cats.map(c => item(`cat:${c.name}`, c.name, c.parts)),
        uncategorized > 0 && cats.length > 0 && item('cat:', 'Uncategorized', uncategorized),
      ]);
    }
  }

  function renderList() {
    rowEls.clear();
    const terms = queryTerms(view.query);
    let list = state.parts.filter(p => matches(p, terms));
    if (view.filter === 'low') list = list.filter(isLow);
    else if (view.filter.startsWith('cat:')) list = list.filter(p => p.category === view.filter.slice(4));
    list.sort(SORTS[view.sort]?.fn || SORTS.name.fn);
    visible = list;
    for (const id of [...view.selected]) if (!state.byId.has(id)) view.selected.delete(id);

    if (!state.parts.length) {
      clear(listEl, h('div.empty',
        h('div.empty-art', icon('parts')),
        h('h2', 'No parts yet'),
        h('p', 'Add parts one at a time, add a whole resistor or capacitor kit in one go, or paste a list you already keep somewhere.'),
        h('div.empty-actions',
          h('button.btn.btn-primary', { type: 'button', onclick: () => openPartEditor() }, icon('plus'), 'Add part'),
          h('button.btn', { type: 'button', onclick: () => openKit() }, icon('kit'), 'Add a kit'),
          h('button.btn', { type: 'button', onclick: () => openPasteList() }, icon('paste'), 'Paste a list'))));
      return;
    }
    if (!list.length) {
      clear(listEl, h('div.empty.empty-small',
        h('p', view.query ? `Nothing matches “${view.query}”.` : 'No parts here.'),
        view.query && !view.selecting && h('button.btn', { type: 'button', onclick: () => openPartEditor(null, { name: view.query }) }, icon('plus'), `Add “${view.query}”`)));
      return;
    }

    const groupByCat = view.sort === 'name' && view.filter === 'all' && state.groups.categories.length > 0;
    if (groupByCat) {
      const groups = new Map();
      for (const p of list) {
        const k = p.category || '';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(p);
      }
      const keys = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
      clear(listEl, keys.map(k => h('section.part-group',
        h('h2.group-head', h('span', k || 'Uncategorized'), h('span.group-count', groups.get(k).length)),
        groups.get(k).map(p => partRow(p, ctx)))));
    } else {
      clear(listEl, h('section.part-group', list.map(p => partRow(p, ctx))));
    }
  }

  const rerender = () => { renderChips(); renderList(); updateSummary(); drawBar(); };
  rerender();
  const off = onChange(what => { if (what === 'parts' || what === 'settings') rerender(); });

  const onKey = e => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (e.key === 'Escape' && view.selecting && !typing) { e.preventDefault(); setSelecting(false); }
    if (e.key === '/' && !typing) { e.preventDefault(); searchEl.focus(); }
    if ((e.key === 'n' || e.key === 'N') && !typing && !view.selecting) { e.preventDefault(); openPartEditor(); }
  };
  document.addEventListener('keydown', onKey);
  if (!isTouch() && state.parts.length) setTimeout(() => searchEl.focus({ preventScroll: true }));
  return () => {
    off();
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('has-select-bar');
    summaryEl = null;
    rowEls.clear();
  };
}
