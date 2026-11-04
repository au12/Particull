// Fill an empty Particull with sample parts and projects.
// Usage: node scripts/seed-demo.js [http://localhost:8080]
const base = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');

const parts = `
Microcontrollers | ESP32-S3-DevKitC-1 N16R8 | 3 | Bin 1 | | | Dual USB-C
Microcontrollers | Raspberry Pi Pico W | 4 | Bin 1
Microcontrollers | Teensy 4.1 | 1 | Bin 1
Microcontrollers | Seeed XIAO ESP32-C3 | 5 | Bin 1
Microcontrollers | ATtiny85 | 6 | Drawer C2 | | DIP-8
Capacitors | 100nF ceramic capacitor | 220 | Drawer A2 | | 0805
Capacitors | 10uF ceramic capacitor | 45 | Drawer A2 | | 0805
Capacitors | 22pF ceramic capacitor | 30 | Drawer A2 | | 0603
Capacitors | 470uF electrolytic capacitor 16V | 8 | Drawer A3
LEDs | WS2812B LED strip 60/m | 2 | Shelf 2 | | | Meters
LEDs | 5mm red LED | 35 | Drawer B1
LEDs | 5mm green LED | 28 | Drawer B1
LEDs | WS2812B-Mini RGB LED | 40 | Drawer B1 | WS2812B-2020
Displays | 1.69in ST7789 IPS display 240x280 | 2 | Bin 4
Displays | SSD1306 0.96in OLED I2C | 3 | Bin 4
Sensors | BME280 breakout | 2 | Bin 3
Sensors | MPU6050 IMU breakout | 1 | Bin 3
Sensors | HC-SR04 ultrasonic sensor | 2 | Bin 3
Power | AMS1117-3.3 regulator | 12 | Drawer C1 | | SOT-223
Power | TP4056 USB-C LiPo charger board | 4 | Drawer C1
Power | MT3608 boost converter | 3 | Drawer C1
Batteries | 1200mAh LiPo battery 3.7V | 2 | Shelf 1
Batteries | CR2032 coin cell | 6 | Shelf 1
Switches & input | 6x6mm tactile button | 60 | Drawer B3
Switches & input | EC11 rotary encoder with switch | 4 | Drawer B3
Switches & input | SPDT slide switch | 10 | Drawer B3
Connectors | USB-C 16-pin receptacle | 8 | Drawer B4 | | SMD
Connectors | 2.54mm male pin header 1x40 | 20 | Drawer B4
Connectors | JST-PH 2-pin connector | 15 | Drawer B4
Semiconductors | 1N5819 Schottky diode | 25 | Drawer C2
Semiconductors | AO3400 N-channel MOSFET | 30 | Drawer C2 | | SOT-23
Semiconductors | 2N2222 transistor | 18 | Drawer C2 | | TO-92
Audio | MAX98357A I2S amplifier | 2 | Bin 3
Audio | 28mm 8 ohm speaker | 3 | Bin 3
Hardware | M3 heat-set inserts | 120 | Drawer D1
Hardware | M2.5 nylon standoffs | 48 | Drawer D1
Hardware | 6x3mm neodymium magnets | 50 | Drawer D1
Wire & cable | 26 AWG silicone wire | 6 | Shelf 2 | | | Assorted colors
`.trim().split('\n').map(l => {
  const [category, name, qty, location, mpn = '', pkg = '', notes = ''] = l.split('|').map(s => s.trim());
  return { category, name, qty: Number(qty), location, mpn, package: pkg, notes, unit: /wire/.test(name) ? 'spool' : '' };
});

const dingr = `| Qty | Part | Part number | Package | Notes |
| --- | --- | --- | --- | --- |
| 1 | ESP32-S3 module | ESP32-S3-WROOM-1-N16R8 | | Main MCU |
| 1 | 1.69" ST7789 IPS display | | | 240x280 |
| 12 | WS2812B-2020 RGB LED | WS2812B-2020 | 2020 | Timer halo |
| 1 | EC11 rotary encoder | | | Push to start |
| 1 | AMS1117 3.3V LDO | AMS1117-3.3 | SOT-223 | |
| 1 | USB-C receptacle | | SMD | Power in |
| 6 | 10K ohm res | | 0805 | Pull-ups, CC |
| 2 | 5.1k resistor | | 0805 | USB-C CC pull-downs |
| 8 | 0.1uF cap | | 0805 | Decoupling |
| 2 | 10 uF cap | | 0805 | Regulator |
| 1 | Piezo buzzer | | | Done chime |`;

const ipod = `| Qty | Part | Part number | Package | Notes |
| --- | --- | --- | --- | --- |
| 1 | Teensy 4.1 | | | Main board |
| 1 | 2.0in IPS display 320x240 | | | Fits the 5.5G window |
| 1 | Capacitive click wheel controller | | | Reuse stock wheel |
| 1 | MAX98357A I2S amp | | | Headphone path |
| 1 | 1200mAh LiPo | | | |
| 1 | TP4056 charger | | | |
| 2 | 6mm tact switch | | | Hold switch, reset |
| 4 | 10k resistor | | 0805 | |
| 6 | 100nF capacitor | | 0805 | |`;

async function call(path, body, method = 'POST') {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

const existing = await (await fetch(`${base}/api/parts`)).json();
if (existing.parts.length) {
  console.log(`There are already ${existing.parts.length} parts here. Seed an empty instance.`);
  process.exit(1);
}
await call('/api/parts/bulk', { rows: parts.filter(p => p.category !== 'Resistors') });
// A resistor book, the way "Add a kit" makes it: every E12 value from 10Ω to 1M, plenty of each.
const E12 = [1, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
const ohms = v => (v >= 1e6 ? `${+(v / 1e6).toPrecision(3)}M` : v >= 1e3 ? `${+(v / 1e3).toPrecision(3)}k` : `${+v.toPrecision(3)}Ω`);
const book = [10, 100, 1e3, 1e4, 1e5].flatMap(d => E12.map(b => b * d)).concat(1e6);
await call('/api/parts/bulk', { rows: book.map(v => ({ name: `${ohms(v)} resistor`, package: '0805', category: 'Resistors', location: 'Resistor book', stockLevel: 'plenty', qty: 0 })) });
await call('/api/parts/bulk', { rows: [
  { name: '220Ω resistor', package: '1/4W through-hole', category: 'Resistors', location: 'Drawer A1', qty: 0 },
  { name: 'Heat shrink tubing assortment', category: 'Wire & cable', location: 'Shelf 2', stockLevel: 'some', qty: 0 },
  { name: 'Solder, 0.8mm leaded', category: 'Consumables', location: 'Bench', stockLevel: 'low', qty: 0 },
  { name: 'PLA filament, black', category: 'Consumables', location: 'Shelf 3', qty: 650, unit: 'g' },
] });
await call('/api/projects', { name: 'Teensy iPod, stage 1', notes: 'Desktop bring-up before it goes in the 5.5G shell.', status: 'planned', bom: ipod });
await call('/api/projects', { name: 'Patio string lights', notes: 'WLED on an ESP32, about 100 ft of addressable bulbs.', status: 'idea', bom: '- 1x ESP32-S3 dev board\n- 1x 5V 20A power supply\n- 1x 74AHCT125 level shifter\n- 1x 1000uF electrolytic capacitor\n- 1x 330 ohm resistor' });
const old = await call('/api/projects', { name: 'Dishwasher indicator v1', notes: 'The Tasmota original.', status: 'done', bom: '- 1x ESP8266 D1 mini\n- 3x 5mm LED\n- 1x 6mm tact switch' });
await call(`/api/projects/${old.id}`, { archived: true }, 'PUT');
const d = await call('/api/projects', { name: 'Dingr prototype', notes: 'Appliance timer: color display, 12-LED halo, rotary encoder.', status: 'building', builds: 2, bom: dingr });
// Leave one suggested match to review, settle the rest as a person would.
for (const l of d.lines) {
  if (l.status === 'review' && !/LDO/.test(l.name)) await call(`/api/lines/${l.id}`, { partId: l.partId, state: 'confirmed', remember: true }, 'PUT');
}
console.log(`Seeded ${(await (await fetch(`${base}/api/parts`)).json()).parts.length} parts and 4 projects at ${base}.`);
