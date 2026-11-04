// Standard component values (E-series) and how to write them.
// Used to generate kits and to collapse runs of resistors and capacitors in exports.

export const SERIES = {
  E3: [1.0, 2.2, 4.7],
  E6: [1.0, 1.5, 2.2, 3.3, 4.7, 6.8],
  E12: [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2],
  E24: [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1],
};

const tidy = n => Number(n.toPrecision(3));
const trim = n => String(tidy(n));

/** Every value of a series from min to max, inclusive. */
export function seriesValues(series, min, max) {
  const base = SERIES[series];
  if (!base || !(min > 0) || !(max >= min)) return [];
  const out = [];
  for (let dec = Math.floor(Math.log10(min)) - 1; dec <= Math.ceil(Math.log10(max)) + 1; dec++) {
    for (const b of base) {
      const v = tidy(b * 10 ** dec);
      if (v >= tidy(min) && v <= tidy(max)) out.push(v);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** 4700 -> "4.7k", 1e6 -> "1M", 47 -> "47Ω" */
export function formatOhms(v) {
  if (v >= 1e6) return `${trim(v / 1e6)}M`;
  if (v >= 1e3) return `${trim(v / 1e3)}k`;
  return `${trim(v)}Ω`;
}

/** Capacitance in picofarads -> "22pF", "100nF", "4.7µF" */
export function formatFarads(pf) {
  if (pf < 1e3) return `${trim(pf)}pF`;
  if (pf < 1e6) return `${trim(pf / 1e3)}nF`;
  return `${trim(pf / 1e6)}µF`;
}

/** Capacitance in picofarads -> always µF, the way electrolytics are labeled. */
export function formatMicrofarads(pf) {
  return `${trim(pf / 1e6)}µF`;
}

/**
 * Describe a set of values as compactly as possible:
 * "E12 series 10Ω–1M" when it is (nearly) a whole series, otherwise the values themselves.
 * @param {number[]} values
 * @param {(v:number)=>string} fmt
 */
export function describeValues(values, fmt) {
  const vals = [...new Set(values.map(tidy))].sort((a, b) => a - b);
  if (vals.length >= 6) {
    for (const name of ['E6', 'E12', 'E24']) {
      const base = SERIES[name];
      const inSeries = vals.filter(v => base.includes(tidy(v / 10 ** Math.floor(Math.log10(v) + 1e-9))));
      const extra = vals.filter(v => !inSeries.includes(v));
      if (inSeries.length < 6 || extra.length > 3) continue;
      const min = inSeries[0], max = inSeries[inSeries.length - 1];
      const expect = seriesValues(name, min, max);
      const missing = expect.filter(v => !inSeries.includes(v));
      if (missing.length > Math.max(2, Math.floor(expect.length * 0.08))) continue;
      const except = missing.length ? `, except ${missing.map(fmt).join(', ')}` : '';
      const plus = extra.length ? `, plus ${extra.map(fmt).join(', ')}` : '';
      return `${name} series ${fmt(min)}–${fmt(max)} (${inSeries.length} values${except})${plus}`;
    }
  }
  return vals.map(fmt).join(', ');
}

// Values common to electrolytic capacitor kits, in µF.
export const ELECTROLYTIC_KIT = [0.1, 0.22, 0.47, 1, 2.2, 3.3, 4.7, 10, 22, 33, 47, 100, 220, 330, 470, 1000, 2200];
