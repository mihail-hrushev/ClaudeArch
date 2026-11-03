import type { Model } from "./fem/types";
import { squareProfile } from "./fem/profiles";

const SQ = squareProfile(5);

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
