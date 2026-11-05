import type { Model } from "../fem/types";
import { squareProfile } from "../fem/profiles";
import { WORLD_FRAME, assemble } from "../fem/placement";
import { removeDuplicateMembers } from "../fem/dedupe";
import type { View } from "./view";

const SQ = squareProfile(5);

/** Axis test elements: one straight bar per world axis and a quarter arc from +X to +Z. */
export const testModel: Model = {
  elements: [
    { id: "vertical", kind: "straight", start: [0, 0, 0], end: [0, 0, 100], profile: SQ, color: [0.2, 0.4, 1] },
    { id: "alongX", kind: "straight", start: [0, 0, 0], end: [100, 0, 0], profile: SQ, color: [1, 0.2, 0.2] },
    { id: "alongY", kind: "straight", start: [0, 0, 0], end: [0, 100, 0], profile: SQ, color: [0.2, 0.85, 0.3] },
    {
      id: "arc",
      kind: "arc",
      start: [100, 0, 0],
      end: [0, 0, 100],
      startTangent: [0, 0, 1],
      segmentLength: 40,
      profile: SQ,
      color: [1, 0.85, 0.1],
    },
  ],
};

/** The test model placed at the world origin, through the same assembly pipeline as every model. */
export function buildTestModel(): Model {
  return removeDuplicateMembers(assemble([{ name: "test", model: testModel, frame: WORLD_FRAME }]));
}

export const testView: View = { target: [0, 250, 300], radius: 2000, alpha: -Math.PI / 2, beta: Math.PI / 2.8 };
