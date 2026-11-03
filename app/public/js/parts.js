// Parts page, part editor, "Paste a list" and "Export for chat".
import { h, clear, icon, api, toast, showError, sheet, confirmSheet, menu, debounce, plural, copyText, downloadUrl, isTouch, readFile, money, stepper } from './lib.js';
import { state, onChange, upsertParts, removePart, costOn } from './state.js';

const view = { query: '', filter: 'all', sort: 'name' };
try { Object.assign(view, JSON.parse(localStorage.getItem('particull.partsView') || '{}'), { query: '' }); } catch { /* private mode */ }
const saveView = () => { try { localStorage.setItem('particull.partsView', JSON.stringify({ filter: view.filter, sort: view.sort })); } catch { /* ignore */ } };

const isLow = p => p.qty === 0 || (p.minQty != null && p.qty <= p.minQty);

function matches(p, terms) {
  if (!terms.length) return true;
  const hay = `${p.name} ${p.mpn} ${p.package} ${p.category} ${p.location} ${p.notes} ${(p.aliases || []).join(' ')}`.toLowerCase();
  return terms.every(t => hay.includes(t));
}

const SORTS = {
  name: { label: 'Name', fn: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) },
  most: { label: 'Most in stock', fn: (a, b) => b.qty - a.qty },
  least: { label: 'Fewest in stock', fn: (a, b) => a.qty - b.qty },
  recent: { label: 'Recently changed', fn: (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') },
  location: { label: 'Location', fn: (a, b) => (a.location || '￿').localeCompare(b.location || '￿', undefined, { numeric: true }) || a.name.localeCompare(b.name, undefined, { numeric: true }) },
};

// ---------- quantity changes ----------
const pending = new Map();
function changeQty(part, { delta, set }) {
  const next = set != null ? Math.max(0, set) : Math.max(0, part.qty + delta);
  if (next === part.qty) return;
  const prev = part.qty;
  part.qty = next;
  part.updatedAt = new Date().toISOString();
  upsertParts([part], { silent: true });
  updateRow(part);
  // Coalesce quick taps into one request per part.
  const p = pending.get(part.id) || { delta: 0, base: prev };
  p.delta += next - prev;
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

// ---------- rows ----------
const rowEls = new Map();

function tape(text, cls = '') {
  return h(`span.tape${cls}`, { title: 'Location' }, text);
}

function partRow(p) {
  const st = stepper({
    value: p.qty,
    label: `Quantity of ${p.name}`,
    onDelta: d => changeQty(state.byId.get(p.id), { delta: d }),
    onSet: v => changeQty(state.byId.get(p.id), { set: v }),
  });
  const metaBits = [
    p.package && h('span.meta-pkg', p.package),
    p.mpn && h('span.meta-mpn', p.mpn),
    view.filter === 'all' && view.sort !== 'name' && p.category && h('span.meta-cat', p.category),
    p.location && tape(p.location),
    costOn() && p.cost != null && h('span.meta-cost', money(p.cost, state.settings.currency)),
  ].filter(Boolean);
  const row = h('div.part-row', {
    tabindex: '0', role: 'button', 'aria-label': `${p.name}, ${p.qty} on hand. Open to edit.`,
    class: isLow(p) ? (p.qty === 0 ? 'is-out' : 'is-low') : '',
    onclick: () => openPartEditor(state.byId.get(p.id)),
    onkeydown: e => {
      if (e.target !== row) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPartEditor(state.byId.get(p.id)); }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); changeQty(state.byId.get(p.id), { delta: 1 }); }
      if (e.key === '-') { e.preventDefault(); changeQty(state.byId.get(p.id), { delta: -1 }); }
    },
  },
  h('div.part-main',
    h('div.part-name', p.name),
    metaBits.length > 0 && h('div.part-meta', metaBits)),
  h('div.part-qty',
    isLow(p) && h('span.low-flag', p.qty === 0 ? 'Out' : 'Low'),
    st));
  row._stepper = st;
  rowEls.set(p.id, row);
  return row;
}

function updateRow(p) {
  const row = rowEls.get(p.id);
  if (!row) return;
  row._stepper.update(p.qty);
  const low = isLow(p);
  row.classList.toggle('is-out', p.qty === 0);
  row.classList.toggle('is-low', low && p.qty > 0);
  const qtyBox = row.querySelector('.part-qty');
  let flag = qtyBox.querySelector('.low-flag');
  if (low) {
    if (!flag) { flag = h('span.low-flag'); qtyBox.prepend(flag); }
    flag.textContent = p.qty === 0 ? 'Out' : 'Low';
  } else flag?.remove();
  row.setAttribute('aria-label', `${p.name}, ${p.qty} on hand. Open to edit.`);
  updateSummary();
}

let summaryEl;
function updateSummary() {
  if (!summaryEl) return;
  const pieces = state.parts.reduce((s, p) => s + p.qty, 0);
  let text = `${plural(state.parts.length, 'part')}, ${plural(pieces, 'piece')}`;
  if (costOn()) {
    const value = state.parts.reduce((s, p) => s + (p.cost != null ? p.cost * p.qty : 0), 0);
    if (value) text += `, worth ${money(value, state.settings.currency)}`;
  }
  summaryEl.textContent = text;
}

// ---------- page ----------
export function renderParts(root) {
  let listEl, chipsEl, searchEl;

  const headActions = h('div.page-actions',
    h('button.btn.btn-quiet.hide-sm', { type: 'button', onclick: openExport }, icon('chat'), 'Export for chat'),
    h('button.btn.btn-quiet.hide-sm', { type: 'button', onclick: () => openPasteList() }, icon('paste'), 'Paste a list'),
    h('button.icon-btn.show-sm', { type: 'button', 'aria-label': 'Export for chat', onclick: openExport }, icon('chat')),
    h('button.icon-btn.show-sm', { type: 'button', 'aria-label': 'Paste a list', onclick: () => openPasteList() }, icon('paste')),
    h('button.icon-btn.icon-btn-primary.show-sm', { type: 'button', 'aria-label': 'Add part', onclick: () => openPartEditor() }, icon('plus')),
    h('button.btn.btn-primary.hide-sm', { type: 'button', onclick: () => openPartEditor(), title: 'Add part (N)' }, icon('plus'), 'Add part'));

  summaryEl = h('p.page-sub');
  searchEl = h('input.search-input', {
    type: 'search', placeholder: 'Search parts', value: view.query, 'aria-label': 'Search parts', enterkeyhint: 'search', autocomplete: 'off',
    oninput: debounce(e => { view.query = e.target.value; renderList(); }, 60),
    onkeydown: e => {
      if (e.key === 'Escape' && searchEl.value) { e.stopPropagation(); searchEl.value = ''; view.query = ''; renderList(); }
      if (e.key === 'Enter') { const first = listEl.querySelector('.part-row'); if (first && isTouch()) searchEl.blur(); else first?.focus(); }
    },
  });
  const sortBtn = h('button.btn.btn-quiet.sort-btn', { type: 'button', 'aria-label': 'Sort', onclick: e => menu(e.currentTarget, Object.entries(SORTS).map(([k, s]) => ({
    label: s.label, icon: view.sort === k ? 'check' : null, action: () => { view.sort = k; saveView(); sortBtn.lastChild.textContent = s.label; renderList(); },
  }))) }, icon('sort'), h('span.hide-xs', SORTS[view.sort]?.label || 'Name'));

  chipsEl = h('div.chips', { role: 'tablist', 'aria-label': 'Filter by category' });
  listEl = h('div.part-list');

  clear(root,
    h('header.page-head',
      h('div', h('h1', 'Parts'), summaryEl),
      headActions),
    h('div.toolbar',
      h('label.search', icon('search'), searchEl),
      sortBtn),
    chipsEl,
    listEl);

  function renderChips() {
    const cats = state.groups.categories;
    const lowCount = state.parts.filter(isLow).length;
    if (view.filter.startsWith('cat:') && !cats.some(c => `cat:${c.name}` === view.filter)) view.filter = 'all';
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
    const terms = view.query.toLowerCase().split(/\s+/).filter(Boolean);
    let list = state.parts.filter(p => matches(p, terms));
    if (view.filter === 'low') list = list.filter(isLow);
    else if (view.filter.startsWith('cat:')) list = list.filter(p => p.category === view.filter.slice(4));
    list.sort(SORTS[view.sort]?.fn || SORTS.name.fn);

    if (!state.parts.length) {
      clear(listEl, h('div.empty',
        h('div.empty-art', icon('parts')),
        h('h2', 'No parts yet'),
        h('p', 'Add parts one at a time, or paste a list you already keep somewhere. Quantities and names are all Particull needs.'),
        h('div.empty-actions',
          h('button.btn.btn-primary', { type: 'button', onclick: () => openPartEditor() }, icon('plus'), 'Add part'),
          h('button.btn', { type: 'button', onclick: () => openPasteList() }, icon('paste'), 'Paste a list'))));
      return;
    }
    if (!list.length) {
      clear(listEl, h('div.empty.empty-small',
        h('p', view.query ? `Nothing matches “${view.query}”.` : 'No parts here.'),
        view.query && h('button.btn', { type: 'button', onclick: () => openPartEditor(null, { name: view.query }) }, icon('plus'), `Add “${view.query}”`)));
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
        groups.get(k).map(partRow))));
    } else {
      clear(listEl, h('section.part-group', list.map(partRow)));
    }
  }

  const rerender = () => { renderChips(); renderList(); updateSummary(); };
  rerender();
  const off = onChange(what => { if (what === 'parts' || what === 'settings') rerender(); });

  const onKey = e => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); searchEl.focus(); }
    if ((e.key === 'n' || e.key === 'N') && !typing) { e.preventDefault(); openPartEditor(); }
  };
  document.addEventListener('keydown', onKey);
  if (!isTouch() && state.parts.length) setTimeout(() => searchEl.focus({ preventScroll: true }));
  return () => { off(); document.removeEventListener('keydown', onKey); summaryEl = null; rowEls.clear(); };
}

// ---------- part editor ----------
function datalist(id, values) {
  return h('datalist', { id }, values.map(v => h('option', { value: v })));
}

function field(label, control, hint) {
  return h('label.field', h('span.field-label', label), control, hint && h('span.field-hint', hint));
}

/**
 * Add or edit a part.
 * @param {object|null} part existing part, or null to add
 * @param {object} preset values for a new part
 */
export function openPartEditor(part = null, preset = {}, { onSaved } = {}) {
  const editing = Boolean(part);
  const src = part || { qty: 1, ...stickyNew(), ...preset };
  const s = sheet({ title: editing ? 'Edit part' : 'Add part', size: 'md' });
  let dirty = false; // eslint-disable-line no-unused-vars

  const name = h('input.input.input-lg', { value: src.name || '', required: true, autocomplete: 'off', autocapitalize: 'sentences', enterkeyhint: 'done', placeholder: 'e.g. 10k resistor, ESP32-S3 dev board' });
  let qty = Math.max(0, Number(src.qty) || 0);
  const qtyStep = stepper({ value: qty, size: 'lg', onDelta: d => { qty = Math.max(0, qty + d); qtyStep.update(qty); dirty = true; }, onSet: v => { qty = Math.max(0, v); qtyStep.update(qty); dirty = true; } });
  const category = h('input.input', { value: src.category || '', list: 'dl-cats', autocomplete: 'off', placeholder: 'e.g. Resistors' });
  const location = h('input.input', { value: src.location || '', list: 'dl-locs', autocomplete: 'off', placeholder: 'e.g. Drawer A3' });
  const mpn = h('input.input.mono', { value: src.mpn || '', autocomplete: 'off', spellcheck: 'false', placeholder: 'Manufacturer part number' });
  const pkg = h('input.input', { value: src.package || '', autocomplete: 'off', placeholder: 'e.g. 0805, SOT-23, DIP-8' });
  const notes = h('textarea.input', { rows: '2', placeholder: 'Anything worth remembering' });
  notes.value = src.notes || '';
  const link = h('input.input', { type: 'url', value: src.link || '', autocomplete: 'off', placeholder: 'Datasheet or product page' });
  const minQty = h('input.input.input-num', { type: 'number', min: '0', inputmode: 'numeric', value: src.minQty ?? '', placeholder: 'Off' });
  const cost = h('input.input.input-num', { type: 'number', min: '0', step: '0.001', inputmode: 'decimal', value: src.cost ?? '', placeholder: '0.00' });
  let aliases = [...(src.aliases || [])];
  const aliasList = h('div.alias-list');
  const aliasInput = h('input.input', { placeholder: 'Add another name', autocomplete: 'off', onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); addAlias(); } } });
  function addAlias() {
    const v = aliasInput.value.trim();
    if (v && !aliases.some(a => a.toLowerCase() === v.toLowerCase())) { aliases.push(v); dirty = true; }
    aliasInput.value = '';
    renderAliases();
  }
  function renderAliases() {
    clear(aliasList, aliases.map((a, i) => h('span.alias', a,
      h('button.alias-x', { type: 'button', 'aria-label': `Remove ${a}`, onclick: () => { aliases.splice(i, 1); dirty = true; renderAliases(); } }, icon('x')))));
  }
  renderAliases();

  const similarBox = h('div.similar', { hidden: true });
  const catSuggest = h('div.suggest', { hidden: true });

  const hasMore = Boolean(src.mpn || src.package || src.notes || src.link || src.aliases?.length || src.minQty != null || (costOn() && src.cost != null));
  const more = h('details.more', { open: hasMore || undefined },
    h('summary', 'More details', h('span.more-hint', 'part number, package, notes, link, other names')),
    h('div.more-grid',
      field('Part number', mpn),
      field('Package', pkg),
      h('div.span-2', field('Notes', notes)),
      h('div.span-2', field('Link', link)),
      h('div.span-2.field',
        h('span.field-label', 'Also known as'),
        aliasList,
        h('div.alias-add', aliasInput, h('button.btn.btn-quiet', { type: 'button', onclick: addAlias }, 'Add')),
        h('span.field-hint', 'Other names a BOM might use for this part. Approving a match adds one here for you.')),
      field('Warn when at or below', minQty, 'Leave empty to only flag it at zero.'),
      costOn() ? field(`Unit cost (${state.settings.currency})`, cost) : null));

  const form = h('form.part-form', { onsubmit: e => { e.preventDefault(); save(false); }, oninput: () => { dirty = true; } },
    field('Name', name),
    similarBox,
    h('div.form-row',
      h('div.field', h('span.field-label', 'Quantity'), qtyStep),
      h('div.form-row-grow',
        field('Category', category),
        catSuggest)),
    field('Location', location),
    more,
    datalist('dl-cats', state.groups.categories.map(c => c.name)),
    datalist('dl-locs', state.groups.locations.map(c => c.name)),
    h('button', { type: 'submit', hidden: true }));
  s.body.append(form);

  const saveBtn = h('button.btn.btn-primary', { type: 'button', onclick: () => save(false) }, editing ? 'Save' : 'Add part');
  s.footer.append(
    editing ? h('button.btn.btn-danger-quiet', { type: 'button', onclick: del }, icon('trash'), h('span.hide-xs', 'Delete')) : h('span'),
    h('div.footer-right',
      !editing && h('button.btn', { type: 'button', onclick: () => save(true), title: 'Shift+Enter' }, 'Add and start another'),
      saveBtn));
  form.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.shiftKey && !editing && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); save(true); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(false); }
  });

  // Duplicate check and category suggestion while typing a new part's name.
  const check = debounce(async () => {
    const n = name.value.trim();
    if (n.length < 2) { similarBox.hidden = true; catSuggest.hidden = true; return; }
    try {
      const r = await api('/similar', { method: 'POST', body: { name: n, mpn: mpn.value, package: pkg.value, exclude: part?.id } });
      const top = r.matches[0];
      if (top && (!editing || top.exact)) {
        clear(similarBox,
          icon('warn'),
          h('div.similar-text',
            h('strong', top.exact ? 'Already in your parts' : 'You may already have this'),
            h('span', `${top.name}, ${top.qty} on hand${top.location ? ` in ${top.location}` : ''}`)),
          !editing && h('div.similar-actions',
            h('button.btn.btn-sm', { type: 'button', onclick: () => addToExisting(top) }, `Add ${qty} to it`),
            h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => { s.close('saved'); openPartEditor(state.byId.get(top.id)); } }, 'Open it')));
        similarBox.hidden = false;
      } else similarBox.hidden = true;
      if (r.category && !category.value.trim()) {
        clear(catSuggest, h('span', 'Suggested'), h('button.chip.chip-sm', { type: 'button', onclick: () => { category.value = r.category; catSuggest.hidden = true; dirty = true; } }, r.category));
        catSuggest.hidden = false;
      } else catSuggest.hidden = true;
    } catch { /* checking is best-effort */ }
  }, 250);
  name.addEventListener('input', check);
  category.addEventListener('input', () => { if (category.value) catSuggest.hidden = true; });
  if (!editing && name.value) check();

  async function addToExisting(match) {
    try {
      const saved = await api(`/parts/${match.id}/qty`, { method: 'POST', body: { delta: qty } });
      upsertParts([saved]);
      toast(`Added ${qty} to ${saved.name}. Now ${saved.qty}.`);
      resetForNext();
    } catch (e) { showError(e); }
  }

  function values() {
    return {
      name: name.value.trim(), qty, category: category.value.trim(), location: location.value.trim(),
      mpn: mpn.value.trim(), package: pkg.value.trim(), notes: notes.value.trim(), link: link.value.trim(), aliases,
      minQty: minQty.value === '' ? null : Number(minQty.value),
      ...(costOn() ? { cost: cost.value === '' ? null : Number(cost.value) } : {}),
    };
  }

  function resetForNext() {
    rememberSticky(category.value.trim(), location.value.trim());
    name.value = ''; mpn.value = ''; pkg.value = ''; notes.value = ''; link.value = ''; minQty.value = ''; cost.value = '';
    aliases = []; renderAliases();
    qty = 1; qtyStep.update(qty);
    similarBox.hidden = true; catSuggest.hidden = true;
    dirty = false;
    initial = JSON.stringify(values());
    name.focus();
  }

  let saving = false;
  async function save(another) {
    if (saving) return;
    const v = values();
    if (!v.name) { name.focus(); name.classList.add('invalid'); toast('Give the part a name.'); return; }
    saving = true;
    try {
      const saved = editing
        ? await api(`/parts/${part.id}`, { method: 'PUT', body: v })
        : await api('/parts', { method: 'POST', body: v });
      upsertParts([saved]);
      onSaved?.(saved);
      if (another) {
        toast(`Added ${saved.name}.`);
        resetForNext();
      } else {
        if (!editing) { rememberSticky(v.category, v.location); toast(`Added ${saved.name}.`); }
        s.close('saved');
      }
    } catch (e) { showError(e); } finally { saving = false; }
  }

  async function del() {
    const ok = await confirmSheet({ title: `Delete ${part.name}?`, message: 'It comes out of your parts list and any project lines using it go back to unmatched. You can undo right after.', confirm: 'Delete part', danger: true });
    if (!ok) return;
    try {
      const r = await api(`/parts/${part.id}`, { method: 'DELETE' });
      removePart(part.id);
      s.close('saved');
      toast(`Deleted ${part.name}.`, {
        action: 'Undo', timeout: 8000, onAction: async () => {
          try { upsertParts([await api('/parts/restore', { method: 'POST', body: r })]); } catch (e) { showError(e); }
        },
      });
    } catch (e) { showError(e); }
  }

  let initial = JSON.stringify(values());
  s.beforeClose = async result => {
    if (result === 'saved' || JSON.stringify(values()) === initial) return true;
    if (!editing && !values().name) return true;
    return confirmSheet({ title: 'Discard changes?', message: editing ? 'Your edits to this part are not saved.' : 'This part has not been added yet.', confirm: 'Discard', danger: true });
  };

  if (!editing || !isTouch()) setTimeout(() => { name.focus(); if (editing) name.setSelectionRange(name.value.length, name.value.length); });
}

// New parts start in the category and location you used last, for a run of similar parts.
let sticky = { category: '', location: '', at: 0 };
function stickyNew() {
  return Date.now() - sticky.at < 30 * 60e3 ? { category: sticky.category, location: sticky.location } : {};
}
function rememberSticky(category, location) { sticky = { category, location, at: Date.now() }; }

// ---------- paste a list ----------
export function openPasteList(initial = '') {
  const s = sheet({ title: 'Paste a list', subtitle: 'One part per line, a table or a CSV file. Quantities like “10x”, “×10” or a Qty column are picked up.', size: 'lg' });
  const ta = h('textarea.input.paste-area', { rows: '7', spellcheck: 'false', placeholder: '10x 10k resistor 0805\n5x 100nF ceramic capacitor\nESP32-S3 dev board ×2\nSSD1306 OLED 0.96in, 3' });
  ta.value = initial;
  const fileInput = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.md,text/*', hidden: true, onchange: async e => {
    const f = e.target.files[0];
    if (!f) return;
    try { ta.value = await readFile(f); run(); } catch (err) { showError(err); }
    e.target.value = '';
  } });
  const cat = h('input.input', { list: 'dl-cats2', placeholder: 'Keep from list', autocomplete: 'off' });
  const loc = h('input.input', { list: 'dl-locs2', placeholder: 'Keep from list', autocomplete: 'off' });
  const preview = h('div.paste-preview');
  const status = h('p.paste-status');
  let rows = [];

  s.body.append(
    ta,
    h('div.paste-tools',
      h('button.btn.btn-quiet.btn-sm', { type: 'button', onclick: () => fileInput.click() }, icon('file'), 'Open a file'),
      fileInput,
      status),
    h('div.form-row.paste-apply',
      field('Category for all', cat),
      field('Location for all', loc)),
    datalist('dl-cats2', state.groups.categories.map(c => c.name)),
    datalist('dl-locs2', state.groups.locations.map(c => c.name)),
    preview);

  const addBtn = h('button.btn.btn-primary', { type: 'button', disabled: true, onclick: submit }, 'Add parts');
  s.footer.append(h('span'), h('div.footer-right', h('button.btn', { type: 'button', onclick: () => s.close() }, 'Cancel'), addBtn));

  const run = debounce(async () => {
    if (!ta.value.trim()) { rows = []; draw(); status.textContent = ''; return; }
    try {
      const r = await api('/parse', { method: 'POST', body: { text: ta.value } });
      rows = r.rows.map(x => ({ ...x, merge: Boolean(x.match && (x.match.exact || x.match.score >= 0.9)), include: true }));
      status.textContent = `${plural(rows.length, 'part')} found${r.format !== 'list' ? ` in a ${r.format}` : ''}.`;
      draw();
    } catch (e) { status.textContent = e.message; }
  }, 300);
  ta.addEventListener('input', run);
  cat.addEventListener('input', draw);
  loc.addEventListener('input', draw);

  function draw() {
    const inc = rows.filter(r => r.include);
    const merging = inc.filter(r => r.merge).length;
    addBtn.disabled = inc.length === 0;
    addBtn.textContent = !inc.length ? 'Add parts' : merging === inc.length ? `Update ${plural(merging, 'part')}` : merging ? `Add ${inc.length - merging}, update ${merging}` : `Add ${plural(inc.length, 'part')}`;
    if (!rows.length) { clear(preview); return; }
    clear(preview, h('div.preview-list', rows.map((r, i) => {
      const qtyIn = h('input.input.input-qty', { type: 'text', inputmode: 'numeric', value: String(r.qty), 'aria-label': 'Quantity', oninput: e => { r.qty = Math.max(0, parseInt(e.target.value, 10) || 0); } });
      const nameIn = h('input.input', { value: r.name, 'aria-label': 'Name', oninput: e => { r.name = e.target.value; } });
      const effectiveCat = cat.value.trim() || r.category;
      return h(`div.preview-row${r.include ? '' : '.excluded'}`,
        h('input.check', { type: 'checkbox', checked: r.include, 'aria-label': `Include ${r.name}`, onchange: e => { r.include = e.target.checked; draw(); } }),
        qtyIn,
        h('div.preview-main',
          nameIn,
          h('div.preview-meta',
            effectiveCat && h('span.meta-cat', effectiveCat),
            (loc.value.trim() || r.location) && tape(loc.value.trim() || r.location),
            r.qtyGuessed && h('span.meta-warn', 'quantity assumed 1')),
          r.match && h('label.preview-merge',
            h('input.check', { type: 'checkbox', checked: r.merge, onchange: e => { r.merge = e.target.checked; draw(); } }),
            h('span', `Add to ${r.match.name} (${r.match.qty} on hand) instead of a new part`))));
    })));
  }

  async function submit() {
    const inc = rows.filter(r => r.include && r.name.trim());
    addBtn.disabled = true;
    try {
      const body = inc.map(r => ({
        name: r.name.trim(), qty: r.qty, mergeInto: r.merge && r.match ? r.match.id : null,
        category: cat.value.trim() || r.category, location: loc.value.trim() || r.location,
        mpn: r.mpn, package: r.package, notes: r.notes, link: r.link, cost: r.cost,
      }));
      const res = await api('/parts/bulk', { method: 'POST', body: { rows: body } });
      upsertParts(res.parts);
      const bits = [res.created && `added ${plural(res.created, 'part')}`, res.merged && `updated ${plural(res.merged, 'part')}`].filter(Boolean);
      toast(`${bits.join(' and ').replace(/^./, c => c.toUpperCase())}.`);
      s.close();
    } catch (e) { showError(e); addBtn.disabled = false; }
  }

  if (initial) run();
  setTimeout(() => ta.focus());
}

// ---------- export for chat ----------
export function openExport() {
  const st = state.settings;
  const opts = { format: 'md', locations: st.exportIncludeLocations, notes: st.exportIncludeNotes, empty: st.exportIncludeEmpty, cost: false };
  const s = sheet({ title: 'Export for chat', subtitle: 'Paste this into a chat with Claude so project ideas use the parts you already have.', size: 'lg' });
  const out = h('textarea.input.export-area', { readOnly: true, rows: '14', spellcheck: 'false', 'aria-label': 'Export preview' });
  const meta = h('p.export-meta');

  const seg = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Format' },
    [['md', 'For chat'], ['csv', 'CSV'], ['json', 'JSON']].map(([k, label]) => h('button.seg', {
      type: 'button', role: 'radio', 'aria-checked': String(opts.format === k),
      onclick: e => { opts.format = k; [...seg.children].forEach(b => b.setAttribute('aria-checked', String(b === e.currentTarget))); load(); },
    }, label)));
  const toggle = (key, label) => h('label.toggle-row',
    h('input.switch', { type: 'checkbox', checked: opts[key], onchange: e => { opts[key] = e.target.checked; load(); } }),
    h('span', label));

  s.body.append(
    h('div.export-controls', seg,
      h('div.export-toggles',
        toggle('notes', 'Notes'),
        toggle('locations', 'Locations'),
        toggle('empty', 'Parts with none left'),
        costOn() && toggle('cost', 'Unit costs'))),
    out, meta);

  const query = () => `format=${opts.format}&locations=${+opts.locations}&notes=${+opts.notes}&empty=${+opts.empty}&cost=${+opts.cost}`;
  async function load() {
    try {
      const text = await api(`/export/inventory?${query()}`, { raw: true });
      out.value = text;
      const kb = new Blob([text]).size / 1024;
      meta.textContent = `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB${opts.format === 'md' ? ', including a note asking for BOMs in a format Particull imports' : ''}.`;
    } catch (e) { out.value = e.message; }
  }
  const copyBtn = h('button.btn.btn-primary', { type: 'button', onclick: async () => {
    const ok = await copyText(out.value);
    if (ok) { copyBtn.replaceChildren(icon('check'), 'Copied'); setTimeout(() => copyBtn.replaceChildren(icon('copy'), 'Copy'), 1600); } else toast("Couldn't copy. Select the text and copy it yourself.");
  } }, icon('copy'), 'Copy');
  s.footer.append(
    h('span'),
    h('div.footer-right',
      h('button.btn', { type: 'button', onclick: () => downloadUrl(`/api/export/inventory?${query()}&download=1`) }, icon('download'), 'Download'),
      copyBtn));
  load();
}
