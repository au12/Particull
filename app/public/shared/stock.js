// How much of a part you have: an exact count, or a rough level for things nobody counts.
// Shared by the server (BOM checks, exports) and the browser.

export const LEVELS = ['plenty', 'some', 'low', 'out'];

export const LEVEL_LABELS = { plenty: 'Plenty', some: 'Some', low: 'Running low', out: 'Out' };
export const LEVEL_SHORT = { plenty: 'Plenty', some: 'Some', low: 'Low', out: 'Out' };

// Common units. Anything else can be typed in.
export const UNITS = ['pcs', 'm', 'cm', 'mm', 'ft', 'in', 'g', 'kg', 'ml', 'roll', 'spool', 'sheet', 'pack', 'pair', 'set'];

/** Round to at most 3 decimals so 0.1 + 0.2 stays 0.3. */
export function roundQty(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

export function formatNumber(n) {
  const r = roundQty(n);
  return Number.isInteger(r) ? r.toLocaleString('en-US') : r.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

/** "pcs" and "" both mean a plain count. */
export const isCountUnit = unit => !unit || unit === 'pcs';

/** Unit word for a quantity: "1 spool", "6 spools", "2.5 m". */
export function unitLabel(unit, qty) {
  if (isCountUnit(unit)) return '';
  if (qty === 1 || ['m', 'cm', 'mm', 'ft', 'in', 'g', 'kg', 'ml'].includes(unit)) return unit;
  if (/(s|x)$/.test(unit)) return unit;
  return `${unit}s`;
}

/** "50", "2.5 m", "6 spools", "Plenty". */
export function formatStock(part) {
  if (part.stockLevel) return LEVEL_LABELS[part.stockLevel];
  const u = unitLabel(part.unit, part.qty);
  return u ? `${formatNumber(part.qty)} ${u}` : formatNumber(part.qty);
}

/** Out of stock, or at or below its warning level. */
export function isLow(part) {
  if (part.stockLevel) return part.stockLevel === 'low' || part.stockLevel === 'out';
  return part.qty <= 0 || (part.minQty != null && part.qty <= part.minQty);
}

export function isOut(part) {
  return part.stockLevel ? part.stockLevel === 'out' : part.qty <= 0;
}

/** For sorting by amount: levels sort as if Plenty were a lot. */
export function stockRank(part) {
  if (!part.stockLevel) return part.qty;
  return { plenty: 1e9, some: 1e8, low: 0.5, out: 0 }[part.stockLevel];
}
