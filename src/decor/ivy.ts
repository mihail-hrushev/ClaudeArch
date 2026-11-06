/**
 * Procedural climbing ivy after Thomas Luft's "An Ivy Generator" (2007).
 *
 * Pure data, no rendering: a set of root seed points grows step by step over the triangles of
 * the model. Every step direction blends the previous direction, a random vector, the pull
 * towards the nearest surface (adhesion) and gravity; a step that would cross a triangle is
 * slid along it instead. Roots branch with a probability per step and die after too many steps
 * without a surface in reach. Leaves are then scattered along the branches.
 *
 * Deterministic: the same model, seeds and parameters give the same output (seeded RNG).
 * World convention of the FEM model: right-handed, Z up, centimetres.
 */
import type { Model } from "../fem/types";
import { discretize } from "../fem/discretize";
import { sweepProfile } from "../fem/sweep";
import { plateSolid } from "../fem/plate";
import { type Vec3, add, sub, scale, dot, cross, len, normalize, WORLD_Z } from "../fem/vec";

export interface IvyParams {
  /** RNG seed: identical seeds give identical ivy. */
  seed: number;
  /** Upper bound on roots (seeds plus branches). */
  maxRoots: number;
  /** Length of one growth step, cm. */
  stepLength: number;
  /** Steps per root before it stops. */
  maxSteps: number;
  /** Weight of the primary direction: up for a seed, then smoothed with each step taken. */
  primaryWeight: number;
  /** Weight of the random wandering. */
  randomWeight: number;
  /** Weight of the pull towards the nearest surface. */
  adhesionWeight: number;
  /** Weight of gravity (0, 0, −1); only pulls while the root floats, growing with the float length. */
  gravityWeight: number;
  /** Distance within which a surface attracts the root, cm (the pull fades out linearly). */
  adhesionRange: number;
  /** Chance per step of a climbing root to spawn a branch. */
  branchProbability: number;
  /** Steps without any surface within `adhesionRange` before a root dies. */
  maxFloatLength: number;
  /** Mean number of leaves per growth node. */
  leafDensity: number;
  /** Mean leaf size (width and length of the leaf quad), cm. */
  leafSize: number;
  /** Relative size spread, 0 … 1: size = leafSize · (1 ± variance). */
  leafSizeVariance: number;
  /** Radius of a seed root at its base, cm (branches and tips taper from it). */
  branchRadius: number;
}

export const DEFAULT_IVY_PARAMS: IvyParams = {
  seed: 7,
  maxRoots: 160,
  stepLength: 8,
  maxSteps: 150,
  primaryWeight: 0.5,
  randomWeight: 0.2,
  adhesionWeight: 0.3,
  gravityWeight: 0.6,
  adhesionRange: 30,
  branchProbability: 0.04,
  maxFloatLength: 10,
  leafDensity: 0.7,
  leafSize: 12,
  leafSizeVariance: 0.4,
  branchRadius: 1.0,
};

/** Branches spawned by branches: deeper ones are thinner and shorter. */
const MAX_BRANCH_DEPTH = 3;
/**
 * Clearance the branch axis keeps from every surface, cm: the stem's own thickness, and the
 * reason a root cannot slip through the narrow slots between a column and the glass frames.
 */
const CLEARANCE = 2;
/** Steps in a row a root may spend blocked by surfaces before it gives up. */
const MAX_STUCK = 4;
/** Constant upward pull on the primary direction (ivy grows against gravity). */
const UP_BIAS = 0.25;
/** The ground plane z = 0 is a surface too (collision and contact, no adhesion pull). */
const GROUND_Z = 0;

export interface IvyNode {
  readonly position: Vec3;
  /** Branch radius at this node, cm. */
  readonly radius: number;
  /** Unit normal of the surface the node sits on, or null when the node floats. */
  readonly surfaceNormal: Vec3 | null;
  /** Growth direction leaving this node (unit). */
  readonly direction: Vec3;
}

export interface IvyBranch {
  readonly nodes: readonly IvyNode[];
  /** 0 for a seed root, +1 per branching. */
  readonly depth: number;
}

export interface IvyLeaf {
  readonly position: Vec3;
  /** Unit normal of the leaf blade. */
  readonly normal: Vec3;
  /** Unit direction from the stem to the tip, perpendicular to `normal`. */
  readonly tangent: Vec3;
  /** Edge length of the leaf quad, cm. */
  readonly size: number;
}

export interface IvyResult {
  readonly branches: readonly IvyBranch[];
  readonly leaves: readonly IvyLeaf[];
  readonly stats: {
    roots: number;
    nodes: number;
    leaves: number;
    /** Highest node, cm above the ground. */
    maxHeight: number;
    /** Wall-clock milliseconds: surface hash build, growth (with leaves). */
    surfaceMs: number;
    growMs: number;
  };
}

// ---------------------------------------------------------------------------------------------
// Random numbers (mulberry32: small, fast, good enough for scattering leaves).

function createRandom(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniformly distributed unit vector. */
function randomUnit(rnd: () => number): Vec3 {
  const z = rnd() * 2 - 1;
  const a = rnd() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return [r * Math.cos(a), r * Math.sin(a), z];
}

/** Any unit vector perpendicular to the unit vector n. */
function perpendicular(n: Vec3): Vec3 {
  const helper: Vec3 = Math.abs(n[2]) < 0.9 ? WORLD_Z : [1, 0, 0];
  return normalize(cross(n, helper));
}

// ---------------------------------------------------------------------------------------------
// Triangle soup with a uniform spatial hash for nearest-point and segment queries.

export interface SurfaceHit {
  /** Closest point on (or the hit point of) the triangle. */
  point: Vec3;
  /** Unit normal of the triangle, oriented towards the query side. */
  normal: Vec3;
  /** Nearest query: distance; raycast: parameter 0 … 1 along the segment. */
  t: number;
}

export class IvySurface {
  /** 9 numbers per triangle: a, b, c. */
  private readonly tri: Float64Array;
  /** 3 numbers per triangle: unit normal (right-hand rule). */
  private readonly nrm: Float64Array;
  readonly triangleCount: number;
  private readonly min: Vec3;
  private readonly cell: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;
  /** CSR cell → triangle lists. */
  private readonly offsets: Int32Array;
  private readonly items: Int32Array;

  /** Triangulates every element with the same generators the renderer uses. */
  static fromModel(model: Model, cell = DEFAULT_IVY_PARAMS.adhesionRange): IvySurface {
    const positions: number[] = [];
    const indices: number[] = [];
    for (const el of model.elements) {
      const g = el.kind === "plate" ? plateSolid(el) : sweepProfile(discretize(el), el.profile, el.endCut);
      const base = positions.length / 3;
      for (let i = 0; i < g.positions.length; i++) positions.push(g.positions[i]);
      for (let i = 0; i < g.indices.length; i++) indices.push(base + g.indices[i]);
    }
    return new IvySurface(positions, indices, cell);
  }

  constructor(positions: ArrayLike<number>, indices: ArrayLike<number>, cell: number) {
    const n = Math.floor(indices.length / 3);
    this.triangleCount = n;
    this.cell = cell;
    const tri = new Float64Array(n * 9);
    const nrm = new Float64Array(n * 3);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        const v = indices[i * 3 + k] * 3;
        const x = positions[v], y = positions[v + 1], z = positions[v + 2];
        tri[i * 9 + k * 3] = x;
        tri[i * 9 + k * 3 + 1] = y;
        tri[i * 9 + k * 3 + 2] = z;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      const o = i * 9;
      const abx = tri[o + 3] - tri[o], aby = tri[o + 4] - tri[o + 1], abz = tri[o + 5] - tri[o + 2];
      const acx = tri[o + 6] - tri[o], acy = tri[o + 7] - tri[o + 1], acz = tri[o + 8] - tri[o + 2];
      let cx = aby * acz - abz * acy, cy = abz * acx - abx * acz, cz = abx * acy - aby * acx;
      const l = Math.hypot(cx, cy, cz) || 1;
      cx /= l; cy /= l; cz /= l;
      nrm[i * 3] = cx; nrm[i * 3 + 1] = cy; nrm[i * 3 + 2] = cz;
    }
    if (n === 0) { minX = minY = minZ = 0; maxX = maxY = maxZ = 0; }
    // One spare cell of margin all round, so queries near the bounds still find their cells.
    this.min = [minX - cell, minY - cell, minZ - cell];
    this.nx = Math.ceil((maxX - minX) / cell) + 3;
    this.ny = Math.ceil((maxY - minY) / cell) + 3;
    this.nz = Math.ceil((maxZ - minZ) / cell) + 3;
    this.tri = tri;
    this.nrm = nrm;

    // Two passes (count, fill) into compact arrays.
    const cells = this.nx * this.ny * this.nz;
    const counts = new Int32Array(cells + 1);
    const range = new Int32Array(6);
    for (let i = 0; i < n; i++) {
      this.triangleCells(i, range);
      for (let z = range[2]; z <= range[5]; z++)
        for (let y = range[1]; y <= range[4]; y++)
          for (let x = range[0]; x <= range[3]; x++) counts[this.cellIndex(x, y, z) + 1]++;
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    const offsets = counts;
    const items = new Int32Array(offsets[cells]);
    const cursor = offsets.slice(0, cells);
    for (let i = 0; i < n; i++) {
      this.triangleCells(i, range);
      for (let z = range[2]; z <= range[5]; z++)
        for (let y = range[1]; y <= range[4]; y++)
          for (let x = range[0]; x <= range[3]; x++) items[cursor[this.cellIndex(x, y, z)]++] = i;
    }
    this.offsets = offsets;
    this.items = items;
  }

  private cellIndex(x: number, y: number, z: number): number {
    return (z * this.ny + y) * this.nx + x;
  }

  private cellCoord(v: number, axis: number, size: number): number {
    const c = Math.floor((v - this.min[axis]) / this.cell);
    return c < 0 ? 0 : c >= size ? size - 1 : c;
  }

  /** Cell range [x0, y0, z0, x1, y1, z1] covering the triangle's bounding box. */
  private triangleCells(i: number, out: Int32Array) {
    const o = i * 9;
    for (let axis = 0; axis < 3; axis++) {
      const a = this.tri[o + axis], b = this.tri[o + 3 + axis], c = this.tri[o + 6 + axis];
      const size = axis === 0 ? this.nx : axis === 1 ? this.ny : this.nz;
      out[axis] = this.cellCoord(Math.min(a, b, c), axis, size);
      out[axis + 3] = this.cellCoord(Math.max(a, b, c), axis, size);
    }
  }

  /** Cell range covering the axis-aligned box [lo, hi]. */
  private boxCells(lo: Vec3, hi: Vec3, out: Int32Array) {
    out[0] = this.cellCoord(lo[0], 0, this.nx); out[3] = this.cellCoord(hi[0], 0, this.nx);
    out[1] = this.cellCoord(lo[1], 1, this.ny); out[4] = this.cellCoord(hi[1], 1, this.ny);
    out[2] = this.cellCoord(lo[2], 2, this.nz); out[5] = this.cellCoord(hi[2], 2, this.nz);
  }

  /** Nearest triangle point within `range` of p (Ericson, "Real-Time Collision Detection" 5.1.5). */
  nearest(p: Vec3, range: number): SurfaceHit | null {
    const r = new Int32Array(6);
    this.boxCells([p[0] - range, p[1] - range, p[2] - range], [p[0] + range, p[1] + range, p[2] + range], r);
    const tri = this.tri;
    let best = range * range;
    let bx = 0, by = 0, bz = 0, bi = -1;
    const px = p[0], py = p[1], pz = p[2];
    for (let z = r[2]; z <= r[5]; z++) for (let y = r[1]; y <= r[4]; y++) for (let x = r[0]; x <= r[3]; x++) {
      const c = this.cellIndex(x, y, z);
      for (let k = this.offsets[c]; k < this.offsets[c + 1]; k++) {
        const i = this.items[k];
        const o = i * 9;
        const ax = tri[o], ay = tri[o + 1], az = tri[o + 2];
        const abx = tri[o + 3] - ax, aby = tri[o + 4] - ay, abz = tri[o + 5] - az;
        const acx = tri[o + 6] - ax, acy = tri[o + 7] - ay, acz = tri[o + 8] - az;
        const apx = px - ax, apy = py - ay, apz = pz - az;
        const d1 = abx * apx + aby * apy + abz * apz;
        const d2 = acx * apx + acy * apy + acz * apz;
        let qx: number, qy: number, qz: number;
        if (d1 <= 0 && d2 <= 0) {
          qx = ax; qy = ay; qz = az;
        } else {
          const bpx = px - tri[o + 3], bpy = py - tri[o + 4], bpz = pz - tri[o + 5];
          const d3 = abx * bpx + aby * bpy + abz * bpz;
          const d4 = acx * bpx + acy * bpy + acz * bpz;
          if (d3 >= 0 && d4 <= d3) {
            qx = tri[o + 3]; qy = tri[o + 4]; qz = tri[o + 5];
          } else {
            const vc = d1 * d4 - d3 * d2;
            if (vc <= 0 && d1 >= 0 && d3 <= 0) {
              const v = d1 / (d1 - d3);
              qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz;
            } else {
              const cpx = px - tri[o + 6], cpy = py - tri[o + 7], cpz = pz - tri[o + 8];
              const d5 = abx * cpx + aby * cpy + abz * cpz;
              const d6 = acx * cpx + acy * cpy + acz * cpz;
              if (d6 >= 0 && d5 <= d6) {
                qx = tri[o + 6]; qy = tri[o + 7]; qz = tri[o + 8];
              } else {
                const vb = d5 * d2 - d1 * d6;
                if (vb <= 0 && d2 >= 0 && d6 <= 0) {
                  const w = d2 / (d2 - d6);
                  qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz;
                } else {
                  const va = d3 * d6 - d5 * d4;
                  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
                    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
                    qx = tri[o + 3] + w * (tri[o + 6] - tri[o + 3]);
                    qy = tri[o + 4] + w * (tri[o + 7] - tri[o + 4]);
                    qz = tri[o + 5] + w * (tri[o + 8] - tri[o + 5]);
                  } else {
                    const denom = 1 / (va + vb + vc);
                    const v = vb * denom, w = vc * denom;
                    qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
                  }
                }
              }
            }
          }
        }
        const dx = px - qx, dy = py - qy, dz = pz - qz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) { best = d; bx = qx; by = qy; bz = qz; bi = i; }
      }
    }
    if (bi < 0) return null;
    return { point: [bx, by, bz], normal: this.orientedNormal(bi, p[0] - bx, p[1] - by, p[2] - bz), t: Math.sqrt(best) };
  }

  /** First triangle crossed by the segment a → b (Möller–Trumbore, both sides). */
  raycast(a: Vec3, b: Vec3): SurfaceHit | null {
    const r = new Int32Array(6);
    this.boxCells(
      [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
      [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])], r);
    const tri = this.tri;
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    let bestT = 1 + 1e-9;
    let bi = -1;
    for (let z = r[2]; z <= r[5]; z++) for (let y = r[1]; y <= r[4]; y++) for (let x = r[0]; x <= r[3]; x++) {
      const c = this.cellIndex(x, y, z);
      for (let k = this.offsets[c]; k < this.offsets[c + 1]; k++) {
        const i = this.items[k];
        const o = i * 9;
        const e1x = tri[o + 3] - tri[o], e1y = tri[o + 4] - tri[o + 1], e1z = tri[o + 5] - tri[o + 2];
        const e2x = tri[o + 6] - tri[o], e2y = tri[o + 7] - tri[o + 1], e2z = tri[o + 8] - tri[o + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-12 && det < 1e-12) continue;
        const inv = 1 / det;
        const tx = a[0] - tri[o], ty = a[1] - tri[o + 1], tz = a[2] - tri[o + 2];
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t >= 0 && t < bestT) { bestT = t; bi = i; }
      }
    }
    if (bi < 0) return null;
    return {
      point: [a[0] + dx * bestT, a[1] + dy * bestT, a[2] + dz * bestT],
      normal: this.orientedNormal(bi, -dx, -dy, -dz),
      t: bestT,
    };
  }

  /** Triangle normal flipped, if needed, to point along (tx, ty, tz). */
  private orientedNormal(i: number, tx: number, ty: number, tz: number): Vec3 {
    const nx = this.nrm[i * 3], ny = this.nrm[i * 3 + 1], nz = this.nrm[i * 3 + 2];
    return nx * tx + ny * ty + nz * tz < 0 ? [-nx, -ny, -nz] : [nx, ny, nz];
  }
}

// ---------------------------------------------------------------------------------------------
// Growth.

interface Root {
  position: Vec3;
  direction: Vec3;
  depth: number;
}

interface GrowingNode {
  position: Vec3;
  surfaceNormal: Vec3 | null;
  direction: Vec3;
}

/** Grows ivy from the seed points over the surface. */
export function growIvy(surface: IvySurface, seeds: readonly Vec3[], params: Partial<IvyParams> = {}): IvyResult {
  const p = { ...DEFAULT_IVY_PARAMS, ...params };
  const t0 = now();
  const rnd = createRandom(p.seed);
  const queue: Root[] = seeds.slice(0, p.maxRoots).map((s) => ({ position: s, direction: WORLD_Z, depth: 0 }));
  const branches: IvyBranch[] = [];
  let rootCount = queue.length;
  let nodeCount = 0;
  let maxHeight = -Infinity;

  for (let q = 0; q < queue.length; q++) {
    const root = queue[q];
    const nodes: GrowingNode[] = [];
    let pos = root.position;
    let dir = root.direction;
    let floating = 0;
    const steps = Math.round(p.maxSteps * Math.pow(0.7, root.depth));
    const first = surface.nearest(pos, p.adhesionRange);
    nodes.push({ position: pos, surfaceNormal: first?.normal ?? null, direction: dir });

    let primary = root.direction;
    let stuck = 0;
    for (let s = 0; s < steps; s++) {
      // Blend of influences (Luft 2007): primary direction, wandering, adhesion (fading with the
      // distance), and gravity, which only takes hold the longer the root floats.
      const near = surface.nearest(pos, p.adhesionRange);
      let gx = primary[0] * p.primaryWeight, gy = primary[1] * p.primaryWeight, gz = primary[2] * p.primaryWeight;
      const r = randomUnit(rnd);
      gx += r[0] * p.randomWeight; gy += r[1] * p.randomWeight; gz += r[2] * p.randomWeight;
      if (near && near.t > 1e-3) {
        const w = (p.adhesionWeight * (1 - near.t / p.adhesionRange)) / near.t;
        gx += (near.point[0] - pos[0]) * w; gy += (near.point[1] - pos[1]) * w; gz += (near.point[2] - pos[2]) * w;
      }
      gz -= p.gravityWeight * Math.pow(floating / p.maxFloatLength, 0.7);
      const gl = Math.hypot(gx, gy, gz);
      dir = gl < 1e-9 ? randomUnit(rnd) : [gx / gl, gy / gl, gz / gl];
      let next: Vec3 = add(pos, scale(dir, p.stepLength));
      let contactNormal: Vec3 | null = null;

      // Crossing a surface: slide along it instead.
      const hit = surface.raycast(pos, next);
      if (hit) {
        const n = hit.normal;
        let slide = sub(dir, scale(n, dot(dir, n)));
        const sl = len(slide);
        slide = sl < 1e-6 ? perpendicular(n) : scale(slide, 1 / sl);
        dir = slide;
        next = add(pos, scale(slide, p.stepLength));
        contactNormal = n;
      }
      // Keep the clearance from the nearest surfaces (two passes settle into corners).
      for (let pass = 0; pass < 2; pass++) {
        const close = surface.nearest(next, CLEARANCE);
        if (!close) break;
        next = add(next, scale(close.normal, CLEARANCE - close.t));
        contactNormal ??= close.normal;
      }
      // The ground is a surface as well: never below it, crawl along it.
      if (next[2] < GROUND_Z + CLEARANCE) {
        next = [next[0], next[1], GROUND_Z + CLEARANCE];
        const flat: Vec3 = [dir[0], dir[1], 0];
        dir = len(flat) < 1e-6 ? perpendicular(WORLD_Z) : normalize(flat);
        contactNormal = WORLD_Z;
      }
      // Still blocked (a slot too narrow for the stem): stay and look for another way.
      if (surface.raycast(pos, next) || surface.nearest(next, CLEARANCE * 0.75)) {
        if (++stuck > MAX_STUCK) break;
        primary = randomUnit(rnd);
        continue;
      }
      stuck = 0;
      // The primary direction follows the growth (not the clearance pushes) and keeps aiming up.
      primary = normalize(add(add(scale(primary, 0.5), scale(dir, 0.5)), scale(WORLD_Z, UP_BIAS)));
      dir = normalize(sub(next, pos));
      pos = next;

      // Contact bookkeeping: a root that floats too long dies.
      const after = surface.nearest(pos, p.adhesionRange);
      const onGround = pos[2] < GROUND_Z + p.adhesionRange * 0.25;
      if (after || onGround) floating = 0; else floating++;
      if (floating > p.maxFloatLength) break;
      const surfaceNormal = contactNormal ?? (after && after.t < p.adhesionRange * 0.5 ? after.normal : onGround ? WORLD_Z : null);
      nodes.push({ position: pos, surfaceNormal, direction: dir });
      if (pos[2] > maxHeight) maxHeight = pos[2];

      // Branching from climbing nodes: a new root with a sideways, slightly upward primary direction.
      if (surfaceNormal && s > 2 && root.depth < MAX_BRANCH_DEPTH && rootCount < p.maxRoots && rnd() < p.branchProbability) {
        const spread = randomUnit(rnd);
        const d = normalize(add(add(scale(dir, 0.4), scale(spread, 0.7)), scale(WORLD_Z, 0.25)));
        queue.push({ position: pos, direction: d, depth: root.depth + 1 });
        rootCount++;
      }
    }

    if (nodes.length < 2) continue;
    // Taper: base radius scaled per depth, down to a quarter at the tip.
    const base = p.branchRadius * Math.pow(0.7, root.depth);
    const last = nodes.length - 1;
    branches.push({
      depth: root.depth,
      nodes: nodes.map((n, i) => ({ ...n, radius: base * (1 - 0.75 * (i / last)) })),
    });
    nodeCount += nodes.length;
  }

  const leaves = placeLeaves(branches, p, rnd);
  const growMs = now() - t0;
  return {
    branches,
    leaves,
    stats: { roots: branches.length, nodes: nodeCount, leaves: leaves.length, maxHeight: Math.max(0, maxHeight), surfaceMs: 0, growMs },
  };
}

function placeLeaves(branches: readonly IvyBranch[], p: IvyParams, rnd: () => number): IvyLeaf[] {
  const leaves: IvyLeaf[] = [];
  const DOWN: Vec3 = [0, 0, -1];
  for (const b of branches) {
    const nodes = b.nodes;
    for (let i = 1; i < nodes.length; i++) {
      const node = nodes[i];
      const prev = nodes[i - 1];
      // Fewer leaves on the youngest growth, so the tips look like fresh tendrils.
      const age = Math.min(1, (nodes.length - 1 - i) / 6);
      const count = Math.floor(p.leafDensity * (0.3 + 0.7 * age) + rnd());
      for (let k = 0; k < count; k++) {
        // Somewhere along the last segment, slightly off the branch.
        const along = rnd();
        const stem = add(prev.position, scale(sub(node.position, prev.position), along));
        // Leaf blade faces away from the surface, or up-ish when the branch floats.
        let normal: Vec3;
        if (node.surfaceNormal) {
          normal = node.surfaceNormal;
        } else {
          const up = sub(WORLD_Z, scale(node.direction, node.direction[2]));
          normal = len(up) < 1e-3 ? perpendicular(node.direction) : normalize(up);
        }
        // Random turn about the normal, a small tilt, and a droop of the tip.
        const u = perpendicular(normal);
        const v = cross(normal, u);
        const a = rnd() * Math.PI * 2;
        let tangent = add(scale(u, Math.cos(a)), scale(v, Math.sin(a)));
        const tilt = (rnd() - 0.5) * 0.7;
        normal = normalize(add(normal, scale(tangent, tilt)));
        tangent = normalize(add(tangent, scale(DOWN, 0.35 * rnd())));
        tangent = normalize(sub(tangent, scale(normal, dot(tangent, normal))));
        const size = p.leafSize * (1 + p.leafSizeVariance * (rnd() * 2 - 1)) * (0.6 + 0.4 * age);
        const position = add(stem, add(scale(normal, node.radius + 0.4), scale(u, (rnd() - 0.5) * node.radius * 2)));
        leaves.push({ position, normal, tangent, size });
      }
    }
  }
  return leaves;
}

// ---------------------------------------------------------------------------------------------
// Convenience: everything from a model.

/**
 * Root seed points derived from the model: at the foot of the ground columns along the front
 * (−Y) and at the two ends (±X), plus the interior column nearest the front centre, each a little
 * outside the column (away from the building's centre) at z ≈ 5 cm.
 */
export function defaultIvyRoots(model: Model): Vec3[] {
  const columns = model.elements.filter(
    (el) => el.kind === "straight" && /\/(wall_)?column_[-\d_]+$/.test(el.id) && el.start[2] <= 1e-6 && el.end[2] > 400,
  ) as { id: string; start: Vec3; profile: { outline: readonly (readonly [number, number])[] } }[];
  if (columns.length === 0) return [];
  const xs = columns.map((c) => c.start[0]);
  const ys = columns.map((c) => c.start[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys);
  const chosen = columns.filter((c) => {
    const [x, y] = c.start;
    const wall = /\/wall_column_/.test(c.id);
    return wall && (y < minY + 150 || x < minX + 300 || x > maxX - 300);
  });
  // The interior column closest to the centre of the front.
  const interior = columns.filter((c) => !/\/wall_column_/.test(c.id) && c.start[1] < 0);
  interior.sort((a, b) => Math.abs(a.start[0]) - Math.abs(b.start[0]));
  if (interior[0]) chosen.push(interior[0]);

  return chosen.map((c) => {
    const radius = Math.max(...c.profile.outline.map(([y, z]) => Math.hypot(y, z)));
    const [x, y] = c.start;
    const out = Math.hypot(x, y) < 1 ? [0, -1] : [x / Math.hypot(x, y), y / Math.hypot(x, y)];
    const d = radius + 6;
    return [x + out[0] * d, y + out[1] * d, 5] as Vec3;
  });
}

/** Builds the surface hash from the model and grows ivy from the default (or given) roots. */
export function generateIvy(model: Model, params: Partial<IvyParams> = {}, seeds?: readonly Vec3[]): IvyResult {
  const t0 = now();
  const surface = IvySurface.fromModel(model, params.adhesionRange ?? DEFAULT_IVY_PARAMS.adhesionRange);
  const surfaceMs = now() - t0;
  const result = growIvy(surface, seeds ?? defaultIvyRoots(model), params);
  return { ...result, stats: { ...result.stats, surfaceMs } };
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
