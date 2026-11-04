// Adding many parts at once: "Paste a list" and "Add a kit".
import { h, clear, icon, api, toast, showError, sheet, debounce, plural, readFile } from './lib.js';
import { state, upsertParts } from './state.js';
import { formatStock, LEVEL_SHORT } from '../shared/stock.js';
import { KITS, kitRows, RESISTOR_STEPS, CAPACITOR_STEPS, PACKAGES, LED_COLORS, CONNECTOR_FAMILIES, SCREW_SIZES, SCREW_KINDS, SEMICONDUCTORS } from '../shared/kits.js';
import { formatOhms, formatFarads, ELECTROLYTIC_KIT } from '../shared/values.js';
import { datalist, field } from './editor.js';

function tape(text) {
  return h('span.tape', { title: 'Location' }, text);
}

/**
 * A preview of rows about to be added, with include / quantity / name / "add to existing" per row.
 * @param {{levels?: () => string|null}} o levels: the amount chosen for all rows, if not counted
 */
function previewList(container, o = {}) {
  let rows = [];
  let onChange = () => {};
  const api_ = {
    set(next) { rows = next; draw(); },
    rows: () => rows,
    onChange(fn) { onChange = fn; },
    draw,
  };
  function draw() {
    if (!rows.length) { clear(container); onChange(); return; }
    const level = o.level?.() || null;
    clear(container, h('div.preview-list', rows.map(r => {
      const qtyEl = level
        ? h('span.preview-level', LEVEL_SHORT[level])
        : h('input.input.input-qty', { type: 'text', inputmode: 'decimal', value: String(r.qty), 'aria-label': 'Quantity', oninput: e => { r.qty = Math.max(0, parseFloat(e.target.value) || 0); } });
      const nameIn = h('input.input', { value: r.name, 'aria-label': 'Name', oninput: e => { r.name = e.target.value; } });
      const cat = o.category?.() || r.category;
      const loc = o.location?.() || r.location;
      return h(`div.preview-row${r.include ? '' : '.excluded'}`,
        h('input.check', { type: 'checkbox', checked: r.include, 'aria-label': `Include ${r.name}`, onchange: e => { r.include = e.target.checked; draw(); } }),
        qtyEl,
        h('div.preview-main',
          nameIn,
          h('div.preview-meta',
            r.package && h('span.meta-pkg', r.package),
            cat && h('span.meta-cat', cat),
            loc && tape(loc),
            r.qtyGuessed && !level && h('span.meta-warn', 'quantity assumed 1')),
          r.match && h('label.preview-merge',
            h('input.check', { type: 'checkbox', checked: r.merge, onchange: e => { r.merge = e.target.checked; draw(); } }),
            h('span', `Add to ${r.match.name} (${formatStock(r.match).toLowerCase()}) instead of a new part`))));
    })));
    onChange();
  }
  return api_;
}

function addButtonLabel(rows) {
  const inc = rows.filter(r => r.include);
  const merging = inc.filter(r => r.merge).length;
  if (!inc.length) return 'Add parts';
  if (merging === inc.length) return `Update ${plural(merging, 'part')}`;
  if (merging) return `Add ${inc.length - merging}, update ${merging}`;
  return `Add ${plural(inc.length, 'part')}`;
}

async function submitRows(rows, { category = '', location = '', level = null } = {}) {
  const body = rows.filter(r => r.include && r.name.trim()).map(r => ({
    name: r.name.trim(),
    qty: level ? 0 : r.qty,
    stockLevel: level,
    mergeInto: r.merge && r.match ? r.match.id : null,
    category: category || r.category,
    location: location || r.location,
    mpn: r.mpn, package: r.package, notes: r.notes, link: r.link, cost: r.cost,
  }));
  const res = await api('/parts/bulk', { method: 'POST', body: { rows: body } });
  upsertParts(res.parts);
  const bits = [res.created && `added ${plural(res.created, 'part')}`, res.merged && `updated ${plural(res.merged, 'part')}`].filter(Boolean);
  toast(`${bits.join(' and ').replace(/^./, c => c.toUpperCase())}.`);
}

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
  const previewEl = h('div.paste-preview');
  const status = h('p.paste-status');
  const preview = previewList(previewEl, { category: () => cat.value.trim(), location: () => loc.value.trim() });

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
    previewEl);

  const addBtn = h('button.btn.btn-primary', { type: 'button', disabled: true, onclick: submit }, 'Add parts');
  s.footer.append(h('span'), h('div.footer-right', h('button.btn', { type: 'button', onclick: () => s.close() }, 'Cancel'), addBtn));
  preview.onChange(() => {
    addBtn.disabled = !preview.rows().some(r => r.include);
    addBtn.textContent = addButtonLabel(preview.rows());
  });

  const run = debounce(async () => {
    if (!ta.value.trim()) { preview.set([]); status.textContent = ''; return; }
    try {
      const r = await api('/parse', { method: 'POST', body: { text: ta.value } });
      preview.set(r.rows.map(x => ({ ...x, merge: Boolean(x.match && (x.match.exact || x.match.score >= 0.9)), include: true })));
      status.textContent = `${plural(r.rows.length, 'part')} found${r.format !== 'list' ? ` in a ${r.format}` : ''}.`;
    } catch (e) { status.textContent = e.message; }
  }, 300);
  ta.addEventListener('input', run);
  cat.addEventListener('input', preview.draw);
  loc.addEventListener('input', preview.draw);

  async function submit() {
    addBtn.disabled = true;
    try {
      await submitRows(preview.rows(), { category: cat.value.trim(), location: loc.value.trim() });
      s.close();
    } catch (e) { showError(e); addBtn.disabled = false; }
  }

  if (initial) run();
  setTimeout(() => ta.focus());
}

// ---------- add a kit ----------
function select(options, value, onchange, label) {
  return h('select.input.select', { 'aria-label': label, onchange: e => onchange(e.target.value) },
    options.map(([v, text]) => h('option', { value: String(v), selected: String(v) === String(value) }, text)));
}

function chipToggles(all, selected, onchange) {
  const box = h('div.chip-toggles');
  const draw = () => clear(box, all.map(([v, label]) => h('button.chip.chip-sm', {
    type: 'button', 'aria-pressed': String(selected.includes(v)),
    onclick: () => {
      selected = selected.includes(v) ? selected.filter(x => x !== v) : [...selected, v];
      draw();
      onchange(selected);
    },
  }, label)));
  draw();
  return box;
}

export function openKit(initialType) {
  const s = sheet({ title: 'Add a kit', subtitle: 'Add every part in an assortment at once.', size: 'lg' });
  const kinds = h('div.kit-kinds', { role: 'radiogroup', 'aria-label': 'Kind of kit' });
  const options = h('div.kit-options');
  const previewEl = h('div.paste-preview');
  const status = h('p.paste-status');
  let type = initialType || 'resistors';
  let o = {};
  let amount = 'plenty';
  let count = 20;
  const cat = h('input.input', { list: 'dl-cats3', placeholder: 'Category', autocomplete: 'off' });
  const loc = h('input.input', { list: 'dl-locs3', placeholder: 'e.g. Resistor book', autocomplete: 'off' });
  const preview = previewList(previewEl, { level: () => (amount === 'count' ? null : amount), category: () => cat.value.trim(), location: () => loc.value.trim() });

  const amountSeg = h('div.segmented', { role: 'radiogroup', 'aria-label': 'How many of each' });
  const countIn = h('input.input.input-qty', { type: 'text', inputmode: 'decimal', 'aria-label': 'How many of each', oninput: e => {
    count = Math.max(0, parseFloat(e.target.value) || 0);
    for (const r of preview.rows()) r.qty = count;
    preview.draw();
  } });
  function drawAmount() {
    clear(amountSeg, [['count', 'Count'], ['plenty', 'Plenty'], ['some', 'Some']].map(([k, label]) => h('button.seg', {
      type: 'button', role: 'radio', 'aria-checked': String(amount === k),
      onclick: () => { amount = k; drawAmount(); preview.draw(); },
    }, label)));
    countIn.value = String(count);
    countIn.hidden = amount !== 'count';
  }

  function drawKinds() {
    clear(kinds, Object.entries(KITS).map(([k, kit]) => h('button.kit-kind', {
      type: 'button', role: 'radio', 'aria-checked': String(type === k),
      onclick: () => { if (type !== k) { type = k; reset(); } },
    }, h('span.kit-kind-title', kit.title))));
  }

  function reset() {
    o = structuredClone(KITS[type].defaults);
    amount = o.amount;
    count = o.count;
    cat.value = kitRows(type, o)[0]?.category || '';
    drawKinds();
    drawAmount();
    drawOptions();
    regenerate();
  }

  const set = (k, v) => { o[k] = v; regenerate(); };
  function drawOptions() {
    const f = (label, control) => h('label.field', h('span.field-label', label), control);
    const ohm = RESISTOR_STEPS.map(v => [v, formatOhms(v)]);
    const pf = CAPACITOR_STEPS.map(v => [v, formatFarads(v)]);
    const pkgs = PACKAGES.map(p => [p, p]);
    let ctl = [];
    if (type === 'resistors' || type === 'ceramic') {
      const steps = type === 'resistors' ? ohm : pf;
      const series = type === 'resistors' ? ['E6', 'E12', 'E24'] : ['E3', 'E6', 'E12'];
      ctl = [
        f('Series', select(series.map(x => [x, x]), o.series, v => set('series', v), 'Series')),
        f('From', select(steps, o.min, v => set('min', Number(v)), 'Smallest value')),
        f('To', select(steps, o.max, v => set('max', Number(v)), 'Largest value')),
        f('Package', select(pkgs, o.package, v => set('package', v), 'Package')),
      ];
    } else if (type === 'electrolytic') {
      const vals = ELECTROLYTIC_KIT.map(v => [v, `${v}µF`]);
      ctl = [
        f('From', select(vals, o.min, v => set('min', Number(v)), 'Smallest value')),
        f('To', select(vals, o.max, v => set('max', Number(v)), 'Largest value')),
        f('Voltage', select(['10V', '16V', '25V', '35V', '50V', '63V', ''].map(v => [v, v || 'Not listed']), o.voltage, v => set('voltage', v), 'Voltage')),
      ];
    } else if (type === 'leds') {
      ctl = [
        h('div.field.span-all', h('span.field-label', 'Sizes'), chipToggles([['3mm', '3mm'], ['5mm', '5mm'], ['10mm', '10mm']], o.sizes, v => set('sizes', v))),
        h('div.field.span-all', h('span.field-label', 'Colors'), chipToggles(LED_COLORS.map(c => [c, c]), o.colors, v => set('colors', v))),
      ];
    } else if (type === 'connectors') {
      const fam = CONNECTOR_FAMILIES[o.family];
      const pins = Array.from({ length: 12 }, (_, i) => [i + 1, `${i + 1}`]);
      const toggle = (k, label) => h('label.toggle-row.toggle-sm', h('input.check', { type: 'checkbox', checked: o[k], onchange: e => set(k, e.target.checked) }), h('span', label));
      ctl = [
        f('Type', select(Object.entries(CONNECTOR_FAMILIES).map(([k, v]) => [k, `${k} (${v.pitch})`]), o.family, v => {
          const nf = CONNECTOR_FAMILIES[v];
          o.minPins = nf.minPins; o.maxPins = nf.maxPins;
          set('family', v);
          drawOptions();
        }, 'Connector type')),
        f('Pins from', select(pins, o.minPins, v => set('minPins', Number(v)), 'Fewest pins')),
        f('Pins to', select(pins, o.maxPins, v => set('maxPins', Number(v)), 'Most pins')),
        o.family !== 'Screw terminal' && h('div.field.span-all.kit-toggles',
          toggle('housings', 'Housings'),
          o.family !== 'Dupont' && toggle('headers', 'PCB headers'),
          toggle('crimps', 'Crimp terminals')),
      ];
      void fam;
    } else if (type === 'semis') {
      o.exclude = o.exclude || [];
      ctl = [h('p.field-hint.span-all', `${SEMICONDUCTORS.length} common diodes, transistors and MOSFETs. Untick any you don’t have below.`)];
    } else if (type === 'hardware') {
      const lengths = h('input.input', { value: o.lengths, placeholder: '6, 8, 10, 12', inputmode: 'numeric', oninput: debounce(e => set('lengths', e.target.value), 250) });
      ctl = [
        h('div.field.span-all', h('span.field-label', 'Sizes'), chipToggles(SCREW_SIZES.map(x => [x, x]), o.sizes, v => set('sizes', v))),
        f('Kind', select(SCREW_KINDS.map(k => [k, k[0].toUpperCase() + k.slice(1) + 's']), o.kind, v => set('kind', v), 'Kind')),
        f('Lengths in mm', lengths),
        !/standoff/.test(o.kind) && h('label.toggle-row.toggle-sm.kit-nuts', h('input.check', { type: 'checkbox', checked: o.nuts, onchange: e => set('nuts', e.target.checked) }), h('span', 'Hex nuts too')),
      ];
    }
    clear(options, h('p.kit-hint', KITS[type].hint), h('div.kit-grid', ctl));
  }

  let seq = 0;
  async function regenerate() {
    const rows = kitRows(type, o);
    const mine = ++seq;
    status.textContent = rows.length ? `${plural(rows.length, 'part')}` : 'No parts with these options.';
    if (!rows.length) { preview.set([]); return; }
    try {
      const r = await api('/match-rows', { method: 'POST', body: { rows: rows.map(x => ({ ...x, qty: count })) } });
      if (mine !== seq) return;
      preview.set(r.rows.map(x => ({ ...x, category: x.category, include: true, merge: Boolean(x.match?.exact) })));
      const have = r.rows.filter(x => x.match?.exact).length;
      status.textContent = `${plural(rows.length, 'part')}${have ? `, ${have} already in your parts` : ''}.`;
    } catch (e) { status.textContent = e.message; }
  }

  s.body.append(
    kinds,
    options,
    h('div.kit-apply',
      h('div.field', h('span.field-label', 'How many of each'), h('div.amount-count', amountSeg, countIn)),
      field('Category', cat),
      field('Location', loc)),
    datalist('dl-cats3', state.groups.categories.map(c => c.name)),
    datalist('dl-locs3', state.groups.locations.map(c => c.name)),
    h('div.kit-preview-head', h('span.field-label', 'Parts'), status),
    previewEl);

  const addBtn = h('button.btn.btn-primary', { type: 'button', disabled: true, onclick: submit }, 'Add parts');
  s.footer.append(h('span'), h('div.footer-right', h('button.btn', { type: 'button', onclick: () => s.close() }, 'Cancel'), addBtn));
  preview.onChange(() => {
    addBtn.disabled = !preview.rows().some(r => r.include);
    addBtn.textContent = addButtonLabel(preview.rows());
  });
  cat.addEventListener('input', preview.draw);
  loc.addEventListener('input', preview.draw);

  async function submit() {
    addBtn.disabled = true;
    try {
      await submitRows(preview.rows().map(r => ({ ...r, qty: amount === 'count' ? r.qty : 0 })), {
        category: cat.value.trim(), location: loc.value.trim(), level: amount === 'count' ? null : amount,
      });
      s.close();
    } catch (e) { showError(e); addBtn.disabled = false; }
  }

  reset();
}
