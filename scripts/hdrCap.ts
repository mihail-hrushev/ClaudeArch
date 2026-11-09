/**
 * Caps the brightest pixels of a Radiance .hdr sky, in place:
 *   npm run hdr:cap -- public/hdri/sky.hdr [max]       default max 200
 * A sun disc of tens of thousands overflows the half-float render targets of the environment
 * prefiltering and shows as a black square; the scene's directional light supplies the sun anyway.
 * Pixels whose brightest channel exceeds `max` are scaled down to it; the file is rewritten with
 * run-length scanlines of literal bytes.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [file, maxArg] = process.argv.slice(2);
if (!file) {
  console.error("usage: npm run hdr:cap -- <file.hdr> [max]");
  process.exit(2);
}
const max = maxArg ? Number(maxArg) : 200;
const data = readFileSync(file);

// Header: text lines up to an empty line, then the resolution line.
let pos = 0;
const line = () => {
  const end = data.indexOf(0x0a, pos);
  const text = data.subarray(pos, end).toString("latin1");
  pos = end + 1;
  return text;
};
const header: string[] = [];
for (let l = line(); l !== ""; l = line()) header.push(l);
const resolution = line();
const m = /^-Y (\d+) \+X (\d+)$/.exec(resolution);
if (!m) throw new Error(`unsupported resolution line "${resolution}"`);
const height = Number(m[1]);
const width = Number(m[2]);

// Scanlines: new run-length encoding (per channel) or flat pixels.
const rgbe = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y++) {
  const row = y * width * 4;
  if (width >= 8 && width < 32768 && data[pos] === 2 && data[pos + 1] === 2 && ((data[pos + 2] << 8) | data[pos + 3]) === width) {
    pos += 4;
    for (let c = 0; c < 4; c++) {
      for (let x = 0; x < width; ) {
        let count = data[pos++];
        if (count > 128) {
          const value = data[pos++];
          for (count -= 128; count > 0; count--) rgbe[row + 4 * x++ + c] = value;
        } else {
          for (; count > 0; count--) rgbe[row + 4 * x++ + c] = data[pos++];
        }
      }
    }
  } else {
    for (let x = 0; x < width * 4; x++) rgbe[row + x] = data[pos++];
  }
}

let capped = 0;
let peak = 0;
for (let i = 0; i < rgbe.length; i += 4) {
  const e = rgbe[i + 3];
  if (e === 0) continue;
  const f = 2 ** (e - 136);
  const r = rgbe[i] * f, g = rgbe[i + 1] * f, b = rgbe[i + 2] * f;
  const v = Math.max(r, g, b);
  peak = Math.max(peak, v);
  if (v <= max) continue;
  capped++;
  const s = max / v;
  // Back to RGBE: mantissa in [0.5, 1) times 256.
  const exponent = Math.ceil(Math.log2(max)) + (2 ** Math.ceil(Math.log2(max)) === max ? 1 : 0);
  const scale = s * 256 / 2 ** exponent;
  rgbe[i] = Math.min(255, Math.floor(r * scale));
  rgbe[i + 1] = Math.min(255, Math.floor(g * scale));
  rgbe[i + 2] = Math.min(255, Math.floor(b * scale));
  rgbe[i + 3] = exponent + 128;
}

const out: number[] = [];
const text = (s: string) => out.push(...Buffer.from(s, "latin1"));
for (const h of header) text(`${h}\n`);
text(`\n${resolution}\n`);
for (let y = 0; y < height; y++) {
  out.push(2, 2, width >> 8, width & 255);
  for (let c = 0; c < 4; c++) {
    for (let x = 0; x < width; x += 128) {
      const n = Math.min(128, width - x);
      out.push(n);
      for (let k = 0; k < n; k++) out.push(rgbe[(y * width + x + k) * 4 + c]);
    }
  }
}
writeFileSync(file, Buffer.from(out));
console.log(`${file}: ${width}x${height}, peak ${Math.round(peak)}, ${capped} pixels capped at ${max}`);
