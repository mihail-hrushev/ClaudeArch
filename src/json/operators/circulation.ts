/**
 * Circulation operators: handrails along edges and stairs between levels.
 */
import { z } from "zod";
import { type Vec3, add, sub, scale, dot, cross, len, normalize, WORLD_Z } from "../../fem/vec";
import { type Handrail, handrail } from "../../generators/handrail";
import { stair } from "../../generators/stair";
import { BuildError } from "../context";
import { Length, Num, Padding, PointSpec, ProfileRef } from "../document";
import { defineOperator } from "../operator";
import { selectedSides } from "./glazing";

const lifted = (q: Vec3, z: number): Vec3 => [q[0], q[1], z];
const flat = (q: Vec3): Vec3 => [q[0], q[1], 0];
/** Shorter pieces of a handrail beside a gap are left out. */
const SHORTEST_SECTION = 10;
/** Straight segment length of the arches under a stair. */
const ARC_SEGMENT = 20;

export const handrails = defineOperator({
  name: "handrail",
  description: "Handrail sections of a type along the sides of a plan outline at a level, or from one point to another; `padding` keeps the posts clear of the ends, `gaps` leave the stretches open where stairs arrive.",
  schema: z.object({
    op: z.literal("handrail"),
    name: z.string(),
    type: z.string(),
    along: z.union([
      z.object({ plan: z.string(), sides: z.array(Num.int()).optional(), level: Length, inward: Length.optional() }).strict(),
      z.object({ from: PointSpec, to: PointSpec }).strict(),
    ]),
    padding: Padding.optional(),
    /** Top of the rail beam below the walking surface, e.g. the floor thickness. */
    railBeamDrop: Length.optional(),
    /** Points results (e.g. stairs) whose two points mark a stretch on a section to leave open. */
    gaps: z.array(z.string()).optional(),
  }).strict(),
  run(ctx, p, path) {
    const type = ctx.handrailType(p.type, `${path}.type`);
    const padding = p.padding === undefined ? undefined : ctx.padding(p.padding, `${path}.padding`);
    // Only the ends given: an explicit `undefined` would override the generator's zero defaults.
    const pad = padding === undefined || typeof padding === "number" ? padding : (({ bottom: _b, top: _t, ...ends }) => ends)(padding);
    const railBeamDrop = ctx.optionalLength(p.railBeamDrop, `${path}.railBeamDrop`) ?? type.railBeamDrop;
    const runs: { name: string; base: Vec3; alongX: Vec3 }[] = [];
    if ("plan" in p.along) {
      const plan = ctx.plan(p.along.plan, `${path}.along.plan`);
      const level = ctx.length(p.along.level, `${path}.along.level`);
      const inward = ctx.optionalLength(p.along.inward, `${path}.along.inward`) ?? 0;
      for (const { side: s, k } of selectedSides(plan.sides, p.along.sides)) {
        runs.push({ name: `${p.name}${k}`, base: lifted(add(s.a, scale(s.inward, inward)), level), alongX: lifted(add(s.b, scale(s.inward, inward)), level) });
      }
    } else {
      runs.push({ name: p.name, base: ctx.point(p.along.from, `${path}.along.from`), alongX: ctx.point(p.along.to, `${path}.along.to`) });
    }
    const gaps = (p.gaps ?? []).map((g, i) => {
      const points = ctx.get(g, "points", `${path}.gaps[${i}]`).points;
      if (points.length !== 2) throw new BuildError(`"${g}" does not mark a stretch with two points`, `${path}.gaps[${i}]`);
      return points;
    });
    if (gaps.length === 0) {
      const made: Handrail[] = runs.map((r) => handrail(r.name, { ...type, base: r.base, alongX: r.alongX, padding: pad, railBeamDrop }));
      made.forEach((h) => ctx.addInstance(h));
      return;
    }
    const ends = typeof pad === "number" ? { left: pad, right: pad } : { left: 0, right: 0, ...pad };
    const made: Handrail[] = runs.flatMap((r) => {
      const length = len(sub(r.alongX, r.base));
      const dir = normalize(sub(r.alongX, r.base));
      // Pieces of the section left by the gaps lying on its line.
      let pieces = [{ from: 0, to: length }];
      for (const [a, b] of gaps) {
        const [u0, u1] = [dot(sub(a, r.base), dir), dot(sub(b, r.base), dir)].sort((x, y) => x - y);
        const off = Math.max(...[a, b].map((q) => len(sub(sub(q, r.base), scale(dir, dot(sub(q, r.base), dir))))));
        if (off > 0.1 * (u1 - u0) || u1 <= 0 || u0 >= length) continue;
        pieces = pieces.flatMap((piece) => [{ from: piece.from, to: Math.min(piece.to, u0) }, { from: Math.max(piece.from, u1), to: piece.to }]);
      }
      return pieces.flatMap((piece, n) => {
        const padding = { left: piece.from === 0 ? ends.left : 0, right: piece.to === length ? ends.right : 0 };
        if (piece.to - piece.from - padding.left - padding.right < SHORTEST_SECTION) return [];
        return [handrail(n === 0 ? r.name : `${r.name}_${n}`, {
          ...type, base: add(r.base, scale(dir, piece.from)), alongX: add(r.base, scale(dir, piece.to)), padding, railBeamDrop,
        })];
      });
    });
    made.forEach((h) => ctx.addInstance(h));
  },
});

export const stairs = defineOperator({
  name: "stair",
  description: "A stair of a type along a centre line in plan, from the lower level up by `height` with a platform at mid height, and optionally an arrival platform at the top with a way off it beside a column (see generators/stair). Leaves a points result: the two ends of the stretch where it arrives, for a gap in a handrail.",
  schema: z.object({
    op: z.literal("stair"),
    name: z.string(),
    type: z.string(),
    /** Plan of the centre line, foot first; only x and y count. */
    path: z.array(PointSpec).min(2),
    floor: Length.optional(),
    height: Length,
    /** "bend": the lower flight is shortened so the middle platform is centred on the first bend; the path's first point then only sets its direction. */
    landing: z.literal("bend").optional(),
    arrival: z.object({
      /** Length of the arrival platform along the centre line (default: to the end of the path). */
      length: Length.optional(),
      /** A way off the arrival along its last stretch, bridging `reach` across to the floor beside it. */
      exit: z.object({
        side: z.enum(["left", "right"]),
        /** Length of the open stretch (default: the last leg of the path). */
        length: Length.optional(),
        reach: Length,
        /** The main column at the bend of the arrival, which carries it. */
        column: PointSpec,
        /** Profile of two quarter arches rising from that column to carry the arrival's inner side. */
        arch: ProfileRef.optional(),
      }).strict().optional(),
    }).strict().optional(),
  }).strict(),
  run(ctx, p, path) {
    const type = ctx.stairType(p.type, `${path}.type`);
    const height = ctx.length(p.height, `${path}.height`);
    const risers = height / type.riser;
    if (Math.abs(risers - Math.round(risers)) > 1e-6 || Math.round(risers) % 2 !== 0) {
      throw new BuildError(`height ${height} is not an even number of risers of ${type.riser}`, path);
    }
    const flightRun = (Math.round(risers) / 2 - 1) * type.tread;
    let nodes = p.path.map((q, i) => flat(ctx.point(q, `${path}.path[${i}]`)));
    if (p.landing === "bend") {
      if (nodes.length < 3) throw new BuildError("a landing at the bend needs a path that bends", `${path}.landing`);
      nodes = [add(nodes[1], scale(normalize(sub(nodes[0], nodes[1])), flightRun + type.platform.length / 2)), ...nodes.slice(1)];
    }
    const legs = nodes.slice(1).map((q, i) => ({ from: nodes[i], along: normalize(sub(q, nodes[i])), length: len(sub(q, nodes[i])) }));
    const total = legs.reduce((s, leg) => s + leg.length, 0);
    const run = 2 * flightRun + type.platform.length;
    const arrival = p.arrival === undefined ? 0
      : p.arrival.length === undefined ? total - run : ctx.length(p.arrival.length, `${path}.arrival.length`);
    const exit = p.arrival?.exit;
    const columnRef = exit && !Array.isArray(exit.column) && "column" in exit.column
      ? ctx.column(exit.column.column[0], exit.column.column[1], `${path}.arrival.exit.column`) : undefined;
    const exitParams = exit && {
      side: exit.side, reach: ctx.length(exit.reach, `${path}.arrival.exit.reach`), carriedBy: [],
      length: exit.length === undefined ? legs[legs.length - 1].length : ctx.length(exit.length, `${path}.arrival.exit.length`),
      column: { id: columnRef?.id ?? `${p.name}_column`, at: ctx.point(exit.column, `${path}.arrival.exit.column`) },
    };
    const floor = ctx.optionalLength(p.floor, `${path}.floor`);
    const made = stair(p.name, { ...type, height, floor, path: nodes, arrival: p.arrival && { length: arrival, exit: exitParams } });
    ctx.addInstance(made);
    made.handrails.forEach((h) => ctx.addInstance(h));

    // Where the stair arrives: the far edge of its bridge, or the top end of its path.
    const legAt = (s: number) => {
      let start = 0;
      for (const [i, leg] of legs.entries()) {
        if (s <= start + leg.length + 1e-9 || i === legs.length - 1) return { leg, at: add(leg.from, scale(leg.along, s - start)) };
        start += leg.length;
      }
      throw new BuildError("the path is too short", path);
    };
    const top = (floor ?? 0) + height;
    const end = run + arrival;
    const half = type.width / 2;
    const across = (s: number, offset: number) => {
      const { leg, at } = legAt(s);
      return lifted(add(at, scale(cross(WORLD_Z, leg.along), offset)), top);
    };
    const side = exit?.side === "left" ? 1 : -1;
    const marks = exitParams
      ? [across(end - exitParams.length, side * (half + exitParams.reach)), across(end, side * (half + exitParams.reach))]
      : [across(end, half), across(end, -half)];
    ctx.put(p.name, { kind: "points", points: marks }, path);

    // Quarter arches from the column to the seats the arrival rests on.
    if (exit?.arch && exitParams) {
      const profile = ctx.profile(exit.arch, `${path}.arrival.exit.arch`);
      const archHalf = Math.max(...profile.outline.map(([, z]) => Math.abs(z)));
      const columnHalf = columnRef ? Math.max(...columnRef.profile.outline.map(([y]) => Math.abs(y))) : 0;
      const color = ctx.color;
      made.seats.forEach((seat, i) => {
        const towards = normalize(flat(sub(seat.at, exitParams.column.at)));
        const from = add(flat(exitParams.column.at), scale(towards, columnHalf + archHalf));
        const spring = seat.at[2] - len(sub(flat(seat.at), from));
        ctx.addElement({
          id: `${p.name}_arch${i}`, kind: "arc", start: lifted(from, spring), end: seat.at, startTangent: WORLD_Z,
          segmentLength: ARC_SEGMENT, profile, ...(color ? { color } : {}),
        });
      });
    }
  },
});

export const circulationOperators = [handrails, stairs];
