/**
 * Builds a model from a structure document: validates it, runs its build steps in order and
 * assembles the result (Babylon-free, so it also runs under tsx).
 */
import type { ZodError } from "zod";
import type { Model } from "../fem/types";
import type { View } from "../models/view";
import { BuildContext, BuildError } from "./context";
import { StructureDocument, type StructureDocumentType } from "./document";
import { operatorByName } from "./operators";

export interface BuiltStructure {
  readonly name: string;
  readonly model: Model;
  readonly view: View;
}

const DEFAULT_VIEW: View = { target: [0, 0, 500], radius: 4000, alpha: Math.PI / 2 + 0.65, beta: Math.PI / 2.5 };

const issues = (error: ZodError, prefix = "") =>
  error.issues.map((i) => `${prefix}${i.path.join(".")}: ${i.message}`).join("\n");

/** The document parsed and validated, or an error naming the first problems. */
export function parseStructure(raw: unknown): StructureDocumentType {
  const parsed = StructureDocument.safeParse(raw);
  if (!parsed.success) throw new BuildError(`invalid structure document\n${issues(parsed.error)}`, "document");
  return parsed.data;
}

export function buildStructure(raw: unknown): BuiltStructure {
  const doc = parseStructure(raw);
  const ctx = new BuildContext(doc);
  doc.build.forEach((step, i) => {
    const path = `build[${i}] (${step.op}${step.name ? ` "${step.name}"` : ""})`;
    const op = operatorByName.get(step.op);
    if (!op) throw new BuildError(`unknown operator "${step.op}"; known: ${[...operatorByName.keys()].join(", ")}`, path);
    const params = op.schema.safeParse(step);
    if (!params.success) throw new BuildError(`invalid parameters\n${issues(params.error, "  ")}`, path);
    try {
      op.run(ctx, params.data, path);
    } catch (e) {
      if (e instanceof BuildError) throw e;
      throw new BuildError(e instanceof Error ? e.message : String(e), path);
    }
  });
  const view: View = doc.view
    ? {
        target: ctx.vec3(doc.view.target, "view.target"), radius: ctx.length(doc.view.radius, "view.radius"),
        alpha: (doc.view.alpha * Math.PI) / 180, beta: (doc.view.beta * Math.PI) / 180,
      }
    : DEFAULT_VIEW;
  return { name: doc.name, model: ctx.model(), view };
}
