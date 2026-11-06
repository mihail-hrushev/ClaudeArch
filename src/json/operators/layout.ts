/**
 * Layout operators: bay lines set once on an outline and carried to the others.
 */
import { z } from "zod";
import { type BaySide, BuildError } from "../context";
import { Length, Num } from "../document";
import { defineOperator } from "../operator";

export const bays = defineOperator({
  name: "bays",
  description: "Divides every side of a plan outline into whole bays of about `step` and leaves a bays result: bay lines that glazing operators (`bays`) and columns (`at.bays`) take their rib stations and column positions from, on this outline or on one with the same sides moved in or out, so ribs and columns line up through every layer.",
  schema: z.object({
    op: z.literal("bays"),
    name: z.string(),
    plan: z.string(),
    step: Length,
    /** Count the bays of these sides (default: all) on the matching side of another outline, e.g. the wider outer facet of an apse. */
    measure: z.object({ plan: z.string(), sides: z.array(Num.int()).optional() }).strict().optional(),
    /** Sides whose bays stay equal shares of every matching side instead of fixed lines carried across, e.g. an apse facet. */
    even: z.array(Num.int()).optional(),
    /** A bay line carried to a side closer than this to its end is left out (default: a quarter of the step). */
    margin: Length.optional(),
  }).strict(),
  run(ctx, p, path) {
    const plan = ctx.plan(p.plan, `${path}.plan`);
    const step = ctx.length(p.step, `${path}.step`);
    if (step <= 0) throw new BuildError("step must be > 0", path);
    const margin = ctx.optionalLength(p.margin, `${path}.margin`) ?? step / 4;
    const n = plan.sides.length;
    const index = (i: number) => ((i % n) + n) % n;
    const measured = p.measure && ctx.plan(p.measure.plan, `${path}.measure.plan`);
    if (measured && measured.sides.length !== n) {
      throw new BuildError(`"${measured.name}" has ${measured.sides.length} sides, "${plan.name}" ${n}`, `${path}.measure`);
    }
    const measuredOn = new Set((p.measure?.sides ?? plan.sides.map((_, k) => k)).map(index));
    const even = new Set((p.even ?? []).map(index));
    const sides: BaySide[] = plan.sides.map((s, k) => {
      const length = measured && measuredOn.has(k) ? measured.sides[k].length : s.length;
      const count = Math.max(1, Math.round(length / step));
      return { a: s.a, along: s.along, length: s.length, even: even.has(k), shares: Array.from({ length: count - 1 }, (_, i) => (i + 1) / count) };
    });
    ctx.put(p.name, { kind: "bays", margin, sides }, path);
  },
});

export const layoutOperators = [bays];
