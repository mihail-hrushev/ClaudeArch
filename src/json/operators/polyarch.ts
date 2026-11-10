/**
 * Polyarch operators: a reference line of arcs, each running on smoothly from the one before, and
 * a glass surface swept along it.
 */
import { z } from "zod";
import type { Element } from "../../fem/types";
import { type Vec3, add, sub, scale, dot, cross, normalize, len, WORLD_Z } from "../../fem/vec";
import type { CutPlane } from "../../generators/glassSurface";
import { glassSurface2 } from "../../generators/glassSurface2";
import { BuildError, type PolyArc } from "../context";
import { Color, CutSpec, Length, Num, OpeningSpec, PointSpec, ProfileRef, SurfaceTypeSpec, TileAlign, Vec3Spec } from "../document";
import { defineOperator } from "../operator";
import { surfaceParams } from "./glazing";

/** Straight segment length of drawn arcs. */
const ARC_SEGMENT = 20;

/** Direction an arc arrives at its end in: its start tangent mirrored about the chord. */
export const arrival = (a: PolyArc): Vec3 => {
  const chord = normalize(sub(a.end, a.start));
  const t = normalize(a.startTangent);
  return sub(scale(chord, 2 * dot(t, chord)), t);
};

/** Length of an arc (of its chord when straight). */
export const arcLength = (a: PolyArc): number => {
  const chord = len(sub(a.end, a.start));
  const phi = Math.acos(Math.max(-1, Math.min(1, dot(normalize(a.startTangent), normalize(sub(a.end, a.start))))));
  return phi < 1e-9 ? chord : (phi * chord) / Math.sin(phi);
};

export const polyarch = defineOperator({
  name: "polyarch",
  description:
    "A reference line of circular arcs in one plane: the first leaves `start` along `tangent`, each next one runs on from where the one before " +
    "arrives, so they join smoothly; `through` lists the arc ends. Not built unless given a `profile`; surfaces sweep along it (polyarchSurface).",
  schema: z.object({
    op: z.literal("polyarch"),
    name: z.string(),
    start: PointSpec,
    /** Direction the first arc leaves `start` in. */
    tangent: Vec3Spec,
    /** The end of every arc, in order. */
    through: z.array(PointSpec).min(1),
    /** Draws the line as arc members with this profile (default: not drawn, a reference only). */
    profile: ProfileRef.optional(),
    color: Color.optional(),
  }).strict(),
  run(ctx, p, path) {
    let start = ctx.point(p.start, `${path}.start`);
    let startTangent = normalize(ctx.vec3(p.tangent, `${path}.tangent`));
    const arcs: PolyArc[] = p.through.map((q, i) => {
      const end = ctx.point(q, `${path}.through[${i}]`);
      if (len(sub(end, start)) < 1e-6) throw new BuildError("an arc of no length", `${path}.through[${i}]`);
      const arc = { start, end, startTangent };
      [start, startTangent] = [end, arrival(arc)];
      return arc;
    });
    if (p.profile) {
      const profile = ctx.profile(p.profile, `${path}.profile`);
      const color = p.color ?? ctx.color;
      arcs.forEach((a, i) => {
        const el: Element = { id: `${p.name}_${i}`, kind: "arc", profile, start: a.start, end: a.end, startTangent: a.startTangent, segmentLength: ARC_SEGMENT, ...(color ? { color } : {}) };
        ctx.addElement(el);
      });
    }
    ctx.put(p.name, { kind: "polyarch", arcs }, path);
  },
});

/** Normal of the polyarch's plane, oriented so that tangent × normal points up; every arc must lie in it. */
function planeOf(arcs: readonly PolyArc[], path: string): Vec3 {
  const bent = arcs.find((a) => len(cross(a.startTangent, sub(a.end, a.start))) > 1e-6 * len(sub(a.end, a.start)));
  let w = bent ? normalize(cross(bent.startTangent, sub(bent.end, bent.start))) : normalize(cross(WORLD_Z, arcs[0].startTangent));
  if (!Number.isFinite(w[0])) throw new BuildError("a straight vertical polyarch has no side to sweep to", path);
  if (dot(cross(arcs[0].startTangent, w), WORLD_Z) < 0) w = scale(w, -1);
  for (const a of arcs) {
    if (Math.abs(dot(normalize(a.startTangent), w)) > 1e-6 || Math.abs(dot(sub(a.end, a.start), w)) > 1e-6 * len(sub(a.end, a.start))) {
      throw new BuildError("the polyarch must lie in one plane", path);
    }
  }
  return w;
}

/** Point and unit tangent of a polyarch at arc length s from its start. */
function pointOn(arcs: readonly PolyArc[], s: number): { point: Vec3; tangent: Vec3 } {
  for (const [i, a] of arcs.entries()) {
    const length = arcLength(a);
    if (s > length && i < arcs.length - 1) {
      s -= length;
      continue;
    }
    const chord = sub(a.end, a.start);
    const t = normalize(a.startTangent);
    const bend = sub(chord, scale(t, dot(chord, t)));
    if (len(bend) < 1e-9 * len(chord)) return { point: add(a.start, scale(t, s)), tangent: t };
    const n = normalize(bend);
    const phi = Math.acos(Math.max(-1, Math.min(1, dot(t, normalize(chord)))));
    const radius = len(chord) / (2 * Math.sin(phi));
    const angle = s / radius;
    return {
      point: add(a.start, add(scale(t, radius * Math.sin(angle)), scale(n, radius * (1 - Math.cos(angle))))),
      tangent: add(scale(t, Math.cos(angle)), scale(n, Math.sin(angle))),
    };
  }
  throw new Error("polyarch without arcs");
}

export const polyarchSurface = defineOperator({
  name: "polyarchSurface",
  description:
    "A glass surface swept along a polyarch, on both sides of it (or one): its section leaves the polyarch at `slope` degrees below level " +
    "(0: level, so the two sides arch smoothly over it; more: they meet in a ridge) and curves to its end `reach` out to the side and `drop` " +
    "down, both in the polyarch's frame at that point, so the section turns with it. Main ribs (the section's arcs) stand every `ribStep` " +
    "along the polyarch, measured on it, evenly across the joints of its arcs; tiles, frames and glass come from the surface type, glass on top. Per side one block of " +
    "generators/glassSurface2 (sweep \"revolve\", its base line running through the polyarch's arcs).",
  schema: z.object({
    op: z.literal("polyarchSurface"),
    name: z.string(),
    type: z.union([z.string(), SurfaceTypeSpec]),
    /** The polyarch result to sweep along. */
    along: z.string(),
    /** How far out each section ends, square to the polyarch in its plane's normal. */
    reach: Length,
    /** How far down each section ends, against the polyarch's normal there. */
    drop: Length,
    /** Angle the section leaves the polyarch at, degrees below level (default 0). */
    slope: Num.optional(),
    /** "both" (default), "left" or "right", looking along the polyarch. */
    sides: z.enum(["both", "left", "right"]).optional(),
    /** Distance between main ribs along the polyarch, from its start (default: the type's). */
    ribStep: Length.optional(),
    align: TileAlign.optional(),
    cuts: z.array(CutSpec).optional(),
    openings: z.array(OpeningSpec).optional(),
    /**
     * Pointed tips: where a cut leaves the outer edge of a side (its rib's last point), a further
     * upright cut runs straight from there to the polyarch's end, its rib with this profile.
     */
    tips: z.object({ profile: ProfileRef }).strict().optional(),
    /**
     * Columns under the outer end of every cut's rib (not the tips'), from `foot` (default 0) up to the rib's axis,
     * each in its own frame: the profile's local z points out from the polyarch's start in plan, local y across.
     */
    columns: z.object({ profile: ProfileRef, foot: Length.optional(), color: Color.optional() }).strict().optional(),
    /**
     * Columns under the cuts' ribs where the points at which the polyarch's arcs meet project square onto the cut planes,
     * from `foot` (default 0) up to the rib, framed like `columns`.
     */
    jointColumns: z.object({ profile: ProfileRef, foot: Length.optional(), color: Color.optional() }).strict().optional(),
  }).strict(),
  run(ctx, p, path) {
    const arcs = ctx.get(p.along, "polyarch", `${path}.along`).arcs;
    const w = planeOf(arcs, `${path}.along`);
    const reach = ctx.length(p.reach, `${path}.reach`);
    const drop = ctx.length(p.drop, `${path}.drop`);
    const slope = ((p.slope ?? 0) * Math.PI) / 180;
    const type = ctx.surfaceType(p.type, `${path}.type`);
    const step = p.ribStep === undefined ? type.ribStep : ctx.length(p.ribStep, `${path}.ribStep`);
    if (!(step > 0) || reach <= 0) throw new BuildError("ribStep and reach must be > 0", path);
    const total = arcs.map(arcLength).reduce((sum, l) => sum + l, 0);
    /** Rib stations along the whole polyarch: every step from its start, with no break at the joints. */
    const stations = Array.from({ length: Math.ceil(total / step) }, (_, k) => k * step).filter((s) => s > 0 && s < total - 1e-6 * total);
    const signs = p.sides === "left" ? [1] : p.sides === "right" ? [-1] : [1, -1];
    const cuts = ctx.cuts(p.cuts, `${path}.cuts`);
    const tipProfile = p.tips && ctx.profile(p.tips.profile, `${path}.tips.profile`);
    const start = arcs[0].start;
    const end = arcs[arcs.length - 1].end;

    /** The tip cuts of one side: from where each cut crosses its outer edge last, upright to the polyarch's end. */
    const tipsOf = (sign: number): CutPlane[] => {
      if (!tipProfile) return [];
      const edge = (s: number) => {
        const { point, tangent } = pointOn(arcs, s);
        return add(point, add(scale(w, sign * reach), scale(cross(w, tangent), drop)));
      };
      const samples = 256;
      return cuts.flatMap((c) => {
        const f = (s: number) => dot(sub(edge(s), c.point), c.normal);
        for (let i = samples; i > 0; i--) {
          let [a, b] = [(total * (i - 1)) / samples, (total * i) / samples];
          if (f(a) < 0 === f(b) < 0) continue;
          for (let k = 0; k < 60; k++) {
            const mid = (a + b) / 2;
            if (f(a) < 0 === f(mid) < 0) a = mid;
            else b = mid;
          }
          const from = edge((a + b) / 2);
          let normal = normalize(cross(sub(end, from), WORLD_Z));
          if (!Number.isFinite(normal[0])) return [];
          if (dot(sub(start, from), normal) < 0) normal = scale(normal, -1);
          return [{ point: from, normal, profile: tipProfile }];
        }
        return [];
      });
    };

    const blocks = signs.map((sign) => {
      // The block's local Z points to its side, so it runs forwards on the left and backwards on the right;
      // local Y (towards the structure) then points down from the polyarch, putting the glass on top.
      const forward = sign > 0;
      const points = forward ? [arcs[0].start, ...arcs.map((a) => a.end)] : [arcs[arcs.length - 1].end, ...[...arcs].reverse().map((a) => a.start)];
      const [base, alongX, ...through] = points;
      const leaving = forward ? normalize(arcs[0].startTangent) : scale(arrival(arcs[arcs.length - 1]), -1);
      const x = normalize(sub(alongX, base));
      const zAxis = scale(w, sign);
      const y = cross(zAxis, x);
      const placement = {
        base, alongX,
        alongZ: add(base, add(scale(zAxis, reach), scale(y, drop))),
        tangent: [0, Math.sin(slope), Math.cos(slope)] as Vec3,
        facing: scale(y, -1),
        cuts: tipsOf(sign),
      };
      const name = `${p.name}_${forward ? "L" : "R"}`;
      try {
        const block = glassSurface2(name, {
          ...surfaceParams(ctx, { type: p.type, align: p.align, cuts: p.cuts, openings: p.openings }, path, placement, total),
          ribStations: forward ? stations : stations.map((u) => total - u).reverse(),
          tangentX: [dot(leaving, x), dot(leaving, y)],
          sweep: "revolve",
          through,
        });
        ctx.addInstance(block);
        return block;
      } catch (e) {
        if (e instanceof BuildError) throw e;
        throw new BuildError(`${forward ? "left" : "right"} side: ${(e as Error).message}`, path);
      }
    });
    if (p.columns) {
      const profile = ctx.profile(p.columns.profile, `${path}.columns.profile`);
      const foot = ctx.optionalLength(p.columns.foot, `${path}.columns.foot`) ?? 0;
      const color = p.columns.color ?? ctx.color;
      const plan = (q: Vec3) => Math.hypot(q[0] - start[0], q[1] - start[1]);
      let k = 0;
      blocks.forEach((block, b) => {
        const f = block.frame;
        const world = (q: Vec3): Vec3 => add(f.origin, add(scale(f.x, q[0]), add(scale(f.y, q[1]), scale(f.z, q[2]))));
        // The block's own cuts (its tips) come first, then the shared ones.
        const own = tipsOf(signs[b]).length;
        for (let i = 0; i < cuts.length; i++) {
          const ribs = block.model.elements.filter((e) => e.kind === "polyline" && (e.id === `cut${own + i}` || e.id.startsWith(`cut${own + i}_`)));
          const ends = ribs.flatMap((e) => (e.kind === "polyline" ? [world(e.nodes[0]), world(e.nodes[e.nodes.length - 1])] : []));
          if (!ends.length) continue;
          const top = ends.reduce((best, q) => (plan(q) > plan(best) ? q : best));
          if (top[2] <= foot) continue;
          // Its own frame: local z (the profile's up) points out from the polyarch's start in plan, local y across.
          const radial = normalize([top[0] - start[0], top[1] - start[1], 0]);
          ctx.addElement({
            id: `${p.name}_column${k++}`, kind: "straight", profile, start: [top[0], top[1], foot], end: top,
            ...(Number.isFinite(radial[0]) ? { up: radial } : {}), ...(color ? { color } : {}),
          });
        }
      });
    }
    if (p.jointColumns) {
      const profile = ctx.profile(p.jointColumns.profile, `${path}.jointColumns.profile`);
      const foot = ctx.optionalLength(p.jointColumns.foot, `${path}.jointColumns.foot`) ?? 0;
      const color = p.jointColumns.color ?? ctx.color;
      /** The ribs along cut i, in world coordinates, from every block. */
      const ribsAlong = (i: number) => blocks.flatMap((block, b) => {
        const f = block.frame;
        const world = (q: Vec3): Vec3 => add(f.origin, add(scale(f.x, q[0]), add(scale(f.y, q[1]), scale(f.z, q[2]))));
        const id = `cut${tipsOf(signs[b]).length + i}`;
        return block.model.elements.flatMap((e) => (e.kind === "polyline" && (e.id === id || e.id.startsWith(`${id}_`)) ? [e.nodes.map(world)] : []));
      });
      let k = 0;
      cuts.forEach((c, i) => {
        const n = normalize(c.normal);
        const across = normalize(cross(n, WORLD_Z)); // level, in the cut plane
        if (!Number.isFinite(across[0])) return; // a level cut has no seam to stand under
        const ribs = ribsAlong(i);
        for (const arc of arcs.slice(1)) {
          // The joint, projected square onto the cut plane; the column rises there to the cut's rib.
          const at = sub(arc.start, scale(n, dot(sub(arc.start, c.point), n)));
          const u = dot(sub(at, c.point), across);
          let top: Vec3 | undefined;
          for (const nodes of ribs) {
            for (let m = 0; m + 1 < nodes.length; m++) {
              const [ua, ub] = [dot(sub(nodes[m], c.point), across), dot(sub(nodes[m + 1], c.point), across)];
              if ((u - ua) * (u - ub) > 0 || ua === ub) continue;
              const q = add(nodes[m], scale(sub(nodes[m + 1], nodes[m]), (u - ua) / (ub - ua)));
              if (!top || q[2] > top[2]) top = q;
            }
          }
          if (!top || top[2] <= foot) continue;
          const radial = normalize([top[0] - start[0], top[1] - start[1], 0]);
          ctx.addElement({
            id: `${p.name}_jointColumn${k++}`, kind: "straight", profile, start: [top[0], top[1], foot], end: top,
            ...(Number.isFinite(radial[0]) ? { up: radial } : {}), ...(color ? { color } : {}),
          });
        }
      });
    }
    ctx.put(p.name, { kind: "surfaces", blocks }, path);
  },
});

export const polyarchOperators = [polyarch, polyarchSurface];
