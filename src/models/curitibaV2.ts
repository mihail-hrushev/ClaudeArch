import type { Model } from "../fem/types";
import { circleProfile, rectangleProfile, squareProfile } from "../fem/profiles";
import { assemble } from "../fem/placement";
import { removeDuplicateMembers } from "../fem/dedupe";
import { curitibaV2 } from "../generators/curitibaV2";
import type { View } from "./view";

/** Scene units are centimetres: lets a size be specified in millimetres. */
const mm = (v: number) => v / 10;

/** Glass shared by all the surface types of Curitiba v2. */
const V2_GLASS = { thickness: 1.2, gap: 1.5, alpha: 0.5, reflection: 0.5, align: "middle-center" as const };

/** Handrail heights, spacing and sections, in scene units. */
const HANDRAIL = () => ({
  height: mm(1100), middleHeight: mm(600), kickHeight: mm(150), postStep: mm(1500),
  profiles: {
    post: squareProfile(mm(60)),
    topRail: circleProfile(mm(25)),
    middleRail: circleProfile(mm(12)),
    kickRail: rectangleProfile(mm(10), mm(120)),
  },
});

/** Section of the arches, their shafts, the ground columns and the stair posts: 100 mm diameter. */
const ARCH_SECTION = () => circleProfile(mm(50));

/** Stair sizes, in scene units. */
const STAIR = () => ({
  width: mm(1200), riser: mm(200), tread: mm(220), treadThickness: mm(40),
  platform: { width: mm(1200), length: mm(1600) },
  profiles: { stringer: rectangleProfile(mm(60), mm(240)), post: ARCH_SECTION() },
});

/**
 * Curitiba Botanical Garden style greenhouse built only from glass surfaces: a core of three
 * equal octagonal domed towers touching corner to corner, wrapped by a lower glazed ground
 * floor with an ambulatory and a walk floor reached by stairs.
 */
export function buildCuritibaV2(): Model {
  const archSection = ARCH_SECTION();
  const instance = curitibaV2({
    tower: { apothem: 420, wallHeight: 1100, rise: 560 },
    ground: { margin: 300, wallHeight: 600, roofAngle: 40 },
    ambulatory: {
      column: circleProfile(15), arch: archSection, wallColumn: archSection,
      roofBeam: rectangleProfile(12, 24), eavesBeam: rectangleProfile(12, 24),
    },
    walkFloor: {
      height: 360, deckThickness: 10, beam: rectangleProfile(12, 24), stair: STAIR(),
      handrail: { ...HANDRAIL(), profiles: { ...HANDRAIL().profiles, railBeam: rectangleProfile(12, 24) } },
    },
    surfaces: {
      towerWall: {
        ribStep: 175,
        tile: { width: 50, length: 100, ...V2_GLASS, align: "top-center" },
        profiles: {
          mainRib: rectangleProfile(5, 14), cutRib: rectangleProfile(8, 20),
          horizontalFrame: rectangleProfile(3, 8), verticalFrame: rectangleProfile(3, 6),
        },
      },
      towerDome: {
        ribStep: 175,
        tile: { width: 50, length: 100, ...V2_GLASS },
        profiles: {
          mainRib: rectangleProfile(5, 14), cutRib: rectangleProfile(8, 20),
          horizontalFrame: rectangleProfile(3, 8), verticalFrame: rectangleProfile(3, 6),
        },
      },
      groundWall: {
        ribStep: 280,
        padding: { left: 5, right: 5 }, // keeps the edge ribs clear of the columns
        tile: { width: 50, length: 100, ...V2_GLASS, align: "top-center" },
        profiles: {
          mainRib: rectangleProfile(5, 14), cutRib: rectangleProfile(5, 14),
          horizontalFrame: rectangleProfile(3, 8), verticalFrame: rectangleProfile(3, 6),
        },
      },
      groundRoof: {
        tile: { width: 50, length: 100, ...V2_GLASS, align: "bottom-center" },
        profiles: {
          mainRib: rectangleProfile(5, 14), cutRib: rectangleProfile(8, 20),
          horizontalFrame: rectangleProfile(3, 8), verticalFrame: rectangleProfile(3, 6),
        },
      },
    },
    color: [0.97, 0.97, 0.95],
  });
  // Neighbouring surfaces share their edge ribs and columns: drop the coincident copies.
  return removeDuplicateMembers(assemble([instance]));
}

export const curitibaV2View: View = { target: [0, 0, 600], radius: 3900, alpha: Math.PI / 2 + 0.65, beta: Math.PI / 2.5 };
