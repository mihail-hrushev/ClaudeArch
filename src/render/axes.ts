import type { Scene } from "@babylonjs/core/scene";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Element } from "../fem/types";
import { squareProfile } from "../fem/profiles";
import { buildElementMesh } from "./elementMesh";

/** World axes gizmo (X red, Y green, Z blue), independent from the model. */
export function createAxes(scene: Scene, length = 100, thickness = 3): TransformNode {
  const root = new TransformNode("axes", scene);
  const profile = squareProfile(thickness);
  const axes: Element[] = [
    { id: "axisX", kind: "straight", start: [0, 0, 0], end: [length, 0, 0], profile, color: [1, 0.2, 0.2] },
    { id: "axisY", kind: "straight", start: [0, 0, 0], end: [0, length, 0], profile, color: [0.2, 0.85, 0.3] },
    { id: "axisZ", kind: "straight", start: [0, 0, 0], end: [0, 0, length], profile, color: [0.2, 0.4, 1] },
  ];
  for (const el of axes) {
    const mesh = buildElementMesh(el, scene);
    mesh.isPickable = false;
    mesh.parent = root;
  }
  return root;
}
