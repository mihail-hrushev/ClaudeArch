import type { Scene } from "@babylonjs/core/scene";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Element } from "../fem/types";
import { squareProfile } from "../fem/profiles";
import { type LocalFrame, WORLD_FRAME, transformElement } from "../fem/placement";
import { buildElementMesh } from "./elementMesh";

/** Axes gizmo (X red, Y green, Z blue) of a coordinate system, independent from the model. */
export function createAxes(
  scene: Scene,
  { frame = WORLD_FRAME, length = 100, thickness = 3, name = "axes" }:
    { frame?: LocalFrame; length?: number; thickness?: number; name?: string } = {},
): TransformNode {
  const root = new TransformNode(name, scene);
  const profile = squareProfile(thickness);
  const axes: Element[] = [
    { id: "X", kind: "straight", start: [0, 0, 0], end: [length, 0, 0], profile, color: [1, 0.2, 0.2] },
    { id: "Y", kind: "straight", start: [0, 0, 0], end: [0, length, 0], profile, color: [0.2, 0.85, 0.3] },
    { id: "Z", kind: "straight", start: [0, 0, 0], end: [0, 0, length], profile, color: [0.2, 0.4, 1] },
  ];
  for (const el of axes) {
    const mesh = buildElementMesh(transformElement(el, frame, `${name}/${el.id}`), scene);
    mesh.isPickable = false;
    mesh.parent = root;
  }
  return root;
}
