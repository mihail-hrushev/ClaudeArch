import type { Element, Model } from "./types";
import { type Vec3, sub, len } from "./vec";

const near = (a: Vec3, b: Vec3, tol: number) => len(sub(a, b)) <= tol;

/** Same straight member: same profile and coincident end points (either direction). */
function sameStraight(a: Element, b: Element, tol: number): boolean {
  if (a.kind !== "straight" || b.kind !== "straight") return false;
  if (a.profile.name !== b.profile.name) return false;
  return (
    (near(a.start, b.start, tol) && near(a.end, b.end, tol)) ||
    (near(a.start, b.end, tol) && near(a.end, b.start, tol))
  );
}

/**
 * Removes coincident duplicate straight members, e.g. a column shared by two neighbouring
 * bays after assembly. The first occurrence (and its id) is kept.
 */
export function removeDuplicateMembers(model: Model, tol = 1e-6): Model {
  const kept: Element[] = [];
  for (const el of model.elements) {
    if (!kept.some((k) => sameStraight(k, el, tol))) kept.push(el);
  }
  return { ...model, elements: kept };
}
