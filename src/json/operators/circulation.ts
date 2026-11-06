/**
 * Circulation operators: handrails along edges and stairs between levels.
 */
import { z } from "zod";
import { type Vec3, add, scale } from "../../fem/vec";
import { type Handrail, handrail } from "../../generators/handrail";
import { stair } from "../../generators/stair";
import { BuildError } from "../context";
import { Length, Num, Padding, PointSpec } from "../document";
import { defineOperator } from "../operator";
import { selectedSides } from "./glazing";

const lifted = (q: Vec3, z: number): Vec3 => [q[0], q[1], z];

export const handrails = defineOperator({
  name: "handrail",
  description: "Handrail sections of a type along the sides of a plan outline at a level, or from one point to another; `padding` keeps the posts clear of the ends.",
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
    const made: Handrail[] = runs.map((r) => handrail(r.name, { ...type, base: r.base, alongX: r.alongX, padding: pad, railBeamDrop }));
    made.forEach((h) => ctx.addInstance(h));
  },
});

export const stairs = defineOperator({
  name: "stair",
  description: "A stair of a type along a centre line in plan, from the lower level up by `height` with a platform at mid height, and optionally an arrival platform at the top (see generators/stair).",
  schema: z.object({
    op: z.literal("stair"),
    name: z.string(),
    type: z.string(),
    /** Plan of the centre line, foot first; only x and y count. */
    path: z.array(PointSpec).min(2),
    floor: Length.optional(),
    height: Length,
    arrival: z.object({ length: Length }).strict().optional(),
  }).strict(),
  run(ctx, p, path) {
    const type = ctx.stairType(p.type, `${path}.type`);
    const height = ctx.length(p.height, `${path}.height`);
    const risers = height / type.riser;
    if (Math.abs(risers - Math.round(risers)) > 1e-6 || Math.round(risers) % 2 !== 0) {
      throw new BuildError(`height ${height} is not an even number of risers of ${type.riser}`, path);
    }
    const made = stair(p.name, {
      ...type, height, floor: ctx.optionalLength(p.floor, `${path}.floor`),
      path: p.path.map((q, i) => ctx.point(q, `${path}.path[${i}]`)),
      arrival: p.arrival && { length: ctx.length(p.arrival.length, `${path}.arrival.length`) },
    });
    ctx.addInstance(made);
    made.handrails.forEach((h) => ctx.addInstance(h));
  },
});

export const circulationOperators = [handrails, stairs];
