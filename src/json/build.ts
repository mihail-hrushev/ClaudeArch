/**
 * Builds a model from a structure document: validates it, runs its build steps in order and
 * assembles the result (Babylon-free, so it also runs under tsx).
 */
import type { Model } from "../fem/types";
import type { View } from "../models/view";
import { BuildContext, BuildError } from "./context";
import { StructureDocument, type StructureDocumentType } from "./document";
import { issues, runSteps } from "./steps";

export interface BuiltStructure {
  readonly name: string;
  readonly model: Model;
  readonly view: View;
}

const DEFAULT_VIEW: View = { target: [0, 0, 500], radius: 4000, alpha: Math.PI / 2 + 0.65, beta: Math.PI / 2.5 };

/** The document parsed and validated, or an error naming the first problems. */
export function parseStructure(raw: unknown): StructureDocumentType {
  const parsed = StructureDocument.safeParse(raw);
  if (!parsed.success) throw new BuildError(`invalid structure document\n${issues(parsed.error)}`, "document");
  return parsed.data;
}

export function buildStructure(raw: unknown): BuiltStructure {
  const doc = parseStructure(raw);
  const ctx = new BuildContext(doc);
  runSteps(ctx, doc.build, "build");
  const view: View = doc.view
    ? {
        target: ctx.vec3(doc.view.target, "view.target"), radius: ctx.length(doc.view.radius, "view.radius"),
        alpha: (doc.view.alpha * Math.PI) / 180, beta: (doc.view.beta * Math.PI) / 180,
      }
    : DEFAULT_VIEW;
  return { name: doc.name, model: ctx.model(), view };
}
