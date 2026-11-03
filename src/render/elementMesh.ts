import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import type { Element, Model } from "../fem/types";
import type { Vec3 } from "../fem/vec";
import { discretize } from "../fem/discretize";
import { type MeshData, sweepProfile } from "../fem/sweep";
import { plateSolid } from "../fem/plate";

/** Render geometry of one element. */
export function elementGeometry(el: Element): MeshData {
  return el.kind === "plate" ? plateSolid(el) : sweepProfile(discretize(el), el.profile);
}

/** Elements sharing a batch key are baked into one mesh (one draw call). */
interface Batch {
  key: string;
  color: Vec3;
  alpha: number;
  /** Edge outline threshold (dot of face normals), or null for no outlines. */
  edges: number | null;
  data: MeshData;
}

function batchOf(el: Element): Omit<Batch, "data"> {
  const color = el.color ?? [0.7, 0.7, 0.7];
  if (el.kind === "plate") {
    const alpha = el.alpha ?? 1;
    return { key: `plate|${color.join(",")}|${alpha}`, color, alpha, edges: null };
  }
  // Smooth (round) profiles: skip facet lines (30° for 12 segments), keep caps / sharp joints.
  const edges = el.profile.smooth ? 0.8 : 0.95;
  return { key: `member|${color.join(",")}|${edges}`, color, alpha: 1, edges };
}

function append(target: MeshData, src: MeshData) {
  const base = target.positions.length / 3;
  target.positions.push(...src.positions);
  target.normals.push(...src.normals);
  for (const i of src.indices) target.indices.push(base + i);
}

function material(scene: Scene, b: Batch): StandardMaterial {
  const mat = new StandardMaterial(`mat_${b.key}`, scene);
  mat.diffuseColor = new Color3(b.color[0], b.color[1], b.color[2]);
  mat.backFaceCulling = false;
  if (b.alpha < 1) {
    // Glass
    mat.alpha = b.alpha;
    mat.specularColor = new Color3(0.9, 0.95, 0.95);
    mat.specularPower = 64;
    mat.twoSidedLighting = true;
  } else {
    mat.specularColor = new Color3(0.15, 0.15, 0.15);
  }
  return mat;
}

/**
 * Builds the model as baked meshes: all elements with the same material are merged into a
 * single mesh, so draw calls scale with the number of materials, not elements.
 * Mesh metadata keeps the element id ranges (first index of each element) for picking later.
 */
export function buildModel(model: Model, scene: Scene, name = "model"): Mesh[] {
  const batches = new Map<string, Batch & { ids: string[]; firstIndex: number[] }>();
  for (const el of model.elements) {
    const b = batchOf(el);
    let batch = batches.get(b.key);
    if (!batch) {
      batch = { ...b, data: { positions: [], normals: [], indices: [] }, ids: [], firstIndex: [] };
      batches.set(b.key, batch);
    }
    batch.ids.push(el.id);
    batch.firstIndex.push(batch.data.indices.length);
    append(batch.data, elementGeometry(el));
  }

  return [...batches.values()].map((b) => {
    const mesh = new Mesh(`${name}:${b.key}`, scene);
    const vd = new VertexData();
    vd.positions = b.data.positions;
    vd.normals = b.data.normals;
    vd.indices = b.data.indices;
    vd.applyToMesh(mesh);
    mesh.material = material(scene, b);
    mesh.metadata = { elementIds: b.ids, firstIndex: b.firstIndex };
    if (b.edges !== null) {
      mesh.enableEdgesRendering(b.edges, true);
      mesh.edgesWidth = 1.5;
      mesh.edgesColor = new Color4(0, 0, 0, 0.6);
    }
    if (b.alpha < 1) mesh.isPickable = false;
    return mesh;
  });
}
