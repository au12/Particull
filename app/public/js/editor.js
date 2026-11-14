// One part: the form (shared by the Add/Edit sheet and the inspector), plus where the part
// is used and what happened to it.
import { h, clear, icon, api, toast, showError, sheet, confirmSheet, debounce, isTouch, stepper, formatWhen } from './lib.js';
import { state, upsertParts, removePart, costOn, undoLast } from './state.js';
import { LEVELS, LEVEL_SHORT, LEVEL_LABELS, UNITS, formatStock, formatNumber, unitLabel } from '../shared/stock.js';
import { openMerge } from './merge.js';

export function datalist(id, values) {
  return h('datalist', { id }, values.map(v => h('option', { value: v })));
}

export function field(label, control, hint) {
  return h('label.field', h('span.field-label', label), control, hint && h('span.field-hint', hint));
}

/**
 * The "how much" control: an exact count (with a unit), or Plenty / Some / Low / Out.
 * @returns {HTMLElement & {get(): {qty:number, stockLevel:string|null, unit:string}, set(v): void}}
 */
export function amountControl({ qty = 1, stockLevel = null, unit = '' } = {}, onChange = () => {}) {
  let mode = stockLevel || 'count';
  let count = Number(qty) || 0;
  const step = stepper({
    value: count, size: 'lg', label: 'Quantity',
    onDelta: d => { count = Math.max(0, Math.round((count + d) * 1000) / 1000); step.update(count); onChange(); },
    onSet: v => { count = Math.max(0, v); step.update(count); onChange(); },
  });
  const unitIn = h('input.input.unit-input', { value: unit || '', list: 'dl-units', placeholder: 'pcs', autocomplete: 'off', 'aria-label': 'Unit', maxlength: '16', oninput: onChange });
  const countRow = h('div.amount-count', step, unitIn, datalistOnce());
  const seg = h('div.segmented.amount-seg', { role: 'radiogroup', 'aria-label': 'How much you have' },
    [['count', 'Count'], ...LEVELS.map(l => [l, LEVEL_SHORT[l]])].map(([k, label]) => h('button.seg', {
      type: 'button', role: 'radio', 'aria-checked': String(mode === k), dataset: { mode: k },
      onclick: () => { mode = k; draw(); onChange(); },
    }, label)));
  const hint = h('span.field-hint.amount-hint');
  const el = h('div.field.amount', h('span.field-label', 'How much'), seg, countRow, hint);
  function draw() {
    [...seg.children].forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    countRow.hidden = mode !== 'count';
    hint.textContent = {
      count: '',
      plenty: 'More than any project will need. BOM checks count it as in stock.',
      some: 'Enough for a build or two. BOM checks count it as in stock.',
      low: 'A few left. Projects list it to top up.',
      out: 'None left.',
    }[mode];
    hint.hidden = mode === 'count';
  }
  draw();
  el.get = () => ({ qty: count, stockLevel: mode === 'count' ? null : mode, unit: unitIn.value.trim() });
  el.set = v => {
    count = Number(v.qty) || 0;
    mode = v.stockLevel || 'count';
    unitIn.value = v.unit || '';
    step.update(count);
    draw();
  };
  el.focusCount = () => step.querySelector('input').focus();
  return el;
}

function datalistOnce() {
  return document.getElementById('dl-units') ? null : datalist('dl-units', UNITS);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A part's values field by field, the way the form holds them. */
export function formFields(p) {
  return {
    name: p.name || '',
    amount: { qty: Number(p.qty) || 0, stockLevel: p.stockLevel || null, unit: p.unit || '' },
    category: p.category || '', location: p.location || '',
    mpn: p.mpn || '', package: p.package || '', notes: p.notes || '', link: p.link || '',
    aliases: [...(p.aliases || [])],
    minQty: p.minQty ?? null,
    ...(costOn() ? { cost: p.cost ?? null } : {}),
  };
}

/**
 * The fields for one part.
 * @param {object} src values to start with
 * @param {object} opts
 * @param {boolean} opts.editing an existing part (duplicates only count if the name is the same)
 * @param {number}  opts.partId the part being edited, left out of duplicate checks
 * @param {(key:string)=>void} opts.onEdit called on every change, with the field that changed
 * @param {()=>void} opts.onSubmit Enter in a field
 * @param {object} opts.actions what the duplicate notice offers: add(match, qty), open(match), merge(match)
 */
export function partForm(src, { editing = false, partId = null, onEdit = () => {}, onSubmit = () => {}, actions = {}, moreOpen } = {}) {
  const edited = key => () => { drawMoreHint(); onEdit(key); };
  const name = h('input.input.input-lg', { value: src.name || '', required: true, autocomplete: 'off', autocapitalize: 'sentences', enterkeyhint: 'done', placeholder: 'e.g. 10k resistor, ESP32-S3 dev board', 'aria-label': 'Name', oninput: edited('name') });
  const amount = amountControl(src, edited('amount'));
  const category = h('input.input', { value: src.category || '', list: 'dl-cats', autocomplete: 'off', placeholder: 'e.g. Resistors', oninput: edited('category') });
  const location = h('input.input', { value: src.location || '', list: 'dl-locs', autocomplete: 'off', placeholder: 'e.g. Drawer A3', oninput: edited('location') });
  const mpn = h('input.input.mono', { value: src.mpn || '', autocomplete: 'off', spellcheck: 'false', placeholder: 'Manufacturer part number', oninput: edited('mpn') });
  const pkg = h('input.input', { value: src.package || '', autocomplete: 'off', placeholder: 'e.g. 0805, SOT-23, DIP-8', oninput: edited('package') });
  const notes = h('textarea.input', { rows: '2', placeholder: 'Anything worth remembering', oninput: edited('notes') });
  notes.value = src.notes || '';
  const link = h('input.input', { type: 'url', value: src.link || '', autocomplete: 'off', placeholder: 'Datasheet or product page', oninput: edited('link') });
  const minQty = h('input.input.input-num', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: src.minQty ?? '', placeholder: 'Off', oninput: edited('minQty') });
  const cost = h('input.input.input-num', { type: 'number', min: '0', step: '0.001', inputmode: 'decimal', value: src.cost ?? '', placeholder: '0.00', oninput: edited('cost') });
  let aliases = [...(src.aliases || [])];
  const aliasList = h('div.alias-list');
  const aliasInput = h('input.input', { placeholder: 'Add another name', autocomplete: 'off', 'aria-label': 'Add another name', onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); addAlias(); } } });
  function addAlias() {
    const v = aliasInput.value.trim();
    if (v && !aliases.some(a => a.toLowerCase() === v.toLowerCase())) { aliases.push(v); drawMoreHint(); onEdit('aliases'); }
    aliasInput.value = '';
    renderAliases();
  }
  function renderAliases() {
    clear(aliasList, aliases.map((a, i) => h('span.alias', a,
      h('button.alias-x', { type: 'button', 'aria-label': `Remove ${a}`, onclick: () => { aliases.splice(i, 1); renderAliases(); drawMoreHint(); onEdit('aliases'); } }, icon('x')))));
  }
  renderAliases();

  const similarBox = h('div.similar', { hidden: true });
  const catSuggest = h('div.suggest', { hidden: true });

  const hasMore = Boolean(src.mpn || src.package || src.notes || src.link || src.aliases?.length || src.minQty != null || (costOn() && src.cost != null));
  // Closed, the heading says what's inside.
  const moreHint = h('span.more-hint');
  function drawMoreHint() {
    const filled = [mpn.value.trim(), pkg.value.trim(), aliases.length && `${aliases.length} other ${aliases.length === 1 ? 'name' : 'names'}`, notes.value.trim() && 'notes', link.value.trim() && 'link'].filter(Boolean);
    moreHint.textContent = filled.length ? filled.join(' · ') : 'part number, package, notes, link, other names';
    moreHint.classList.toggle('is-filled', filled.length > 0);
  }
  const more = h('details.more', { open: (moreOpen ?? hasMore) || undefined },
    h('summary', 'More details', moreHint),
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
      field('Warn when at or below', minQty, 'For counted parts. Leave empty to only flag it at zero.'),
      costOn() ? field(`Unit cost (${state.settings.currency})`, cost) : null));

  const form = h('form.part-form', { onsubmit: e => { e.preventDefault(); onSubmit(); } },
    field('Name', name),
    similarBox,
    amount,
    h('div.form-grid',
      h('div.form-row-grow', field('Category', category), catSuggest),
      field('Location', location)),
    more,
    datalist('dl-cats', state.groups.categories.map(c => c.name)),
    datalist('dl-locs', state.groups.locations.map(c => c.name)),
    h('button', { type: 'submit', hidden: true }));

  const io = {
    name: [() => name.value.trim(), v => { name.value = v; }],
    amount: [() => amount.get(), v => amount.set(v)],
    category: [() => category.value.trim(), v => { category.value = v; }],
    location: [() => location.value.trim(), v => { location.value = v; }],
    mpn: [() => mpn.value.trim(), v => { mpn.value = v; }],
    package: [() => pkg.value.trim(), v => { pkg.value = v; }],
    notes: [() => notes.value.trim(), v => { notes.value = v; }],
    link: [() => link.value.trim(), v => { link.value = v; }],
    aliases: [() => [...aliases], v => { aliases = [...v]; renderAliases(); }],
    minQty: [() => (minQty.value === '' ? null : Number(minQty.value)), v => { minQty.value = v ?? ''; }],
    ...(costOn() ? { cost: [() => (cost.value === '' ? null : Number(cost.value)), v => { cost.value = v ?? ''; }] } : {}),
  };

  const current = () => Object.fromEntries(Object.entries(io).map(([k, [get]]) => [k, get()]));
  drawMoreHint();

  // Duplicate check and category suggestion while typing a name.
  const check = debounce(async () => {
    const n = name.value.trim();
    if (n.length < 2) { similarBox.hidden = true; catSuggest.hidden = true; return; }
    try {
      const r = await api('/similar', { method: 'POST', body: { name: n, mpn: mpn.value, package: pkg.value, exclude: partId } });
      const top = r.matches[0];
      if (top && (!editing || top.exact)) {
        const a = amount.get();
        const canAdd = actions.add && !a.stockLevel && !top.stockLevel && a.qty > 0;
        clear(similarBox,
          icon('warn'),
          h('div.similar-text',
            h('strong', top.exact ? 'Already in your parts' : 'You may already have this'),
            h('span', `${top.name}: ${formatStock(top).toLowerCase()}${top.location ? `, in ${top.location}` : ''}`)),
          h('div.similar-actions',
            canAdd && h('button.btn.btn-sm', { type: 'button', onclick: () => actions.add(top, a.qty) }, `Add ${a.qty} to it`),
            actions.merge && h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => actions.merge(top) }, 'Merge them'),
            actions.open && h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => actions.open(top) }, 'Open it')));
        similarBox.hidden = false;
      } else similarBox.hidden = true;
      if (r.category && !category.value.trim()) {
        clear(catSuggest, h('span', 'Suggested'), h('button.chip.chip-sm', { type: 'button', onclick: () => { category.value = r.category; catSuggest.hidden = true; onEdit('category'); } }, r.category));
        catSuggest.hidden = false;
      } else catSuggest.hidden = true;
    } catch { /* checking is best-effort */ }
  }, 250);
  name.addEventListener('input', check);
  category.addEventListener('input', () => { if (category.value) catSuggest.hidden = true; });

  return {
    el: form,
    name,
    amount,
    check,
    current,
    /** Everything, ready to send to the server. */
    values() {
      const v = current();
      const { amount: a, ...rest } = v;
      return { ...rest, qty: a.qty, stockLevel: a.stockLevel, unit: a.unit };
    },
    /**
     * Take a newer copy of the part, leaving alone any field changed since `saved`.
     * @param {object} part the newer part
     * @param {object} saved the fields as last saved (formFields of the old part)
     */
    sync(part, saved) {
      const next = formFields(part);
      for (const [k, [get, set]] of Object.entries(io)) {
        if (k in next && same(get(), saved[k]) && !same(get(), next[k])) set(next[k]);
      }
      drawMoreHint();
    },
    /** Clear the fields for the next part, keeping what usually stays the same. */
    reset(keep = {}) {
      for (const [k, [, set]] of Object.entries(io)) {
        if (k === 'category' || k === 'location') continue;
        set(k === 'aliases' ? [] : k === 'amount' ? (keep.amount || { qty: 1, stockLevel: null, unit: '' }) : k === 'minQty' || k === 'cost' ? null : '');
      }
      similarBox.hidden = true;
      catSuggest.hidden = true;
    },
    hideNotices() { similarBox.hidden = true; catSuggest.hidden = true; },
  };
}

// ---------- delete and merge, from the sheet or the inspector ----------
export async function deletePartFlow(part, { onDone } = {}) {
  const ok = await confirmSheet({ title: `Delete ${part.name}?`, message: 'It comes out of your parts list and any project lines using it go back to unmatched. You can undo right after.', confirm: 'Delete part', danger: true });
  if (!ok) return false;
  try {
    const r = await api(`/parts/${part.id}`, { method: 'DELETE' });
    removePart(part.id);
    onDone?.();
    toast(`Deleted ${part.name}.`, {
      action: 'Undo', timeout: 8000, onAction: async () => {
        try { upsertParts([await api('/parts/restore', { method: 'POST', body: r })]); } catch (e) { showError(e); }
      },
    });
    return true;
  } catch (e) { showError(e); return false; }
}

// ---------- where it's used, and its history ----------
const PROJECT_STATUS_LABEL = { building: 'Building', planned: 'Planned', idea: 'Idea', done: 'Done' };

function amountText(n, part) {
  const u = unitLabel(part?.unit, n);
  return u ? `${formatNumber(n)} ${u}` : formatNumber(n);
}

const KIND_TITLE = { create: 'Added', add: 'Added more', build: 'Built', receive: 'Received', delete: 'Deleted', restore: 'Put back', merge: 'Merged', undo: 'Undo' };
const FIELD_NAME = { mpn: 'Part number', package: 'Package', notes: 'Notes', link: 'Link', aliases: 'Other names', minQty: 'Warning level', cost: 'Unit cost' };

/** A history entry in words: what happened, and what changed. */
export function describeEvent(e, part) {
  const c = e.changes || {};
  const keys = Object.keys(c);
  if (e.kind === 'create') {
    const level = c.stockLevel?.[1];
    return { title: e.reason || 'Added', detail: level ? LEVEL_LABELS[level] : c.qty ? `${amountText(c.qty[1], part)} on hand` : '' };
  }
  const bits = [];
  if (c.qty) bits.push(`${formatNumber(c.qty[0] ?? 0)} → ${amountText(c.qty[1], part)}`);
  if (c.stockLevel) {
    const [a, b] = c.stockLevel;
    bits.push(`${a ? LEVEL_LABELS[a] : 'Counted'} → ${b ? LEVEL_LABELS[b].toLowerCase() : 'counted exactly'}`);
  }
  if (c.name) bits.push(`Was “${c.name[0]}”`);
  if (c.location) bits.push(!c.location[1] ? 'Location cleared' : c.location[0] ? `${c.location[0]} → ${c.location[1]}` : `Put in ${c.location[1]}`);
  if (c.category) bits.push(c.category[1] ? `Category: ${c.category[1]}` : 'Category cleared');
  if (c.unit) bits.push(`Unit: ${c.unit[1] || 'pieces'}`);
  for (const k of Object.keys(FIELD_NAME)) if (c[k]) bits.push(`${FIELD_NAME[k]} changed`);

  let title = KIND_TITLE[e.kind] || 'Edited';
  if (e.kind === 'edit') {
    if (keys.length && keys.every(k => k === 'qty' || k === 'stockLevel')) title = 'Amount changed';
    else if (keys.length === 1 && keys[0] === 'location') title = 'Moved';
    else if (keys.length === 1 && keys[0] === 'name') title = 'Renamed';
    else title = 'Edited';
  } else if (e.reason && e.kind !== 'undo' && e.kind !== 'delete') title = e.reason;
  return { title, detail: bits.join(' · ') };
}

/**
 * The projects that use a part and its history, loaded from the server.
 * Call .refresh() after the part changes.
 */
export function partExtras(partId) {
  const el = h('div.part-extras');
  let data = null;
  let showAll = false;
  let seq = 0;

  async function load() {
    const mine = ++seq;
    try {
      const r = await api(`/parts/${partId}/details`);
      if (mine !== seq || !el.isConnected) return;
      data = r;
      draw();
    } catch { /* details are extra; the form still works */ }
  }

  function draw() {
    if (!data) return;
    const part = state.byId.get(partId) || data.part;
    clear(el, usageSection(part, data.usage), historySection(part));
  }

  function usageSection(part, usage) {
    if (!usage?.projects?.length) return null;
    const need = usage.need;
    let total = null;
    if (need > 0) {
      if (part.stockLevel) {
        const short = part.stockLevel === 'low' || part.stockLevel === 'out';
        total = h(`p.usage-total${short ? '.is-short' : ''}`, `Planned and building projects need ${amountText(need, part)}. You have ${LEVEL_LABELS[part.stockLevel].toLowerCase()}${short ? ', so top up' : ''}.`);
      } else {
        const short = Math.round((need - part.qty) * 1000) / 1000;
        total = h(`p.usage-total${short > 0 ? '.is-short' : ''}`, short > 0
          ? `Planned and building projects need ${amountText(need, part)}. You have ${formatNumber(part.qty)}, so ${formatNumber(short)} short.`
          : `Planned and building projects need ${amountText(need, part)} of your ${formatNumber(part.qty)}.`);
      }
    }
    return h('section',
      h('h3.extra-head', h('span', 'Used in')),
      h('div.extra-list', usage.projects.map(pr => h('a.extra-row', { href: `#/projects/${pr.id}` },
        h('span.usage-name', pr.name),
        h(`span.status-pill.status-${pr.status}`, PROJECT_STATUS_LABEL[pr.status] || pr.status),
        h('span.usage-need', `needs ${amountText(pr.need, part)}`),
        icon('chevron', 'chev')))),
      total);
  }

  function historySection(part) {
    const list = data.history || [];
    if (!list.length) return null;
    const shown = showAll ? list : list.slice(0, 5);
    return h('section',
      h('h3.extra-head', h('span', 'History')),
      h('div.extra-list', shown.map(e => {
        const { title, detail } = describeEvent(e, part);
        return h(`div.extra-row.hist-row${e.undone ? '.is-undone' : ''}`,
          h('div.hist-main', h('span.hist-title', title), detail && h('span.hist-detail', detail)),
          h('div.hist-side',
            h('span.hist-when', { title: new Date(e.at).toLocaleString() }, e.undone ? 'Undone' : formatWhen(e.at)),
            !e.undone && e.batch === data.undoBatch && h('button.btn.btn-sm.btn-quiet.hist-undo', {
              type: 'button', onclick: async () => { if (await undoLast()) load(); },
            }, icon('undo'), 'Undo')));
      })),
      list.length > 5 && h('button.btn.btn-quiet.btn-sm.extra-more', { type: 'button', onclick: () => { showAll = !showAll; draw(); } },
        showAll ? 'Show less' : `Show all ${list.length}`));
  }

  el.refresh = debounce(load, 350);
  el.load = load;
  load();
  return el;
}

// ---------- the sheet ----------
/**
 * Add or edit a part in a sheet.
 * @param {object|null} part existing part, or null to add
 * @param {object} preset values for a new part
 */
export function openPartEditor(part = null, preset = {}, { onSaved } = {}) {
  const editing = Boolean(part);
  const src = part || { qty: 1, ...stickyNew(), ...preset };
  let s;
  const menuItems = editing ? () => [
    { label: 'Merge with a duplicate…', icon: 'merge', action: merge },
    '-',
    { label: 'Delete part', icon: 'trash', danger: true, action: () => deletePartFlow(part, { onDone: () => s.close('saved') }) },
  ] : null;
  s = sheet({ title: editing ? 'Edit part' : 'Add part', size: 'md', menuItems, menuLabel: 'More actions for this part' });

  const form = partForm(src, {
    editing,
    partId: part?.id,
    onSubmit: () => save(false),
    actions: editing
      ? { merge: top => { s.close('saved'); openMerge([part.id, top.id], { keep: top.id }); } }
      : { add: addToExisting, open: top => { s.close('saved'); openPartEditor(state.byId.get(top.id)); } },
  });
  s.body.append(form.el);
  if (editing) s.body.append(h('div.sheet-extras', partExtras(part.id)));

  const saveBtn = h('button.btn.btn-primary', { type: 'button', onclick: () => save(false) }, editing ? 'Save' : 'Add part');
  s.footer.append(
    h('span'),
    h('div.footer-right',
      !editing && h('button.btn', { type: 'button', onclick: () => save(true), title: 'Shift+Enter' }, 'Add and start another'),
      saveBtn));
  form.el.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.shiftKey && !editing && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); save(true); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(false); }
  });
  if (!editing && form.name.value) form.check();

  async function addToExisting(match, qty) {
    try {
      const saved = await api(`/parts/${match.id}/qty`, { method: 'POST', body: { delta: qty } });
      upsertParts([saved]);
      toast(`Added ${qty} to ${saved.name}. Now ${formatStock(saved).toLowerCase()}.`);
      resetForNext();
    } catch (e) { showError(e); }
  }

  function resetForNext() {
    const v = form.values();
    rememberSticky(v.category, v.location, v);
    form.reset({ amount: { qty: v.stockLevel ? 0 : 1, stockLevel: v.stockLevel, unit: v.unit } });
    initial = JSON.stringify(form.values());
    form.name.focus();
  }

  let saving = false;
  async function save(another) {
    if (saving) return;
    const v = form.values();
    if (!v.name) { form.name.focus(); form.name.classList.add('invalid'); toast('Give the part a name.'); return; }
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
        if (!editing) { rememberSticky(v.category, v.location, v); toast(`Added ${saved.name}.`); }
        s.close('saved');
      }
    } catch (e) { showError(e); } finally { saving = false; }
  }

  async function merge() {
    if (JSON.stringify(form.values()) !== initial && !(await confirmSheet({ title: 'Discard changes?', message: 'Merging uses the part as it was saved.', confirm: 'Discard and merge', danger: true }))) return;
    s.close('saved');
    openMerge([part.id], { keep: part.id, pickOther: true });
  }

  let initial = JSON.stringify(form.values());
  s.beforeClose = async result => {
    if (result === 'saved' || JSON.stringify(form.values()) === initial) return true;
    if (!editing && !form.values().name) return true;
    return confirmSheet({ title: 'Discard changes?', message: editing ? 'Your edits to this part are not saved.' : 'This part has not been added yet.', confirm: 'Discard', danger: true });
  };

  if (!editing || !isTouch()) setTimeout(() => { form.name.focus(); if (editing) form.name.setSelectionRange(form.name.value.length, form.name.value.length); });
  return s;
}

// New parts start in the category, location and amount style you used last, for a run of similar parts.
let sticky = { category: '', location: '', stockLevel: null, unit: '', at: 0 };
function stickyNew() {
  if (Date.now() - sticky.at > 30 * 60e3) return {};
  return { category: sticky.category, location: sticky.location, stockLevel: sticky.stockLevel, unit: sticky.unit, qty: sticky.stockLevel ? 0 : 1 };
}
function rememberSticky(category, location, a = {}) {
  sticky = { category, location, stockLevel: a.stockLevel || null, unit: a.unit || '', at: Date.now() };
}
