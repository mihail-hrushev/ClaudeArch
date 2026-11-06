/**
 * Ivy decoration layer: renders the procedural ivy of src/decor/ivy.ts over the model, strictly
 * separate from the structural meshes. Branches are one tube mesh, leaves one textured quad
 * drawn as thin instances; everything hangs under a TransformNode "ivy" that can be toggled.
 */
import "@babylonjs/core/Meshes/thinInstanceMesh";
import "@babylonjs/core/Rendering/geometryBufferRendererSceneComponent";
import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Material } from "@babylonjs/core/Materials/material";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Model } from "../fem/types";
import { type Vec3, add, cross, normalize, scale, transport, WORLD_Z } from "../fem/vec";
import { type IvyParams, type IvyResult, generateIvy } from "../decor/ivy";

export interface IvyLayer {
  /** Parent of every ivy mesh, named "ivy". */
  root: TransformNode;
  meshes: Mesh[];
  /** The generated ivy (branches and leaves) for inspection. */
  result: IvyResult;
  setEnabled(on: boolean): void;
  readonly enabled: boolean;
}

/** Whatever owns the lighting (the Environment): told about the ivy meshes so they cast its shadows. */
export interface IvyShadowHost {
  addShadowCasters(meshes: AbstractMesh[]): void;
}

/** Sides of a branch tube. */
const TUBE_SIDES = 6;
const LEAF_TEXTURE_URL = "textures/ivy-leaf.png";

/** Generates ivy over the model and builds its meshes. */
export function createIvyLayer(scene: Scene, model: Model, host?: IvyShadowHost, params: Partial<IvyParams> = {}): IvyLayer {
  const t0 = performance.now();
  const result = generateIvy(model, params);
  const t1 = performance.now();

  const root = new TransformNode("ivy", scene);
  const meshes: Mesh[] = [];

  // --- Branches: one tube mesh over all polylines ---
  const branches = new Mesh("ivy_branches", scene);
  branchTubes(result).applyToMesh(branches);
  const branchMat = new StandardMaterial("ivy_branches", scene);
  branchMat.diffuseColor = new Color3(0.2, 0.17, 0.09);
  branchMat.specularColor = new Color3(0.05, 0.05, 0.04);
  branches.material = branchMat;
  meshes.push(branches);

  // --- Leaves: a unit quad (x across, y from stem to tip, facing +z) as thin instances ---
  const leaves = new Mesh("ivy_leaves", scene);
  const quad = new VertexData();
  quad.positions = [-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0];
  quad.normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
  quad.uvs = [0, 0, 1, 0, 1, 1, 0, 1];
  quad.indices = [0, 1, 2, 0, 2, 3];
  quad.applyToMesh(leaves);
  const matrices = new Float32Array(result.leaves.length * 16);
  result.leaves.forEach((leaf, i) => {
    const y = leaf.tangent;
    const z = leaf.normal;
    const x = cross(y, z);
    const s = leaf.size;
    const o = i * 16;
    matrices[o] = x[0] * s; matrices[o + 1] = x[1] * s; matrices[o + 2] = x[2] * s; matrices[o + 3] = 0;
    matrices[o + 4] = y[0] * s; matrices[o + 5] = y[1] * s; matrices[o + 6] = y[2] * s; matrices[o + 7] = 0;
    matrices[o + 8] = z[0]; matrices[o + 9] = z[1]; matrices[o + 10] = z[2]; matrices[o + 11] = 0;
    matrices[o + 12] = leaf.position[0]; matrices[o + 13] = leaf.position[1]; matrices[o + 14] = leaf.position[2]; matrices[o + 15] = 1;
  });
  leaves.thinInstanceSetBuffer("matrix", matrices, 16, true);
  leaves.thinInstanceRefreshBoundingInfo(false);
  const leafMat = new StandardMaterial("ivy_leaves", scene);
  const leafTex = new Texture(LEAF_TEXTURE_URL, scene);
  leafTex.hasAlpha = true;
  leafMat.diffuseTexture = leafTex;
  leafMat.useAlphaFromDiffuseTexture = false;
  leafMat.transparencyMode = Material.MATERIAL_ALPHATEST;
  leafMat.alphaCutOff = 0.5;
  leafMat.backFaceCulling = false;
  leafMat.twoSidedLighting = true;
  leafMat.specularColor = new Color3(0.12, 0.14, 0.1);
  leafMat.specularPower = 24;
  leaves.material = leafMat;
  meshes.push(leaves);

  // --- Scene integration: tagging, shadows (the sun's generator found through the lights, plus
  // whatever the host adds, e.g. the night lights), ambient occlusion ---
  const generators = scene.lights
    .map((light) => light.getShadowGenerator())
    .filter((g): g is ShadowGenerator => g instanceof ShadowGenerator);
  for (const mesh of meshes) {
    mesh.parent = root;
    mesh.metadata = { layer: "ivy" };
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    for (const g of generators) g.addShadowCaster(mesh);
    scene.geometryBufferRenderer?.renderList?.push(mesh);
  }
  host?.addShadowCasters(meshes);
  const refreshShadows = () => {
    for (const g of generators) g.getShadowMap()?.resetRefreshCounter();
  };
  refreshShadows();

  const s = result.stats;
  console.info(
    `ivy: ${s.roots} roots, ${s.nodes} nodes, ${s.leaves} leaves, top ${s.maxHeight.toFixed(0)} cm; ` +
    `surface ${s.surfaceMs.toFixed(0)} ms, growth ${s.growMs.toFixed(0)} ms, meshes ${(performance.now() - t1).toFixed(0)} ms, ` +
    `total ${(performance.now() - t0).toFixed(0)} ms; shadows on ${generators.length} generator(s)`,
  );

  let enabled = true;
  return {
    root,
    meshes,
    result,
    get enabled() {
      return enabled;
    },
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      root.setEnabled(on);
      refreshShadows();
    },
  };
}

/**
 * Hooks the layer into the page: created at start-up only with "?ivy=1" (the baseline look stays
 * unchanged), and the "I" key toggles it, creating it on first use when it was not requested.
 */
export function installIvyToggle(scene: Scene, model: Model, host?: IvyShadowHost, params: Partial<IvyParams> = {}): void {
  let layer: IvyLayer | null = null;
  const create = () => (layer ??= createIvyLayer(scene, model, host, params));
  if (new URLSearchParams(location.search).get("ivy") === "1") create();
  window.addEventListener("keydown", (e) => {
    if (e.key !== "i" && e.key !== "I") return;
    if (layer) layer.setEnabled(!layer.enabled);
    else create();
  });
}

/** Tube geometry (TUBE_SIDES-gon rings, smooth normals) along every branch polyline. */
function branchTubes(result: IvyResult): VertexData {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const branch of result.branches) {
    const nodes = branch.nodes;
    const n = nodes.length;
    if (n < 2) continue;
    // Segment tangents, averaged at interior nodes; a rotation-minimizing frame transported along.
    const tangents: Vec3[] = nodes.map((_, i) => {
      const a = nodes[Math.max(0, i - 1)].position;
      const b = nodes[Math.min(n - 1, i + 1)].position;
      const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      return Math.hypot(d[0], d[1], d[2]) < 1e-9 ? WORLD_Z : normalize(d);
    });
    const helper: Vec3 = Math.abs(tangents[0][2]) < 0.9 ? WORLD_Z : [1, 0, 0];
    let u = normalize(cross(tangents[0], helper));
    const base = positions.length / 3;
    for (let i = 0; i < n; i++) {
      if (i > 0) u = normalize(cross(cross(tangents[i], transport(u, tangents[i - 1], tangents[i])), tangents[i]));
      const v = cross(tangents[i], u);
      const { position, radius } = nodes[i];
      for (let k = 0; k < TUBE_SIDES; k++) {
        const a = (k / TUBE_SIDES) * Math.PI * 2;
        const nrm = add(scale(u, Math.cos(a)), scale(v, Math.sin(a)));
        const p = add(position, scale(nrm, radius));
        positions.push(p[0], p[1], p[2]);
        normals.push(nrm[0], nrm[1], nrm[2]);
        uvs.push(k / TUBE_SIDES, i);
      }
      if (i > 0) {
        const r0 = base + (i - 1) * TUBE_SIDES;
        const r1 = base + i * TUBE_SIDES;
        for (let k = 0; k < TUBE_SIDES; k++) {
          const k1 = (k + 1) % TUBE_SIDES;
          indices.push(r0 + k, r0 + k1, r1 + k1, r0 + k, r1 + k1, r1 + k);
        }
      }
    }
  }
  const vd = new VertexData();
  vd.positions = positions;
  vd.normals = normals;
  vd.uvs = uvs;
  vd.indices = indices;
  return vd;
}
