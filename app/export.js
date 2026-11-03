// Text exports: the inventory as chat context, and a project's shopping list.

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

function byCategory(parts) {
  const groups = new Map();
  for (const p of parts) {
    const k = p.category || 'Uncategorized';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  return [...groups.entries()].sort(([a], [b]) => (a === 'Uncategorized') - (b === 'Uncategorized') || a.localeCompare(b));
}

/**
 * @param {object[]} parts
 * @param {{format:'md'|'csv'|'json', locations:boolean, notes:boolean, empty:boolean, cost:boolean, currency:string}} o
 */
export function exportInventory(parts, o) {
  const list = parts.filter(p => o.empty || p.qty > 0);
  const date = new Date().toLocaleDateString('sv-SE');

  if (o.format === 'json') {
    return JSON.stringify({
      exported: date,
      parts: list.map(p => {
        const r = { name: p.name, qty: p.qty };
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
    const head = ['Qty', 'Name', 'Category', 'Part number', 'Package'];
    if (o.locations) head.push('Location');
    if (o.notes) head.push('Notes');
    if (o.cost) head.push('Unit cost');
    return toCsv([head, ...list.map(p => {
      const r = [p.qty, p.name, p.category, p.mpn, p.package];
      if (o.locations) r.push(p.location);
      if (o.notes) r.push(p.notes);
      if (o.cost) r.push(p.cost ?? '');
      return r;
    })]);
  }

  const pieces = list.reduce((s, p) => s + p.qty, 0);
  const out = [
    '# My parts inventory',
    '',
    `Exported from Particull on ${date}: ${list.length} parts, ${pieces.toLocaleString('en-US')} pieces in total.`,
    '',
    'These are the parts I already have on hand. When you suggest a build, use these where they fit, and clearly list anything I would still need to buy.',
    '',
    BOM_FORMAT_HINT,
    '',
  ];
  for (const [cat, items] of byCategory(list)) {
    out.push(`## ${cat}`, '');
    for (const p of items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      const extra = [];
      if (p.package && !p.name.toLowerCase().includes(p.package.toLowerCase())) extra.push(p.package);
      if (p.mpn && !p.name.toLowerCase().includes(p.mpn.toLowerCase())) extra.push(p.mpn);
      let line = `- ${p.qty} × ${p.name}${extra.length ? ` (${extra.join(', ')})` : ''}`;
      if (o.notes && p.notes) line += ` — ${p.notes.replace(/\s+/g, ' ')}`;
      if (o.locations && p.location) line += ` [${p.location}]`;
      if (o.cost && p.cost != null) line += ` @ ${money(p.cost, o.currency)}`;
      out.push(line);
    }
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
    let s = `- ${l.short} × ${l.name}${extra ? ` (${extra})` : ''}`;
    if (l.have) s += ` — have ${l.have}, need ${l.need}`;
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
