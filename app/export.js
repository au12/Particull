// Text exports: the inventory as chat context, and a project's shopping list.
import { analyze } from './public/shared/match.js';
import { formatNumber, unitLabel, isCountUnit, isLow, LEVEL_LABELS } from './public/shared/stock.js';
import { describeValues, formatOhms, formatFarads, formatMicrofarads } from './public/shared/values.js';

export const BOM_FORMAT_HINT = `When you give me a bill of materials, put it in one Markdown table with these columns so I can import it into Particull:

| Qty | Part | Part number | Package | Notes |

One row per distinct part, quantity for a single build. When I already have a part, use the same name as in my inventory.`;

const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = rows => rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

function money(n, currency) {
  return `${currency}${n < 1 ? n.toFixed(3).replace(/0$/, '') : n.toFixed(2)}`;
}

// Words that can sit in a plain resistor or capacitor name without making it special.
const PASSIVE_WORDS = new Set(['resistor', 'capacitor', 'ceramic', 'electrolytic', 'tantalum', 'film', 'metal', 'carbon', 'smd', 'throughhole', 'mlcc', 'x7r', 'x5r', 'c0g', 'np0', 'polarized', 'aluminum', 'aluminium', 'axial', 'radial', 'ohm']);

/** If a part is a plain resistor or capacitor, what group it belongs to and its value. */
function passive(p, o) {
  if (p.mpn || !isCountUnit(p.unit) || isLow(p) || (o.notes && p.notes) || (o.cost && p.cost != null)) return null;
  const a = analyze(p.name.replace(/\d+(\.\d+)?\s*%/g, ' '), { package: p.package });
  const res = a.values.get('res');
  const cap = a.values.get('cap');
  if (Boolean(res) === Boolean(cap)) return null;
  for (const t of a.tokens) {
    if (t.includes(':')) {
      if (/^(pkg|res|cap|v|w):/.test(t)) continue;
      return null;
    }
    if (!PASSIVE_WORDS.has(t)) return null;
  }
  const kind = res ? 'Resistors'
    : a.tokens.has('electrolytic') ? 'Electrolytic capacitors'
      : a.tokens.has('tantalum') ? 'Tantalum capacitors'
        : 'Ceramic capacitors';
  const pkg = p.package || [...a.packages][0] || (a.tokens.has('throughhole') ? 'through-hole' : '');
  const volts = cap && a.values.get('v') ? `${a.values.get('v').split(':')[1]}V` : '';
  const watts = res && a.values.get('w') ? `${formatNumber(Number(a.values.get('w').split(':')[1]))}W` : '';
  const loc = o.locations ? p.location : '';
  return {
    key: [kind, pkg.toLowerCase(), volts, watts, loc].join('|'),
    kind, pkg, volts, watts, loc,
    value: Number((res || cap).split(':')[1]),
  };
}

function amountPhrase(items, fmt) {
  // Mostly one amount with a few exceptions: "plenty of each (5.1k: 8)"
  const label = p => (p.stockLevel ? LEVEL_LABELS[p.stockLevel].toLowerCase() : formatNumber(p.qty));
  const tally = new Map();
  for (const p of items) tally.set(label(p), (tally.get(label(p)) || 0) + 1);
  const [common, n] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  if (n === items.length) return `${common} of each`;
  if (items.length - n <= 3) {
    const odd = items.filter(p => label(p) !== common).map(p => `${fmt(p._value)}: ${label(p)}`);
    return `${common} of each (${odd.join(', ')})`;
  }
  const counts = items.filter(p => !p.stockLevel).map(p => p.qty);
  if (!counts.length) return 'some of each';
  const min = Math.min(...counts), max = Math.max(...counts);
  if (counts.length === items.length) return min === max ? `${formatNumber(min)} of each` : `${formatNumber(min)}–${formatNumber(max)} of each`;
  return `at least ${formatNumber(min)} of each`;
}

/**
 * Collapse runs of plain resistors and capacitors into one line per kind and package.
 * @returns {{entries: Array<{category:string, sort:string, line:string}>, rest: object[], collapsed: number}}
 */
function compactPassives(list, o) {
  const groups = new Map();
  const rest = [];
  for (const p of list) {
    const info = passive(p, o);
    if (!info) { rest.push(p); continue; }
    if (!groups.has(info.key)) groups.set(info.key, { ...info, items: [] });
    groups.get(info.key).items.push({ ...p, _value: info.value });
  }
  const entries = [];
  let collapsed = 0;
  for (const g of groups.values()) {
    if (g.items.length < 4) { rest.push(...g.items); continue; }
    const fmt = g.kind === 'Resistors' ? formatOhms : g.kind === 'Ceramic capacitors' ? formatFarads : formatMicrofarads;
    const label = [g.kind, g.pkg, g.watts, g.volts && `${g.volts}`].filter(Boolean).join(', ');
    const cats = new Map();
    for (const p of g.items) cats.set(p.category || 'Uncategorized', (cats.get(p.category || 'Uncategorized') || 0) + 1);
    const category = [...cats.entries()].sort((a, b) => b[1] - a[1])[0][0];
    let line = `- ${label}: ${describeValues(g.items.map(p => p._value), fmt)}; ${amountPhrase(g.items, fmt)}`;
    if (g.loc) line += ` [${g.loc}]`;
    entries.push({ category, sort: `${g.kind} ${g.pkg}`, line });
    collapsed += g.items.length;
  }
  return { entries, rest, collapsed };
}

function partLine(p, o) {
  const extra = [];
  if (p.package && !p.name.toLowerCase().includes(p.package.toLowerCase())) extra.push(p.package);
  if (p.mpn && !p.name.toLowerCase().includes(p.mpn.toLowerCase())) extra.push(p.mpn);
  const desc = `${p.name}${extra.length ? ` (${extra.join(', ')})` : ''}`;
  let line;
  if (p.stockLevel) line = `- ${desc}: ${LEVEL_LABELS[p.stockLevel].toLowerCase()}`;
  else if (!isCountUnit(p.unit)) line = `- ${formatNumber(p.qty)} ${unitLabel(p.unit, p.qty)} of ${desc}`;
  else line = `- ${formatNumber(p.qty)} × ${desc}`;
  if (o.notes && p.notes) line += ` — ${p.notes.replace(/\s+/g, ' ')}`;
  if (o.locations && p.location) line += ` [${p.location}]`;
  if (o.cost && p.cost != null) line += ` @ ${money(p.cost, o.currency)}`;
  return line;
}

/**
 * @param {object[]} parts
 * @param {{format:'md'|'csv'|'json', locations:boolean, notes:boolean, empty:boolean, cost:boolean, currency:string}} o
 */
export function exportInventory(parts, o) {
  const list = parts.filter(p => o.empty || (p.stockLevel ? p.stockLevel !== 'out' : p.qty > 0));
  const date = new Date().toLocaleDateString('sv-SE');

  if (o.format === 'json') {
    return JSON.stringify({
      exported: date,
      parts: list.map(p => {
        const r = { name: p.name };
        if (p.stockLevel) r.amount = p.stockLevel; else r.qty = p.qty;
        if (!isCountUnit(p.unit)) r.unit = p.unit;
        if (p.category) r.category = p.category;
        if (p.mpn) r.partNumber = p.mpn;
        if (p.package) r.package = p.package;
        if (o.locations && p.location) r.location = p.location;
        if (o.notes && p.notes) r.notes = p.notes;
        if (o.cost && p.cost != null) r.unitCost = p.cost;
        return r;
      }),
    }, null, 2);
  }

  if (o.format === 'csv') {
    const head = ['Qty', 'Unit', 'Name', 'Category', 'Part number', 'Package'];
    if (o.locations) head.push('Location');
    if (o.notes) head.push('Notes');
    if (o.cost) head.push('Unit cost');
    return toCsv([head, ...list.map(p => {
      const r = [p.stockLevel ? LEVEL_LABELS[p.stockLevel] : p.qty, isCountUnit(p.unit) ? '' : p.unit, p.name, p.category, p.mpn, p.package];
      if (o.locations) r.push(p.location);
      if (o.notes) r.push(p.notes);
      if (o.cost) r.push(p.cost ?? '');
      return r;
    })]);
  }

  const { entries, rest, collapsed } = o.compact ? compactPassives(list, o) : { entries: [], rest: list, collapsed: 0 };
  const out = [
    '# My parts inventory',
    '',
    `Exported from Particull on ${date}: ${list.length} parts.`,
    '',
    'These are the parts I already have on hand. When you suggest a build, use these where they fit, and clearly list anything I would still need to buy.',
    '"Plenty" and "some" mean I have enough for a normal hobby build without counting.',
  ];
  if (collapsed) out.push(`Runs of plain resistors and capacitors are listed as one line per kind and package; every value named is on hand.`);
  out.push('', BOM_FORMAT_HINT, '');
  const byCat = new Map();
  for (const e of entries) {
    if (!byCat.has(e.category)) byCat.set(e.category, []);
    byCat.get(e.category).push(e);
  }
  for (const p of rest) {
    const c = p.category || 'Uncategorized';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push({ category: c, sort: `~${p.name}`, line: partLine(p, o) });
  }
  const cats = [...byCat.keys()].sort((a, b) => (a === 'Uncategorized') - (b === 'Uncategorized') || a.localeCompare(b));
  for (const cat of cats) {
    out.push(`## ${cat}`, '');
    for (const e of byCat.get(cat).sort((a, b) => a.sort.localeCompare(b.sort, undefined, { numeric: true }))) out.push(e.line);
    out.push('');
  }
  return out.join('\n');
}

export function shoppingList(project, { format = 'md', cost = false, currency = '$' } = {}) {
  const lines = project.lines.filter(l => l.status === 'short' || l.status === 'missing');
  if (format === 'csv') {
    const head = ['Buy', 'Part', 'Part number', 'Package', 'Have', 'Need', 'Notes'];
    return toCsv([head, ...lines.map(l => [l.short, l.name, l.mpn, l.package, l.have, l.need, l.notes])]);
  }
  const out = [`# Shopping list: ${project.name}`, ''];
  if (project.builds > 1) out.push(`For ${project.builds} builds.`, '');
  if (!lines.length) out.push('Nothing to buy. You have everything on the list.');
  for (const l of lines) {
    const extra = [l.mpn, l.package].filter(Boolean).join(', ');
    const u = l.part ? unitLabel(l.part.unit, l.short) : '';
    let s = `- ${formatNumber(l.short)}${u ? ` ${u} of` : ' ×'} ${l.name}${extra ? ` (${extra})` : ''}`;
    if (l.level === 'low') s += ' — running low, top up';
    else if (l.have) s += ` — have ${formatNumber(l.have)}, need ${formatNumber(l.need)}`;
    if (cost && l.part?.cost != null) s += ` @ ${money(l.part.cost, currency)}`;
    out.push(s);
  }
  return out.join('\n') + '\n';
}

export function bomExport(project, { format = 'md' } = {}) {
  if (format === 'csv') {
    return toCsv([['Qty', 'Part', 'Part number', 'Package', 'References', 'Notes', 'Status', 'Matched part'],
      ...project.lines.map(l => [l.qty, l.name, l.mpn, l.package, l.refs, l.notes, l.status, l.part?.name || ''])]);
  }
  const esc = s => String(s || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  const out = [`# ${project.name}`, '', '| Qty | Part | Part number | Package | Notes |', '| --- | --- | --- | --- | --- |'];
  for (const l of project.lines) out.push(`| ${l.qty} | ${esc(l.name)} | ${esc(l.mpn)} | ${esc(l.package)} | ${esc(l.notes)} |`);
  return out.join('\n') + '\n';
}
