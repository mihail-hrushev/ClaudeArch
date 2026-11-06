/**
 * Glazing operators: glass surfaces placed one by one, or around and over plan outlines.
 */
import { z } from "zod";
import { type Vec3, add, sub, scale, dot, cross, normalize, len, WORLD_Z } from "../../fem/vec";
import { type P2, type Side, at } from "../../fem/plan";
import { type CutPlane, type GlassSurface, type GlassSurfaceParams, glassSurface } from "../../generators/glassSurface";
import { type BuildContext, BuildError, type SurfaceType } from "../context";
import { CutSpec, Length, Num, PointSpec, SurfaceTypeSpec, TileAlign, Vec3Spec, Padding } from "../document";
import { defineOperator } from "../operator";

/** Fields every glazing operator takes: the surface type and what it may override per use. */
const Glazing = {
  type: z.union([z.string(), SurfaceTypeSpec]),
  ribStep: Length.optional(),
  /** Explicit rib positions along X (replaces ribStep). */
  ribStations: z.array(Length).optional(),
  /** Whole bays: the rib step is rounded so the ribs divide the width evenly (default true). */
  evenBays: z.boolean().optional(),
  ribsOnGrid: z.boolean().optional(),
  align: TileAlign.optional(),
  padding: Padding.optional(),
  cuts: z.array(CutSpec).optional(),
  openings: z.array(z.union([z.string(), z.array(CutSpec)])).optional(),
};
type GlazingParams = z.infer<z.ZodObject<typeof Glazing>>;

/** Height: a level, or a height field result with an offset. */
export const Height = z.union([Length, z.object({ on: z.string(), offset: Length.optional() }).strict()]);

/** The parameters of one glass surface from a glazing operator's fields and its placement. */
export function surfaceParams(
  ctx: BuildContext, p: GlazingParams, path: string,
  placement: Pick<GlassSurfaceParams, "base" | "alongX" | "alongZ" | "tangent" | "facing"> & { cuts?: readonly CutPlane[]; openings?: readonly (readonly CutPlane[])[] },
): GlassSurfaceParams {
  const type: SurfaceType = ctx.surfaceType(p.type, `${path}.type`);
  const width = len(sub(placement.alongX, placement.base));
  let ribStep = p.ribStep === undefined ? type.ribStep : ctx.length(p.ribStep, `${path}.ribStep`);
  if (p.evenBays !== false && Number.isFinite(ribStep)) ribStep = width / Math.max(1, Math.round(width / ribStep));
  if (!Number.isFinite(ribStep)) ribStep = width;
  const padding = p.padding === undefined ? type.padding : ctx.padding(p.padding, `${path}.padding`);
  return {
    ...type,
    ribStep,
    ribStations: p.ribStations?.map((s, i) => ctx.length(s, `${path}.ribStations[${i}]`)),
    ribsOnGrid: p.ribsOnGrid ?? type.ribsOnGrid,
    padding,
    tile: p.align ? { ...type.tile, align: p.align } : type.tile,
    ...placement,
    cuts: [...(placement.cuts ?? []), ...ctx.cuts(p.cuts, `${path}.cuts`)],
    openings: [...(placement.openings ?? []), ...ctx.openings(p.openings, `${path}.openings`)],
  };
}

/** Builds one block, registers it and returns it. */
export function place(ctx: BuildContext, name: string, params: GlassSurfaceParams): GlassSurface {
  const block = glassSurface(name, params);
  ctx.addInstance(block);
  return block;
}

const lifted = (q: Vec3, z: number): Vec3 => [q[0], q[1], z];

/** Local tangent of a section at the base: `angle` degrees above the horizontal, towards the inside. */
const tangentOf = (degrees: number): Vec3 => [0, Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];

/** The sides of a plan an operator works on: all, or the given indices. */
export function selectedSides(sides: readonly Side[], indices: readonly number[] | undefined): { side: Side; k: number }[] {
  const all = sides.map((side, k) => ({ side, k }));
  if (!indices) return all;
  return indices.map((i) => all[((i % sides.length) + sides.length) % sides.length]);
}

export const surface = defineOperator({
  name: "surface",
  description: "One glass surface placed by its base, the end of its X axis and the top of its section (see generators/glassSurface).",
  schema: z.object({
    op: z.literal("surface"),
    name: z.string(),
    ...Glazing,
    base: PointSpec,
    alongX: PointSpec,
    alongZ: PointSpec,
    /** Section tangent at the base, in the local frame (default [0, 0, 1]). */
    tangent: Vec3Spec.optional(),
    /** Direction the glass faces, away from the structure (default: horizontal, outwards). */
    facing: Vec3Spec.optional(),
  }).strict(),
  run(ctx, p, path) {
    const block = place(ctx, p.name, surfaceParams(ctx, p, path, {
      base: ctx.point(p.base, `${path}.base`), alongX: ctx.point(p.alongX, `${path}.alongX`), alongZ: ctx.point(p.alongZ, `${path}.alongZ`),
      tangent: p.tangent && ctx.vec3(p.tangent, `${path}.tangent`), facing: p.facing && ctx.vec3(p.facing, `${path}.facing`),
    }));
    ctx.put(p.name, { kind: "surfaces", blocks: [block] }, path);
  },
});

/**
 * Bays of a side between the columns of a result standing in its line: a column whose axis is
 * `within` the line (default: its own width) splits the side, each bay stopping `clear` short of
 * its axis (default: the column's half width); the corner cuts move in by the same amount.
 */
const Bays = z.object({ columns: z.string(), clear: Length.optional(), within: Length.optional() }).strict();

interface Bay {
  readonly from: number;
  readonly to: number;
  /** Corner cuts of this bay: the side's at its ends, moved in to the column faces. */
  readonly cuts: readonly CutPlane[];
}

function sideBays(ctx: BuildContext, spec: z.infer<typeof Bays> | undefined, s: Side, path: string): Bay[] {
  if (!spec) return [{ from: 0, to: s.length, cuts: s.corners }];
  const columns = ctx.get(spec.columns, "columns", `${path}.bays.columns`).columns;
  const clear = ctx.optionalLength(spec.clear, `${path}.bays.clear`);
  const within = ctx.optionalLength(spec.within, `${path}.bays.within`);
  const halfWidth = (c: (typeof columns)[number]) => Math.max(...c.profile.outline.map(([y]) => Math.abs(y)));
  const marks = columns
    .map((c) => ({ u: dot(sub(c.at, s.a), s.along), away: Math.abs(dot(sub(c.at, s.a), s.inward)), clear: clear ?? halfWidth(c) }))
    .filter((m) => m.away <= (within ?? 2 * (clear ?? m.clear)) && m.u > m.clear && m.u < s.length - m.clear)
    .sort((a, b) => a.u - b.u);
  const nearest = (q: Vec3) => columns.reduce((best, c) => (len(sub(c.at, q)) < len(sub(best.at, q)) ? c : best));
  const moved = (c: CutPlane, q: Vec3): CutPlane => ({ point: add(c.point, scale(c.normal, clear ?? halfWidth(nearest(q)))), normal: c.normal });
  const corners = [moved(s.corners[0], s.a), moved(s.corners[1], s.b)];
  const ends = [0, ...marks.flatMap((m) => [m.u - m.clear, m.u + m.clear]), s.length];
  return Array.from({ length: marks.length + 1 }, (_, j): Bay => ({
    from: ends[2 * j], to: ends[2 * j + 1],
    cuts: [...(j === 0 ? [corners[0]] : []), ...(j === marks.length ? [corners[1]] : [])],
  }));
}

export const walls = defineOperator({
  name: "walls",
  description: "Upright glass walls along the sides of a plan outline, from a foot level (or a roof they stand on) up to a top level (or a roof they stop under); neighbouring walls meet on the corner bisectors. With `bays`, every side is split into bays between the columns standing in its line.",
  schema: z.object({
    op: z.literal("walls"),
    name: z.string(),
    ...Glazing,
    plan: z.string(),
    /** Sides to glaze (default: all). */
    sides: z.array(Num.int()).optional(),
    foot: Height.optional(),
    top: Height,
    /** How far the wall runs on past a sloping foot or top it is cut by (default 10). */
    overlap: Length.optional(),
    /** Inset of the wall line from the plan outline, towards the inside. */
    inset: Length.optional(),
    /** Split every side at the columns of a result standing in its line, one surface per bay. */
    bays: Bays.optional(),
  }).strict(),
  run(ctx, p, path) {
    const plan = ctx.plan(p.plan, `${path}.plan`);
    const footAt = ctx.height(p.foot ?? 0, `${path}.foot`);
    const topAt = ctx.height(p.top, `${path}.top`);
    const overlap = ctx.optionalLength(p.overlap, `${path}.overlap`) ?? 10;
    const inset = ctx.optionalLength(p.inset, `${path}.inset`) ?? 0;
    const sloping = (h: typeof footAt, a: Vec3, b: Vec3) => Math.abs(h(a) - h(b)) > 1e-9;
    const blocks = selectedSides(plan.sides, p.sides).flatMap(({ side: s, k }) => sideBays(ctx, p.bays, s, path).map((bay, j) => {
      const along = (u: number) => add(add(s.a, scale(s.along, u)), scale(s.inward, inset));
      const [a, b] = [along(bay.from), along(bay.to)];
      const cuts: CutPlane[] = [...bay.cuts];
      let foot = Math.min(footAt(a), footAt(b));
      let top = Math.max(topAt(a), topAt(b));
      if (sloping(footAt, a, b)) {
        foot -= overlap;
        const up = cross(s.inward, sub(lifted(b, footAt(b)), lifted(a, footAt(a))));
        cuts.push({ point: lifted(a, footAt(a)), normal: up[2] < 0 ? scale(up, -1) : up });
      }
      if (sloping(topAt, a, b)) {
        top += overlap;
        const up = cross(s.inward, sub(lifted(b, topAt(b)), lifted(a, topAt(a))));
        cuts.push({ point: lifted(a, topAt(a)), normal: up[2] > 0 ? scale(up, -1) : up });
      }
      if (top <= foot) throw new BuildError(`side ${k}: top ${top} is not above foot ${foot}`, path);
      return place(ctx, p.bays ? `${p.name}_side${k}_bay${j}` : `${p.name}_side${k}`, surfaceParams(ctx, p, path, {
        base: lifted(a, foot), alongX: lifted(b, foot), alongZ: lifted(a, top), cuts,
      }));
    }));
    ctx.put(p.name, { kind: "surfaces", blocks }, path);
  },
});

/** Circular section from the origin, leaving at `slope` degrees, through (run, rise). */
function sectionHeight(run: number, rise: number, slope: number | undefined): (d: number) => number {
  if (slope === undefined) return (d) => (rise * Math.min(run, Math.max(0, d))) / run;
  const theta = (slope * Math.PI) / 180;
  const denominator = 2 * (run * Math.sin(theta) - rise * Math.cos(theta));
  if (Math.abs(denominator) < 1e-9 * (run + Math.abs(rise))) return (d) => (rise * Math.min(run, Math.max(0, d))) / run;
  const radius = (run * run + rise * rise) / denominator;
  const [cy, cz] = [radius * Math.sin(theta), -radius * Math.cos(theta)];
  const sign = Math.sign(radius);
  return (d) => {
    const y = Math.min(run, Math.max(0, d));
    const inside = Math.max(0, radius * radius - (y - cy) ** 2);
    return cz + sign * Math.sqrt(inside);
  };
}

export const roof = defineOperator({
  name: "roof",
  description: "A roof face rising from every side of a plan outline (the eaves) by `rise` over `run` inward, with one section for all faces so they meet on the corner bisectors; `slope` at the eaves bends the section into an arc. Leaves a height field.",
  schema: z.object({
    op: z.literal("roof"),
    name: z.string(),
    ...Glazing,
    plan: z.string(),
    sides: z.array(Num.int()).optional(),
    eaves: Length,
    /** Height of the section at `run` from the eaves. With `slope` and no rise the arc levels off there. */
    rise: Length.optional(),
    /** Horizontal reach of the section (default: from the eaves to the middle of the plan). */
    run: Length.optional(),
    /** Angle of the roof at the eaves, degrees above the horizontal (default: straight to the rise). */
    slope: Num.optional(),
    /** Split every face at the columns of a result standing in the eaves line, one surface per bay. */
    bays: Bays.optional(),
  }).strict(),
  run(ctx, p, path) {
    const plan = ctx.plan(p.plan, `${path}.plan`);
    const eaves = ctx.length(p.eaves, `${path}.eaves`);
    const run = ctx.optionalLength(p.run, `${path}.run`)
      ?? Math.min(...plan.sides.map((s) => dot(sub(at(plan.centroid), s.a), s.inward)));
    let rise = ctx.optionalLength(p.rise, `${path}.rise`);
    if (rise === undefined) {
      if (p.slope === undefined) throw new BuildError("give rise, slope or both", path);
      rise = run * Math.tan((p.slope * Math.PI) / 360);
    }
    const section = sectionHeight(run, rise, p.slope);
    const heightAt = (q: Vec3) => eaves + section(Math.min(...plan.sides.map((s) => dot(sub(q, s.a), s.inward))));
    const blocks = selectedSides(plan.sides, p.sides).flatMap(({ side: s, k }) => sideBays(ctx, p.bays, s, path).map((bay, j) => {
      const base = lifted(add(s.a, scale(s.along, bay.from)), eaves);
      return place(ctx, p.bays ? `${p.name}_side${k}_bay${j}` : `${p.name}_side${k}`, surfaceParams(ctx, p, path, {
        base, alongX: lifted(add(s.a, scale(s.along, bay.to)), eaves), alongZ: add(add(base, scale(s.inward, run)), [0, 0, rise]),
        tangent: p.slope === undefined ? undefined : tangentOf(p.slope), cuts: bay.cuts,
      }));
    }));
    ctx.put(p.name, { kind: "height", field: { heightAt }, blocks }, path);
  },
});

export const dome = defineOperator({
  name: "dome",
  description: "A faceted dome over a plan outline: one curved face per side, from the base level up to the apex `rise` above it, springing vertically (default), flat to the apex, or at a given angle.",
  schema: z.object({
    op: z.literal("dome"),
    name: z.string(),
    ...Glazing,
    plan: z.string(),
    sides: z.array(Num.int()).optional(),
    base: Length,
    rise: Length,
    /** Plan position of the apex (default: the centroid). */
    apex: z.tuple([Length, Length]).optional(),
    /** Angle at the base, degrees above the horizontal (default 90, vertical), or "flat". */
    springing: z.union([Num, z.literal("flat")]).optional(),
  }).strict(),
  run(ctx, p, path) {
    const plan = ctx.plan(p.plan, `${path}.plan`);
    const base = ctx.length(p.base, `${path}.base`);
    const rise = ctx.length(p.rise, `${path}.rise`);
    const apex: P2 = p.apex ? ctx.p2(p.apex, `${path}.apex`) : plan.centroid;
    const top = at(apex, base + rise);
    const blocks = selectedSides(plan.sides, p.sides).map(({ side: s, k }) => {
      const inward = dot(sub(top, lifted(s.a, base)), s.inward);
      const tangent = p.springing === "flat" ? normalize([0, inward, rise]) : p.springing === undefined ? undefined : tangentOf(p.springing);
      return place(ctx, `${p.name}_side${k}`, surfaceParams(ctx, p, path, {
        base: lifted(s.a, base), alongX: lifted(s.b, base), alongZ: top, tangent, cuts: s.corners,
      }));
    });
    ctx.put(p.name, { kind: "surfaces", blocks }, path);
  },
});

export const floor = defineOperator({
  name: "floor",
  description: "A tiled floor over a plan outline at a level, its tiles on top and its structure hanging below; the tile grid runs along the first side (or the given one).",
  schema: z.object({
    op: z.literal("floor"),
    name: z.string(),
    ...Glazing,
    plan: z.string(),
    level: Length,
    /** Side of the plan the tile grid runs along (default 0). */
    along: Num.int().optional(),
    /** Glass side down instead: tiles below, structure on top. */
    ceiling: z.boolean().optional(),
  }).strict(),
  run(ctx, p, path) {
    const plan = ctx.plan(p.plan, `${path}.plan`);
    const level = ctx.length(p.level, `${path}.level`);
    const s = plan.sides[(((p.along ?? 0) % plan.sides.length) + plan.sides.length) % plan.sides.length];
    const outline = plan.polygon.map((q) => at(q, level));
    const x = s.along;
    const zAxis = s.inward;
    const origin = lifted(s.a, level);
    const xs = outline.map((q) => dot(sub(q, origin), x));
    const zs = outline.map((q) => dot(sub(q, origin), zAxis));
    const corner = (u: number, v: number) => add(add(origin, scale(x, u)), scale(zAxis, v));
    const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    const block = place(ctx, p.name, surfaceParams(ctx, p, path, {
      base: corner(x0, z0), alongX: corner(x1, z0), alongZ: corner(x0, z1), facing: p.ceiling ? scale(WORLD_Z, -1) : WORLD_Z,
      cuts: outline.map((q, j) => ({ point: q, normal: normalize(cross(WORLD_Z, sub(outline[(j + 1) % outline.length], q))) })),
    }));
    ctx.put(p.name, { kind: "surfaces", blocks: [block] }, path);
  },
});

export const deck = defineOperator({
  name: "deck",
  description: "Tiled deck bays between two outlines, e.g. a walkway between beam lines: one bay between each two consecutive corners of the outer outline, closed along the inner outline between the corners nearest to them. The tiles' top is at `level` with the structure hanging below; each bay's tile grid is centred on it and runs along its inner edge.",
  schema: z.object({
    op: z.literal("deck"),
    name: z.string(),
    ...Glazing,
    outer: z.string(),
    inner: z.string(),
    /** The walking surface. */
    level: Length,
  }).strict(),
  run(ctx, p, path) {
    const outer = ctx.plan(p.outer, `${path}.outer`).polygon;
    const inner = ctx.plan(p.inner, `${path}.inner`).polygon;
    const z = ctx.length(p.level, `${path}.level`) - ctx.surfaceType(p.type, `${path}.type`).tile.thickness / 2;
    const n = inner.length;
    const distance = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const nearest = (q: P2) => inner.reduce((best, c, j) => (distance(c, q) < distance(inner[best], q) ? j : best), 0);
    const blocks = outer.map((o, k) => {
      const o1 = outer[(k + 1) % outer.length];
      const [j0, j1] = [nearest(o), nearest(o1)];
      // Back along the inner outline from the corner nearest the bay's end to the one nearest its start.
      const chain: P2[] = [];
      for (let j = j1; ; j = (j + n - 1) % n) {
        chain.push(inner[j]);
        if (j === j0 || chain.length > n) break;
      }
      const outline = [o, o1, ...chain].map((q) => at(q, z));
      const origin = scale(add(outline[0], outline[1]), 0.5);
      const [first, last] = [outline[2], outline[outline.length - 1]];
      // Local Z square to the inner edge, towards it; X across the bay.
      const zAxis = len(sub(last, first)) > 1e-9 ? normalize(cross(sub(last, first), WORLD_Z)) : normalize(sub(first, origin));
      const xAxis = cross(zAxis, WORLD_Z);
      const xs = outline.map((q) => dot(sub(q, origin), xAxis));
      const zs = outline.map((q) => dot(sub(q, origin), zAxis));
      const corner = (u: number, v: number) => add(add(origin, scale(xAxis, u)), scale(zAxis, v));
      const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
      return place(ctx, `${p.name}${k}`, surfaceParams(ctx, p, path, {
        base: corner(x0, z0), alongX: corner(x1, z0), alongZ: corner(x0, z1), facing: WORLD_Z,
        cuts: outline.map((q, j) => ({ point: q, normal: normalize(cross(WORLD_Z, sub(outline[(j + 1) % outline.length], q))) })),
      }));
    });
    ctx.put(p.name, { kind: "surfaces", blocks }, path);
  },
});

export const glazingOperators = [surface, walls, roof, dome, floor, deck];
