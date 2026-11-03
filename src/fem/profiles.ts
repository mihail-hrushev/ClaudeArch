/**
 * Cross-section profiles, defined in the element's local (y, z) plane.
 * Outline points must be counter-clockwise (y right, z up) and convex.
 */
export type Point2 = readonly [number, number];

export interface Profile {
  readonly name: string;
  readonly outline: readonly Point2[];
  /** Smooth side shading (round sections); flat shading otherwise. */
  readonly smooth?: boolean;
}

/** Circle approximated by a regular polygon (first vertex on local +y). */
export function circleProfile(radius: number, segments = 12): Profile {
  return {
    name: `CHS${2 * radius}`,
    smooth: true,
    outline: Array.from({ length: segments }, (_, i): Point2 => {
      const a = (2 * Math.PI * i) / segments;
      return [radius * Math.cos(a), radius * Math.sin(a)];
    }),
  };
}

export function squareProfile(size: number): Profile {
  const h = size / 2;
  return {
    name: `SQ${size}`,
    outline: [
      [-h, -h],
      [h, -h],
      [h, h],
      [-h, h],
    ],
  };
}
