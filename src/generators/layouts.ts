import type { Model } from "../fem/types";
import { type Instance, lookAt } from "../fem/placement";
import { type Vec3, add } from "../fem/vec";

export interface RingLayoutParams {
  readonly count: number;
  /** Plan distance from the ring center to each instance origin. */
  readonly radius: number;
  /** Total angle covered (radians): 2π full ring, π half ring. */
  readonly sweep?: number;
  /** Angle where the sweep starts (radians, from world X). */
  readonly startAngle?: number;
  readonly center?: Vec3;
  readonly name?: string;
}

/**
 * Places copies of a model around a center: the sweep is split into `count` equal sectors,
 * one instance per sector (at its mid-angle), local +X looking at the center.
 */
export function ringLayout(model: Model, p: RingLayoutParams): Instance[] {
  const sweep = p.sweep ?? 2 * Math.PI;
  const start = p.startAngle ?? 0;
  const center = p.center ?? [0, 0, 0];
  return Array.from({ length: p.count }, (_, i) => {
    const a = start + (sweep * (i + 0.5)) / p.count;
    const origin = add(center, [p.radius * Math.cos(a), p.radius * Math.sin(a), 0]);
    return { name: `${p.name ?? "ring"}${i}`, model, frame: lookAt(origin, center) };
  });
}

/**
 * Fits a trapezoidal bay (narrow end towards the center) exactly into a ring sector:
 * both long sides lie on the sector borders, so neighbouring bays share their side walls.
 * Given the bay length and inner (narrow) width, returns the outer (wide) width and the
 * ring radius of the bay center.
 */
export function fitRingBay(length: number, innerWidth: number, sectorAngle: number) {
  const t = Math.tan(sectorAngle / 2);
  const innerDist = innerWidth / 2 / t;
  const outerDist = innerDist + length;
  return { outerWidth: 2 * outerDist * t, radius: innerDist + length / 2 };
}
