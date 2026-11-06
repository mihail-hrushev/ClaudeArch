import type { z } from "zod";
import type { BuildContext } from "./context";

/**
 * One build operation of a structure document: validates its own parameters with `schema` and
 * runs against the context, adding elements and instances and leaving named results.
 */
export interface Operator<S extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly name: string;
  /** One or two sentences for the catalogue of operators. */
  readonly description: string;
  readonly schema: S;
  run(ctx: BuildContext, params: z.infer<S>, path: string): void;
}

export const defineOperator = <S extends z.ZodTypeAny>(op: Operator<S>): Operator<S> => op;
