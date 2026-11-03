/**
 * Cross-section profiles, defined in the element's local (y, z) plane.
 * Outline points must be counter-clockwise (y right, z up) and convex.
 */
export type Point2 = readonly [number, number];

export interface Profile {
  readonly name: string;
  readonly outline: readonly Point2[];
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
