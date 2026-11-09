/**
 * Exports a structure document as a binary glTF without the browser (Babylon's NullEngine):
 *   npm run glb -- crystal_palace_v2            writes refs/crystal_palace_v2.glb
 *   npm run glb -- crystal_palace_v2 out.glb    writes the file given
 * The same meshes, materials and exporter as the "Save GLB" button in the app, but without the
 * environment, so glass with the older `reflection` look misses its sky reflection settings; glTF
 * materials (`metallic`/`roughness`) come out exactly as the app saves them. The materials written
 * are listed, e.g. to compare with a reference .glb.
 */
import "@babylonjs/core/Rendering/edgesRenderer";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { buildStructure } from "../src/json/build";
import { buildModel } from "../src/render/elementMesh";
import { structureGlb } from "../src/render/exportGlb";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const [name, out] = process.argv.slice(2);
if (!name) {
  console.error("usage: npm run glb -- <structure name> [out.glb]");
  process.exit(2);
}
const target = out ?? join(ROOT, "refs", `${name}.glb`);

const { model } = buildStructure(JSON.parse(readFileSync(join(ROOT, "structures", `${name}.json`), "utf8")));
const engine = new NullEngine();
const scene = new Scene(engine);
scene.useRightHandedSystem = true; // as the app: Z-up, right-handed (see scene.ts)
const meshes = buildModel(model, scene);
const blob = await structureGlb(scene, meshes, name);
const bytes = Buffer.from(await blob.arrayBuffer());
writeFileSync(target, bytes);

// The JSON chunk's materials, as written.
const jsonLength = bytes.readUInt32LE(12);
const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
console.log(`${name}: ${model.elements.length} elements, ${meshes.length} meshes, ${(bytes.length / 1e6).toFixed(1)} MB -> ${target}`);
for (const m of gltf.materials ?? []) console.log(JSON.stringify(m));
engine.dispose();
