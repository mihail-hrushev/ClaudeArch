/**
 * Writes public/textures/ivy-leaf.png: a procedural five-lobed ivy leaf, green with darker veins,
 * transparent outside the blade, stem at the bottom edge (v = 0 of the leaf quad).
 *   npm run ivy:texture
 * Pure Node: the PNG is encoded here (zlib from node:zlib plus a CRC-32), no dependencies.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const SIZE = 256;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "textures", "ivy-leaf.png");

// --- Leaf shape: a body disc plus five lobes (ellipses) around the centre, stem below. ---
type Lobe = { angle: number; offset: number; a: number; b: number };
const CENTRE = [128, 148] as const;
const BODY_RADIUS = 46;
const LOBES: Lobe[] = [
  { angle: 90, offset: 62, a: 72, b: 36 }, // tip, pointing up
  { angle: 90 - 55, offset: 56, a: 58, b: 30 },
  { angle: 90 + 55, offset: 56, a: 58, b: 30 },
  { angle: 90 - 122, offset: 44, a: 40, b: 26 },
  { angle: 90 + 122, offset: 44, a: 40, b: 26 },
];
const STEM_TOP = [128, 190] as const;
const STEM_BOTTOM = [128, 252] as const;
const STEM_HALF_WIDTH = 2.6;
const DEG = Math.PI / 180;

/** Image y grows downwards: an angle of 90° points to the top of the picture. */
function lobeTip(l: Lobe): [number, number] {
  return [CENTRE[0] + Math.cos(l.angle * DEG) * (l.offset + l.a), CENTRE[1] - Math.sin(l.angle * DEG) * (l.offset + l.a)];
}

/** Negative inside the blade: the smallest implicit value over body and lobes. */
function blade(x: number, y: number): number {
  const dx = x - CENTRE[0], dy = y - CENTRE[1];
  let f = Math.hypot(dx, dy) / BODY_RADIUS - 1;
  for (const l of LOBES) {
    const c = Math.cos(l.angle * DEG), s = -Math.sin(l.angle * DEG);
    const cx = CENTRE[0] + c * l.offset, cy = CENTRE[1] + s * l.offset;
    const px = x - cx, py = y - cy;
    const u = px * c + py * s, v = -px * s + py * c;
    f = Math.min(f, Math.hypot(u / l.a, v / l.b) - 1);
  }
  return f;
}

function segmentDistance(x: number, y: number, a: readonly [number, number], b: readonly [number, number]): number {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * abx + (y - a[1]) * aby) / (abx * abx + aby * aby)));
  return Math.hypot(x - a[0] - abx * t, y - a[1] - aby * t);
}

/** Cheap deterministic noise in [0, 1). */
function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothNoise(x: number, y: number, scale: number): number {
  const gx = x / scale, gy = y / scale;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const top = hash(x0, y0) * (1 - sx) + hash(x0 + 1, y0) * sx;
  const bottom = hash(x0, y0 + 1) * (1 - sx) + hash(x0 + 1, y0 + 1) * sx;
  return top * (1 - sy) + bottom * sy;
}

// --- Raster ---
const rgba = new Uint8Array(SIZE * SIZE * 4);
const SS = 4; // supersampling per axis for the blade edge
const veins = LOBES.map((l) => [STEM_TOP, lobeTip(l)] as const);

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // Coverage of blade and stem.
    let inside = 0;
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
      const px = x + (i + 0.5) / SS, py = y + (j + 0.5) / SS;
      if (blade(px, py) < 0 || segmentDistance(px, py, STEM_TOP, STEM_BOTTOM) < STEM_HALF_WIDTH) inside++;
    }
    const alpha = inside / (SS * SS);

    // Colour: darker towards the centre and the stem, lighter and yellower at the lobe tips,
    // with mottling; veins darker, fading towards the tips; the stem brownish.
    const cx = x + 0.5, cy = y + 0.5;
    const edge = Math.min(1, Math.max(0, -blade(cx, cy) * 1.6)); // 0 at the edge, 1 inside
    const noise = smoothNoise(cx, cy, 18) * 0.6 + smoothNoise(cx, cy, 6) * 0.4;
    let r = 0.16 + 0.16 * (1 - edge) + 0.10 * noise;
    let g = 0.42 + 0.20 * (1 - edge) + 0.12 * noise;
    let b = 0.12 + 0.05 * (1 - edge) + 0.04 * noise;
    let vein = 0;
    for (const [a, t] of veins) {
      const d = segmentDistance(cx, cy, a, t);
      const along = Math.hypot(cx - a[0], cy - a[1]) / Math.hypot(t[0] - a[0], t[1] - a[1]);
      const width = 2.2 - 1.4 * Math.min(1, along);
      vein = Math.max(vein, Math.max(0, 1 - d / width) * (1 - 0.5 * Math.min(1, along)));
    }
    // Midrib continues into the stem.
    vein = Math.max(vein, Math.max(0, 1 - segmentDistance(cx, cy, STEM_TOP, STEM_BOTTOM) / 1.2));
    const shade = 1 - 0.38 * vein;
    r *= shade; g *= shade; b *= shade;
    if (segmentDistance(cx, cy, STEM_TOP, STEM_BOTTOM) < STEM_HALF_WIDTH + 0.5 && cy > STEM_TOP[1]) {
      r = 0.30; g = 0.33; b = 0.14; // stem
    }
    const o = (y * SIZE + x) * 4;
    rgba[o] = Math.round(Math.min(1, r) * 255);
    rgba[o + 1] = Math.round(Math.min(1, g) * 255);
    rgba[o + 2] = Math.round(Math.min(1, b) * 255);
    rgba[o + 3] = Math.round(alpha * 255);
  }
}

// --- PNG encoding ---
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(Buffer.from(type, "ascii"), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePng(pixels: Uint8Array, width: number, height: number): Buffer {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  // Filter byte 0 (none) before every row.
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

mkdirSync(dirname(OUT), { recursive: true });
const png = encodePng(rgba, SIZE, SIZE);
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${SIZE}x${SIZE}, ${png.length} bytes)`);
