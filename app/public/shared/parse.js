// Turns pasted or uploaded text into rows of parts.
// Understands Markdown tables, CSV/TSV/semicolon files (including KiCad BOM exports),
// and plain lists like "10x 10k resistor 0805" or "ESP32-S3 dev board ×2".
// Shared by the server (BOM import) and the browser (paste-a-list preview).

const FIELD_ALIASES = {
  qty: ['qty', 'quantity', 'count', 'amount', '#', 'pcs', 'qnty', 'qty per pcb', 'quantity per pcb', 'qty.', 'number', 'stock', 'on hand', 'in stock', 'units'],
  name: ['name', 'part', 'item', 'component', 'part name', 'title', 'product', 'parts', 'components'],
  value: ['value', 'val'],
  description: ['description', 'desc'],
  mpn: ['mpn', 'part number', 'part #', 'part no', 'part no.', 'pn', 'p/n', 'manufacturer part number', 'mfr part', 'mfr part #', 'mfg part', 'mfg part #', 'manufacturer part', 'sku', 'model'],
  package: ['package', 'footprint', 'case', 'size', 'pkg', 'case/package'],
  refs: ['reference', 'references', 'ref', 'refs', 'designator', 'designators', 'ref des', 'refdes'],
  notes: ['notes', 'note', 'comment', 'comments', 'remarks', 'purpose', 'function', 'use', 'used for', 'why'],
  category: ['category', 'type', 'group', 'kind'],
  location: ['location', 'bin', 'drawer', 'box', 'storage', 'place', 'where'],
  link: ['link', 'url', 'datasheet', 'source', 'buy'],
  cost: ['cost', 'price', 'unit cost', 'unit price', 'each'],
};

const HEADER_LOOKUP = new Map();
for (const [field, names] of Object.entries(FIELD_ALIASES)) {
  for (const n of names) HEADER_LOOKUP.set(n, field);
}

function headerField(cell) {
  const key = String(cell || '').toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  if (HEADER_LOOKUP.has(key)) return HEADER_LOOKUP.get(key);
  const loose = key.replace(/[().:]/g, '').trim();
  if (HEADER_LOOKUP.has(loose)) return HEADER_LOOKUP.get(loose);
  return null;
}

// RFC 4180-ish splitter that handles quotes and doubled quotes.
export function splitDelimited(line, delim) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"' && cur.trim() === '') {
      quoted = true;
      cur = '';
    } else if (ch === delim) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// Splits text into logical lines, keeping newlines that sit inside quoted CSV cells.
function logicalLines(text) {
  // Only CSV-style files quote cells across line breaks. Anything else (Markdown, plain lists)
  // may contain stray inch marks like 1.69" and is split on newlines as-is.
  const first = text.split(/\r?\n/).find(l => l.trim()) || '';
  if (first.trim().startsWith('|') || !/[,;\t]/.test(first)) return text.split(/\r?\n/);
  const lines = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const prev = text[i - 1];
      // A quote opens a cell only at its start, and closes it only before a delimiter or line end.
      if (!quoted && (i === 0 || prev === ',' || prev === ';' || prev === '\t' || prev === '\n' || (prev === ' ' && /[,;\t]\s*$/.test(cur)))) quoted = true;
      else if (quoted && text[i + 1] === '"') { cur += '""'; i++; continue; }
      else if (quoted && (i + 1 >= text.length || /[,;\t\r\n]/.test(text[i + 1]) || /^\s*[,;\t\r\n]/.test(text.slice(i + 1, i + 4)))) quoted = false;
    }
    if ((ch === '\n') && !quoted) { lines.push(cur); cur = ''; continue; }
    if (ch === '\r' && !quoted) continue;
    cur += ch;
  }
  lines.push(cur);
  return lines;
}

function toQty(raw) {
  if (raw == null) return null;
  const m = String(raw).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Math.ceil(parseFloat(m[1]));
  return Number.isFinite(n) ? n : null;
}

function toCost(raw) {
  if (raw == null || raw === '') return null;
  const m = String(raw).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

const REF_WORDS = { R: 'resistor', C: 'capacitor', L: 'inductor', D: 'diode', LED: 'LED', Q: 'transistor', Y: 'crystal', X: 'crystal', F: 'fuse', SW: 'switch', S: 'switch', BT: 'battery holder', FB: 'ferrite bead', RV: 'potentiometer' };

// KiCad footprint "Resistor_SMD:R_0805_2012Metric" -> "0805"
function packageFromFootprint(fp) {
  if (!fp) return '';
  const s = String(fp);
  const imperial = s.match(/(?:^|[_:])(?:[A-Z]{1,3}_)?(0201|0402|0603|0805|1206|1210|1812|2010|2512)(?:_|$)/i);
  if (imperial) return imperial[1];
  const pkg = s.match(/\b(SOT-?\d+(?:-\d)?|SOD-?\d+|TO-?\d+|DIP-?\d+|SOIC-?\d+|TSSOP-?\d+|SSOP-?\d+|MSOP-?\d+|QFN-?\d+|LQFP-?\d+|QFP-?\d+)/i);
  if (pkg) return pkg[1].toUpperCase();
  const tail = s.includes(':') ? s.split(':').pop() : s;
  return tail.length <= 24 ? tail.replace(/_/g, ' ') : '';
}

function refWord(refs) {
  const first = String(refs || '').split(/[,\s]+/).find(Boolean) || '';
  const prefix = (first.match(/^[A-Za-z]+/) || [''])[0].toUpperCase();
  return REF_WORDS[prefix] || '';
}

function cleanCell(s) {
  return String(s ?? '').replace(/^\*\*(.*)\*\*$/, '$1').replace(/^`(.*)`$/, '$1').replace(/<br\s*\/?>/gi, ' ').trim();
}

function rowFromCells(cells, fields) {
  const r = {};
  fields.forEach((f, i) => {
    if (!f) return;
    const v = cleanCell(cells[i]);
    if (v === '') return;
    if (r[f] == null) r[f] = v;
  });
  let name = r.name || '';
  const isKicadStyle = !r.name && r.value;
  if (!name && r.value) name = r.value;
  if (!name && r.description) name = r.description;
  if (isKicadStyle) {
    const word = refWord(r.refs);
    if (word && !new RegExp(word, 'i').test(name)) name = `${name} ${word}`;
  }
  if (!name && r.mpn) name = r.mpn;
  name = name.replace(/\s+/g, ' ').trim();
  if (!name) return null;

  let notes = r.notes || '';
  if (r.description && r.description !== name && !notes) notes = r.description;
  let pkg = r.package || '';
  if (pkg && /[:_]/.test(pkg)) pkg = packageFromFootprint(pkg);
  if (r.value && r.name && !name.toLowerCase().includes(r.value.toLowerCase())) name = `${name} ${r.value}`;
  if (pkg && name.toLowerCase().includes(pkg.toLowerCase())) pkg = '';

  const qty = toQty(r.qty);
  return {
    qty: qty == null ? 1 : qty,
    qtyGuessed: qty == null,
    name,
    mpn: r.mpn && r.mpn !== name ? r.mpn : '',
    package: pkg,
    refs: r.refs || '',
    notes,
    category: r.category || '',
    location: r.location || '',
    link: r.link || '',
    cost: toCost(r.cost),
  };
}

function parseTable(lines, delim) {
  const header = delim === '|' ? splitMarkdownRow(lines[0]) : splitDelimited(lines[0], delim);
  const fields = header.map(headerField);
  const rows = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    if (delim === '|' && /^\s*\|?\s*:?-{2,}/.test(line)) continue;
    const cells = delim === '|' ? splitMarkdownRow(line) : splitDelimited(line, delim);
    if (cells.every(c => !c.trim())) continue;
    // Skip "Total" style rows in tables
    if (/^\**\s*(total|subtotal)\b/i.test(cleanCell(cells[0])) && cells.slice(1).filter(c => c.trim()).length <= 1) continue;
    const row = rowFromCells(cells, fields);
    if (row) rows.push(row);
  }
  return rows;
}

function splitMarkdownRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  // Allow escaped pipes inside cells
  return s.split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, '|').trim());
}

// Common chip numbers that would otherwise be read as a quantity ("555 timer").
const NUMBER_PARTS = new Set(['555', '556', '741', '358', '324', '386', '4017', '4026', '4040', '4051', '4060', '4066', '4511', '7400', '7404', '7408', '7432', '7805', '7809', '7812', '7833', '1117', '2222', '3904', '3906', '4007', '4148', '5817', '595', '165', '6502', '8266', '2812', '18650', '21700', '1602', '2004', '328', '32']);

const BULLET = /^\s*(?:[-*+•▪◦‣]|\d{1,3}[.)](?=\s)|\[[ xX]\])\s*(?:\[[ xX]\]\s*)?/;

export function parseLine(raw) {
  let line = raw.replace(BULLET, '').replace(/\*\*/g, '').replace(/`/g, '').trim();
  if (!line) return null;

  let notes = '';
  const noteSplit = line.match(/^(.*?)\s+(?:—|–|--|\/\/)\s+(.*)$/);
  if (noteSplit) { line = noteSplit[1].trim(); notes = noteSplit[2].trim(); }

  let qty = null;
  let m;
  // Leading: "10x", "10 x", "10 ×", "x10", "10 pcs", "10pcs", "10 of"
  if ((m = line.match(/^(\d{1,6})\s*(?:x|×|\*)\s+(.+)$/i)) || (m = line.match(/^(\d{1,6})\s*(?:×|x)(?=[^\w])\s*(.+)$/i))) {
    qty = +m[1]; line = m[2];
  } else if ((m = line.match(/^(?:x|×)\s?(\d{1,6})\s+(.+)$/i))) {
    qty = +m[1]; line = m[2];
  } else if ((m = line.match(/^(\d{1,6})\s*(?:pcs?|pieces?|ea|units?|of)\.?\s+(.+)$/i))) {
    qty = +m[1]; line = m[2];
  } else if ((m = line.match(/^(.+?)\s*[(\[]\s*(?:x|×|qty:?\s*)?(\d{1,6})\s*(?:pcs?|x)?\s*[)\]]$/i))) {
    qty = +m[2]; line = m[1];
  } else if ((m = line.match(/^(.+?)\s+(?:x|×)\s?(\d{1,6})$/i)) || (m = line.match(/^(.+?)\s*×\s*(\d{1,6})$/))) {
    qty = +m[2]; line = m[1];
  } else if ((m = line.match(/^(.+?)\s*(?:,|:|\s-|\t)\s*(?:qty:?\s*)?([1-9]\d{0,5})\s*(?:pcs?|pieces?|ea|units?)?$/i))) {
    qty = +m[2]; line = m[1];
  } else if ((m = line.match(/^(.+?)\s+(?:qty|quantity)[:\s]+(\d{1,6})$/i))) {
    qty = +m[2]; line = m[1];
  } else if ((m = line.match(/^(.+?)\s+([1-9]\d{0,5})\s*(?:pcs?|pieces?|ea|units?)$/i))) {
    qty = +m[2]; line = m[1];
  } else if ((m = line.match(/^([1-9]\d{0,4})\s+(.+)$/)) && !NUMBER_PARTS.has(m[1])) {
    qty = +m[1]; line = m[2];
  }

  const name = line.replace(/\s+/g, ' ').replace(/[,;:]+$/, '').trim();
  if (!name) return null;
  return { qty: qty == null ? 1 : qty, qtyGuessed: qty == null, name, mpn: '', package: '', refs: '', notes, category: '', location: '', link: '', cost: null };
}

function looksLikeHeader(cells) {
  const known = cells.map(headerField).filter(Boolean);
  return known.length >= 1 && known.length >= Math.min(2, cells.length) ||
    (known.length >= 1 && cells.length >= 2 && known.some(f => f === 'qty' || f === 'name' || f === 'value'));
}

/**
 * Parse free text into rows.
 * @returns {{format: string, rows: Array, skipped: string[]}}
 */
export function parseParts(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const lines = logicalLines(src);
  const nonEmpty = lines.filter(l => l.trim());
  if (!nonEmpty.length) return { format: 'empty', rows: [], skipped: [] };

  // Markdown tables (possibly surrounded by prose or headings, possibly several tables).
  const tableLines = nonEmpty.filter(l => /^\s*\|.*\|\s*$/.test(l));
  if (tableLines.length >= 2) {
    const rows = [];
    let block = [];
    const flush = () => {
      if (block.length >= 2 && looksLikeHeader(splitMarkdownRow(block[0]))) rows.push(...parseTable(block, '|'));
      block = [];
    };
    for (const l of lines) {
      if (/^\s*\|.*\|\s*$/.test(l)) block.push(l); else flush();
    }
    flush();
    if (rows.length) return { format: 'markdown table', rows, skipped: [] };
  }

  // Delimited files with a header row.
  for (const delim of ['\t', ',', ';']) {
    const first = nonEmpty[0];
    if (!first.includes(delim)) continue;
    const cells = splitDelimited(first, delim);
    if (cells.length >= 2 && looksLikeHeader(cells)) {
      const rows = parseTable(nonEmpty, delim);
      if (rows.length) return { format: delim === '\t' ? 'tab-separated' : delim === ',' ? 'CSV' : 'semicolon-separated', rows, skipped: [] };
    }
  }

  // Plain list. Headings and "Passives:" lines set the category for the lines below them.
  const rows = [];
  const skipped = [];
  let category = '';
  for (const l of nonEmpty) {
    const t = l.trim();
    const heading = t.match(/^#{1,6}\s+(.+?)\s*#*$/) || t.match(/^([A-Za-z][\w &/+-]{1,40}):$/) || t.match(/^\*\*([^*]{1,40})\*\*:?$/);
    if (heading) {
      const h = heading[1].trim();
      category = /^(bom|bill of materials|parts( list)?|shopping list|components|inventory|my parts.*)$/i.test(h) ? '' : h;
      continue;
    }
    if (/^(qty|quantity)\b.*\b(part|name|item)\b/i.test(t)) continue;
    if (/^[-=_*]{3,}$/.test(t)) continue;
    const row = parseLine(t);
    if (row) {
      if (category && !row.category) row.category = category;
      rows.push(row);
    } else skipped.push(t);
  }
  return { format: 'list', rows, skipped };
}
