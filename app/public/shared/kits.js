// Assortment kits: turn "E12 resistors 10Ω–1M, 0805" into one part per value.
import { seriesValues, formatOhms, formatFarads, ELECTROLYTIC_KIT } from './values.js';

export const RESISTOR_STEPS = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7];
export const CAPACITOR_STEPS = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7]; // picofarads: 1pF … 10µF
export const PACKAGES = ['0402', '0603', '0805', '1206', 'Through-hole'];
export const LED_COLORS = ['red', 'green', 'blue', 'yellow', 'white', 'warm white', 'orange', 'RGB'];
export const CONNECTOR_FAMILIES = {
  'JST-XH': { pitch: '2.5mm', minPins: 2, maxPins: 6 },
  'JST-PH': { pitch: '2.0mm', minPins: 2, maxPins: 6 },
  'JST-SH': { pitch: '1.0mm', minPins: 2, maxPins: 6 },
  'Dupont': { pitch: '2.54mm', minPins: 1, maxPins: 6 },
  'Screw terminal': { pitch: '5.08mm', minPins: 2, maxPins: 4 },
};
export const SCREW_SIZES = ['M2', 'M2.5', 'M3', 'M4', 'M5'];
export const SCREW_KINDS = ['socket head screw', 'button head screw', 'flat head screw', 'brass standoff', 'nylon standoff'];

export const SEMICONDUCTORS = [
  ['1N4148 signal diode', 'Semiconductors'],
  ['1N4007 rectifier diode', 'Semiconductors'],
  ['1N5819 Schottky diode', 'Semiconductors'],
  ['1N5408 rectifier diode', 'Semiconductors'],
  ['3.3V Zener diode', 'Semiconductors'],
  ['5.1V Zener diode', 'Semiconductors'],
  ['12V Zener diode', 'Semiconductors'],
  ['2N2222 NPN transistor', 'Semiconductors'],
  ['2N3904 NPN transistor', 'Semiconductors'],
  ['2N3906 PNP transistor', 'Semiconductors'],
  ['BC547 NPN transistor', 'Semiconductors'],
  ['BC557 PNP transistor', 'Semiconductors'],
  ['S8050 NPN transistor', 'Semiconductors'],
  ['S8550 PNP transistor', 'Semiconductors'],
  ['2N7000 N-channel MOSFET', 'Semiconductors'],
  ['IRLZ44N N-channel MOSFET', 'Semiconductors'],
  ['AO3400 N-channel MOSFET', 'Semiconductors'],
  ['TIP120 Darlington transistor', 'Semiconductors'],
];

export const KITS = {
  resistors: {
    title: 'Resistors',
    hint: 'A resistor book or assortment, one part per value.',
    defaults: { series: 'E12', min: 10, max: 1e6, package: '0805', amount: 'plenty', count: 20 },
  },
  ceramic: {
    title: 'Ceramic capacitors',
    hint: 'An MLCC or ceramic disc assortment.',
    defaults: { series: 'E6', min: 10, max: 1e6, package: '0805', amount: 'plenty', count: 20 },
  },
  electrolytic: {
    title: 'Electrolytic capacitors',
    hint: 'A radial electrolytic assortment.',
    defaults: { min: 0.1, max: 1000, voltage: '25V', amount: 'count', count: 10 },
  },
  leds: {
    title: 'LEDs',
    hint: 'Through-hole LEDs by size and color.',
    defaults: { sizes: ['5mm'], colors: ['red', 'green', 'blue', 'yellow', 'white'], amount: 'count', count: 20 },
  },
  connectors: {
    title: 'Connectors',
    hint: 'JST, Dupont or screw terminal kits by pin count.',
    defaults: { family: 'JST-XH', minPins: 2, maxPins: 5, housings: true, headers: true, crimps: true, amount: 'count', count: 10 },
  },
  semis: {
    title: 'Diodes & transistors',
    hint: 'The usual through-hole assortment. Untick what you don’t have.',
    defaults: { amount: 'count', count: 10 },
  },
  hardware: {
    title: 'Screws & standoffs',
    hint: 'Metric screws or standoffs by size and length.',
    defaults: { sizes: ['M3'], lengths: '6, 8, 10, 12, 16, 20', kind: 'socket head screw', nuts: true, amount: 'count', count: 20 },
  },
};

const pkgName = p => (p === 'Through-hole' ? 'Through-hole' : p);

/**
 * Build the parts for a kit.
 * @returns {Array<{name:string, package:string, category:string}>}
 */
export function kitRows(type, o) {
  switch (type) {
    case 'resistors':
      return seriesValues(o.series, o.min, o.max).map(v => ({ name: `${formatOhms(v)} resistor`, package: pkgName(o.package), category: 'Resistors' }));
    case 'ceramic':
      return seriesValues(o.series, o.min, o.max).map(v => ({ name: `${formatFarads(v)} ceramic capacitor`, package: pkgName(o.package), category: 'Capacitors' }));
    case 'electrolytic':
      return ELECTROLYTIC_KIT.filter(v => v >= o.min && v <= o.max)
        .map(v => ({ name: `${v}µF electrolytic capacitor${o.voltage ? ` ${o.voltage}` : ''}`, package: '', category: 'Capacitors' }));
    case 'leds':
      return (o.sizes || []).flatMap(size => (o.colors || []).map(c => ({ name: `${size} ${c} LED`, package: '', category: 'LEDs' })));
    case 'connectors': {
      const fam = CONNECTOR_FAMILIES[o.family];
      if (!fam) return [];
      const rows = [];
      for (let n = o.minPins; n <= o.maxPins; n++) {
        if (o.family === 'Screw terminal') { rows.push({ name: `${n}-pin screw terminal ${fam.pitch}`, package: '', category: 'Connectors' }); continue; }
        if (o.housings) rows.push({ name: `${o.family} ${n}-pin housing`, package: '', category: 'Connectors' });
        if (o.headers && o.family !== 'Dupont') rows.push({ name: `${o.family} ${n}-pin PCB header`, package: '', category: 'Connectors' });
      }
      if (o.crimps && o.family !== 'Screw terminal') rows.push({ name: `${o.family} crimp terminal`, package: '', category: 'Connectors' });
      return rows;
    }
    case 'semis':
      return SEMICONDUCTORS.filter(([n]) => !o.exclude?.includes(n)).map(([name, category]) => ({
        name,
        category,
        package: /diode/i.test(name) ? '' : /IRLZ44N|TIP120/.test(name) ? 'TO-220' : /AO3400/.test(name) ? 'SOT-23' : 'TO-92',
      }));
    case 'hardware': {
      const lengths = String(o.lengths || '').split(/[,\s]+/).map(Number).filter(n => n > 0);
      const standoff = /standoff/.test(o.kind);
      const rows = [];
      for (const size of o.sizes || []) {
        for (const len of lengths) rows.push({ name: `${size} × ${len}mm ${o.kind}`, package: '', category: 'Hardware' });
        if (o.nuts && !standoff) rows.push({ name: `${size} hex nut`, package: '', category: 'Hardware' });
      }
      return rows;
    }
    default:
      return [];
  }
}
