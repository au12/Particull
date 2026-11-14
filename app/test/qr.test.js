import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { encodeQR, qrSvg } from '../public/shared/qr.js';

/** Draw the code into an RGBA buffer, 4 px per module with a quiet zone, and read it back with jsQR. */
function decode({ size, modules }, scale = 4, quiet = 4) {
  const dim = (size + quiet * 2) * scale;
  const px = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + quiet) * scale + dy) * dim + (x + quiet) * scale + dx) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
      }
    }
  }
  return jsQR(px, dim, dim);
}

test('codes decode back to the same text across versions and error levels', () => {
  const samples = [
    'A',
    'https://parts.example.com/#/parts/loc/Drawer%20A2',
    'Resistor book',
    'Ünïcødé bin — 抽屜 3',
  ];
  for (let n = 10; n <= 200; n += 19) samples.push('x'.repeat(n));
  const seen = new Set();
  for (const ecl of ['L', 'M', 'Q', 'H']) {
    for (const text of samples) {
      let code;
      try { code = encodeQR(text, { ecl }); } catch { continue; } // too long for v10 at this level
      seen.add(code.version);
      const out = decode(code);
      assert.ok(out, `no decode: ${ecl} v${code.version} "${text.slice(0, 20)}"`);
      assert.deepEqual([...out.binaryData], [...new TextEncoder().encode(text)], `${ecl} v${code.version}`);
    }
  }
  // Every version from 1 to 10 got exercised, including 7+ with version blocks.
  for (let v = 1; v <= 10; v++) assert.ok(seen.has(v), `version ${v} not tested`);
});

test('too much text is refused, and the SVG is one crisp path', () => {
  assert.throws(() => encodeQR('x'.repeat(400)), /too long/);
  const svg = qrSvg('Drawer A2', { title: 'Drawer A2 & <bin>' });
  assert.match(svg, /^<svg[^>]+viewBox="0 0 25 25"/);
  assert.equal((svg.match(/<path/g) || []).length, 1);
  assert.match(svg, /aria-label="Drawer A2 &amp; &lt;bin&gt;"/);
});
