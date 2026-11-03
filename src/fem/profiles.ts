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

/**
 * Prism (symmetric trapezoid) section, centroid on the element axis.
 * `width1` at local −z, `width2` at local +z (for curved ribs +z points into the bend,
 * i.e. towards the inside of the vault). A width of 0 gives a triangle.
 */
export function prismProfile(width1: number, width2: number, height: number): Profile {
  if (width1 < 0 || width2 < 0 || width1 + width2 <= 0 || height <= 0) {
    throw new Error("prismProfile: widths must be ≥ 0 (not both 0) and height > 0");
  }
  // Centroid height above the width1 side.
  const zc = (height * (width1 + 2 * width2)) / (3 * (width1 + width2));
  const z1 = -zc;
  const z2 = height - zc;
  const outline: Point2[] = [];
  if (width1 > 0) outline.push([-width1 / 2, z1], [width1 / 2, z1]);
  else outline.push([0, z1]);
  if (width2 > 0) outline.push([width2 / 2, z2], [-width2 / 2, z2]);
  else outline.push([0, z2]);
  return { name: `PR${width1}/${width2}x${height}`, outline };
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
