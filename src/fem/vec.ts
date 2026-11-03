/** Minimal immutable 3D vector math (right-handed, Z-up world). */
export type Vec3 = readonly [number, number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => {
  const l = len(a);
  if (l < 1e-12) throw new Error("Cannot normalize zero-length vector");
  return scale(a, 1 / l);
};

/** Rodrigues rotation of v around unit axis k by angle (radians). */
export function rotateAroundAxis(v: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

/** Rotate v by the minimal rotation that takes unit vector `from` onto unit vector `to`. */
export function transport(v: Vec3, from: Vec3, to: Vec3): Vec3 {
  const axis = cross(from, to);
  const s = len(axis);
  if (s < 1e-12) return v; // parallel: nothing to rotate
  return rotateAroundAxis(v, scale(axis, 1 / s), Math.atan2(s, dot(from, to)));
}

export const WORLD_X: Vec3 = [1, 0, 0];
export const WORLD_Y: Vec3 = [0, 1, 0];
export const WORLD_Z: Vec3 = [0, 0, 1];
