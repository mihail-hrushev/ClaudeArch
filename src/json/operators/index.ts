/**
 * Catalogue of build operators. A new operator goes in a module of its own concern and is
 * added to the list here; the document's `build` steps refer to it by `op`.
 */
import type { Operator } from "../operator";
import { glazingOperators } from "./glazing";
import { supportOperators } from "./supports";
import { circulationOperators } from "./circulation";
import { layoutOperators } from "./layout";
import { openingOperators } from "./openings";
import { groupOperators } from "./groups";

export const OPERATORS: readonly Operator[] = [
  ...glazingOperators,
  ...supportOperators,
  ...circulationOperators,
  ...layoutOperators,
  ...openingOperators,
  ...groupOperators,
];

export const operatorByName = new Map(OPERATORS.map((op) => [op.name, op]));
