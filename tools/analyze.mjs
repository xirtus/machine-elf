/**
 * Visual critic, quantitative edition. Analyzes a screenshot PNG against the
 * BRIEF's art-direction rules. Usage:
 *   node tools/analyze.mjs testshots/00-x.png [json]
 *
 * Metrics:
 *  - lumaPct75 / lumaPct90 : % pixels above 0.75/0.90 luma  (bloom soup if >10% at .75)
 *  - blackPct              : % pixels below 0.045 luma       (neon needs black; want >25%)
 *  - meanLuma / contrast   : frame brightness + stddev
 *  - hueSpread             : 0..1, how many distinct hue families carry real mass (rainbow vomit if >0.5)
 *  - meanSat               : mean saturation of lit pixels
 *  - edgeDensity           : mean Sobel magnitude (detail vs mush; want >0.02 at 1080p)
 *  - deadSpace             : % pixels whose 9x9 neighborhood is nearly flat (cheap flat fill; want <25%)
 *  - grid luma             : 5x3 region brightness map (composition)
 *  - top5                  : dominant quantized colors
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const png = process.argv[2];
if (!png) { console.error('usage: analyze.mjs <png>'); process.exit(1); }

// sips -> BMP (trivial to parse, no deps)
const bmp = join(tmpdir(), 'crit.bmp');
try { execSync(`rm -f "${bmp}"`); } catch {}
execSync(`sips -s format bmp -s formatOptions best "${png}" --out "${bmp}" >/dev/null 2>&1`);
if (!existsSync(bmp)) { console.error('sips conversion failed for ' + png); process.exit(2); }
const buf = readFileSync(bmp);

const off = buf.readUInt32LE(10);
const hdrSize = buf.readUInt32LE(14);
const W = buf.readInt32LE(18);
const H = buf.readInt32LE(22);
const bpp = buf.readUInt16LE(28);
const comp = buf.readUInt32LE(30);
if (comp !== 0) { console.error('compressed bmp, giving up'); process.exit(1); }
const bytes = bpp / 8;
const rowSize = Math.floor((W * bytes + 3) / 4) * 4;
const topDown = H < 0;
const h = Math.abs(H);

const px = (x, y) => {
  const ry = topDown ? y : h - 1 - y;
  const i = off + ry * rowSize + x * bytes;
  return [buf[i + 2], buf[i + 1], buf[i]]; // BGR -> RGB
};

// ---- luminance / stats ----
const hist = new Array(256).fill(0);
let lumaSum = 0, lumaSum2 = 0, satSum = 0, satN = 0;
const hueBins = new Array(24).fill(0);
const step = 2; // stride 2 for speed at 1600px width
let n = 0;
const gridW = 5, gridH = 3;
const gridSum = Array.from({ length: gridW * gridH }, () => 0);
const gridN = Array.from({ length: gridW * gridH }, () => 0);

for (let y = 0; y < h; y += step) {
  for (let x = 0; x < W; x += step) {
    const [r, g, b] = px(x, y);
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    hist[Math.min(255, l)]++;
    lumaSum += l; lumaSum2 += l * l; n++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    if (l > 12) { satSum += sat; satN++; }
    if (sat > 0.28 && l > 15) {
      let hh = 0;
      if (mx === r) hh = ((g - b) / (mx - mn || 1)) * 60;
      else if (mx === g) hh = 120 + ((b - r) / (mx - mn || 1)) * 60;
      else hh = 240 + ((r - g) / (mx - mn || 1)) * 60;
      hueBins[((Math.round(hh / 15) % 24) + 24) % 24] += sat;
    }
    const gx = Math.floor((x / W) * gridW), gy = Math.floor((y / h) * gridH);
    gridSum[gy * gridW + Math.min(gx, gridW - 1)] += l;
    gridN[gy * gridW + Math.min(gx, gridW - 1)]++;
  }
}

// ---- edges + dead space (full res, stride 3) ----
const S = 3;
let edgeSum = 0, edgeN = 0, dead = 0, deadN = 0;
for (let y = 5; y < h - 9; y += S) {
  for (let x = 5; x < W - 9; x += S) {
    const [r1, g1, b1] = px(x, y);
    const l1 = 0.2126 * r1 + 0.7152 * g1 + 0.0722 * b1;
    let gx = 0, gy = 0, mn = 255, mx = 0, cnt = 0;
    for (let dy = -4; dy <= 4; dy += 4) {
      for (let dx = -4; dx <= 4; dx += 4) {
        const [r2, g2, b2] = px(x + dx, y + dy);
        const l2 = 0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2;
        gx += dx * l2; gy += dy * l2; cnt++;
        if (l2 < mn) mn = l2;
        if (l2 > mx) mx = l2;
      }
    }
    edgeSum += Math.sqrt(gx * gx + gy * gy); edgeN++;
    if (mx - mn < 1.5) dead++; deadN++;
  }
}

let p75 = 0, p90 = 0, p5 = 0;
for (let i = 0; i < 256; i++) { if (i >= 192) p75 += hist[i]; if (i >= 230) p90 += hist[i]; if (i < 12) p5 += hist[i]; }
const mean = lumaSum / n;
const contrast = Math.sqrt(lumaSum2 / n - mean * mean);

// hue spread: fraction of hue mass outside the top-3 hue families (shift-invariant via circular)
const totalHue = hueBins.reduce((a, b) => a + b, 0);
let spread = 0;
if (totalHue > 1) {
  let best = 0;
  for (let c = 0; c < 24; c++) {
    let m3 = 0;
    for (let k = 0; k < 24; k++) {
      const d = Math.min(Math.abs(k - c), 24 - Math.abs(k - c));
      m3 += hueBins[k] * (d <= 3 ? 1 : 0);
    }
    best = Math.max(best, m3);
  }
  spread = 1 - best / totalHue;
}

// top 5 dominant colors via coarse quantization
const q = new Map();
for (let y = 0; y < h; y += 8) for (let x = 0; x < W; x += 8) {
  const [r, g, b] = px(x, y);
  const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
  q.set(key, (q.get(key) || 0) + 1);
}
const top5 = [...q.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => {
  const r = ((k >> 6) & 7) * 36, g = ((k >> 3) & 7) * 36, b = (k & 7) * 36;
  return { hex: `#${[r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')}`, pct: +(100 * v / (n / 16)).toFixed(1) };
});

const out = {
  file: png, res: `${W}x${h}`,
  lumaPct75: +(100 * p75 / n).toFixed(2),
  lumaPct90: +(100 * p90 / n).toFixed(2),
  blackPct: +(100 * p5 / n).toFixed(2),
  meanLuma: +mean.toFixed(1),
  contrast: +contrast.toFixed(1),
  hueSpread: +spread.toFixed(3),
  meanSat: +(satSum / (satN || 1)).toFixed(3),
  edgeDensity: +(edgeSum / edgeN / 16).toFixed(3),
  deadSpacePct: +(100 * dead / deadN).toFixed(1),
  gridLuma: Array.from({ length: gridH }, (_, gy) =>
    Array.from({ length: gridW }, (_, gx) => +(gridSum[gy * gridW + gx] / gridN[gy * gridW + gx]).toFixed(0))),
  top5,
};

if (process.argv[3] === 'json') console.log(JSON.stringify(out));
else {
  console.log(`file        ${out.file}`);
  console.log(`res         ${out.res}`);
  console.log(`bright>75%  ${out.lumaPct75}%   (bloom soup if >10)`);
  console.log(`bright>90%  ${out.lumaPct90}%`);
  console.log(`black<5%    ${out.blackPct}%   (neon needs >25)`);
  console.log(`meanLuma    ${out.meanLuma}   contrast ${out.contrast}`);
  console.log(`hueSpread   ${out.hueSpread}  (rainbow vomit if >0.5)`);
  console.log(`meanSat     ${out.meanSat}`);
  console.log(`edgeDensity ${out.edgeDensity} (mush if <0.02)`);
  console.log(`deadSpace   ${out.deadSpacePct}%  (flat fill if >25)`);
  console.log(`grid luma   (rows top->bottom)`);
  for (const row of out.gridLuma) console.log('  ' + row.map(v => String(v).padStart(3)).join(' '));
  console.log(`top5        ${out.top5.map(c => `${c.hex} ${c.pct}%`).join('  ')}`);
}

// ---- ascii render (append-mode: re-run with --ascii) ----
if (process.argv.includes('--ascii')) {
  const cols = 132, rows = 44;
  const ramp = ' .:-=+*#%@';
  const hueChar = { r: 'R', y: 'Y', g: 'G', c: 'C', b: 'B', m: 'M' };
  for (let ry = 0; ry < rows; ry++) {
    let line = '';
    for (let rx = 0; rx < cols; rx++) {
      const x = Math.floor((rx / cols) * W), y = Math.floor((ry / rows) * h);
      const [r, g, b] = px(x, y);
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      let ch = ramp[Math.min(9, Math.floor(l / 26))];
      if (sat > 0.3 && l > 20) {
        let hh = 0;
        if (mx === r) hh = ((g - b) / (mx - mn || 1)) * 60;
        else if (mx === g) hh = 120 + ((b - r) / (mx - mn || 1)) * 60;
        else hh = 240 + ((r - g) / (mx - mn || 1)) * 60;
        hh = ((hh % 360) + 360) % 360;
        const hk = hh < 30 || hh >= 330 ? 'r' : hh < 70 ? 'y' : hh < 150 ? 'g' : hh < 200 ? 'c' : hh < 270 ? 'b' : 'm';
        ch = hueChar[hk];
      }
      line += ch;
    }
    console.log(line);
  }
}
