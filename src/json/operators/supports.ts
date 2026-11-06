/**
 * Support operators: columns, arches and beams standing on them, raw members and plates, and
 * solid boxes and bands.
 */
import { z } from "zod";
import type { Element, PlateElement } from "../../fem/types";
import { rectangleProfile } from "../../fem/profiles";
import { type Vec3, add, sub, scale, dot, cross, normalize, len, WORLD_Z } from "../../fem/vec";
import { at } from "../../fem/plan";
import { type BuildContext, BuildError, type PlacedColumn } from "../context";
import { Color, CutSpec, Length, Num, PointSpec, ProfileRef, Vec3Spec } from "../document";
import { defineOperator } from "../operator";
import { Height, selectedSides } from "./glazing";

/** Straight segment length of arcs. */
const ARC_SEGMENT = 20;

const lifted = (q: Vec3, z: number): Vec3 => [q[0], q[1], z];
const halfDepth = (outline: readonly (readonly [number, number])[]) => Math.max(...outline.map(([, z]) => Math.abs(z)));

/**
 * Where columns stand:
 *   { plan, corners?, inset? }            at the corners of an outline, moved in along the bisectors
 *   { plan, sides?, spacing | bays, inset?, includeCorners? }
 *                                         along the sides, every ~spacing (or `bays` per side), corners included
 *   { points: [...] }                     at explicit points
 */
const Stations = z.union([
  z.object({ plan: z.string(), corners: z.array(Num.int()).optional(), inset: Length.optional() }).strict(),
  z.object({
    plan: z.string(), sides: z.array(Num.int()).optional(), spacing: Length.optional(), bays: Num.int().min(1).optional(),
    inset: Length.optional(), includeCorners: z.boolean().optional(),
  }).strict(),
  z.object({ points: z.array(PointSpec).min(1) }).strict(),
]);

interface Station {
  readonly at: Vec3;
  readonly inward?: Vec3;
}

function stations(ctx: BuildContext, spec: z.infer<typeof Stations>, path: string): Station[] {
  if ("points" in spec) return spec.points.map((q, i) => ({ at: ctx.point(q, `${path}.points[${i}]`) }));
  const plan = ctx.plan(spec.plan, `${path}.plan`);
  const inset = ctx.optionalLength(spec.inset, `${path}.inset`) ?? 0;
  const n = plan.sides.length;
  // Corner: on the bisector, moved in so the column keeps `inset` from both sides.
  const corner = (k: number): Station => {
    const s = plan.sides[k];
    const before = plan.sides[(k + n - 1) % n];
    const inward = normalize(add(before.inward, s.inward));
    const half = Math.acos(Math.max(-1, Math.min(1, dot(before.inward, s.inward)))) / 2;
    return { at: add(s.a, scale(inward, inset / Math.cos(half))), inward };
  };
  if (!("spacing" in spec) && !("bays" in spec) && !("includeCorners" in spec)) {
    const which = (spec as { corners?: number[] }).corners ?? plan.sides.map((_, k) => k);
    return which.map((k) => corner(((k % n) + n) % n));
  }
  if (!("spacing" in spec) && !("bays" in spec)) throw new BuildError("give spacing or bays", path);
  const spacing = ctx.optionalLength(spec.spacing, `${path}.spacing`);
  const out: Station[] = [];
  for (const { side: s, k } of selectedSides(plan.sides, spec.sides)) {
    const bays = spec.bays ?? (spacing ? Math.max(1, Math.round(s.length / spacing)) : 1);
    if (spec.includeCorners !== false) out.push(corner(k));
    for (let i = 1; i < bays; i++) {
      out.push({ at: add(add(s.a, scale(s.along, (s.length * i) / bays)), scale(s.inward, inset)), inward: s.inward });
    }
    if (spec.includeCorners !== false && spec.sides && !spec.sides.includes((k + 1) % n)) out.push(corner((k + 1) % n));
  }
  return out;
}

export const columns = defineOperator({
  name: "columns",
  description: "Columns at the corners of a plan outline, along its sides, or at points, from a foot level up to a top level or a roof. Leaves a columns result that arches and beams span between.",
  schema: z.object({
    op: z.literal("columns"),
    name: z.string(),
    at: Stations,
    profile: ProfileRef,
    foot: Length.optional(),
    top: Height,
    /** Turn the profile's local z into the building (default: world X / Y as for any vertical member). */
    orient: z.boolean().optional(),
    color: Color.optional(),
  }).strict(),
  run(ctx, p, path) {
    const profile = ctx.profile(p.profile, `${path}.profile`);
    const foot = ctx.optionalLength(p.foot, `${path}.foot`) ?? 0;
    const topAt = ctx.height(p.top, `${path}.top`);
    const color = p.color ?? ctx.color;
    const placed = stations(ctx, p.at, `${path}.at`).map((st, i): PlacedColumn => {
      const base = lifted(st.at, foot);
      const top = topAt(base);
      if (top <= foot) throw new BuildError(`column ${i}: top ${top} is not above foot ${foot}`, path);
      const el = ctx.addElement({
        id: `${p.name}_${i}`, kind: "straight", start: base, end: lifted(base, top), profile,
        ...(p.orient && st.inward ? { up: st.inward } : {}), ...(color ? { color } : {}),
      });
      return { id: el.id, at: base, top, inward: st.inward, profile };
    });
    ctx.put(p.name, { kind: "columns", columns: placed }, path);
  },
});

/** Pairs of consecutive columns of a result, around in a ring when `closed`. */
function spans(ctx: BuildContext, name: string, closed: boolean | undefined, path: string): [PlacedColumn, PlacedColumn][] {
  const all = ctx.get(name, "columns", path).columns;
  if (all.length < 2) throw new BuildError(`"${name}" has fewer than two columns`, path);
  const pairs = all.slice(1).map((c, i): [PlacedColumn, PlacedColumn] => [all[i], c]);
  if (closed !== false && all.length > 2) pairs.push([all[all.length - 1], all[0]]);
  return pairs;
}

export const arches = defineOperator({
  name: "arches",
  description: "Arches between each two consecutive columns of a columns result (around in a ring unless open): semicircular, or segmental with a rise, springing at a level.",
  schema: z.object({
    op: z.literal("arches"),
    name: z.string(),
    between: z.string(),
    profile: ProfileRef,
    /** Springing level; "top" springs from each column's top less the arch's own height. */
    spring: Length,
    /** Rise of a segmental arch (default: a semicircle). */
    rise: Length.optional(),
    /** The ring of columns is open: no arch from the last back to the first. */
    open: z.boolean().optional(),
    /** Horizontal offset of the arch plane from the column axes, along the columns' inward direction. */
    inward: Length.optional(),
    segment: Length.optional(),
    color: Color.optional(),
  }).strict(),
  run(ctx, p, path) {
    const profile = ctx.profile(p.profile, `${path}.profile`);
    const spring = ctx.length(p.spring, `${path}.spring`);
    const rise = ctx.optionalLength(p.rise, `${path}.rise`);
    const inward = ctx.optionalLength(p.inward, `${path}.inward`) ?? 0;
    const segment = ctx.optionalLength(p.segment, `${path}.segment`) ?? ARC_SEGMENT;
    const color = p.color ?? ctx.color;
    const ids = spans(ctx, p.between, !p.open, `${path}.between`).map(([a, b], i) => {
      const move = (c: PlacedColumn) => (c.inward ? add(c.at, scale(c.inward, inward)) : c.at);
      const start = lifted(move(a), spring);
      const end = lifted(move(b), spring);
      const chord = sub(end, start);
      let startTangent: Vec3 = WORLD_Z;
      if (rise !== undefined) {
        // Segmental: the tangent at the springing makes the arc through the crown at `rise`.
        const half = len(chord) / 2;
        const phi = 2 * Math.atan2(rise, half);
        const along = normalize(chord);
        startTangent = add(scale(along, Math.cos(phi)), scale(WORLD_Z, Math.sin(phi)));
      }
      const el = ctx.addElement({
        id: `${p.name}_${i}`, kind: "arc", start, end, startTangent, segmentLength: segment, profile, ...(color ? { color } : {}),
      });
      return el.id;
    });
    ctx.put(p.name, { kind: "members", ids }, path);
  },
});

export const beams = defineOperator({
  name: "beams",
  description: "Beams between each two consecutive columns of a columns result (around in a ring unless open) at a level, or following a roof as a polyline just under its surface.",
  schema: z.object({
    op: z.literal("beams"),
    name: z.string(),
    between: z.string(),
    profile: ProfileRef,
    /** Axis level, or a roof to follow with an offset (negative: below it). */
    level: Height,
    open: z.boolean().optional(),
    inward: Length.optional(),
    /** Longest straight piece when following a roof (default 25). */
    segment: Length.optional(),
    color: Color.optional(),
  }).strict(),
  run(ctx, p, path) {
    const profile = ctx.profile(p.profile, `${path}.profile`);
    const levelAt = ctx.height(p.level, `${path}.level`);
    const follows = typeof p.level === "object";
    const inward = ctx.optionalLength(p.inward, `${path}.inward`) ?? 0;
    const segment = ctx.optionalLength(p.segment, `${path}.segment`) ?? 25;
    const color = p.color ?? ctx.color;
    const ids = spans(ctx, p.between, !p.open, `${path}.between`).map(([a, b], i) => {
      const move = (c: PlacedColumn) => (c.inward ? add(c.at, scale(c.inward, inward)) : c.at);
      const [from, to] = [move(a), move(b)];
      const id = `${p.name}_${i}`;
      const common = { id, profile, ...(color ? { color } : {}) };
      if (!follows) {
        const z = levelAt(from);
        return ctx.addElement({ ...common, kind: "straight", start: lifted(from, z), end: lifted(to, z) }).id;
      }
      const span = len(sub(to, from));
      const pieces = Math.max(1, Math.ceil(span / segment));
      const nodes = Array.from({ length: pieces + 1 }, (_, j) => {
        const q = add(from, scale(sub(to, from), j / pieces));
        return lifted(q, levelAt(q));
      });
      return ctx.addElement({ ...common, kind: "polyline", nodes, start: nodes[0], end: nodes[pieces], up: [0, 0, -1] }).id;
    });
    ctx.put(p.name, { kind: "members", ids }, path);
  },
});

export const member = defineOperator({
  name: "member",
  description: "One straight, arc or polyline member with a profile, placed by its points.",
  schema: z.object({
    op: z.literal("member"),
    name: z.string(),
    profile: ProfileRef,
    start: PointSpec,
    end: PointSpec,
    /** Makes an arc: the direction the member leaves `start` in. */
    startTangent: Vec3Spec.optional(),
    /** Makes a polyline through these points (start and end included). */
    nodes: z.array(PointSpec).optional(),
    segment: Length.optional(),
    up: Vec3Spec.optional(),
    endCut: Vec3Spec.optional(),
    color: Color.optional(),
  }).strict(),
  run(ctx, p, path) {
    const profile = ctx.profile(p.profile, `${path}.profile`);
    const color = p.color ?? ctx.color;
    const common = {
      id: p.name, profile, start: ctx.point(p.start, `${path}.start`), end: ctx.point(p.end, `${path}.end`),
      up: p.up && ctx.vec3(p.up, `${path}.up`), endCut: p.endCut && ctx.vec3(p.endCut, `${path}.endCut`), ...(color ? { color } : {}),
    };
    let el: Element;
    if (p.nodes) {
      el = { ...common, kind: "polyline", nodes: p.nodes.map((q, i) => ctx.point(q, `${path}.nodes[${i}]`)) };
    } else if (p.startTangent) {
      el = {
        ...common, kind: "arc", startTangent: ctx.vec3(p.startTangent, `${path}.startTangent`),
        segmentLength: ctx.optionalLength(p.segment, `${path}.segment`) ?? ARC_SEGMENT,
      };
    } else {
      el = { ...common, kind: "straight", segmentLength: ctx.optionalLength(p.segment, `${path}.segment`) };
    }
    ctx.put(p.name, { kind: "members", ids: [ctx.addElement(el).id] }, path);
  },
});

export const plate = defineOperator({
  name: "plate",
  description: "One flat plate: a convex polygon of corners with a thickness, e.g. a floor slab, a lake or a lantern face.",
  schema: z.object({
    op: z.literal("plate"),
    name: z.string(),
    corners: z.array(PointSpec).min(3),
    /** Or: all the corners of a plan outline at a level. */
    thickness: Length,
    color: Color.optional(),
    alpha: Num.optional(),
    reflection: Num.optional(),
    bevel: z.object({ width: Length, depth: Length }).strict().optional(),
  }).strict(),
  run(ctx, p, path) {
    ctx.addElement(plateOf(ctx, p.name, p.corners.map((q, i) => ctx.point(q, `${path}.corners[${i}]`)), p, path));
  },
});

function plateOf(
  ctx: BuildContext, id: string, corners: readonly Vec3[],
  p: { thickness: z.infer<typeof Length>; color?: Vec3; alpha?: number; reflection?: number; bevel?: { width: z.infer<typeof Length>; depth: z.infer<typeof Length> } },
  path: string,
): PlateElement {
  return {
    id, kind: "plate", corners, thickness: ctx.length(p.thickness, `${path}.thickness`),
    color: p.color ?? ctx.color, alpha: p.alpha ?? 1, reflection: p.reflection,
    bevel: p.bevel && { width: ctx.length(p.bevel.width, `${path}.bevel.width`), depth: ctx.length(p.bevel.depth, `${path}.bevel.depth`) },
  };
}

export const slab = defineOperator({
  name: "slab",
  description: "A plate covering a convex plan outline at a level, e.g. a floor or a pool.",
  schema: z.object({
    op: z.literal("slab"),
    name: z.string(),
    plan: z.string(),
    /** Level of the top face. */
    level: Length,
    thickness: Length,
    color: Color.optional(),
    alpha: Num.optional(),
    reflection: Num.optional(),
    bevel: z.object({ width: Length, depth: Length }).strict().optional(),
  }).strict(),
  run(ctx, p, path) {
    const plan = ctx.plan(p.plan, `${path}.plan`);
    const z = ctx.length(p.level, `${path}.level`) - ctx.length(p.thickness, `${path}.thickness`) / 2;
    ctx.addElement(plateOf(ctx, p.name, plan.polygon.map((q) => at(q, z)), p, path));
  },
});

export const box = defineOperator({
  name: "box",
  description: "A solid block aligned with the axes, between x, y and z ranges.",
  schema: z.object({
    op: z.literal("box"),
    name: z.string(),
    x: z.tuple([Length, Length]),
    y: z.tuple([Length, Length]),
    z: z.tuple([Length, Length]),
    color: Color.optional(),
  }).strict(),
  run(ctx, p, path) {
    const [x0, x1] = p.x.map((v, i) => ctx.length(v, `${path}.x[${i}]`));
    const [y0, y1] = p.y.map((v, i) => ctx.length(v, `${path}.y[${i}]`));
    const [z0, z1] = p.z.map((v, i) => ctx.length(v, `${path}.z[${i}]`));
    const color = p.color ?? ctx.color;
    ctx.addElement({
      id: p.name, kind: "straight", profile: rectangleProfile(y1 - y0, z1 - z0),
      start: [x0, (y0 + y1) / 2, (z0 + z1) / 2], end: [x1, (y0 + y1) / 2, (z0 + z1) / 2], ...(color ? { color } : {}),
    });
  },
});

export const band = defineOperator({
  name: "band",
  description: "A solid band along the sides of a plan outline between two levels, centred on the outline (or moved in), its pieces mitred at the corners: a plinth, a frieze, a cornice.",
  schema: z.object({
    op: z.literal("band"),
    name: z.string(),
    plan: z.string(),
    sides: z.array(Num.int()).optional(),
    thickness: Length,
    z: z.tuple([Length, Length]),
    /** Move the band's centre line into the plan. */
    inset: Length.optional(),
    color: Color.optional(),
  }).strict(),
  run(ctx, p, path) {
    const plan = ctx.plan(p.plan, `${path}.plan`);
    const thickness = ctx.length(p.thickness, `${path}.thickness`);
    const [z0, z1] = p.z.map((v, i) => ctx.length(v, `${path}.z[${i}]`));
    const inset = ctx.optionalLength(p.inset, `${path}.inset`) ?? 0;
    const color = p.color ?? ctx.color;
    const sides = plan.sides;
    const n = sides.length;
    const selected = selectedSides(sides, p.sides);
    for (const { side: s, k } of selected) {
      const miter = (other: typeof s) => (thickness / 2) * Math.tan(Math.acos(Math.min(1, Math.abs(dot(other.along, s.along)))) / 2);
      const before = sides[(k + n - 1) % n];
      const after = sides[(k + 1) % n];
      const run = (q: Vec3, by: number) => add(add(q, scale(s.along, by)), scale(s.inward, inset));
      ctx.addElement({
        id: `${p.name}${k}`, kind: "straight", profile: rectangleProfile(thickness, z1 - z0), ...(color ? { color } : {}),
        start: lifted(run(s.a, -miter(before)), (z0 + z1) / 2), end: lifted(run(s.b, miter(after)), (z0 + z1) / 2),
      });
    }
  },
});

export const outline = defineOperator({
  name: "outline",
  description: "Derives a new plan outline from the columns of a result, from points, or by cutting an outline with planes, for the operations after it.",
  schema: z.object({
    op: z.literal("outline"),
    name: z.string(),
    columns: z.string().optional(),
    points: z.array(PointSpec).optional(),
    /** Cuts applied to the `plan` outline: the part kept is where all normals point. */
    plan: z.string().optional(),
    cuts: z.array(CutSpec).optional(),
  }).strict(),
  run(ctx, p, path) {
    let polygon: Vec3[];
    if (p.columns) polygon = ctx.get(p.columns, "columns", `${path}.columns`).columns.map((c) => c.at);
    else if (p.points) polygon = p.points.map((q, i) => ctx.point(q, `${path}.points[${i}]`));
    else if (p.plan) polygon = ctx.plan(p.plan, `${path}.plan`).polygon.map((q) => at(q));
    else throw new BuildError("give columns, points or plan", path);
    for (const c of ctx.cuts(p.cuts, `${path}.cuts`)) polygon = clip(polygon, c.point, c.normal);
    if (polygon.length < 3) throw new BuildError("nothing is left of the outline", path);
    ctx.addPlan(p.name, polygon.map((q) => [q[0], q[1]]), path);
  },
});

/** Convex polygon clipped by a plane, keeping the side the normal points to. */
function clip(polygon: readonly Vec3[], point: Vec3, normal: Vec3): Vec3[] {
  const side = (q: Vec3) => dot(sub(q, point), normal);
  const out: Vec3[] = [];
  polygon.forEach((q, i) => {
    const r = polygon[(i + 1) % polygon.length];
    const [dq, dr] = [side(q), side(r)];
    if (dq >= -1e-9) out.push(q);
    if ((dq < -1e-9 && dr > 1e-9) || (dq > 1e-9 && dr < -1e-9)) out.push(add(q, scale(sub(r, q), dq / (dq - dr))));
  });
  return out;
}

export const supportOperators = [columns, arches, beams, member, plate, slab, box, band, outline];

// Keep helpers that later operators may share.
export { lifted, halfDepth, cross };
