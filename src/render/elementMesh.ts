import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import type { Element, Model } from "../fem/types";
import type { Vec3 } from "../fem/vec";
import { discretize } from "../fem/discretize";
import { sweepProfile } from "../fem/sweep";

const materialCache = new Map<string, StandardMaterial>();

function materialFor(scene: Scene, color: Vec3): StandardMaterial {
  const key = color.join(",");
  let mat = materialCache.get(key);
  if (!mat) {
    mat = new StandardMaterial(`mat_${key}`, scene);
    mat.diffuseColor = new Color3(color[0], color[1], color[2]);
    mat.specularColor = new Color3(0.15, 0.15, 0.15);
    mat.backFaceCulling = false;
    materialCache.set(key, mat);
  }
  return mat;
}

export function buildElementMesh(el: Element, scene: Scene): Mesh {
  const data = sweepProfile(discretize(el), el.profile);
  const mesh = new Mesh(el.id, scene);
  const vd = new VertexData();
  vd.positions = data.positions;
  vd.normals = data.normals;
  vd.indices = data.indices;
  vd.applyToMesh(mesh);
  mesh.material = materialFor(scene, el.color ?? [0.7, 0.7, 0.7]);
  // Smooth (round) profiles: skip facet lines (30° for 12 segments), keep caps / sharp joints.
  mesh.enableEdgesRendering(el.profile.smooth ? 0.8 : 0.95, true);
  mesh.edgesWidth = 1.5;
  mesh.edgesColor = new Color4(0, 0, 0, 0.6);
  return mesh;
}

export function buildModel(model: Model, scene: Scene): Mesh[] {
  return model.elements.map((el) => buildElementMesh(el, scene));
}
