// Fuzzy part matching tuned for electronics names.
// "10K ohm resistor 0805", "10kΩ res 0805" and "R 10k 0805" all describe the same part;
// "10k resistor" and "4.7k resistor" do not, however similar the words look.

const SYNONYMS = {
  res: 'resistor', resistors: 'resistor', resistor: 'resistor', ohm: 'resistor', ohms: 'resistor',
  cap: 'capacitor', caps: 'capacitor', capacitor: 'capacitor', capacitors: 'capacitor', condenser: 'capacitor',
  elec: 'electrolytic', electrolytic: 'electrolytic', lytic: 'electrolytic',
  cer: 'ceramic', ceramic: 'ceramic', mlcc: 'ceramic',
  leds: 'led', led: 'led',
  diodes: 'diode', fet: 'mosfet', mosfets: 'mosfet', transistors: 'transistor', bjt: 'transistor',
  mcu: 'microcontroller', microcontroller: 'microcontroller', microcontrollers: 'microcontroller',
  pot: 'potentiometer', pots: 'potentiometer', potentiometer: 'potentiometer', trimpot: 'trimmer', trimmer: 'trimmer',
  btn: 'button', button: 'button', buttons: 'button', pushbutton: 'button', tactile: 'button', tact: 'button',
  sw: 'switch', switches: 'switch',
  headers: 'header', pinheader: 'header', pinheaders: 'header',
  conn: 'connector', connectors: 'connector',
  xtal: 'crystal', crystals: 'crystal',
  osc: 'oscillator',
  reg: 'regulator', regulators: 'regulator', vreg: 'regulator', ldo: 'regulator',
  ind: 'inductor', inductors: 'inductor', choke: 'inductor',
  batt: 'battery', batteries: 'battery', cell: 'battery',
  spk: 'speaker', speakers: 'speaker',
  buzz: 'buzzer', buzzers: 'buzzer', piezo: 'buzzer',
  disp: 'display', screen: 'display', displays: 'display',
  usbc: 'usbc', typec: 'usbc',
  devboard: 'board', breakout: 'board', module: 'board', modules: 'board', pcb: 'board', boards: 'board',
  sensors: 'sensor', motors: 'motor', servos: 'servo', steppers: 'stepper',
  wires: 'wire', cables: 'cable', jumpers: 'jumper',
  magnets: 'magnet', screws: 'screw', nuts: 'nut', standoffs: 'standoff', spacers: 'standoff',
  ic: 'ic', chip: 'ic', chips: 'ic', ics: 'ic',
  opamp: 'opamp', amp: 'amplifier', amplifiers: 'amplifier',
  smt: 'smd', tht: 'throughhole', pth: 'throughhole', dip: 'dip',
};

const STOPWORDS = new Set(['x', 'pcs', 'pc', 'piece', 'pieces', 'of', 'the', 'a', 'an', 'with', 'for', 'and', 'or', 'set', 'pack', 'kit', 'lot', 'qty', 'ea', 'each', 'new', 'genuine', 'original', 'through', 'hole', 'type', 'mm']);
const TYPE_WORDS = new Set(['resistor', 'capacitor', 'electrolytic', 'ceramic', 'led', 'diode', 'mosfet', 'transistor', 'microcontroller', 'potentiometer', 'trimmer', 'button', 'switch', 'header', 'connector', 'crystal', 'oscillator', 'regulator', 'inductor', 'battery', 'speaker', 'buzzer', 'display', 'oled', 'lcd', 'sensor', 'motor', 'servo', 'stepper', 'board', 'ic', 'opamp', 'amplifier', 'fuse', 'relay', 'zener', 'schottky', 'encoder', 'jack', 'socket', 'cable', 'wire', 'magnet', 'screw', 'nut', 'standoff', 'antenna', 'driver']);
const PACKAGE_PREFIXES = ['sot', 'sod', 'to', 'dip', 'soic', 'sop', 'ssop', 'tssop', 'msop', 'qfn', 'qfp', 'lqfp', 'tqfp', 'dfn', 'bga', 'sma', 'smb', 'smc', 'melf'];
const IMPERIAL = new Set(['0201', '0402', '0603', '0805', '1206', '1210', '1812', '2010', '2512']);
const PKG_RE = new RegExp(`^(?:${PACKAGE_PREFIXES.join('|')})\\d{1,3}[a-z]?$`);

const SI = { p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, meg: 1e6, g: 1e9 };

function num(s) {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function fmt(n) {
  // Stable key for a physical value: 3 significant figures.
  return Number(n.toPrecision(3)).toString();
}

// Recognise one token as an electrical value. Returns e.g. "res:10000" or null.
function valueOf(tok, ctx) {
  let m;
  // 4k7, 2r2, 1m5 (resistor shorthand)
  if ((m = tok.match(/^(\d+)([rkm])(\d+)$/))) {
    const mult = { r: 1, k: 1e3, m: 1e6 }[m[2]];
    return `res:${fmt(parseFloat(`${m[1]}.${m[3]}`) * mult)}`;
  }
  // 3v3, 1v8
  if ((m = tok.match(/^(\d+)v(\d+)$/))) return `v:${fmt(parseFloat(`${m[1]}.${m[2]}`))}`;
  // 1/4w
  if ((m = tok.match(/^(\d+)\/(\d+)w$/))) return `w:${fmt(+m[1] / +m[2])}`;
  if (!(m = tok.match(/^(\d+(?:\.\d+)?)([a-z]*)$/))) return null;
  const n = num(m[1]);
  const u = m[2];
  if (n == null || !u) return null;
  let r;
  if ((r = u.match(/^(p|n|u|m)?f$/)) || (r = u.match(/^(p|n|u)$/))) return `cap:${fmt(n * SI[r[1] || ''] * 1e12)}`;
  if ((r = u.match(/^(k|m|meg)?(?:ohms?|r)$/)) || (r = u.match(/^(k|meg)$/))) return `res:${fmt(n * SI[r[1] || ''])}`;
  if (u === 'm' && ctx.has('resistor')) return `res:${fmt(n * 1e6)}`;
  if ((r = u.match(/^(n|u|m)h$/))) return `ind:${fmt(n * SI[r[1]] * 1e9)}`;
  if ((r = u.match(/^(m|k)?v$/))) return `v:${fmt(n * SI[r[1] || ''])}`;
  if ((r = u.match(/^(u|m)?a$/))) return `a:${fmt(n * SI[r[1] || ''])}`;
  if ((r = u.match(/^(k|m|g)?hz$/))) return `hz:${fmt(n * SI[r[1] === 'm' ? 'meg' : (r[1] || '')])}`;
  if ((r = u.match(/^(m)?w$/))) return `w:${fmt(n * SI[r[1] || ''])}`;
  if ((r = u.match(/^mah$/))) return `mah:${fmt(n)}`;
  return null;
}

export function compact(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
}

/** Break a part description into comparable pieces. */
export function analyze(text, extra = {}) {
  let s = ` ${String(text || '')} `.toLowerCase()
    .normalize('NFKC')
    .replace(/[µμ]/g, 'u')
    .replace(/Ω|ω/g, 'ohm')
    .replace(/±/g, ' ')
    .replace(/(\d),(\d{3})\b/g, '$1$2');
  // "10 k", "100 nF", "3.3 V" -> "10k", "100nf", "3.3v"
  s = s.replace(/(\d)\s+(k|m|meg|r|ohms?|kohms?|mohms?|pf|nf|uf|mf|f|p|n|u|v|mv|kv|ma|ua|a|mhz|khz|ghz|hz|uh|nh|mh|w|mw|mah)\b/g, '$1$2');
  // "type-c", "usb-c", "usb c"
  s = s.replace(/\b(?:usb[\s-]?c|type[\s-]?c)\b/g, ' usbc ');
  s = s.replace(/\bop[\s-]?amps?\b/g, ' opamp ');
  s = s.replace(/\btact(?:ile)?[\s-]+(?:switch|button)(?:es|s)?\b/g, ' button ');
  s = s.replace(/\bpush[\s-]?buttons?\b/g, ' button ');
  s = s.replace(/\bthrough[\s-]?hole\b/g, ' throughhole ');
  s = s.replace(/\bpin[\s-]?headers?\b/g, ' header ');
  s = s.replace(/\bdev(?:elopment)?[\s-]?(?:kit|board)s?\b/g, ' board ');
  // Regulator part numbers carry their voltage: "AMS1117-3.3", "AP2112K-3.3" -> 3.3v
  if (/\b(ldo|regulators?|reg|vreg|ams1117|lm1117|ld1117|ap2112k?|xc6206|mcp1700|ht73\d\d)\b/.test(s)) {
    s = s.replace(/([a-z]\d{3,}[a-z]?)-(\d{1,2}(?:\.\d{1,2})?)(?![\d.a-z])/g, '$1 $2v');
  }
  // "SOT-23", "TO-92", "DIP-8" -> "sot23"
  s = s.replace(new RegExp(`\\b(${PACKAGE_PREFIXES.join('|')})[\\s-](\\d{1,3}[a-z]?)\\b`, 'g'), '$1$2');

  const raw = s.split(/[^a-z0-9./]+/).filter(Boolean).flatMap(t => (/^\d+\/\d+w$/.test(t) ? [t] : t.split('/'))).filter(Boolean);
  const tokens = new Set();
  const values = new Map();
  const packages = new Set();
  const typeWords = new Set();

  const ctx = new Set(raw.map(t => SYNONYMS[t] || t));
  for (let t of raw) {
    t = t.replace(/^\.+|\.+$/g, '');
    if (!t) continue;
    const v = valueOf(t, ctx);
    if (v) {
      const kind = v.split(':')[0];
      if (!values.has(kind)) values.set(kind, v);
      tokens.add(v);
      continue;
    }
    if (IMPERIAL.has(t) || PKG_RE.test(t)) { packages.add(t); tokens.add(`pkg:${t}`); continue; }
    if (/^\d+mm$/.test(t)) { tokens.add(t); continue; }
    if (STOPWORDS.has(t)) continue;
    let w = SYNONYMS[t] || t;
    if (!SYNONYMS[t] && w.length > 4 && w.endsWith('s') && !w.endsWith('ss') && !/\d/.test(w)) w = w.slice(0, -1);
    if (TYPE_WORDS.has(w)) typeWords.add(w);
    tokens.add(w);
  }
  if (extra.package) for (const p of analyze(extra.package).packages) { packages.add(p); tokens.add(`pkg:${p}`); }

  // A bare "10k" with no other type word in a passive context means a resistor.
  if (values.has('res') && !typeWords.size) { typeWords.add('resistor'); tokens.add('resistor'); }
  if (values.has('cap') && !typeWords.has('capacitor')) { typeWords.add('capacitor'); tokens.add('capacitor'); }

  return { tokens, values, packages, typeWords, compact: compact(text), mpn: compact(extra.mpn) };
}

function weight(tok) {
  if (tok.includes(':')) return tok.startsWith('pkg:') ? 1.5 : 3;
  if (TYPE_WORDS.has(tok)) return 1.5;
  if (/\d/.test(tok)) return 2.5; // part-number-ish tokens like esp32, ws2812b, lm7805
  return 1;
}

function tokenSim(a, b) {
  if (a === b) return 1;
  // "v:3.3" against a bare "3.3" (as in AMS1117-3.3)
  if (a.includes(':') !== b.includes(':')) {
    const [v, bare] = a.includes(':') ? [a, b] : [b, a];
    return !v.startsWith('pkg:') && /^\d+(\.\d+)?$/.test(bare) && v.split(':')[1] === String(+bare) ? 0.8 : 0;
  }
  if (a.includes(':')) return 0;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  // ws2812 vs ws2812b, esp32 vs esp32s3, lm7805 vs lm7805ct
  if (s.length >= 4 && l.startsWith(s) && l.length - s.length <= 3) return /\d/.test(s) ? 0.8 : 0.7;
  if (s.length >= 5 && l.length - s.length <= 1 && editDistance(s, l) <= 1) return 0.75;
  return 0;
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/**
 * Compare two analyzed descriptions.
 * @returns {{score: number, exact: boolean, notes: string[]}}
 */
export function compare(a, b) {
  if (a.mpn && b.mpn && a.mpn === b.mpn) return { score: 1, exact: true, notes: [] };
  if (a.mpn && a.mpn.length >= 5 && (b.compact === a.mpn || b.compact.includes(a.mpn))) return { score: 0.97, exact: b.compact === a.mpn, notes: [] };
  if (b.mpn && b.mpn.length >= 5 && (a.compact === b.mpn || a.compact.includes(b.mpn))) return { score: 0.97, exact: a.compact === b.mpn, notes: [] };
  const pkgConflict = a.packages.size > 0 && b.packages.size > 0 && ![...a.packages].some(p => b.packages.has(p));
  if (a.compact && a.compact === b.compact) {
    return pkgConflict ? { score: 0.6, exact: false, notes: ['different package'] } : { score: 1, exact: true, notes: [] };
  }

  const notes = [];
  for (const [kind, v] of a.values) {
    if (b.values.has(kind) && b.values.get(kind) !== v) return { score: 0, exact: false, notes: ['different value'] };
  }
  // Different component types ("10k resistor" vs "10k potentiometer") are different parts.
  if (a.typeWords.size && b.typeWords.size) {
    const shared = [...a.typeWords].some(t => b.typeWords.has(t));
    if (!shared) return { score: 0, exact: false, notes: ['different type'] };
  }

  let wa = 0, wb = 0, overlap = 0;
  const bTokens = [...b.tokens];
  for (const t of a.tokens) {
    const w = weight(t);
    wa += w;
    let best = 0;
    for (const u of bTokens) { best = Math.max(best, tokenSim(t, u)); if (best === 1) break; }
    overlap += w * best;
  }
  for (const u of b.tokens) wb += weight(u);
  if (!wa || !wb) return { score: 0, exact: false, notes };

  const dice = (2 * overlap) / (wa + wb);
  const containment = overlap / Math.min(wa, wb);
  let score = 0.55 * dice + 0.45 * containment;

  const shorter = a.compact.length <= b.compact.length ? a.compact : b.compact;
  const longer = shorter === a.compact ? b.compact : a.compact;
  if (shorter.length >= 6 && longer.includes(shorter)) score = Math.max(score, 0.78);
  // A shared part-number-like token (ams1117, ssd1306, ws2812b) is strong evidence on its own.
  const partNo = t => t.length >= 6 && /\d/.test(t) && /[a-z]/.test(t) && !t.includes(':');
  if ([...a.tokens].some(t => partNo(t) && b.tokens.has(t))) score = Math.max(score, 0.62);

  for (const kind of a.values.keys()) {
    if (!b.values.has(kind)) { score *= 0.85; notes.push('value not listed'); break; }
  }
  if (pkgConflict) {
    score *= 0.6;
    notes.push('different package');
  }
  // Same values on both sides make a match much more believable.
  if (a.values.size && [...a.values.values()].every(v => [...b.values.values()].includes(v))) score = Math.min(1, score + 0.08);

  return { score: Math.round(Math.min(score, 0.99) * 100) / 100, exact: false, notes };
}

export const MATCH_SUGGEST = 0.5;

/**
 * Find inventory parts that could be the described item.
 * @param {{name:string, mpn?:string, package?:string}} item
 * @param {Array<{id:number,name:string,mpn?:string,package?:string,aliases?:string[],qty?:number}>} parts
 * @returns {Array<{part:object, score:number, exact:boolean, via:string, notes:string[]}>} best first
 */
export function findMatches(item, parts, { limit = 3, min = 0.35, cache } = {}) {
  const a = analyze(item.name, { mpn: item.mpn, package: item.package });
  const results = [];
  for (const part of parts) {
    let prepared = cache?.get(part.id);
    if (!prepared) {
      prepared = [
        { via: 'name', an: analyze(part.name, { mpn: part.mpn, package: part.package }) },
        ...(part.aliases || []).map(al => ({ via: 'alias', an: analyze(al, { package: part.package }), alias: al })),
      ];
      cache?.set(part.id, prepared);
    }
    let best = null;
    for (const p of prepared) {
      const r = compare(a, p.an);
      if (!best || r.score > best.score || (r.score === best.score && r.exact && !best.exact)) best = { ...r, via: p.via, alias: p.alias };
    }
    if (best && best.score >= min) results.push({ part, ...best });
  }
  results.sort((x, y) => (y.exact - x.exact) || (y.score - x.score) || ((y.part.qty || 0) - (x.part.qty || 0)));
  return results.slice(0, limit);
}

// Category guesses for parts typed in by hand.
const CATEGORY_RULES = [
  [/\b(esp32|esp8266|esp-?01|arduino|nano|uno|mega2560|pico|rp2040|rp2350|teensy|stm32|attiny|atmega|seeed|xiao|feather|qt ?py|micro:?bit|nrf52|samd21|ch32|microcontroller|mcu)\b/i, 'Microcontrollers'],
  [/\b(raspberry pi|rpi|pi zero|pi 4|pi 5|beaglebone|sbc)\b/i, 'Single-board computers'],
  [/\b(resistors?|ohms?|[0-9.]+\s?[kmr]\b|[0-9]+[kr][0-9]+)/i, 'Resistors'],
  [/\b(capacitors?|caps?|[0-9.]+\s?[pnu]f\b|electrolytic|mlcc)\b/i, 'Capacitors'],
  [/\b(inductors?|ferrite|[0-9.]+\s?[unm]h\b)\b/i, 'Inductors'],
  [/\b(leds?|ws2812b?|sk6812|apa102|neopixel|led strip)\b/i, 'LEDs'],
  [/\b(oled|lcd|tft|e-?ink|e-?paper|display|screen|7-?segment|ssd1306|st7789|ili9341)\b/i, 'Displays'],
  [/\b(sensor|bme280|bmp280|dht11|dht22|mpu6050|accelerometer|gyro|imu|hc-sr04|ultrasonic|pir|ldr|photoresistor|thermistor|hall|vl53l0x|ina219|current sensor|tof)\b/i, 'Sensors'],
  [/\b(diodes?|zener|schottky|1n4148|1n4007|1n58\d\d|mosfets?|transistors?|2n2222|2n3904|2n3906|bc547|irf\w+|ao3400|bjt|triac|optocoupler)\b/i, 'Semiconductors'],
  [/\b(regulators?|ldo|ams1117|lm7805|78\d\d|lm317|buck|boost|mt3608|lm2596|tp4056|charger|power supply|psu|dc-?dc)\b/i, 'Power'],
  [/\b(batter(y|ies)|18650|21700|lipo|li-?ion|cr2032|coin cell|aa|aaa|battery holder)\b/i, 'Batteries'],
  [/\b(motors?|servos?|steppers?|nema ?17|28byj|a4988|drv8825|tmc2209|l298n|motor driver|vibration)\b/i, 'Motors & drivers'],
  [/\b(buttons?|switch(es)?|tactile|encoder|rotary|toggle|slide switch|dip switch|keyswitch|joystick)\b/i, 'Switches & input'],
  [/\b(headers?|connectors?|jst|dupont|terminal|screw terminal|usb[- ]?c|type[- ]?c|micro ?usb|barrel jack|jack|socket|xt60|molex|ffc|fpc|banana)\b/i, 'Connectors'],
  [/\b(wire|cable|jumpers?|awg|ribbon|heat ?shrink)\b/i, 'Wire & cable'],
  [/\b(speakers?|buzzers?|piezo|microphone|mic|max98357|pam8403|audio|dac|i2s)\b/i, 'Audio'],
  [/\b(relays?|ssr)\b/i, 'Relays'],
  [/\b(crystal|oscillator|xtal|resonator)\b/i, 'Crystals & oscillators'],
  [/\b(wifi|bluetooth|lora|nrf24|rfid|rc522|gps|antenna|radio|zigbee|433 ?mhz)\b/i, 'Wireless'],
  [/\b(screws?|nuts?|bolts?|standoffs?|spacers?|washers?|m2|m2\.5|m3|m4|heat-?set|inserts?|magnets?)\b/i, 'Hardware'],
  [/\b(ic|chip|555|741|op-?amp|lm358|shift register|74hc\w+|cd4\d+|eeprom|flash|multiplexer|adc|max7219|pca9685)\b/i, 'ICs'],
  [/\b(breadboard|perfboard|protoboard|pcb|stripboard)\b/i, 'Prototyping'],
  [/\b(fuse|polyfuse|ptc)\b/i, 'Protection'],
];

export function guessCategory(name) {
  const s = String(name || '');
  for (const [re, cat] of CATEGORY_RULES) if (re.test(s)) return cat;
  return '';
}
