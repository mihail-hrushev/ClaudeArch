import type { Element } from "../fem/types";
import type { Profile } from "../fem/profiles";
import { type Instance, WORLD_FRAME } from "../fem/placement";
import { type Vec3, add, sub, scale, dot, cross, len, normalize, WORLD_Z } from "../fem/vec";
import { type Handrail, type HandrailParams, handrail } from "./handrail";

/**
 * Stair with a platform at the middle of its height, following a centre line that can bend at the
 * platforms, with a defined load path:
 *
 *   treads → stringers → platform frames → posts
 *   platforms → platform frames → posts
 *
 * `path` is the plan of the centre line, from the foot of the stair onwards. From its start the
 * stair runs: lower flight, platform of `platform.length` measured along the centre line, upper
 * flight, and optionally an `arrival` platform at the top. A flight must lie on one straight leg of
 * the path; platforms can turn, with a mitre at each bend. The height must be an even number of
 * risers. Each flight has one tread less than risers: the next level takes the last step.
 *
 * An arrival `exit` opens the last stretch of one side and bridges across to the floor beside it.
 * The arrival then has no posts. It must turn exactly once, at a main column on the exit side, and
 * is one plate: its inner corner is where the line of the stair head meets the inner side, so
 * nothing of it reaches over the flight. A cross beam from that corner lands on the column, and the
 * model carries the inner side at the `seats`, just past the corner and at the end beam, e.g. on
 * arches:
 *
 *   stair head, outer side before the bend → cross beam → seat and column
 *   sides after the bend → cross beam and end beam
 *   end beam → seat and `exit.carriedBy`
 *   bridge → end beam, near edge beam, exit edge beam, `exit.carriedBy`
 *
 * Elements are in world coordinates. Any consistent length unit works.
 */
export interface StairParams {
  /** Plan of the centre line, foot of the stair first; only x and y count. */
  readonly path: readonly Vec3[];
  /** Height of the lower floor (default 0). */
  readonly floor?: number;
  /** Rise from the lower floor to the upper floor. */
  readonly height: number;
  readonly width: number;
  readonly riser: number;
  readonly tread: number;
  readonly treadThickness: number;
  readonly platform: { readonly width: number; readonly length: number };
  /** Platform at the top, along the centre line. */
  readonly arrival?: {
    readonly length: number;
    /** Way off the arrival platform, along its last stretch. */
    readonly exit?: {
      readonly side: "left" | "right";
      readonly length: number;
      readonly reach: number;
      /** Ids of the beams along the far edge of the bridge, which carry the cantilever. */
      readonly carriedBy: readonly string[];
      /** Main column at the bend of the arrival; only x and y of `at` count. */
      readonly column: { readonly id: string; readonly at: Vec3 };
    };
  };
  readonly profiles: {
    /** Local y across, local z upwards. Also frames the platforms. */
    readonly stringer: Profile;
    /** Under the corners of the platforms. */
    readonly post: Profile;
  };
  /** Along both sides of the flights and platforms; without rail beam. */
  readonly handrail?: Omit<HandrailParams, "base" | "alongX" | "padding" | "railBeamDrop" | "color">;
  readonly color?: Vec3;
  readonly treadColor?: Vec3;
}

export type StairRole = "tread" | "platform" | "stringer" | "platformBeam" | "post";

export interface StairDetail {
  readonly role: StairRole;
  readonly element: Element;
  /** 0 = lower flight, 1 = upper flight. */
  readonly flight?: number;
  /** Ids of the details this one transmits its load to. */
  readonly supportedBy: readonly string[];
}

/** Point under a beam without a post, which the model must carry. */
export interface StairSeat {
  /** Id for the support; the beam already names it in `supportedBy`. */
  readonly id: string;
  /** On the axis of the beam, so a support ending here is hidden inside it. */
  readonly at: Vec3;
  readonly carries: readonly string[];
}

export interface Stair extends Instance {
  readonly details: readonly StairDetail[];
  readonly seats: readonly StairSeat[];
  readonly handrails: readonly Handrail[];
  readonly risers: number;
  /** Length along the centre line from the first riser to the upper nosing. */
  readonly run: number;
}

const FRAME_COLOR: Vec3 = [0.3, 0.32, 0.36];
const TREAD_COLOR: Vec3 = [0.78, 0.76, 0.72];
/** Shorter pieces of a handrail are left out. */
const SHORTEST_RAIL = 5;

const halfDepth = (profile: Profile) => Math.max(...profile.outline.map(([, z]) => Math.abs(z)));
const halfWidth = (profile: Profile) => Math.max(...profile.outline.map(([y]) => Math.abs(y)));
const flat = ([x, y]: Vec3): Vec3 => [x, y, 0];
const raised = (q: Vec3, z: number): Vec3 => [q[0], q[1], z];
/** Where the plan lines through a along u and through b along v cross. */
const meet = (a: Vec3, u: Vec3, b: Vec3, v: Vec3): Vec3 => {
  const d = sub(b, a);
  return add(a, scale(u, (d[0] * v[1] - d[1] * v[0]) / (u[0] * v[1] - u[1] * v[0])));
};

/** A strip of the stair in plan, with its left and right edge at each end. */
interface Strip {
  readonly startLeft: Vec3;
  readonly startRight: Vec3;
  readonly endLeft: Vec3;
  readonly endRight: Vec3;
}

export function stair(name: string, p: StairParams): Stair {
  const floor = p.floor ?? 0;
  const risers = Math.round(p.height / p.riser);
  if (Math.abs(risers * p.riser - p.height) > 1e-6 * p.height || risers % 2 !== 0 || risers < 2) {
    throw new Error(`stair: a height of ${p.height} is not an even number of ${p.riser} risers`);
  }
  const perFlight = risers / 2;
  const treads = perFlight - 1;
  const flightRun = treads * p.tread;
  const arrival = p.arrival?.length ?? 0;
  const run = 2 * flightRun + p.platform.length;

  // The centre line by distance along it.
  const nodes = p.path.map(flat);
  const legs = nodes.slice(1).map((q, i) => {
    const along = normalize(sub(q, nodes[i]));
    return { from: nodes[i], along, left: cross(WORLD_Z, along), length: len(sub(q, nodes[i])) };
  });
  const bends: number[] = [];
  legs.reduce((s, leg) => {
    bends.push(s + leg.length);
    return s + leg.length;
  }, 0);
  const total = bends[bends.length - 1];
  if (run + arrival > total + 1e-6) throw new Error("stair: the path is too short");
  const legAt = (s: number) => Math.max(0, bends.findIndex((end) => s <= end + 1e-9));
  const pointAt = (s: number) => {
    const i = legAt(s);
    return add(legs[i].from, scale(legs[i].along, s - (i ? bends[i - 1] : 0)));
  };

  const half = p.width / 2;
  /** Left and right of the centre line at s, on leg i. */
  const across = (s: number, i: number): [Vec3, Vec3] => {
    const q = pointAt(s);
    return [add(q, scale(legs[i].left, half)), add(q, scale(legs[i].left, -half))];
  };
  /** Left and right ends of the mitre at bend i, between legs i and i + 1. */
  const mitre = (i: number): [Vec3, Vec3] => {
    const middle = normalize(add(legs[i].left, legs[i + 1].left));
    const reach = half / dot(middle, legs[i].left);
    const q = legs[i + 1].from;
    return [add(q, scale(middle, reach)), add(q, scale(middle, -reach))];
  };
  /** The strips from s0 to s1, one per leg. */
  const strips = (s0: number, s1: number): Strip[] => {
    const inside = bends.slice(0, -1).map((b, i) => ({ b, i })).filter(({ b }) => b > s0 + 1e-9 && b < s1 - 1e-9);
    const cuts = [{ s: s0 }, ...inside.map(({ b, i }) => ({ s: b, bend: i })), { s: s1 }] as { s: number; bend?: number }[];
    return cuts.slice(1).map((end, n) => {
      const start = cuts[n];
      const leg = legAt((start.s + end.s) / 2);
      const [startLeft, startRight] = start.bend === undefined ? across(start.s, leg) : mitre(start.bend);
      const [endLeft, endRight] = end.bend === undefined ? across(end.s, leg) : mitre(end.bend);
      return { startLeft, startRight, endLeft, endRight };
    });
  };

  const color = p.color ?? FRAME_COLOR;
  const treadColor = p.treadColor ?? TREAD_COLOR;
  const { stringer, post } = p.profiles;
  const details: StairDetail[] = [];
  const platformZ = floor + perFlight * p.riser;
  const topZ = floor + p.height;
  const lands = [
    { id: "platform", s0: flightRun, s1: flightRun + p.platform.length, z: platformZ },
    ...(arrival > 0 ? [{ id: "arrival", s0: run, s1: run + arrival, z: topZ }] : []),
  ];

  // Platforms, their frames, and posts at the corners.
  const beamDrop = p.treadThickness + halfDepth(stringer);
  const exit = p.arrival?.exit;
  const exitStart = exit ? run + arrival - exit.length : 0;
  const exitSide = exit?.side === "left" ? 1 : -1;
  const seats: StairSeat[] = [];
  /** Inner side of an arrival with an exit: from the stair head by the corner to the end. */
  let innerSide: readonly [Vec3, Vec3, Vec3] | undefined;
  const posts = new Map<string, { id: string; at: Vec3; top: number }>();
  const postAt = (q: Vec3, top: number) => {
    const key = `${Math.round(q[0] * 10)}_${Math.round(q[1] * 10)}`;
    const found = posts.get(key) ?? { id: `post${posts.size}`, at: q, top };
    posts.set(key, found);
    return found.id;
  };
  const frameBeam = (id: string, a: Vec3, b: Vec3, z: number, supportedBy?: readonly string[]) => details.push({
    role: "platformBeam",
    supportedBy: supportedBy ?? [postAt(a, z - halfDepth(stringer)), postAt(b, z - halfDepth(stringer))],
    element: { id, kind: "straight", start: raised(a, z), end: raised(b, z), profile: stringer, up: [0, 0, 1], color },
  });
  for (const land of lands) {
    const beamZ = land.z - beamDrop;
    const parts = strips(land.s0, land.s1);
    const beams: string[] = [];
    const beam = (id: string, a: Vec3, b: Vec3, supportedBy?: readonly string[]) => {
      beams.push(id);
      frameBeam(id, a, b, beamZ, supportedBy);
    };
    let outlines = parts.map((q) => [q.startRight, q.endRight, q.endLeft, q.startLeft]);
    const leaves = land.id === "arrival" ? exit : undefined;
    if (leaves) {
      if (parts.length !== 2) throw new Error("stair: an arrival with an exit must turn exactly once");
      const [before, after] = parts;
      const [free, held] = exitSide > 0 ? ["left", "right"] : ["right", "left"];
      const [freeStart, freeBend, freeEnd, heldStart, heldBend, heldEnd] = exitSide > 0
        ? [before.startLeft, before.endLeft, after.endLeft, before.startRight, after.startRight, after.endRight]
        : [before.startRight, before.endRight, after.endRight, before.startLeft, after.startLeft, after.endLeft];
      const corner = meet(heldStart, sub(freeStart, heldStart), heldBend, sub(heldEnd, heldBend));
      const column = flat(leaves.column.at);
      const seat = (id: string, at: Vec3, carries: readonly string[]) => {
        seats.push({ id: `${name}_${id}`, at: raised(at, beamZ), carries });
        return `${name}_${id}`;
      };
      // Seats sit clear of the beam ends, so a support wider than the beams stays hidden in them:
      // on the inner side past the corner, and in the joint with the end beam.
      const crossSeat = add(corner, scale(normalize(sub(heldEnd, corner)), 2 * halfWidth(stringer)));
      const endSeat = add(heldEnd, scale(normalize(sub(column, heldEnd)), halfWidth(stringer) / 2));
      const tip = add(freeEnd, scale(legs[legAt(land.s1 - 1e-6)].left, exitSide * leaves.reach));
      beam("arrival_cross", corner, column, [seat("arch_cross", crossSeat, ["arrival_cross", `arrival_${held}1`]), leaves.column.id]);
      beam("arrival_end", heldEnd, tip, [seat("arch_end", endSeat, ["arrival_end"]), ...leaves.carriedBy]);
      beam("arrival_start", corner, freeStart, ["arrival_cross", `arrival_${free}0`]);
      beam(`arrival_${free}0`, freeStart, freeBend, ["arrival_cross"]);
      beam(`arrival_${free}1`, freeBend, freeEnd, ["arrival_cross", "arrival_end"]);
      beam(`arrival_${held}1`, corner, heldEnd, ["arrival_cross", "arrival_end"]);
      const outline = [freeStart, freeBend, freeEnd, heldEnd, corner];
      outlines = [exitSide > 0 ? outline.reverse() : outline];
      innerSide = [heldStart, corner, heldEnd];
    } else {
      beam(`${land.id}_start`, parts[0].startLeft, parts[0].startRight);
      parts.forEach((q, i) => {
        beam(`${land.id}_left${i}`, q.startLeft, q.endLeft);
        beam(`${land.id}_right${i}`, q.startRight, q.endRight);
      });
      const last = parts[parts.length - 1];
      beam(`${land.id}_end`, last.endLeft, last.endRight);
    }
    const z = land.z - p.treadThickness / 2;
    outlines.forEach((outline, i) => details.push({
      role: "platform", supportedBy: beams,
      element: {
        id: `${land.id}${i}`, kind: "plate", thickness: p.treadThickness, color: treadColor,
        corners: outline.map((c) => raised(c, z)),
      },
    }));
  }

  // Treads and the stringers under their edges.
  const stringerId = (flight: number, side: number) => `stringer${flight}_${side}`;
  const flightFloor = [floor, platformZ];
  const flightStart = [0, flightRun + p.platform.length];
  const flightEnd = (flight: number) => flightStart[flight] + flightRun;
  const slope = Math.hypot(flightRun, perFlight * p.riser) / flightRun;
  flightStart.forEach((s0, flight) => {
    const leg = legAt(s0 + flightRun / 2);
    if (legAt(s0 + 1e-6) !== leg || legAt(flightEnd(flight) - 1e-6) !== leg) {
      throw new Error("stair: a flight must lie on one straight leg of the path");
    }
    for (let i = 0; i < treads; i++) {
      const z = flightFloor[flight] + (i + 1) * p.riser - p.treadThickness / 2;
      const [startLeft, startRight] = across(s0 + i * p.tread, leg);
      const [endLeft, endRight] = across(s0 + (i + 1) * p.tread, leg);
      details.push({
        role: "tread", flight, supportedBy: [stringerId(flight, 0), stringerId(flight, 1)],
        element: {
          id: `tread${flight}_${i}`, kind: "plate", thickness: p.treadThickness, color: treadColor,
          corners: [startRight, endRight, endLeft, startLeft].map((c) => raised(c, z)),
        },
      });
    }
    const drop = halfDepth(stringer) * slope + p.treadThickness;
    const lowZ = flightFloor[flight] - drop;
    const highZ = flightFloor[flight] + perFlight * p.riser - drop;
    const startEdges = across(s0, leg);
    const endEdges = across(flightEnd(flight), leg);
    [0, 1].forEach((side) => details.push({
      role: "stringer", flight,
      supportedBy: flight === 0 ? ["platform_start"] : ["platform_end", ...(arrival > 0 ? ["arrival_start"] : [])],
      element: {
        id: stringerId(flight, side), kind: "straight", profile: stringer, up: [0, 0, 1], color,
        start: raised(startEdges[side], lowZ), end: raised(endEdges[side], highZ),
      },
    }));
  });

  // The bridge from the exit across to the floor beside it.
  if (exit) {
    const leg = legAt(exitStart + exit.length / 2);
    const sideways = scale(legs[leg].left, exitSide * (half + exit.reach));
    const [a, b] = [add(pointAt(exitStart), sideways), add(pointAt(run + arrival), sideways)];
    const [c, d] = [add(pointAt(run + arrival), scale(legs[leg].left, exitSide * half)), add(pointAt(exitStart), scale(legs[leg].left, exitSide * half))];
    const corners = exitSide < 0 ? [a, b, c, d] : [d, c, b, a];
    const edgeBeam = `arrival_${exitSide > 0 ? "left" : "right"}${strips(run, run + arrival).length - 1}`;
    frameBeam("bridge_start", d, a, topZ - beamDrop, [edgeBeam, ...exit.carriedBy]);
    details.push({
      role: "platform", supportedBy: ["arrival_end", "bridge_start", edgeBeam, ...exit.carriedBy],
      element: {
        id: "bridge", kind: "plate", thickness: p.treadThickness, color: treadColor,
        corners: corners.map((q) => raised(q, topZ - p.treadThickness / 2)),
      },
    });
  }

  [...posts.values()].forEach(({ id, at, top }) => details.push({
    role: "post", supportedBy: [],
    element: { id, kind: "straight", start: raised(at, floor), end: raised(at, top), profile: post, up: [0, 1, 0], color },
  }));

  // Handrails along both sides.
  const handrails: Handrail[] = [];
  if (p.handrail) {
    const rail = p.handrail;
    const section = (id: string, a: Vec3, b: Vec3) => {
      if (len(sub(b, a)) < SHORTEST_RAIL) return;
      handrails.push(handrail(`${name}_${id}`, { ...rail, ...(p.color ? { color: p.color } : {}), base: a, alongX: b }));
    };
    const onEdges = (id: string, s0: number, s1: number, z: number, sides: readonly number[]) => strips(s0, s1).forEach((q, i) => {
      if (sides.includes(1)) section(`${id}_left${i}`, raised(q.startLeft, z), raised(q.endLeft, z));
      if (sides.includes(-1)) section(`${id}_right${i}`, raised(q.startRight, z), raised(q.endRight, z));
    });
    flightStart.forEach((s0, flight) => {
      const leg = legAt(s0 + flightRun / 2);
      const [startEdges, endEdges] = [across(s0, leg), across(flightEnd(flight), leg)];
      [0, 1].forEach((side) => section(
        `flight${flight}_${side}`, raised(startEdges[side], flightFloor[flight]),
        raised(endEdges[side], flightFloor[flight] + perFlight * p.riser),
      ));
    });
    onEdges("platform", flightRun, flightRun + p.platform.length, platformZ, [1, -1]);
    if (arrival > 0) {
      onEdges("arrival", run, exit ? exitStart : run + arrival, topZ, exit ? [exitSide] : [1, -1]);
      if (exit && innerSide) {
        const [head, corner, end] = innerSide;
        section("arrival_inner0", raised(head, topZ), raised(corner, topZ));
        section("arrival_inner1", raised(corner, topZ), raised(end, topZ));
        const leg = legAt(exitStart + exit.length / 2);
        const outward = scale(legs[leg].left, exitSide);
        for (const [id, s] of [["bridge0", exitStart], ["bridge1", run + arrival]] as const) {
          const edge = add(pointAt(s), scale(outward, half));
          section(id, raised(edge, topZ), raised(add(edge, scale(outward, exit.reach)), topZ));
        }
      }
      const [endLeft, endRight] = across(run + arrival, legAt(run + arrival - 1e-6));
      section("end", raised(endRight, topZ), raised(endLeft, topZ));
    }
  }

  return { name, frame: WORLD_FRAME, details, seats, handrails, risers, run, model: { elements: details.map((d) => d.element) } };
}
