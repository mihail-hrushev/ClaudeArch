import type { Element } from "../fem/types";
import type { Profile } from "../fem/profiles";
import { type Instance, frameFromUp } from "../fem/placement";
import { type Vec3, sub, len } from "../fem/vec";

/**
 * Structural handrail section: a straight run of rail between two points, made of details with
 * a defined load path:
 *
 *   top, middle and kick rails → posts → rail beam
 *
 * - Posts: upright, evenly spaced as close to `postStep` as fits, one at each end.
 * - Top rail, middle rail and kick rail: along the section, one piece per bay between two posts.
 * - Rail beam (optional): one beam below the walking surface carrying the posts, and usually the
 *   edge of the floor as well.
 *
 * Local frame: X along base → alongX, Y = global Z × X, Z = X × Y. Heights are measured plumb
 * from the line base → alongX, which can slope, e.g. along a stair: posts always stand upright.
 * `padding` insets the posts and rails from the ends of the section, e.g. to stand clear of
 * columns. The rail beam keeps the full length, so it still reaches the supports at both ends.
 *
 * Any consistent length unit works.
 */
export interface HandrailParams {
  /** Start of the section, on the walking surface. */
  readonly base: Vec3;
  /** End of the section. */
  readonly alongX: Vec3;
  /** Axis of the top rail above the walking surface. */
  readonly height: number;
  /** Axis of the middle rail. */
  readonly middleHeight: number;
  /** Axis of the kick rail. */
  readonly kickHeight: number;
  /** Target post spacing. */
  readonly postStep: number;
  /** Inset of posts and rails from the ends: one value, or per end. */
  readonly padding?: number | { readonly left?: number; readonly right?: number };
  /** Top of the rail beam below the walking surface (default 0), e.g. the floor thickness. */
  readonly railBeamDrop?: number;
  readonly profiles: {
    readonly post: Profile;
    readonly topRail: Profile;
    readonly middleRail: Profile;
    /** Local y across the rail, local z upwards. */
    readonly kickRail: Profile;
    /** Without it the posts stand on the walking surface. */
    readonly railBeam?: Profile;
  };
  readonly color?: Vec3;
}

export type HandrailRole = "post" | "topRail" | "middleRail" | "kickRail" | "railBeam";

/** One detail of the section; `bay` is the post number, or the bay left to right for rails. */
export interface HandrailDetail {
  readonly role: HandrailRole;
  readonly element: Element;
  readonly bay?: number;
  /** Ids of the details this one transmits its load to. */
  readonly supportedBy: readonly string[];
}

export interface Handrail extends Instance {
  readonly details: readonly HandrailDetail[];
}

const RAIL_COLOR: Vec3 = [0.3, 0.32, 0.36];
const RAIL_BEAM_ID = "rail_beam";

const halfHeight = (profile: Profile) => Math.max(...profile.outline.map(([, z]) => Math.abs(z)));

export function handrail(name: string, p: HandrailParams): Handrail {
  const { profiles } = p;
  const length = len(sub(p.alongX, p.base));
  const pad = typeof p.padding === "number" ? { left: p.padding, right: p.padding } : { left: 0, right: 0, ...p.padding };
  const span = length - pad.left - pad.right;
  if (p.postStep <= 0 || span <= 0) throw new Error("handrail: post step and the length left by the padding must be > 0");

  const frame = frameFromUp(p.base, p.alongX);
  const color = p.color ?? RAIL_COLOR;
  const drop = p.railBeamDrop ?? 0;
  const bays = Math.max(1, Math.round(span / p.postStep));
  const postX = Array.from({ length: bays + 1 }, (_, i) => pad.left + (span * i) / bays);
  const details: HandrailDetail[] = [];
  // World Z in the local frame: plumb, also on a sloping section.
  const plumb: Vec3 = [frame.x[2], 0, frame.z[2]];
  const at = (x: number, height: number): Vec3 => [x + plumb[0] * height, 0, plumb[2] * height];

  if (profiles.railBeam) {
    const z = -drop - halfHeight(profiles.railBeam);
    details.push({
      role: "railBeam", supportedBy: [],
      element: { id: RAIL_BEAM_ID, kind: "straight", start: at(0, z), end: at(length, z), profile: profiles.railBeam, up: plumb, color },
    });
  }

  const postId = (i: number) => `post${i}`;
  postX.forEach((x, i) => details.push({
    role: "post", bay: i, supportedBy: profiles.railBeam ? [RAIL_BEAM_ID] : [],
    element: {
      id: postId(i), kind: "straight", start: at(x, profiles.railBeam ? -drop : 0), end: at(x, p.height),
      profile: profiles.post, up: [0, 1, 0], color,
    },
  }));

  const rails: readonly [HandrailRole, number, Profile][] = [
    ["topRail", p.height, profiles.topRail],
    ["middleRail", p.middleHeight, profiles.middleRail],
    ["kickRail", p.kickHeight, profiles.kickRail],
  ];
  for (const [role, height, profile] of rails) {
    for (let bay = 0; bay < bays; bay++) {
      details.push({
        role, bay, supportedBy: [postId(bay), postId(bay + 1)],
        element: {
          id: `${role}_b${bay}`, kind: "straight", start: at(postX[bay], height), end: at(postX[bay + 1], height),
          profile, up: plumb, color,
        },
      });
    }
  }

  return { name, frame, details, model: { elements: details.map((d) => d.element) } };
}
