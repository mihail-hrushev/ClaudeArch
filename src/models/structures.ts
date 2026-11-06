/**
 * Structure documents (structures/*.json) as scene models: `?model=<file name without .json>`.
 * Built on demand, so a broken document only fails when it is selected.
 */
import { type BuiltStructure, buildStructure } from "../json/build";

const files = import.meta.glob("../../structures/*.json", { import: "default" });

const keyOf = (path: string) => path.replace(/^.*\//, "").replace(/\.json$/, "");

export const structureKeys = Object.keys(files).map(keyOf);

export async function loadStructure(key: string): Promise<BuiltStructure> {
  const path = Object.keys(files).find((f) => keyOf(f) === key);
  if (!path) throw new Error(`no structure document "${key}" (have: ${structureKeys.join(", ")})`);
  return buildStructure(await files[path]());
}
