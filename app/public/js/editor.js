// Add or edit one part.
import { h, clear, icon, api, toast, showError, sheet, confirmSheet, debounce, isTouch, stepper } from './lib.js';
import { state, upsertParts, removePart, costOn } from './state.js';
import { LEVELS, LEVEL_SHORT, UNITS, formatStock } from '../shared/stock.js';
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

/**
 * Add or edit a part.
 * @param {object|null} part existing part, or null to add
 * @param {object} preset values for a new part
 */
export function openPartEditor(part = null, preset = {}, { onSaved } = {}) {
  const editing = Boolean(part);
  const src = part || { qty: 1, ...stickyNew(), ...preset };
  const s = sheet({ title: editing ? 'Edit part' : 'Add part', size: 'md' });

  const name = h('input.input.input-lg', { value: src.name || '', required: true, autocomplete: 'off', autocapitalize: 'sentences', enterkeyhint: 'done', placeholder: 'e.g. 10k resistor, ESP32-S3 dev board' });
  const amount = amountControl(src);
  const category = h('input.input', { value: src.category || '', list: 'dl-cats', autocomplete: 'off', placeholder: 'e.g. Resistors' });
  const location = h('input.input', { value: src.location || '', list: 'dl-locs', autocomplete: 'off', placeholder: 'e.g. Drawer A3' });
  const mpn = h('input.input.mono', { value: src.mpn || '', autocomplete: 'off', spellcheck: 'false', placeholder: 'Manufacturer part number' });
  const pkg = h('input.input', { value: src.package || '', autocomplete: 'off', placeholder: 'e.g. 0805, SOT-23, DIP-8' });
  const notes = h('textarea.input', { rows: '2', placeholder: 'Anything worth remembering' });
  notes.value = src.notes || '';
  const link = h('input.input', { type: 'url', value: src.link || '', autocomplete: 'off', placeholder: 'Datasheet or product page' });
  const minQty = h('input.input.input-num', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: src.minQty ?? '', placeholder: 'Off' });
  const cost = h('input.input.input-num', { type: 'number', min: '0', step: '0.001', inputmode: 'decimal', value: src.cost ?? '', placeholder: '0.00' });
  let aliases = [...(src.aliases || [])];
  const aliasList = h('div.alias-list');
  const aliasInput = h('input.input', { placeholder: 'Add another name', autocomplete: 'off', onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); addAlias(); } } });
  function addAlias() {
    const v = aliasInput.value.trim();
    if (v && !aliases.some(a => a.toLowerCase() === v.toLowerCase())) aliases.push(v);
    aliasInput.value = '';
    renderAliases();
  }
  function renderAliases() {
    clear(aliasList, aliases.map((a, i) => h('span.alias', a,
      h('button.alias-x', { type: 'button', 'aria-label': `Remove ${a}`, onclick: () => { aliases.splice(i, 1); renderAliases(); } }, icon('x')))));
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
      field('Warn when at or below', minQty, 'For counted parts. Leave empty to only flag it at zero.'),
      costOn() ? field(`Unit cost (${state.settings.currency})`, cost) : null));

  const form = h('form.part-form', { onsubmit: e => { e.preventDefault(); save(false); } },
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
  s.body.append(form);

  const saveBtn = h('button.btn.btn-primary', { type: 'button', onclick: () => save(false) }, editing ? 'Save' : 'Add part');
  s.footer.append(
    editing
      ? h('div.footer-left',
        h('button.btn.btn-danger-quiet', { type: 'button', onclick: del }, icon('trash'), h('span.hide-xs', 'Delete')),
        h('button.btn.btn-quiet', { type: 'button', onclick: merge, title: 'Combine this part with a duplicate' }, icon('merge'), h('span.hide-xs', 'Merge')))
      : h('span'),
    h('div.footer-right',
      !editing && h('button.btn', { type: 'button', onclick: () => save(true), title: 'Shift+Enter' }, 'Add and start another'),
      saveBtn));
  form.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.shiftKey && !editing && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); save(true); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(false); }
  });

  // Duplicate check and category suggestion while typing a name.
  const check = debounce(async () => {
    const n = name.value.trim();
    if (n.length < 2) { similarBox.hidden = true; catSuggest.hidden = true; return; }
    try {
      const r = await api('/similar', { method: 'POST', body: { name: n, mpn: mpn.value, package: pkg.value, exclude: part?.id } });
      const top = r.matches[0];
      if (top && (!editing || top.exact)) {
        const a = amount.get();
        const canAdd = !editing && !a.stockLevel && !top.stockLevel && a.qty > 0;
        clear(similarBox,
          icon('warn'),
          h('div.similar-text',
            h('strong', top.exact ? 'Already in your parts' : 'You may already have this'),
            h('span', `${top.name}: ${formatStock(top).toLowerCase()}${top.location ? `, in ${top.location}` : ''}`)),
          h('div.similar-actions',
            canAdd && h('button.btn.btn-sm', { type: 'button', onclick: () => addToExisting(top) }, `Add ${a.qty} to it`),
            editing
              ? h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => { s.close('saved'); openMerge([part.id, top.id], { keep: top.id }); } }, 'Merge them')
              : h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => { s.close('saved'); openPartEditor(state.byId.get(top.id)); } }, 'Open it')));
        similarBox.hidden = false;
      } else similarBox.hidden = true;
      if (r.category && !category.value.trim()) {
        clear(catSuggest, h('span', 'Suggested'), h('button.chip.chip-sm', { type: 'button', onclick: () => { category.value = r.category; catSuggest.hidden = true; } }, r.category));
        catSuggest.hidden = false;
      } else catSuggest.hidden = true;
    } catch { /* checking is best-effort */ }
  }, 250);
  name.addEventListener('input', check);
  category.addEventListener('input', () => { if (category.value) catSuggest.hidden = true; });
  if (!editing && name.value) check();

  async function addToExisting(match) {
    const a = amount.get();
    try {
      const saved = await api(`/parts/${match.id}/qty`, { method: 'POST', body: { delta: a.qty } });
      upsertParts([saved]);
      toast(`Added ${a.qty} to ${saved.name}. Now ${formatStock(saved).toLowerCase()}.`);
      resetForNext();
    } catch (e) { showError(e); }
  }

  function values() {
    const a = amount.get();
    return {
      name: name.value.trim(), qty: a.qty, stockLevel: a.stockLevel, unit: a.unit,
      category: category.value.trim(), location: location.value.trim(),
      mpn: mpn.value.trim(), package: pkg.value.trim(), notes: notes.value.trim(), link: link.value.trim(), aliases,
      minQty: minQty.value === '' ? null : Number(minQty.value),
      ...(costOn() ? { cost: cost.value === '' ? null : Number(cost.value) } : {}),
    };
  }

  function resetForNext() {
    const a = amount.get();
    rememberSticky(category.value.trim(), location.value.trim(), a);
    name.value = ''; mpn.value = ''; pkg.value = ''; notes.value = ''; link.value = ''; minQty.value = ''; cost.value = '';
    aliases = []; renderAliases();
    amount.set({ qty: a.stockLevel ? 0 : 1, stockLevel: a.stockLevel, unit: a.unit });
    similarBox.hidden = true; catSuggest.hidden = true;
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
        if (!editing) { rememberSticky(v.category, v.location, v); toast(`Added ${saved.name}.`); }
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

  async function merge() {
    if (JSON.stringify(values()) !== initial && !(await confirmSheet({ title: 'Discard changes?', message: 'Merging uses the part as it was saved.', confirm: 'Discard and merge', danger: true }))) return;
    s.close('saved');
    openMerge([part.id], { keep: part.id, pickOther: true });
  }

  let initial = JSON.stringify(values());
  s.beforeClose = async result => {
    if (result === 'saved' || JSON.stringify(values()) === initial) return true;
    if (!editing && !values().name) return true;
    return confirmSheet({ title: 'Discard changes?', message: editing ? 'Your edits to this part are not saved.' : 'This part has not been added yet.', confirm: 'Discard', danger: true });
  };

  if (!editing || !isTouch()) setTimeout(() => { name.focus(); if (editing) name.setSelectionRange(name.value.length, name.value.length); });
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
