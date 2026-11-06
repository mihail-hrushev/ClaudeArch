/**
 * Builds a structure document and reports what it produced, or the first error with its path.
 *   npm run structure -- structures/<name>.json [--elements]
 * Lists the operators and their parameters:
 *   npm run structure -- --operators
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { buildStructure } from "../src/json/build";
import { OPERATORS } from "../src/json/operators";

const args = process.argv.slice(2);

if (args.includes("--operators")) {
  for (const op of OPERATORS) {
    console.log(`${op.name}: ${op.description}`);
    const shape = (op.schema as z.ZodObject<z.ZodRawShape>).shape;
    for (const [key, field] of Object.entries(shape)) {
      if (key === "op") continue;
      console.log(`    ${key}${field instanceof z.ZodOptional ? "?" : ""}`);
    }
  }
  process.exit(0);
}

const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: npm run structure -- structures/<name>.json [--elements]");
  process.exit(2);
}
try {
  const built = buildStructure(JSON.parse(readFileSync(file, "utf8")));
  const kinds = new Map<string, number>();
  for (const el of built.model.elements) kinds.set(el.kind, (kinds.get(el.kind) ?? 0) + 1);
  console.log(`${built.name}: ${built.model.elements.length} elements (${[...kinds].map(([k, n]) => `${n} ${k}`).join(", ")})`);
  if (args.includes("--elements")) for (const el of built.model.elements) console.log(`  ${el.id} ${el.kind}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
