import type { Element, Model } from "./types";
import { type Vec3, add, sub, scale, dot, cross, normalize, WORLD_X, WORLD_Y, WORLD_Z } from "./vec";

/** Orthonormal right-handed local coordinate system (UCS) expressed in world coordinates. */
export interface LocalFrame {
  readonly origin: Vec3;
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;
}

export const WORLD_FRAME: LocalFrame = { origin: [0, 0, 0], x: WORLD_X, y: WORLD_Y, z: WORLD_Z };

/** Frame from an origin, a local X direction and an up hint (local Z, orthogonalized). */
export function frameFromX(origin: Vec3, xDir: Vec3, up: Vec3 = WORLD_Z): LocalFrame {
  const z0 = normalize(up);
  const x = normalize(sub(xDir, scale(z0, dot(xDir, z0)))); // keep X perpendicular to up
  const z = normalize(cross(x, cross(z0, x)));
  return { origin, x, y: cross(z, x), z };
}

/** Frame at `origin` whose local +X points (horizontally) at `target`, local Z = up. */
export const lookAt = (origin: Vec3, target: Vec3, up: Vec3 = WORLD_Z): LocalFrame =>
  frameFromX(origin, sub(target, origin), up);

export const toWorldVector = (f: LocalFrame, v: Vec3): Vec3 =>
  add(add(scale(f.x, v[0]), scale(f.y, v[1])), scale(f.z, v[2]));

export const toWorldPoint = (f: LocalFrame, p: Vec3): Vec3 => add(f.origin, toWorldVector(f, p));

/** Maps every point / direction of an element from frame `f` to world coordinates. */
export function transformElement(el: Element, f: LocalFrame, id = el.id): Element {
  const common = {
    id,
    start: toWorldPoint(f, el.start),
    end: toWorldPoint(f, el.end),
    up: el.up && toWorldVector(f, el.up),
  };
  switch (el.kind) {
    case "straight":
      return { ...el, ...common };
    case "arc":
      return { ...el, ...common, startTangent: toWorldVector(f, el.startTangent) };
    case "ellipticArc":
      return {
        ...el,
        ...common,
        startTangent: toWorldVector(f, el.startTangent),
        baseEnd: toWorldPoint(f, el.baseEnd),
      };
  }
}

/** One placed copy of a model: geometry defined in `frame` coordinates. */
export interface Instance {
  readonly name: string;
  readonly model: Model;
  readonly frame: LocalFrame;
}

/** Flattens instances into one world-space model; element ids become `<instance>/<element>`. */
export function assemble(instances: readonly Instance[]): Model {
  return {
    elements: instances.flatMap((inst) =>
      inst.model.elements.map((el) => transformElement(el, inst.frame, `${inst.name}/${el.id}`)),
    ),
  };
}
