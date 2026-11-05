/**
 * Regression snapshot of the model geometry (Babylon-free, runs under tsx).
 *   npm run snapshot          compare every model against snapshots/<name>.json, exit 1 on a difference
 *   npm run snapshot:update   (re)write the snapshot files
 * Numbers are rounded to 9 decimals so the files are stable across platforms.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "../src/fem/types";
import { buildCuritibaV2 } from "../src/models/curitibaV2";
import { buildTestModel } from "../src/models/testModel";

const MODELS: Record<string, () => Model> = {
  curitibaV2: buildCuritibaV2,
  testModel: buildTestModel,
};

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "snapshots");
const update = process.argv.includes("--update");

const round = (_key: string, value: unknown) =>
  typeof value === "number" ? Number(value.toFixed(9)) : value;

/** One element per line: readable git diffs, and a cheap line count. */
const serialize = (model: Model): string =>
  "[\n" + model.elements.map((el) => JSON.stringify(el, round)).join(",\n") + "\n]\n";

/** Path of the first differing field between two JSON values, or null when equal. */
function firstDifference(a: unknown, b: unknown, path = ""): string | null {
  if (a === b) return null;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const diff = firstDifference(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      path ? `${path}.${key}` : key,
    );
    if (diff) return diff;
  }
  return null;
}

let failed = false;
mkdirSync(DIR, { recursive: true });
for (const [name, build] of Object.entries(MODELS)) {
  const file = join(DIR, `${name}.json`);
  const model = build();
  const actual = serialize(model);
  if (update) {
    writeFileSync(file, actual);
    console.log(`${name}: wrote ${model.elements.length} elements to ${file}`);
    continue;
  }
  if (!existsSync(file)) {
    console.error(`${name}: missing snapshot ${file} (run npm run snapshot:update)`);
    failed = true;
    continue;
  }
  const expected = readFileSync(file, "utf8");
  if (expected === actual) {
    console.log(`${name}: ${model.elements.length} elements, unchanged`);
    continue;
  }
  failed = true;
  const was: Array<{ id: string }> = JSON.parse(expected);
  const now: Array<{ id: string }> = JSON.parse(actual);
  console.error(`${name}: DIFFERS (${was.length} elements expected, ${now.length} now)`);
  const n = Math.min(was.length, now.length);
  for (let i = 0; i < n; i++) {
    if (was[i].id !== now[i].id) {
      console.error(`  element ${i}: id "${was[i].id}" expected, "${now[i].id}" now`);
      break;
    }
    const diff = firstDifference(was[i], now[i]);
    if (diff) {
      console.error(`  element ${i} "${now[i].id}": ${diff}`);
      break;
    }
    if (i === n - 1) console.error(`  first ${n} elements equal; element count differs`);
  }
}
process.exit(failed ? 1 : 0);
