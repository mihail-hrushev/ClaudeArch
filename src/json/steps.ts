/**
 * Runs build steps in order against a context: the document's own, or a group's.
 */
import type { ZodError } from "zod";
import { type BuildContext, BuildError } from "./context";
import type { OperationSpecType } from "./document";
import { operatorByName } from "./operators";

export const issues = (error: ZodError, prefix = "") =>
  error.issues.map((i) => `${prefix}${i.path.join(".")}: ${i.message}`).join("\n");

/** `where` prefixes the step paths in errors, e.g. `build` or `groups.porch.build`. */
export function runSteps(ctx: BuildContext, steps: readonly OperationSpecType[], where: string): void {
  steps.forEach((step, i) => {
    const path = `${where}[${i}] (${step.op}${step.name ? ` "${step.name}"` : ""})`;
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
}
