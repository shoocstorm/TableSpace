// What the scene's parts tell each other every frame, outside React: where
// each monolith is right now (they glide between layouts), how tall it is,
// and the curve of each relationship. Relationship lines, flow particles,
// query pulses and badges read these instead of re-rendering.

import { CubicBezierCurve3, Vector3 } from 'three';

export type LiveTable = { pos: Vector3; height: number; depth: number; expanded: boolean; dim: number };

export const live = {
  tables: new Map<string, LiveTable>(),
  curves: new Map<string, CubicBezierCurve3>(),
  /** Until this time (performance.now) something is moving, so curves are rebuilt. */
  movingUntil: 0,
};

export const touch = (ms = 250) => {
  live.movingUntil = Math.max(live.movingUntil, performance.now() + ms);
};
export const isMoving = () => performance.now() < live.movingUntil;

export function resetLive(): void {
  live.tables.clear();
  live.curves.clear();
  touch(1500);
}
