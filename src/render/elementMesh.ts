import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Material } from "@babylonjs/core/Materials/material";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import type { Element, Model } from "../fem/types";
import type { Vec3 } from "../fem/vec";
import { discretize } from "../fem/discretize";
import { type MeshData, UV_UNIT, sweepProfile } from "../fem/sweep";
import { plateSolid } from "../fem/plate";

/** Render geometry of one element. */
export function elementGeometry(el: Element): MeshData {
  return el.kind === "plate" ? plateSolid(el) : sweepProfile(discretize(el), el.profile, el.endCut);
}

/** Elements sharing a batch key are baked into one mesh (one draw call). */
interface Batch {
  key: string;
  color: Vec3;
  alpha: number;
  /** Glass reflection strength (see PlateElement). */
  reflection?: number;
  /** Glow colour (see PlateElement). */
  emissive?: Vec3;
  /** Physically based look (see PlateElement): rendered with a PBR material when set. */
  pbr?: { metallic: number; roughness: number };
  /** Edge outline threshold (dot of face normals), or null for no outlines. */
  edges: number | null;
  /** Diffuse texture; `tile` = scene units covered by one repeat. */
  texture?: { url: string; tile: number };
  data: MeshData;
}

function batchOf(el: Element): Omit<Batch, "data"> {
  const color = el.color ?? [0.7, 0.7, 0.7];
  const texture = el.texture ? { url: el.texture.url, tile: el.texture.tile ?? UV_UNIT } : undefined;
  const texKey = texture ? `|tex:${texture.url}|${texture.tile}` : "";
  if (el.kind === "plate") {
    const alpha = el.alpha ?? 1;
    const glow = el.emissive ? `|glow:${el.emissive.join(",")}` : "";
    const pbr = el.metallic !== undefined || el.roughness !== undefined ? { metallic: el.metallic ?? 0, roughness: el.roughness ?? 1 } : undefined;
    const pbrKey = pbr ? `|pbr:${pbr.metallic},${pbr.roughness}` : "";
    const reflection = pbr ? undefined : el.reflection; // unused by a PBR material, so not a reason for another batch
    return {
      key: `plate|${color.join(",")}|${alpha}|${reflection ?? ""}${glow}${pbrKey}${texKey}`,
      color, alpha, reflection, emissive: el.emissive, pbr, edges: null, texture,
    };
  }
  // Smooth (round) profiles: skip facet lines (30° for 12 segments), keep caps / sharp joints.
  const edges = el.profile.smooth ? 0.8 : 0.95;
  const pbr = el.metallic !== undefined || el.roughness !== undefined ? { metallic: el.metallic ?? 0, roughness: el.roughness ?? 1 } : undefined;
  const pbrKey = pbr ? `|pbr:${pbr.metallic},${pbr.roughness}` : "";
  return { key: `member|${color.join(",")}|${edges}${pbrKey}${texKey}`, color, alpha: 1, edges, pbr, texture };
}

function append(target: MeshData, src: MeshData) {
  const base = target.positions.length / 3;
  target.positions.push(...src.positions);
  target.normals.push(...src.normals);
  target.uvs.push(...src.uvs);
  for (const i of src.indices) target.indices.push(base + i);
}

/** A glTF-style physically based material: colours linear, as in the glTF file. */
function pbrMaterial(scene: Scene, b: Batch & { pbr: NonNullable<Batch["pbr"]> }): PBRMaterial {
  const mat = new PBRMaterial(`mat_${b.key}`, scene);
  mat.albedoColor = new Color3(b.color[0], b.color[1], b.color[2]);
  mat.metallic = b.pbr.metallic;
  mat.roughness = b.pbr.roughness;
  if (b.emissive) mat.emissiveColor = new Color3(b.emissive[0], b.emissive[1], b.emissive[2]);
  mat.alpha = b.alpha;
  if (b.alpha < 1) mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  // Single-sided, as glTF materials are by default: panes and bars are closed solids, and drawing a
  // pane's back faces too would count it twice (twice the opacity and glow) and turn the glass milky.
  mat.backFaceCulling = true;
  return mat;
}

function material(scene: Scene, b: Batch): StandardMaterial | PBRMaterial {
  if (b.pbr) return pbrMaterial(scene, { ...b, pbr: b.pbr });
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
  if (b.emissive) mat.emissiveColor = new Color3(b.emissive[0], b.emissive[1], b.emissive[2]);
  if (b.texture) {
    // Mesh uvs are world distance / UV_UNIT, so one repeat per `tile` scene units.
    const tex = new Texture(b.texture.url, scene);
    tex.uScale = tex.vScale = UV_UNIT / b.texture.tile;
    mat.diffuseTexture = tex;
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
      batch = { ...b, data: { positions: [], normals: [], uvs: [], indices: [] }, ids: [], firstIndex: [] };
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
    vd.uvs = b.data.uvs;
    vd.indices = b.data.indices;
    vd.applyToMesh(mesh);
    // Our triangles run counter-clockwise around their normals, as in glTF; Babylon's default is
    // clockwise, which in this right-handed scene would cull the outer faces and flip the exported winding.
    mesh.sideOrientation = Material.CounterClockWiseSideOrientation;
    mesh.material = material(scene, b);
    mesh.metadata = { elementIds: b.ids, firstIndex: b.firstIndex, reflection: b.reflection };
    if (b.edges !== null) {
      mesh.enableEdgesRendering(b.edges, true);
      mesh.edgesWidth = 1.5;
      mesh.edgesColor = new Color4(0, 0, 0, 0.6);
    }
    if (b.alpha < 1) mesh.isPickable = false;
    return mesh;
  });
}
