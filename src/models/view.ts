/** Initial orbit camera view of a model (target in scene units, radius, orbit angles in radians). */
export interface View {
  readonly target: readonly [number, number, number];
  readonly radius: number;
  readonly alpha: number;
  readonly beta: number;
}
