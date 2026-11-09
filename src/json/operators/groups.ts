/**
 * Group operators: a reusable assembly from the document's `groups`, built in its local
 * coordinates and placed, turned about the vertical and moved.
 */
import { z } from "zod";
import { type LocalFrame, assemble, transformElement } from "../../fem/placement";
import { type Vec3, add, sub } from "../../fem/vec";
import { type BuildResult, BuildError } from "../context";
import { Num, P2Spec, Vec3Spec } from "../document";
import { defineOperator } from "../operator";
import { runSteps } from "../steps";

/** Groups placing groups: deeper than this is taken for a group placing itself. */
const MAX_DEPTH = 8;

export const group = defineOperator({
  name: "group",
  description:
    "Places a group from `groups`: its steps are built in the group's local coordinates (references to the document's " +
    "outlines, columns and levels read as if the group stood unrotated at the origin), then the result is turned " +
    "`rotate` degrees about the vertical through `about` and moved by `move`. Element ids and results get the prefix `<name>/`.",
  schema: z.object({
    op: z.literal("group"),
    name: z.string(),
    /** The group in `groups`. */
    use: z.string(),
    /** Degrees, counter-clockwise seen from above. */
    rotate: Num.optional(),
    /** Plan point the group turns about (default the origin). */
    about: P2Spec.optional(),
    move: Vec3Spec.optional(),
  }).strict(),
  run(ctx, p, path) {
    const spec = ctx.doc.groups?.[p.use];
    if (!spec) throw new BuildError(`unknown group "${p.use}"; known: ${Object.keys(ctx.doc.groups ?? {}).join(", ") || "none"}`, `${path}.use`);
    if (ctx.depth >= MAX_DEPTH) throw new BuildError(`groups nested deeper than ${MAX_DEPTH}: does "${p.use}" place itself?`, path);

    const inner = ctx.child(spec.plan, `groups.${p.use}`);
    runSteps(inner, spec.build, `groups.${p.use}.build`);

    // world = R (q - about) + about + move, as a frame: axes R, origin about + move - R about.
    const a = ((p.rotate ?? 0) * Math.PI) / 180;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    const x: Vec3 = [c, s, 0];
    const y: Vec3 = [-s, c, 0];
    const about = p.about ? ctx.p2(p.about, `${path}.about`) : [0, 0];
    const pivot: Vec3 = [about[0], about[1], 0];
    const turnedPivot: Vec3 = [c * pivot[0] - s * pivot[1], s * pivot[0] + c * pivot[1], 0];
    const move = p.move ? ctx.vec3(p.move, `${path}.move`) : [0, 0, 0] as Vec3;
    const frame: LocalFrame = { origin: add(add(pivot, move), sub([0, 0, 0], turnedPivot)), x, y, z: [0, 0, 1] };
    const point = (q: Vec3): Vec3 => add(frame.origin, add(add([x[0] * q[0], x[1] * q[0], 0], [y[0] * q[1], y[1] * q[1], 0]), [0, 0, q[2]]));
    const direction = (v: Vec3): Vec3 => [x[0] * v[0] + y[0] * v[1], x[1] * v[0] + y[1] * v[1], v[2]];

    // Elements, with those of instances placed inside the group flattened first.
    const ids = new Map<string, string>();
    for (const el of [...assemble(inner.instances).elements, ...inner.elements]) {
      ids.set(el.id, ctx.addElement(transformElement(el, frame, `${p.name}/${el.id}`)).id);
    }

    // Results made inside the group, under the prefix, where they can be carried along.
    for (const [key, result] of inner.results) {
      if (ctx.results.get(key) === result) continue; // seen from outside, not made here
      let placed: BuildResult | undefined;
      if (result.kind === "columns") {
        placed = { kind: "columns", columns: result.columns.map((col) => ({
          ...col, id: `${p.name}/${col.id}`, at: point(col.at), top: col.top + frame.origin[2], inward: col.inward && direction(col.inward),
        })) };
      } else if (result.kind === "points") {
        placed = { kind: "points", points: result.points.map(point) };
      } else if (result.kind === "members") {
        placed = { kind: "members", ids: result.ids.map((id) => ids.get(id) ?? `${p.name}/${id}`) };
      }
      if (placed) ctx.put(`${p.name}/${key}`, placed, path);
    }
  },
});

export const groupOperators = [group];
