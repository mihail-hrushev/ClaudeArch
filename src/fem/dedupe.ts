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

/** Same polyline member: same profile and coincident nodes in the same order. */
function samePolyline(a: Element, b: Element, tol: number): boolean {
  if (a.kind !== "polyline" || b.kind !== "polyline") return false;
  if (a.profile.name !== b.profile.name || a.nodes.length !== b.nodes.length) return false;
  return a.nodes.every((p, i) => near(p, b.nodes[i], tol));
}

/**
 * Removes coincident duplicate members, e.g. a column shared by two neighbouring bays or a
 * rib shared by two cut surfaces after assembly. The first occurrence (and its id) is kept.
 */
export function removeDuplicateMembers(model: Model, tol = 1e-6): Model {
  const kept: Element[] = [];
  // Candidates by the X of their midpoint (independent of direction), in unit-wide cells.
  const cells = new Map<number, Element[]>();
  for (const el of model.elements) {
    if (el.kind !== "straight" && el.kind !== "polyline") {
      kept.push(el);
      continue;
    }
    const cell = Math.round((el.start[0] + el.end[0]) / 2);
    const candidates = [cell - 1, cell, cell + 1].flatMap((c) => cells.get(c) ?? []);
    if (candidates.some((k) => sameStraight(k, el, tol) || samePolyline(k, el, tol))) continue;
    kept.push(el);
    cells.set(cell, [...(cells.get(cell) ?? []), el]);
  }
  return { ...model, elements: kept };
}
