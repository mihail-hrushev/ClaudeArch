/**
 * Opening operators: framed windows standing in the line of a plan side, and arcaded glass
 * screens between two points.
 */
import { z } from "zod";
import type { Element } from "../../fem/types";
import type { Profile } from "../../fem/profiles";
import { type Vec3, add, dot, len, normalize, scale, sub, WORLD_Z } from "../../fem/vec";
import { BuildError } from "../context";
import { Color, Length, Num, PointSpec, ProfileRef, TangentRef } from "../document";
import { defineOperator } from "../operator";

type P = readonly [number, number];

/** Points of a half ellipse around `c` (semi-axes a across, b up), from the right springing to the left, `n` pieces. */
function halfEllipse(c: P, a: number, b: number, n: number): P[] {
  return Array.from({ length: n + 1 }, (_, i): P => {
    const t = (Math.PI * i) / n;
    return [c[0] + a * Math.cos(t), c[1] + b * Math.sin(t)];
  });
}

export const window = defineOperator({
  name: "window",
  description:
    "A framed window in the line of a plan side: a rectangle split by a middle post, each half split again by a rib; " +
    "above the springing an outer elliptical arch joins the frame sides, its crown touching the frame top, and an inner one joins the two ribs; a horizontal rib on each side joins the feet of the two arches and a diagonal one joins them at 45 degrees from the centre (the angle of the round arch the ellipse projects). Glass inside " +
    "the outer arch, solid spandrels between it and the frame. The arches stay elliptical for any width and height.",
  schema: z.object({
    op: z.literal("window"),
    name: z.string(),
    /** The plan side it stands in: ["plan", i]. */
    side: z.tuple([z.string(), Num.int()]),
    /** Distance of the window centre from the start of the side (default: the middle). */
    at: Length.optional(),
    /** Offset of the window plane into the plan. */
    inward: Length.optional(),
    /** Level of the bottom of the frame. */
    foot: Length,
    /** Outer size of the frame. */
    width: Length,
    /** Height of the frame; or give `top` instead. */
    height: Length.optional(),
    /** Level of the top of the frame, instead of `height`. */
    top: Length.optional(),
    /** Level where both arches spring, like `foot` (default: half-way up the frame). */
    spring: Length.optional(),
    /** Rise of the inner arch as a share of the outer one (default 0.5: the two arches are similar ellipses). */
    innerRise: Num.positive().optional(),
    /** Straight pieces per arch (default 24), rounded up to a multiple of 4. */
    arcSegments: Num.int().min(4).optional(),
    profiles: z.object({
      /** Frame and outer arch. */
      frame: ProfileRef,
      /** Middle post (default: the frame profile). */
      post: ProfileRef.optional(),
      /** Ribs of the halves and the inner arch (default: the post profile). */
      rib: ProfileRef.optional(),
    }).strict(),
    glass: z.object({ thickness: Length.optional(), color: Color.optional(), alpha: Num.optional(), reflection: Num.optional() }).strict().optional(),
    solid: z.object({ thickness: Length.optional(), color: Color.optional() }).strict().optional(),
    color: Color.optional(),
  }).strict(),
  run(ctx, p, path) {
    const plan = ctx.plan(p.side[0], `${path}.side`);
    const n = plan.sides.length;
    const s = plan.sides[((p.side[1] % n) + n) % n];

    const width = ctx.length(p.width, `${path}.width`);
    const foot = ctx.length(p.foot, `${path}.foot`);
    if ((p.height === undefined) === (p.top === undefined)) throw new BuildError("give a window either `height` or `top`", path);
    const height = p.height !== undefined ? ctx.length(p.height, `${path}.height`) : ctx.length(p.top!, `${path}.top`) - foot;
    const frameProfile = ctx.profile(p.profiles.frame, `${path}.profiles.frame`);
    const postProfile = p.profiles.post ? ctx.profile(p.profiles.post, `${path}.profiles.post`) : frameProfile;
    const ribProfile = p.profiles.rib ? ctx.profile(p.profiles.rib, `${path}.profiles.rib`) : postProfile;
    const frameWidth = 2 * Math.max(...frameProfile.outline.map(([y]) => Math.abs(y)));

    // Local coordinates: u across the window from its centre, v up from the foot; on the frame's centre lines.
    const right = width / 2 - frameWidth / 2;
    const bottom = frameWidth / 2;
    const top = height - frameWidth / 2;
    const spring = p.spring === undefined ? height / 2 : ctx.length(p.spring, `${path}.spring`) - foot;
    if (right <= 0 || !(spring > bottom && spring < top - frameWidth)) {
      throw new BuildError(`a window ${width} x ${height} is too small for its frame, or springs outside it`, path);
    }
    // The outer arch's crown touches the frame top: their edges meet, their centre lines a frame width apart.
    const rise = top - frameWidth - spring;
    const innerHalf = right / 2;
    const innerRise = rise * (p.innerRise ?? 0.5);
    if (innerRise >= rise) throw new BuildError("the inner arch reaches the outer one: lower innerRise", `${path}.innerRise`);
    // A multiple of 4, so both arches have nodes at the quarter angles where the diagonal ribs meet them.
    const segments = 4 * Math.ceil((p.arcSegments ?? 24) / 4);
    const outer = halfEllipse([0, spring], right, rise, segments);
    const inner = halfEllipse([0, spring], innerHalf, innerRise, segments);

    const along = p.at === undefined ? s.length / 2 : ctx.length(p.at, `${path}.at`);
    const centre = add(add(s.a, scale(s.along, along)), scale(s.inward, ctx.optionalLength(p.inward, `${path}.inward`) ?? 0));
    const origin: Vec3 = [centre[0], centre[1], foot];
    const W = ([u, v]: P): Vec3 => add(add(origin, scale(s.along, u)), scale(WORLD_Z, v));
    const normal = s.inward;
    const color = p.color ?? ctx.color;
    const ids: string[] = [];
    const put = (el: Element) => { ids.push(ctx.addElement(el).id); };

    // Members, their profiles' depth across the window plane.
    const straight = (id: string, profile: Profile, a: P, b: P) =>
      put({ id: `${p.name}_${id}`, kind: "straight", profile, start: W(a), end: W(b), up: normal, ...(color ? { color } : {}) });
    const arch = (id: string, profile: Profile, pts: readonly P[]) => {
      const nodes = pts.map(W);
      put({ id: `${p.name}_${id}`, kind: "polyline", profile, nodes, start: nodes[0], end: nodes[nodes.length - 1], up: normal, ...(color ? { color } : {}) });
    };
    straight("frameBottom", frameProfile, [-right, bottom], [right, bottom]);
    straight("frameRight", frameProfile, [right, bottom], [right, top]);
    straight("frameTop", frameProfile, [right, top], [-right, top]);
    straight("frameLeft", frameProfile, [-right, top], [-right, bottom]);
    arch("outerArch", frameProfile, outer);
    straight("post", postProfile, [0, bottom], [0, top]);
    straight("ribRight", ribProfile, [innerHalf, bottom], [innerHalf, spring]);
    straight("ribLeft", ribProfile, [-innerHalf, bottom], [-innerHalf, spring]);
    arch("innerArch", ribProfile, inner);
    // At the springing, each side: from the foot of the outer arch to the foot of the inner one.
    straight("springRight", ribProfile, [right, spring], [innerHalf, spring]);
    straight("springLeft", ribProfile, [-innerHalf, spring], [-right, spring]);
    // Diagonals at 45 degrees either side of the post, splitting the band between the arches into four sectors:
    // equal ones of a round arch, seen projected when the arches are elliptical (both at the same parametric angle).
    straight("diagonalRight", ribProfile, inner[segments / 4], outer[segments / 4]);
    straight("diagonalLeft", ribProfile, inner[(3 * segments) / 4], outer[(3 * segments) / 4]);

    // Panels: plates centred on the window plane.
    const glass = p.glass ?? {};
    const solid = p.solid ?? {};
    const glassThickness = ctx.optionalLength(glass.thickness, `${path}.glass.thickness`) ?? 12;
    const solidThickness = ctx.optionalLength(solid.thickness, `${path}.solid.thickness`) ?? 40;
    let g = 0;
    const pane = (pts: readonly P[]) => put({
      id: `${p.name}_glass_${g++}`, kind: "plate", corners: pts.map(W), thickness: glassThickness,
      color: glass.color ?? [0.8, 0.9, 0.95], alpha: glass.alpha ?? 0.35, reflection: glass.reflection ?? 0.5,
    });
    let f = 0;
    const fill = (pts: readonly P[]) => put({
      id: `${p.name}_solid_${f++}`, kind: "plate", corners: pts.map(W), thickness: solidThickness,
      color: solid.color ?? color ?? [0.9, 0.9, 0.88], alpha: 1,
    });

    // Below the springing: four panes between the frame, the ribs and the post.
    const lines = [-right, -innerHalf, 0, innerHalf, right];
    for (let i = 0; i < 4; i++) pane([[lines[i], bottom], [lines[i + 1], bottom], [lines[i + 1], spring], [lines[i], spring]]);
    // Inside the inner arch, either side of the post.
    const crown = Math.round(segments / 2);
    const innerCrown: P = [0, spring + innerRise];
    pane([[0, spring], ...inner.slice(0, crown), innerCrown]);
    pane([[0, spring], innerCrown, ...inner.slice(crown + 1)]);
    // Between the arches: four sectors split by the springing ribs, the diagonals and the post, one pane each.
    const quarter = segments / 4;
    for (let q = 0; q < 4; q++) {
      pane([...outer.slice(q * quarter, (q + 1) * quarter + 1), ...inner.slice(q * quarter, (q + 1) * quarter + 1).reverse()]);
    }
    // Spandrels: one solid piece in each top corner, between the frame and the outer arch.
    fill([[right, top], [0, top], ...outer.slice(0, crown + 1).reverse()]);
    fill([[-right, top], ...outer.slice(crown).reverse(), [0, top]]);

    ctx.put(p.name, { kind: "members", ids }, path);
  },
});

/** A circular arc in a vertical plane from `a` to `b`, leaving `a` along `dir`, as a height over u; undefined outside it. */
function arcHeight(a: P, b: P, dir: P): (u: number) => number | undefined {
  const lo = Math.min(a[0], b[0]);
  const hi = Math.max(a[0], b[0]);
  const chord: P = [b[0] - a[0], b[1] - a[1]];
  const side = chord[0] * dir[1] - chord[1] * dir[0];
  const line = (u: number) => a[1] + ((u - a[0]) / chord[0]) * chord[1];
  if (Math.abs(side) < 1e-9 * Math.hypot(...chord) * Math.hypot(...dir) || Math.abs(chord[0]) < 1e-9) {
    return (u) => (u < lo - 1e-6 || u > hi + 1e-6 ? undefined : line(u));
  }
  // Centre on the normal of `dir` at `a`, equally far from `b`.
  const n: P = [-dir[1], dir[0]];
  const t = (chord[0] * chord[0] + chord[1] * chord[1]) / (2 * (n[0] * chord[0] + n[1] * chord[1]));
  const c: P = [a[0] + n[0] * t, a[1] + n[1] * t];
  const r2 = (a[0] - c[0]) ** 2 + (a[1] - c[1]) ** 2;
  return (u) => {
    if (u < lo - 1e-6 || u > hi + 1e-6) return undefined;
    const d = Math.sqrt(Math.max(0, r2 - (u - c[0]) ** 2));
    // The root on the same side of the chord as the arc (the side `dir` leaves to).
    const pick = (v: number) => Math.sign(chord[0] * (v - a[1]) - chord[1] * (u - a[0])) === Math.sign(side);
    const up = c[1] + d;
    const down = c[1] - d;
    if (Math.abs(up - line(u)) < 1e-9) return up;
    return pick(up) ? up : down;
  };
}

export const archSurface = defineOperator({
  name: "archSurface",
  description:
    "An upright glazed screen between two points: a rectangular frame from `foot` to `top`, split by vertical ribs into equal bays of about `ribStep`, " +
    "each bay crowned by a semicircular arch springing from the ribs, its crown touching the frame top. Glass below and inside the arches, " +
    "solid spandrels between the arches and the frame top. A `floor` of arcs (e.g. the section of a roof against the screen) cuts away everything below it: " +
    "the bottom frame follows it and the ribs stand on it.",
  schema: z.object({
    op: z.literal("archSurface"),
    name: z.string(),
    /** Ends of the screen; only their plan position counts. */
    from: PointSpec,
    to: PointSpec,
    /** Shortens the screen at both ends, e.g. by a column's radius. */
    inset: Length.optional(),
    /** Levels of the bottom and the top of the frame. */
    foot: Length,
    top: Length,
    /** Bay width (rib spacing), rounded so the bays are equal (default 400 mm). */
    ribStep: Length.optional(),
    /** Straight pieces per arch (default 12), rounded up to an even number. */
    arcSegments: Num.int().min(2).optional(),
    /**
     * Arcs in the screen's plane the screen stands on, written like a surface section: from `from` to `to`, leaving `from`
     * along `tangent` ([0, towards `to`, up]; default straight to `to`). Where arcs overlap the higher one counts.
     */
    floor: z.array(z.object({ from: PointSpec, to: PointSpec, tangent: TangentRef.optional() }).strict()).optional(),
    profiles: z.object({
      /** Frame. */
      frame: ProfileRef,
      /** Vertical ribs (default: the frame profile). */
      rib: ProfileRef.optional(),
      /** Arches (default: the rib profile). */
      arch: ProfileRef.optional(),
    }).strict(),
    glass: z.object({ thickness: Length.optional(), color: Color.optional(), alpha: Num.optional(), reflection: Num.optional() }).strict().optional(),
    solid: z.object({ thickness: Length.optional(), color: Color.optional() }).strict().optional(),
    color: Color.optional(),
  }).strict(),
  run(ctx, p, path) {
    const a0 = ctx.point(p.from, `${path}.from`);
    const b0 = ctx.point(p.to, `${path}.to`);
    const flat = sub([b0[0], b0[1], 0], [a0[0], a0[1], 0]);
    if (len(flat) < 1e-6) throw new BuildError("`from` and `to` are at the same place in plan", path);
    const along = normalize(flat);
    const normal: Vec3 = [-along[1], along[0], 0];
    const inset = ctx.optionalLength(p.inset, `${path}.inset`) ?? 0;
    const length = len(flat) - 2 * inset;
    const foot = ctx.length(p.foot, `${path}.foot`);
    const height = ctx.length(p.top, `${path}.top`) - foot;

    const frameProfile = ctx.profile(p.profiles.frame, `${path}.profiles.frame`);
    const ribProfile = p.profiles.rib ? ctx.profile(p.profiles.rib, `${path}.profiles.rib`) : frameProfile;
    const archProfile = p.profiles.arch ? ctx.profile(p.profiles.arch, `${path}.profiles.arch`) : ribProfile;
    const widthOf = (pr: Profile) => 2 * Math.max(...pr.outline.map(([y]) => Math.abs(y)));
    const frameWidth = widthOf(frameProfile);

    // Local coordinates: u along the screen from its start, v up from the foot; on the members' centre lines.
    const left = frameWidth / 2;
    const right = length - frameWidth / 2;
    const bottom = frameWidth / 2;
    const top = height - frameWidth / 2;
    const step = ctx.optionalLength(p.ribStep, `${path}.ribStep`) ?? 40;
    const bays = Math.max(1, Math.round((right - left) / step));
    const bay = (right - left) / bays;
    const r = bay / 2;
    // The crowns touch the frame top: their edges meet.
    const spring = top - frameWidth / 2 - widthOf(archProfile) / 2 - r;
    if (length <= frameWidth || !(spring > bottom)) {
      throw new BuildError(`an arch screen ${length} x ${height} is too low or too short for arches of ${bay} span`, path);
    }
    const segments = 2 * Math.ceil((p.arcSegments ?? 12) / 2);
    const crown = segments / 2;
    const ribs = Array.from({ length: bays + 1 }, (_, i) => left + i * bay);
    const arches = Array.from({ length: bays }, (_, i) => halfEllipse([ribs[i] + r, spring], r, r, segments));

    const origin: Vec3 = add([a0[0], a0[1], foot], scale(along, inset));
    const local = (q: Vec3): P => [dot(sub(q, origin), along), q[2] - foot];

    // The floor: the bottom frame's centre line, `bottom` without arcs, else half a frame above the highest arc.
    const arcs = (p.floor ?? []).map((f, i) => {
      const fa = local(ctx.point(f.from, `${path}.floor[${i}].from`));
      const fb = local(ctx.point(f.to, `${path}.floor[${i}].to`));
      const t = f.tangent ? ctx.tangent(f.tangent, `${path}.floor[${i}].tangent`) : undefined;
      const towards = Math.sign(fb[0] - fa[0]) || 1;
      const dir: P = t ? [towards * t[1], t[2]] : [fb[0] - fa[0], fb[1] - fa[1]];
      return arcHeight(fa, fb, dir);
    });
    const floorAt = (u: number): number => {
      let v = bottom;
      for (const arc of arcs) {
        const h = arc(u);
        if (h !== undefined) v = Math.max(v, h + frameWidth / 2);
      }
      return v;
    };
    const cutting = arcs.length > 0;
    const sampleStep = 5; // cm along u where the floor is followed
    const samples = (u0: number, u1: number): number[] => {
      const n = Math.max(1, Math.ceil(Math.abs(u1 - u0) / sampleStep));
      return Array.from({ length: n + 1 }, (_, i) => u0 + ((u1 - u0) * i) / n);
    };
    const over = (q: P) => q[1] - floorAt(q[0]);
    /** Where the segment a → b crosses the floor (`over` changes sign). */
    const crossing = (a: P, b: P): P => {
      let lo = 0;
      let hi = 1;
      const at = (t: number): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const inside = over(a) >= 0;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if ((over(at(mid)) >= 0) === inside) lo = mid; else hi = mid;
      }
      return at((lo + hi) / 2);
    };
    /** The part of a polygon above the floor, its cut edges following the floor. */
    const clip = (poly: readonly P[]): P[] => {
      if (!cutting) return [...poly];
      const marked: { q: P; exit: boolean }[] = [];
      poly.forEach((cur, i) => {
        const next = poly[(i + 1) % poly.length];
        const inCur = over(cur) >= 0;
        if (inCur) marked.push({ q: cur, exit: false });
        if (inCur !== (over(next) >= 0)) marked.push({ q: crossing(cur, next), exit: inCur });
      });
      const out: P[] = [];
      marked.forEach((m, k) => {
        out.push(m.q);
        if (m.exit) {
          const entry = marked[(k + 1) % marked.length].q;
          for (const u of samples(m.q[0], entry[0]).slice(1, -1)) out.push([u, floorAt(u)]);
        }
      });
      return out;
    };
    /** Runs of a polyline above the floor, cut where it crosses it. */
    const runs = (pts: readonly P[]): P[][] => {
      if (!cutting) return [[...pts]];
      const result: P[][] = [];
      let run: P[] = [];
      pts.forEach((q, i) => {
        const inside = over(q) >= 0;
        if (i > 0 && inside !== (over(pts[i - 1]) >= 0)) run.push(crossing(pts[i - 1], q));
        if (inside) run.push(q);
        else if (run.length) { result.push(run); run = []; }
      });
      if (run.length) result.push(run);
      return result.filter((rn) => rn.length >= 2 && Math.hypot(rn[rn.length - 1][0] - rn[0][0], rn[rn.length - 1][1] - rn[0][1]) > 0.5);
    };

    const W = ([u, v]: P): Vec3 => add(add(origin, scale(along, u)), scale(WORLD_Z, v));
    const color = p.color ?? ctx.color;
    const ids: string[] = [];
    const put = (el: Element) => { ids.push(ctx.addElement(el).id); };
    const straight = (id: string, profile: Profile, a: P, b: P) =>
      put({ id: `${p.name}_${id}`, kind: "straight", profile, start: W(a), end: W(b), up: normal, ...(color ? { color } : {}) });
    const polyline = (id: string, profile: Profile, pts: readonly P[]) => {
      if (pts.length === 2) { straight(id, profile, pts[0], pts[1]); return; }
      const nodes = pts.map(W);
      put({ id: `${p.name}_${id}`, kind: "polyline", profile, nodes, start: nodes[0], end: nodes[nodes.length - 1], up: normal, ...(color ? { color } : {}) });
    };
    const pieces = (id: string, profile: Profile, pts: readonly P[]) =>
      runs(pts).forEach((rn, k, all) => polyline(all.length > 1 ? `${id}_${k + 1}` : id, profile, rn));

    // Frame: the bottom follows the floor wherever it is below the top.
    if (cutting) {
      const bottomLine = samples(left, right).map((u): P => [u, floorAt(u)]);
      const below: P[][] = [];
      let run: P[] = [];
      for (const q of bottomLine) {
        if (q[1] < top - frameWidth) run.push(q);
        else if (run.length) { below.push(run); run = []; }
      }
      if (run.length) below.push(run);
      below.filter((rn) => rn.length >= 2).forEach((rn, k, all) => polyline(all.length > 1 ? `frameBottom_${k + 1}` : "frameBottom", frameProfile, rn));
    } else {
      straight("frameBottom", frameProfile, [left, bottom], [right, bottom]);
    }
    pieces("frameRight", frameProfile, [[right, bottom], [right, top]]);
    // Straight between the cuts.
    runs(samples(right, left).map((u): P => [u, top])).forEach((rn, k, all) =>
      straight(all.length > 1 ? `frameTop_${k + 1}` : "frameTop", frameProfile, rn[0], rn[rn.length - 1]));
    pieces("frameLeft", frameProfile, [[left, top], [left, bottom]]);
    for (let i = 1; i < bays; i++) pieces(`rib${i}`, ribProfile, [[ribs[i], bottom], [ribs[i], spring]]);
    arches.forEach((pts, i) => pieces(`arch${i + 1}`, archProfile, pts));

    const glass = p.glass ?? {};
    const solid = p.solid ?? {};
    const glassThickness = ctx.optionalLength(glass.thickness, `${path}.glass.thickness`) ?? 12;
    const solidThickness = ctx.optionalLength(solid.thickness, `${path}.solid.thickness`) ?? 40;
    const area = (pts: readonly P[]) => Math.abs(pts.reduce((s, q, i) => {
      const n = pts[(i + 1) % pts.length];
      return s + q[0] * n[1] - n[0] * q[1];
    }, 0)) / 2;
    let g = 0;
    const pane = (poly: readonly P[]) => {
      const pts = clip(poly);
      if (pts.length < 3 || area(pts) < 1) return;
      put({
        id: `${p.name}_glass_${g++}`, kind: "plate", corners: pts.map(W), thickness: glassThickness,
        color: glass.color ?? [0.8, 0.9, 0.95], alpha: glass.alpha ?? 0.35, reflection: glass.reflection ?? 0.5,
      });
    };
    let f = 0;
    const fill = (poly: readonly P[]) => {
      const pts = clip(poly);
      if (pts.length < 3 || area(pts) < 1) return;
      put({
        id: `${p.name}_solid_${f++}`, kind: "plate", corners: pts.map(W), thickness: solidThickness,
        color: solid.color ?? color ?? [0.9, 0.9, 0.88], alpha: 1,
      });
    };

    // Each bay: a pane below the springing and a half-disc pane inside its arch.
    arches.forEach((pts, i) => {
      pane([[ribs[i], bottom], [ribs[i + 1], bottom], [ribs[i + 1], spring], [ribs[i], spring]]);
      pane(pts);
    });
    // Spandrels: at each rib, between the halves of the two arches meeting there and the frame top;
    // at the ends, between the frame side, the outer half arch and the frame top.
    const rightHalfDown = (pts: readonly P[]) => pts.slice(0, crown + 1).reverse(); // crown to right springing
    const leftHalfUp = (pts: readonly P[]) => pts.slice(crown).reverse(); // left springing to crown
    const crownX = (i: number) => ribs[i] + r;
    fill([[left, top], ...leftHalfUp(arches[0]), [crownX(0), top]]);
    for (let i = 1; i < bays; i++) {
      fill([...rightHalfDown(arches[i - 1]), ...leftHalfUp(arches[i]).slice(1), [crownX(i), top], [crownX(i - 1), top]]);
    }
    fill([[crownX(bays - 1), top], ...rightHalfDown(arches[bays - 1]), [right, top]]);

    ctx.put(p.name, { kind: "members", ids }, path);
  },
});

export const archWindow = defineOperator({
  name: "archWindow",
  description:
    "A large round-headed window between two points: straight jambs from `foot` up to the springing, then two concentric semicircular arches. " +
    "The band between them is split into `ringSegments` equal sectors by radial ribs; the inner arch's half disc into `ribs` equal vertical strips, " +
    "the ribs running on down to the sill. Glass throughout. Give the springing as a level, or a `ceiling` of arcs (e.g. the section of the roof " +
    "above) and the window rises until the outer arch's back just touches it; the gap between the outer arch and the ceiling is then filled solid.",
  schema: z.object({
    op: z.literal("archWindow"),
    name: z.string(),
    /** Ends of the window's base line; only their plan position counts. The window is centred between them. */
    from: PointSpec,
    to: PointSpec,
    /** Level of the sill's centre line. */
    foot: Length,
    /** Radius of the outer arch's centre line (default: half the distance between `from` and `to`). */
    outerRadius: Length.optional(),
    /** Radius of the inner arch's centre line. */
    innerRadius: Length,
    /** Sectors of the band between the arches (default 15). */
    ringSegments: Num.int().min(1).optional(),
    /** Vertical strips inside the inner arch (default 12). */
    ribs: Num.int().min(1).optional(),
    /** Level of the springing; or give `ceiling`. */
    spring: Length.optional(),
    /** Arcs in the window's plane, written like a surface section (see archSurface `floor`), that the outer arch's back just touches. */
    ceiling: z.array(z.object({ from: PointSpec, to: PointSpec, tangent: TangentRef.optional() }).strict()).optional(),
    /** With a ceiling: fill the gap between the outer arch and it with a solid panel (default true). */
    spandrels: z.boolean().optional(),
    /** Straight pieces per sector of the arches (default 4). */
    arcSegments: Num.int().min(1).optional(),
    profiles: z.object({
      /** Sill, jambs and outer arch. */
      frame: ProfileRef,
      /** Springing transom and inner arch (default: the frame profile). */
      arch: ProfileRef.optional(),
      /** Radial and vertical ribs (default: the arch profile). */
      rib: ProfileRef.optional(),
    }).strict(),
    glass: z.object({ thickness: Length.optional(), color: Color.optional(), alpha: Num.optional(), reflection: Num.optional() }).strict().optional(),
    solid: z.object({ thickness: Length.optional(), color: Color.optional() }).strict().optional(),
    color: Color.optional(),
  }).strict(),
  run(ctx, p, path) {
    const a0 = ctx.point(p.from, `${path}.from`);
    const b0 = ctx.point(p.to, `${path}.to`);
    const flat = sub([b0[0], b0[1], 0], [a0[0], a0[1], 0]);
    if (len(flat) < 1e-6) throw new BuildError("`from` and `to` are at the same place in plan", path);
    const along = normalize(flat);
    const normal: Vec3 = [-along[1], along[0], 0];
    const foot = ctx.length(p.foot, `${path}.foot`);
    const R = ctx.optionalLength(p.outerRadius, `${path}.outerRadius`) ?? len(flat) / 2;
    const r = ctx.length(p.innerRadius, `${path}.innerRadius`);
    if (!(r > 0 && r < R)) throw new BuildError(`the inner radius ${r} must be between 0 and the outer radius ${R}`, path);
    const sectors = p.ringSegments ?? 15;
    const strips = p.ribs ?? 12;
    const per = 2 * Math.ceil((p.arcSegments ?? 4) / 2); // even, so the arches have a node at the crown
    const pieces = sectors * per;

    const frameProfile = ctx.profile(p.profiles.frame, `${path}.profiles.frame`);
    const archProfile = p.profiles.arch ? ctx.profile(p.profiles.arch, `${path}.profiles.arch`) : frameProfile;
    const ribProfile = p.profiles.rib ? ctx.profile(p.profiles.rib, `${path}.profiles.rib`) : archProfile;
    const frameWidth = 2 * Math.max(...frameProfile.outline.map(([y]) => Math.abs(y)));

    // Local coordinates: u across from the window's centre, v up from the foot; on the members' centre lines.
    const origin: Vec3 = [(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2, foot];
    const local = (q: Vec3): P => [dot(sub(q, origin), along), q[2] - foot];
    const W = ([u, v]: P): Vec3 => add(add(origin, scale(along, u)), scale(WORLD_Z, v));

    const arcs = (p.ceiling ?? []).map((f, i) => {
      const fa = local(ctx.point(f.from, `${path}.ceiling[${i}].from`));
      const fb = local(ctx.point(f.to, `${path}.ceiling[${i}].to`));
      const t = f.tangent ? ctx.tangent(f.tangent, `${path}.ceiling[${i}].tangent`) : undefined;
      const towards = Math.sign(fb[0] - fa[0]) || 1;
      const dir: P = t ? [towards * t[1], t[2]] : [fb[0] - fa[0], fb[1] - fa[1]];
      return arcHeight(fa, fb, dir);
    });
    /** The lowest ceiling arc over u; undefined where there is none. */
    const ceilingAt = (u: number): number | undefined => {
      let v: number | undefined;
      for (const arc of arcs) {
        const h = arc(u);
        if (h !== undefined) v = v === undefined ? h : Math.min(v, h);
      }
      return v;
    };
    if ((p.spring === undefined) === (arcs.length === 0)) throw new BuildError("give an arch window either `spring` or a `ceiling`", path);
    let spring: number;
    if (p.spring !== undefined) {
      spring = ctx.length(p.spring, `${path}.spring`) - foot;
    } else {
      // As high as keeps the outer arch's back under the ceiling everywhere above it.
      const back = R + frameWidth / 2;
      const n = 800;
      let best = Infinity;
      for (let k = 0; k <= n; k++) {
        const u = -back + (2 * back * k) / n;
        const h = ceilingAt(u);
        if (h !== undefined) best = Math.min(best, h - Math.sqrt(Math.max(0, back * back - u * u)));
      }
      if (!Number.isFinite(best)) throw new BuildError("the ceiling does not reach over the window", `${path}.ceiling`);
      spring = best;
    }
    if (!(spring > frameWidth)) throw new BuildError(`the window springs at ${spring + foot}, at or below its foot`, path);

    const semicircle = (radius: number): P[] => Array.from({ length: pieces + 1 }, (_, j): P => {
      const t = (Math.PI * j) / pieces;
      return [radius * Math.cos(t), spring + radius * Math.sin(t)];
    });
    const outer = semicircle(R); // right springing to left
    const inner = semicircle(r);
    const ribU = Array.from({ length: strips + 1 }, (_, k) => -r + (2 * r * k) / strips);
    const innerAt = (u: number) => spring + Math.sqrt(Math.max(0, r * r - u * u));

    const color = p.color ?? ctx.color;
    const ids: string[] = [];
    const put = (el: Element) => { ids.push(ctx.addElement(el).id); };
    const straight = (id: string, profile: Profile, a: P, b: P) =>
      put({ id: `${p.name}_${id}`, kind: "straight", profile, start: W(a), end: W(b), up: normal, ...(color ? { color } : {}) });
    const polyline = (id: string, profile: Profile, pts: readonly P[]) => {
      const nodes = pts.map(W);
      put({ id: `${p.name}_${id}`, kind: "polyline", profile, nodes, start: nodes[0], end: nodes[nodes.length - 1], up: normal, ...(color ? { color } : {}) });
    };

    straight("sill", frameProfile, [-R, 0], [R, 0]);
    straight("jambRight", frameProfile, [R, 0], [R, spring]);
    straight("jambLeft", frameProfile, [-R, spring], [-R, 0]);
    polyline("outerArch", frameProfile, outer);
    straight("transom", archProfile, [R, spring], [-R, spring]);
    polyline("innerArch", archProfile, inner);
    for (let j = 1; j < sectors; j++) straight(`radial${j}`, ribProfile, inner[j * per], outer[j * per]);
    // The inner arch's feet and the strip ribs, down to the sill.
    straight("ribRight", ribProfile, [r, 0], [r, spring]);
    straight("ribLeft", ribProfile, [-r, 0], [-r, spring]);
    for (let k = 1; k < strips; k++) straight(`rib${k}`, ribProfile, [ribU[k], 0], [ribU[k], innerAt(ribU[k])]);

    const glass = p.glass ?? {};
    const solid = p.solid ?? {};
    const glassThickness = ctx.optionalLength(glass.thickness, `${path}.glass.thickness`) ?? 12;
    const solidThickness = ctx.optionalLength(solid.thickness, `${path}.solid.thickness`) ?? 40;
    /** Without repeated corners (e.g. where a strip's side shrinks to nothing at the inner arch's feet). */
    const distinct = (pts: readonly P[]) =>
      pts.filter((q, i) => { const n = pts[(i + 1) % pts.length]; return Math.hypot(q[0] - n[0], q[1] - n[1]) > 1e-3; });
    let g = 0;
    const pane = (pts: readonly P[]) => put({
      id: `${p.name}_glass_${g++}`, kind: "plate", corners: distinct(pts).map(W), thickness: glassThickness,
      color: glass.color ?? [0.8, 0.9, 0.95], alpha: glass.alpha ?? 0.35, reflection: glass.reflection ?? 0.5,
    });
    let f = 0;
    const fill = (pts: readonly P[]) => put({
      id: `${p.name}_solid_${f++}`, kind: "plate", corners: distinct(pts).map(W), thickness: solidThickness,
      color: solid.color ?? color ?? [0.9, 0.9, 0.88], alpha: 1,
    });

    // Below the springing: strips between the jambs, the inner arch's feet and the ribs.
    const lines = [-R, ...ribU, R];
    for (let i = 0; i + 1 < lines.length; i++) pane([[lines[i], 0], [lines[i + 1], 0], [lines[i + 1], spring], [lines[i], spring]]);
    // Inside the inner arch: one strip between each pair of ribs, its top following the arch.
    for (let k = 0; k < strips; k++) {
      const u0 = ribU[k];
      const u1 = ribU[k + 1];
      const top = inner.filter(([u]) => u > u0 + 1e-6 && u < u1 - 1e-6); // right to left
      pane([[u0, spring], [u1, spring], [u1, innerAt(u1)], ...top, [u0, innerAt(u0)]]);
    }
    // Between the arches: one pane per sector.
    for (let j = 0; j < sectors; j++) {
      pane([...outer.slice(j * per, (j + 1) * per + 1), ...inner.slice(j * per, (j + 1) * per + 1).reverse()]);
    }
    // Between the outer arch and the ceiling, each side of the crown.
    if (arcs.length && p.spandrels !== false) {
      const step = 5; // cm along u where the ceiling is followed
      const n = Math.ceil(R / step);
      for (const sgn of [1, -1]) {
        // The ceiling from the crown out to the side, then the outer arch from the side back up to the crown.
        const ceil: P[] = [];
        for (let k = 0; k <= n; k++) {
          const u = (sgn * R * k) / n;
          const h = ceilingAt(u);
          if (h !== undefined) ceil.push([u, h]);
        }
        if (ceil.length < 2) continue;
        const reach = Math.abs(ceil[ceil.length - 1][0]);
        const half = sgn > 0 ? outer.slice(0, pieces / 2 + 1) : outer.slice(pieces / 2).reverse();
        const arch = half.filter(([u]) => Math.abs(u) <= reach + 1e-6 && Math.abs(u) > 1e-6);
        fill([...ceil, ...arch]);
      }
    }

    ctx.put(p.name, { kind: "members", ids }, path);
  },
});

export const openingOperators = [window, archSurface, archWindow];
