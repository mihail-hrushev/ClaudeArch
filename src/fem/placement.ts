import type { Element, Model } from "./types";
import { type Vec3, add, sub, scale, cross, normalize, WORLD_X, WORLD_Y, WORLD_Z } from "./vec";

/** Orthonormal right-handed local coordinate system (UCS) expressed in world coordinates. */
export interface LocalFrame {
  readonly origin: Vec3;
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;
}

export const WORLD_FRAME: LocalFrame = { origin: [0, 0, 0], x: WORLD_X, y: WORLD_Y, z: WORLD_Z };

/** Frame with X exactly towards `xPoint`, Y = up × X, Z = X × Y. */
export function frameFromUp(origin: Vec3, xPoint: Vec3, up: Vec3 = WORLD_Z): LocalFrame {
  const x = normalize(sub(xPoint, origin));
  const y = normalize(cross(up, x));
  return { origin, x, y, z: cross(x, y) };
}

export const toWorldVector = (f: LocalFrame, v: Vec3): Vec3 =>
  add(add(scale(f.x, v[0]), scale(f.y, v[1])), scale(f.z, v[2]));

export const toWorldPoint = (f: LocalFrame, p: Vec3): Vec3 => add(f.origin, toWorldVector(f, p));

/** Maps every point / direction of an element from frame `f` to world coordinates. */
export function transformElement(el: Element, f: LocalFrame, id = el.id): Element {
  if (el.kind === "plate") {
    return { ...el, id, corners: el.corners.map((p) => toWorldPoint(f, p)) };
  }
  const common = {
    id,
    start: toWorldPoint(f, el.start),
    end: toWorldPoint(f, el.end),
    up: el.up && toWorldVector(f, el.up),
    endCut: el.endCut && toWorldVector(f, el.endCut),
  };
  switch (el.kind) {
    case "straight":
      return { ...el, ...common };
    case "arc":
      return { ...el, ...common, startTangent: toWorldVector(f, el.startTangent) };
    case "polyline":
      return { ...el, ...common, nodes: el.nodes.map((p) => toWorldPoint(f, p)) };
  }
}

/** One placed copy of a model: geometry defined in `frame` coordinates. */
export interface Instance {
  readonly name: string;
  readonly model: Model;
  readonly frame: LocalFrame;
}

/** Flattens instances into one world-space model; ids become `<instance>/<id>`. */
export function assemble(instances: readonly Instance[]): Model {
  return {
    elements: instances.flatMap((inst) =>
      inst.model.elements.map((el) => transformElement(el, inst.frame, `${inst.name}/${el.id}`)),
    ),
  };
}
