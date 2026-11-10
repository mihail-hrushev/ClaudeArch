/**
 * Support operators: columns, arches and beams standing on them, raw members and plates, and
 * solid boxes and bands.
 */
import { z } from "zod";
import type { Element, PlateElement } from "../../fem/types";
import { type Profile, rectangleProfile } from "../../fem/profiles";
import { type Vec3, add, sub, scale, dot, cross, normalize, len, WORLD_Z } from "../../fem/vec";
import { type Side, at } from "../../fem/plan";
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
 *                                         along the sides, every ~spacing (or `bays` per side, or on
 *                                         the bay lines of a `bays` result), corners included
 *   { plan, sides?, opposite, inset?, includeCorners? }
 *                                         along the sides, opposite the columns of another result (or the
 *                                         convex corners of another outline): each of those projects onto its
 *                                         nearest side, except the one nearest to each corner, which the
 *                                         corner column stands for
 *   { points: [...] }                     at explicit points
 */
const Stations = z.union([
  z.object({ plan: z.string(), corners: z.array(Num.int()).optional(), inset: Length.optional() }).strict(),
  z.object({
    plan: z.string(), sides: z.array(Num.int()).optional(), spacing: Length.optional(), bays: z.union([Num.int().min(1), z.string()]).optional(),
    inset: Length.optional(), includeCorners: z.boolean().optional(),
  }).strict(),
  z.object({
    plan: z.string(), sides: z.array(Num.int()).optional(), opposite: z.string(),
    inset: Length.optional(), includeCorners: z.boolean().optional(),
  }).strict(),
  z.object({ points: z.array(PointSpec).min(1) }).strict(),
]);

interface Station {
  readonly at: Vec3;
  readonly inward?: Vec3;
  /** The corner of the outline it stands at, or the side it stands along. */
  readonly corner?: number;
  readonly side?: number;
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
    return { at: add(s.a, scale(inward, inset / Math.cos(half))), inward, corner: k };
  };
  if (!("spacing" in spec) && !("bays" in spec) && !("opposite" in spec) && !("includeCorners" in spec)) {
    const which = (spec as { corners?: number[] }).corners ?? plan.sides.map((_, k) => k);
    return which.map((k) => corner(((k % n) + n) % n));
  }
  /** Distances along each side at which a column stands, between its corners. */
  let marks: (s: Side, k: number) => number[];
  if ("opposite" in spec) {
    // The columns of a result, or the convex corners of an outline (re-entrant ones face away from the sides).
    const convexCorners = (sides: readonly Side[]) =>
      sides.filter((s, k) => cross(sides[(k + sides.length - 1) % sides.length].along, s.along)[2] > 1e-9).map((s) => s.a);
    const others: Vec3[] = ctx.results.get(spec.opposite)?.kind === "columns"
      ? ctx.get(spec.opposite, "columns", `${path}.opposite`).columns.map((c) => c.at)
      : convexCorners(ctx.plan(spec.opposite, `${path}.opposite`).sides);
    const distance = (a: Vec3, b: Vec3) => len(sub(a, b));
    const nearestTo = (q: Vec3) => others.reduce((best, c) => (distance(c, q) < distance(best, q) ? c : best));
    const atCorners = plan.sides.map((s) => nearestTo(s.a));
    const landings = plan.sides.map((): number[] => []);
    for (const c of others.filter((c) => !atCorners.includes(c))) {
      const away = plan.sides.map((s) => dot(sub(c, s.a), s.inward));
      const k = away.indexOf(Math.min(...away));
      landings[k].push(dot(sub(c, plan.sides[k].a), plan.sides[k].along));
    }
    marks = (_s, k) => landings[k].sort((a, b) => a - b);
  } else {
    if (!("spacing" in spec) && !("bays" in spec)) throw new BuildError("give spacing or bays", path);
    const spacing = ctx.optionalLength(spec.spacing, `${path}.spacing`);
    marks = (s, k) => {
      if (typeof spec.bays === "string") return ctx.bayStations(spec.bays, plan, k, `${path}.bays`);
      const bays = spec.bays ?? (spacing ? Math.max(1, Math.round(s.length / spacing)) : 1);
      return Array.from({ length: bays - 1 }, (_, i) => (s.length * (i + 1)) / bays);
    };
  }
  const out: Station[] = [];
  for (const { side: s, k } of selectedSides(plan.sides, spec.sides)) {
    if (spec.includeCorners !== false) out.push(corner(k));
    for (const u of marks(s, k)) out.push({ at: add(add(s.a, scale(s.along, u)), scale(s.inward, inset)), inward: s.inward, side: k });
    if (spec.includeCorners !== false && spec.sides && !spec.sides.includes((k + 1) % n)) out.push(corner((k + 1) % n));
  }
  return out;
}

/** A tier of a classical column's base or capital: its profile and height. */
const ColumnTier = z.object({ profile: ProfileRef, height: Length }).strict();
/** A base or a capital: one tier, or a stack of tiers listed from the bottom up (plinth, torus, ...). */
const ColumnEnd = z.union([ColumnTier, z.array(ColumnTier).min(1)]);

export const columns = defineOperator({
  name: "columns",
  description: "Columns at the corners of a plan outline, along its sides, or at points, from a foot level up to a top level or a roof, with an optional base and capital. Leaves a columns result that arches and beams span between.",
  schema: z.object({
    op: z.literal("columns"),
    name: z.string(),
    at: Stations,
    profile: ProfileRef,
    foot: Length.optional(),
    top: Height,
    /** Columns at these corners, or on the bay lines of these sides, rise to another top instead. */
    tops: z.array(z.object({ corners: z.array(Num.int()).optional(), sides: z.array(Num.int()).optional(), top: Height }).strict()).optional(),
    /** A wider base under the shaft, from the foot: one tier or a stack of tiers from the bottom up. */
    base: ColumnEnd.optional(),
    /** A capital on the shaft, up to the top: one tier or a stack from the bottom up; its profiles' local y runs along the wall, local z into the building. */
    capital: ColumnEnd.optional(),
    /** Turn the profile's local z into the building (default: world X / Y as for any vertical member). */
    orient: z.boolean().optional(),
    /** Direction of the profiles' local z for every column (overrides `orient`). */
    up: Vec3Spec.optional(),
    color: Color.optional(),
  }).strict(),
  run(ctx, p, path) {
    const profile = ctx.profile(p.profile, `${path}.profile`);
    const foot = ctx.optionalLength(p.foot, `${path}.foot`) ?? 0;
    const topAt = ctx.height(p.top, `${path}.top`);
    const tops = (p.tops ?? []).map((t, i) => ({ ...t, at: ctx.height(t.top, `${path}.tops[${i}].top`) }));
    const end = (spec: z.infer<typeof ColumnEnd> | undefined, key: string) => {
      if (!spec) return undefined;
      const list = Array.isArray(spec) ? spec : [spec];
      const at = (i: number) => (Array.isArray(spec) ? `${path}.${key}[${i}]` : `${path}.${key}`);
      const tiers = list.map((t, i) => ({ profile: ctx.profile(t.profile, `${at(i)}.profile`), height: ctx.length(t.height, `${at(i)}.height`) }));
      return { tiers, height: tiers.reduce((h, t) => h + t.height, 0), single: !Array.isArray(spec) };
    };
    const base = end(p.base, "base");
    const capital = end(p.capital, "capital");
    const up = p.up && ctx.vec3(p.up, `${path}.up`);
    const color = p.color ?? ctx.color;
    const placed = stations(ctx, p.at, `${path}.at`).map((st, i): PlacedColumn => {
      const q = lifted(st.at, foot);
      const override = tops.find((t) =>
        (st.corner !== undefined && t.corners?.includes(st.corner)) || (st.side !== undefined && t.sides?.includes(st.side)));
      const top = (override?.at ?? topAt)(q);
      if (top <= foot) throw new BuildError(`column ${i}: top ${top} is not above foot ${foot}`, path);
      const orient = up ?? (p.orient && st.inward ? st.inward : undefined);
      const rest = { ...(orient ? { up: orient } : {}), ...(color ? { color } : {}) };
      const seat = base ? foot + base.height : foot;
      const neck = capital ? top - capital.height : top;
      if (neck <= seat) throw new BuildError(`column ${i}: the base and the capital leave no shaft between ${seat} and ${neck}`, path);
      const kind = "straight" as const;
      // The tiers of an end, stacked from `from`; a single tier keeps the plain id.
      const stack = (e: NonNullable<ReturnType<typeof end>>, from: number, key: string) => {
        let z0 = from;
        e.tiers.forEach((t, j) => {
          const id = e.single ? `${p.name}_${i}_${key}` : `${p.name}_${i}_${key}${j}`;
          ctx.addElement({ id, kind, start: lifted(q, z0), end: lifted(q, z0 + t.height), profile: t.profile, ...rest });
          z0 += t.height;
        });
      };
      if (base) stack(base, foot, "base");
      const el = ctx.addElement({ id: `${p.name}_${i}`, kind, start: lifted(q, seat), end: lifted(q, neck), profile, ...rest });
      if (capital) stack(capital, neck, "capital");
      return { id: el.id, at: q, top, inward: st.inward, profile };
    });
    ctx.put(p.name, { kind: "columns", columns: placed }, path);
  },
});

/**
 * Pairs of consecutive columns of a result, around in a ring when `closed`; or, with `to`, each
 * column of the result paired with the nearest column of that other result.
 */
function spans(ctx: BuildContext, name: string, closed: boolean | undefined, path: string, to?: string): [PlacedColumn, PlacedColumn][] {
  const all = ctx.get(name, "columns", path).columns;
  if (to !== undefined) {
    const others = ctx.get(to, "columns", `${path} to`).columns;
    const distance = (a: PlacedColumn, b: PlacedColumn) => len(sub(a.at, b.at));
    return all.map((c) => [c, others.reduce((best, o) => (distance(o, c) < distance(best, c) ? o : best))]);
  }
  if (all.length < 2) throw new BuildError(`"${name}" has fewer than two columns`, path);
  const pairs = all.slice(1).map((c, i): [PlacedColumn, PlacedColumn] => [all[i], c]);
  if (closed !== false && all.length > 2) pairs.push([all[all.length - 1], all[0]]);
  return pairs;
}

/** Points along an arch where it is tested against what it stays under. */
const ARCH_SAMPLES = 64;

/** Half extent of a profile in any direction across it. */
const reach = (outline: readonly (readonly [number, number])[]) => Math.max(...outline.map(([y, z]) => Math.max(Math.abs(y), Math.abs(z))));

/**
 * A slender column of the arch section standing against a main column, carrying the arches that
 * end on it (see `shafts` of `arches`). Shafts are shared across operations: every arch ending at
 * the same spot of the same column raises the one shaft there to its own springing.
 */
interface Shaft {
  readonly at: Vec3;
  readonly foot: number;
  top: number;
  elementId?: string;
}
const SHAFTS = new WeakMap<BuildContext, Map<string, Shaft>>();

function standShaft(ctx: BuildContext, column: PlacedColumn, at: Vec3, top: number, profile: Profile, color: Vec3 | undefined): void {
  let registry = SHAFTS.get(ctx);
  if (!registry) SHAFTS.set(ctx, (registry = new Map()));
  const key = `${column.id}|${Math.round(at[0])},${Math.round(at[1])}`;
  const shaft = registry.get(key) ?? { at, foot: column.at[2], top: -Infinity };
  registry.set(key, shaft);
  if (top <= shaft.top || top <= shaft.foot) return;
  shaft.top = top;
  const element: Element = {
    id: shaft.elementId ?? `${column.id}_shaft`, kind: "straight", start: lifted(at, shaft.foot), end: lifted(at, top), profile, ...(color ? { color } : {}),
  };
  if (shaft.elementId) {
    // Raised by a higher arch: the one shaft grows.
    const i = ctx.elements.findIndex((el) => el.id === shaft.elementId);
    ctx.elements[i] = element;
  } else {
    shaft.elementId = ctx.addElement(element).id;
  }
}

export const arches = defineOperator({
  name: "arches",
  description: "Arches between each two consecutive columns of a columns result (around in a ring unless open), or from each column to the nearest of another result: semicircular, or segmental with a rise, springing at a level, with their crowns at one, or raised until they just touch what they stand `under`; " +
    "with both `spring` and `under`, half ellipses springing at that level, as tall as just touches.",
  schema: z.object({
    op: z.literal("arches"),
    name: z.string(),
    between: z.string(),
    /** Pair each column of `between` with the nearest column of this result instead of the next one. */
    to: z.string().optional(),
    profile: ProfileRef,
    /** Springing level of the arch axis; with `under` as well, the arches are half ellipses reaching up to it. */
    spring: Length.optional(),
    /** Or the level of the crown of the arch axis: each arch springs its own rise (half its span when semicircular) below it. */
    crown: Length.optional(),
    /**
     * Or: the arch is raised until its back just touches this, anywhere along it: a level, a roof
     * with an offset, or `{ "columns": offset }`, the line between the two column tops moved by `offset`.
     */
    under: z.union([Height, z.object({ columns: Length }).strict()]).optional(),
    /** Rise of a segmental arch (default: a semicircle). */
    rise: Length.optional(),
    /** The ring of columns is open: no arch from the last back to the first. */
    open: z.boolean().optional(),
    /** Horizontal offset of the arch plane from the column axes, along the columns' inward direction. */
    inward: Length.optional(),
    /**
     * The arches do not land on the columns: each end stops short of its column by the column's half
     * width plus the arch's half section (or, moved `inward`, stays where it is), and a slender shaft
     * of the arch profile stands there, from the column's foot to the springing of the highest arch
     * on it. Arches ending at the same spot of a column, from any operation, share the shaft.
     */
    shafts: z.boolean().optional(),
    segment: Length.optional(),
    color: Color.optional(),
  }).strict(),
  run(ctx, p, path) {
    const profile = ctx.profile(p.profile, `${path}.profile`);
    const given = [p.spring, p.crown, p.under].filter((v) => v !== undefined).length;
    const elliptic = p.spring !== undefined && p.under !== undefined && p.crown === undefined;
    if (given !== 1 && !elliptic) throw new BuildError("give exactly one of spring, crown or under (or spring and under: elliptical)", path);
    if (elliptic && p.rise !== undefined) throw new BuildError("an elliptical arch (spring and under) takes no rise", path);
    const spring = ctx.optionalLength(p.spring, `${path}.spring`);
    const crown = ctx.optionalLength(p.crown, `${path}.crown`);
    const rise = ctx.optionalLength(p.rise, `${path}.rise`);
    const inward = ctx.optionalLength(p.inward, `${path}.inward`) ?? 0;
    const segment = ctx.optionalLength(p.segment, `${path}.segment`) ?? ARC_SEGMENT;
    const color = p.color ?? ctx.color;
    const back = halfDepth(profile.outline);
    const underColumns = p.under !== undefined && typeof p.under === "object" && "columns" in p.under
      ? ctx.length(p.under.columns, `${path}.under.columns`) : undefined;
    const underAt = p.under === undefined || underColumns !== undefined
      ? undefined : ctx.height(p.under as Parameters<typeof ctx.height>[0], `${path}.under`);
    const archHalf = reach(profile.outline);
    const ids = spans(ctx, p.between, !p.open, `${path}.between`, p.to).map(([a, b], i) => {
      const move = (c: PlacedColumn) => (c.inward ? add(c.at, scale(c.inward, inward)) : c.at);
      let [from, to] = [move(a), move(b)];
      if (p.shafts) {
        // Each end stops short of its column (unless already moved off its axis) where its shaft stands.
        const along = normalize([to[0] - from[0], to[1] - from[1], 0]);
        const short = (c: PlacedColumn, q: Vec3, towards: Vec3) => (c.inward && inward !== 0 ? q : add(q, scale(towards, reach(c.profile.outline) + archHalf)));
        [from, to] = [short(a, from, along), short(b, to, scale(along, -1))];
      }
      const chord = sub(to, from);
      const half = len(chord) / 2;
      const limitAt = (j: number) => {
        const q = add(from, scale(chord, j / ARCH_SAMPLES));
        return (underAt ? underAt(q) : a.top + ((b.top - a.top) * j) / ARCH_SAMPLES + underColumns!) - back;
      };
      const shafts = (springing: number) => {
        if (!p.shafts) return;
        standShaft(ctx, a, from, springing, profile, color);
        standShaft(ctx, b, to, springing, profile, color);
      };
      if (elliptic) {
        // Half ellipse over the chord from `spring`, as tall as keeps its back under the limit everywhere.
        const tall = Math.min(...Array.from({ length: ARCH_SAMPLES - 1 }, (_, k) => {
          const j = k + 1;
          const t = (2 * j) / ARCH_SAMPLES - 1;
          return (limitAt(j) - spring!) / Math.sqrt(1 - t * t);
        }));
        if (!(tall > 0)) throw new BuildError(`arch ${i}: springs at ${spring} above what it stands under`, path);
        const pieces = 2 * Math.max(4, Math.ceil((Math.PI * Math.max(half, tall)) / segment / 2));
        const nodes = Array.from({ length: pieces + 1 }, (_, j) => {
          const t = (Math.PI * j) / pieces;
          return lifted(add(from, scale(chord, (1 - Math.cos(t)) / 2)), spring! + tall * Math.sin(t));
        });
        const across = normalize([-chord[1], chord[0], 0]);
        shafts(spring!);
        return ctx.addElement({
          id: `${p.name}_${i}`, kind: "polyline", nodes, start: nodes[0], end: nodes[pieces], up: across, profile, ...(color ? { color } : {}),
        }).id;
      }
      const r = rise ?? half;
      // Circle of the arch over its chord: radius and the centre's depth below the springing.
      const radius = (half * half + r * r) / (2 * r);
      const below = radius - r;
      const level = spring ?? (crown !== undefined ? crown - r : Math.min(...Array.from({ length: ARCH_SAMPLES + 1 }, (_, j) => {
        const x = (2 * half * j) / ARCH_SAMPLES;
        const q = add(from, scale(chord, j / ARCH_SAMPLES));
        const arc = Math.sqrt(Math.max(0, radius * radius - (x - half) ** 2)) - below;
        const limit = underAt ? underAt(q) : a.top + ((b.top - a.top) * j) / ARCH_SAMPLES + underColumns!;
        return limit - back - arc;
      })));
      const start = lifted(from, level);
      const end = lifted(to, level);
      shafts(level);
      let startTangent: Vec3 = WORLD_Z;
      if (rise !== undefined) {
        // Segmental: the tangent at the springing makes the arc through the crown at `rise`.
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
  description: "Beams between each two consecutive columns of a columns result (around in a ring unless open), or from each column to the nearest of another result, at a level or following a roof as a polyline just under its surface.",
  schema: z.object({
    op: z.literal("beams"),
    name: z.string(),
    between: z.string(),
    /** Pair each column of `between` with the nearest column of this result instead of the next one. */
    to: z.string().optional(),
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
    const ids = spans(ctx, p.between, !p.open, `${path}.between`, p.to).map(([a, b], i) => {
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
    /** Makes an arc: the direction the member leaves `start` in, or `{ after: <member> }`: the direction that member arrives at its end in, so the two run on smoothly. */
    startTangent: z.union([Vec3Spec, z.object({ after: z.string() }).strict()]).optional(),
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
        ...common, kind: "arc",
        startTangent: "after" in p.startTangent
          ? endTangent(ctx, p.startTangent.after, `${path}.startTangent.after`)
          : ctx.vec3(p.startTangent, `${path}.startTangent`),
        segmentLength: ctx.optionalLength(p.segment, `${path}.segment`) ?? ARC_SEGMENT,
      };
    } else {
      el = { ...common, kind: "straight", segmentLength: ctx.optionalLength(p.segment, `${path}.segment`) };
    }
    ctx.put(p.name, { kind: "members", ids: [ctx.addElement(el).id] }, path);
  },
});

/** Direction the last member of a members result arrives at its end in. */
function endTangent(ctx: BuildContext, name: string, path: string): Vec3 {
  const ids = ctx.get(name, "members", path).ids;
  const el = ctx.elements.find((e) => e.id === ids[ids.length - 1]);
  if (!el || el.kind === "plate") throw new BuildError(`"${name}" is not a member`, path);
  if (el.kind === "polyline") return normalize(sub(el.nodes[el.nodes.length - 1], el.nodes[el.nodes.length - 2]));
  const chord = normalize(sub(el.end, el.start));
  if (el.kind !== "arc") return chord;
  // An arc arrives at its end mirrored about the chord from how it left its start.
  const t = normalize(el.startTangent);
  return sub(scale(chord, 2 * dot(t, chord)), t);
}

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

export const pyramid = defineOperator({
  name: "pyramid",
  description: "A pyramid of solid plates over a plan outline, from a base level (or a roof the base stands on) up to an apex over the centroid: a lantern roof, a spire.",
  schema: z.object({
    op: z.literal("pyramid"),
    name: z.string(),
    plan: z.string(),
    base: Height,
    /** Level of the apex. */
    apex: Length,
    thickness: Length,
    color: Color.optional(),
    alpha: Num.optional(),
    reflection: Num.optional(),
  }).strict(),
  run(ctx, p, path) {
    const plan = ctx.plan(p.plan, `${path}.plan`);
    const baseAt = ctx.height(p.base, `${path}.base`);
    const apex = at(plan.centroid, ctx.length(p.apex, `${path}.apex`));
    plan.sides.forEach((s, k) => {
      ctx.addElement(plateOf(ctx, `${p.name}${k}`, [lifted(s.a, baseAt(s.a)), lifted(s.b, baseAt(s.b)), apex], p, path));
    });
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
    /** Its own material by name from `materials`, e.g. matte masonry under a document of black ironwork; the fields below override it. */
    material: z.string().optional(),
    color: Color.optional(),
    /** Physically based look (0 … 1); `color` is then linear. */
    metallic: Num.min(0).max(1).optional(),
    roughness: Num.min(0).max(1).optional(),
  }).strict(),
  run(ctx, p, path) {
    const plan = ctx.plan(p.plan, `${path}.plan`);
    const thickness = ctx.length(p.thickness, `${path}.thickness`);
    const [z0, z1] = p.z.map((v, i) => ctx.length(v, `${path}.z[${i}]`));
    const inset = ctx.optionalLength(p.inset, `${path}.inset`) ?? 0;
    const m = p.material ? ctx.material(p.material, `${path}.material`) : {};
    const color = p.color ?? (m.color as Vec3 | undefined) ?? ctx.color;
    const metallic = p.metallic ?? m.metallic;
    const roughness = p.roughness ?? m.roughness;
    const finish = metallic !== undefined || roughness !== undefined ? { metallic: metallic ?? 0, roughness: roughness ?? 1 } : {};
    const sides = plan.sides;
    const n = sides.length;
    const selected = selectedSides(sides, p.sides);
    for (const { side: s, k } of selected) {
      const miter = (other: typeof s) => (thickness / 2) * Math.tan(Math.acos(Math.min(1, Math.abs(dot(other.along, s.along)))) / 2);
      const before = sides[(k + n - 1) % n];
      const after = sides[(k + 1) % n];
      const run = (q: Vec3, by: number) => add(add(q, scale(s.along, by)), scale(s.inward, inset));
      ctx.addElement({
        id: `${p.name}${k}`, kind: "straight", profile: rectangleProfile(thickness, z1 - z0), ...(color ? { color } : {}), ...finish,
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
    /** Every corner moved `share` of the way (default half) towards the nearest column of this result. */
    towards: z.string().optional(),
    share: Num.optional(),
  }).strict(),
  run(ctx, p, path) {
    let polygon: Vec3[];
    if (p.columns) polygon = ctx.get(p.columns, "columns", `${path}.columns`).columns.map((c) => c.at);
    else if (p.points) polygon = p.points.map((q, i) => ctx.point(q, `${path}.points[${i}]`));
    else if (p.plan) polygon = ctx.plan(p.plan, `${path}.plan`).polygon.map((q) => at(q));
    else throw new BuildError("give columns, points or plan", path);
    if (p.towards) {
      const others = ctx.get(p.towards, "columns", `${path}.towards`).columns;
      const share = p.share ?? 0.5;
      polygon = polygon.map((q) => {
        const near = others.reduce((best, c) => (len(sub(c.at, q)) < len(sub(best.at, q)) ? c : best)).at;
        return add(q, scale(sub([near[0], near[1], q[2]], q), share));
      });
    }
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

/** A member's axis by arc length: its length, and point and unit tangent at a distance from its start. */
interface Axis {
  readonly length: number;
  at(s: number): { point: Vec3; tangent: Vec3 };
}

function axisOf(el: Element, path: string): Axis {
  if (el.kind === "plate") throw new BuildError(`"${el.id}" is a plate, not a member`, path);
  const straight = (a: Vec3, b: Vec3): Axis => {
    const length = len(sub(b, a));
    const tangent = normalize(sub(b, a));
    return { length, at: (s) => ({ point: add(a, scale(tangent, s)), tangent }) };
  };
  if (el.kind === "polyline") {
    const pieces = el.nodes.slice(1).map((q, i) => straight(el.nodes[i], q));
    const length = pieces.reduce((sum, q) => sum + q.length, 0);
    return {
      length,
      at: (s) => {
        for (const piece of pieces) {
          if (s <= piece.length || piece === pieces[pieces.length - 1]) return piece.at(s);
          s -= piece.length;
        }
        return pieces[0].at(0);
      },
    };
  }
  if (el.kind !== "arc") return straight(el.start, el.end);
  const chord = sub(el.end, el.start);
  const t = normalize(el.startTangent);
  const bend = sub(chord, scale(t, dot(chord, t)));
  if (len(bend) < 1e-9 * len(chord)) return straight(el.start, el.end);
  const n = normalize(bend);
  const phi = Math.acos(Math.max(-1, Math.min(1, dot(t, normalize(chord)))));
  const radius = len(chord) / (2 * Math.sin(phi));
  return {
    length: 2 * phi * radius,
    at: (s) => {
      const a = s / radius;
      return {
        point: add(el.start, add(scale(t, radius * Math.sin(a)), scale(n, radius * (1 - Math.cos(a))))),
        tangent: add(scale(t, Math.cos(a)), scale(n, Math.sin(a))),
      };
    },
  };
}

export const branches = defineOperator({
  name: "branches",
  description:
    "Smaller arches branching off members (one after another, e.g. the pieces of a long arch) every `step` along them: " +
    "each leaves the axis square to it, on both sides (or one), and curves to its end `reach` out and `drop` down, " +
    "both measured in the members' own frame at that point: out along their side, down against their normal (the profile's up, square to the axis), so the branches turn with the members.",
  schema: z.object({
    op: z.literal("branches"),
    name: z.string(),
    /** Members results the branches leave from, in order along the line they form. */
    from: z.array(z.string()).min(1),
    profile: ProfileRef,
    /** Distance between branches along the members (the first one `step` from the start). */
    step: Length,
    /** How far out each branch ends, square to the members in plan. */
    reach: Length,
    /** How far each branch ends below its start, against the members' normal there (default 0: a straight member). */
    drop: Length.optional(),
    /** "both" (default), "left" or "right", looking along the members. */
    sides: z.enum(["both", "left", "right"]).optional(),
    /** Straight ribs joining each two neighbouring branches on a side, every `step` along them (from the members out) and at their ends. */
    ties: z.object({ step: Length, profile: ProfileRef }).strict().optional(),
    segment: Length.optional(),
    color: Color.optional(),
  }).strict(),
  run(ctx, p, path) {
    const profile = ctx.profile(p.profile, `${path}.profile`);
    const step = ctx.length(p.step, `${path}.step`);
    const reach = ctx.length(p.reach, `${path}.reach`);
    const drop = ctx.optionalLength(p.drop, `${path}.drop`) ?? 0;
    const segmentLength = ctx.optionalLength(p.segment, `${path}.segment`) ?? ARC_SEGMENT;
    if (step <= 0 || reach <= 0) throw new BuildError("step and reach must be > 0", path);
    const axes = p.from.flatMap((name, i) => ctx.get(name, "members", `${path}.from[${i}]`).ids.map((id) => {
      const el = ctx.elements.find((e) => e.id === id);
      if (!el) throw new BuildError(`"${name}" has no element "${id}"`, `${path}.from[${i}]`);
      return axisOf(el, `${path}.from[${i}]`);
    }));
    const total = axes.reduce((sum, a) => sum + a.length, 0);
    const signs = p.sides === "left" ? [1] : p.sides === "right" ? [-1] : [1, -1];
    const color = p.color ?? ctx.color;
    const ids: string[] = [];
    /** The branches on each side, in order along the members. */
    const rows = new Map<number, Element[]>(signs.map((sign) => [sign, []]));
    for (let k = 1; k * step < total - 1e-6 * total; k++) {
      let s = k * step;
      const axis = axes.find((a) => (s <= a.length ? true : ((s -= a.length), false))) ?? axes[axes.length - 1];
      const { point, tangent } = axis.at(s);
      // The members' frame there: their side (square to the axis, level) and their normal (square to both, upwards).
      const level = normalize(cross(WORLD_Z, tangent));
      if (!Number.isFinite(level[0])) throw new BuildError(`the members run vertically ${k * step} along them: no side to branch to`, path);
      const normal = cross(tangent, level);
      for (const sign of signs) {
        const out = scale(level, sign);
        const end = add(add(point, scale(out, reach)), scale(normal, -drop));
        const el: Element = drop === 0
          ? { id: `${p.name}_${k}${sign > 0 ? "L" : "R"}`, kind: "straight", profile, start: point, end, ...(color ? { color } : {}) }
          : { id: `${p.name}_${k}${sign > 0 ? "L" : "R"}`, kind: "arc", profile, start: point, end, startTangent: out, segmentLength, ...(color ? { color } : {}) };
        ids.push(ctx.addElement(el).id);
        rows.get(sign)!.push(el);
      }
    }
    if (p.ties) {
      const tieStep = ctx.length(p.ties.step, `${path}.ties.step`);
      if (tieStep <= 0) throw new BuildError("ties.step must be > 0", `${path}.ties.step`);
      const tieProfile = ctx.profile(p.ties.profile, `${path}.ties.profile`);
      for (const [sign, row] of rows) {
        const branchAxes = row.map((el) => axisOf(el, path));
        for (let i = 0; i + 1 < row.length; i++) {
          const [a, b] = [branchAxes[i], branchAxes[i + 1]];
          const length = Math.min(a.length, b.length);
          const at = [...Array.from({ length: Math.ceil(length / tieStep - 1e-6) }, (_, j) => (j + 1) * tieStep).filter((u) => u < length - 1e-6 * length), length];
          at.forEach((u, j) => {
            // At the ends, the ends themselves (branches of different lengths still close).
            const qa = j === at.length - 1 ? a.at(a.length) : a.at(u);
            const qb = j === at.length - 1 ? b.at(b.length) : b.at(u);
            const along = normalize(sub(qb.point, qa.point));
            // Square to the surface the ties and branches make, upwards.
            const n = normalize(cross(qa.tangent, along));
            const el: Element = {
              id: `${p.name}_tie${sign > 0 ? "L" : "R"}${i + 1}_${j + 1}`, kind: "straight", profile: tieProfile,
              start: qa.point, end: qb.point, up: n[2] < 0 ? scale(n, -1) : n, ...(color ? { color } : {}),
            };
            ids.push(ctx.addElement(el).id);
          });
        }
      }
    }
    ctx.put(p.name, { kind: "members", ids }, path);
  },
});

export const supportOperators = [columns, arches, beams, member, branches, plate, slab, pyramid, box, band, outline];

// Keep helpers that later operators may share.
export { lifted, halfDepth, cross };
