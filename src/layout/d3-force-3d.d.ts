// d3-force-3d ships no types; this covers what layout/force.ts uses.
declare module 'd3-force-3d' {
  export type SimNode = { index?: number; x?: number; y?: number; z?: number; vx?: number; vy?: number; vz?: number };
  export type SimLink<N> = { source: N | string | number; target: N | string | number };
  export interface Force<N> {
    (alpha: number): void;
    initialize?(nodes: N[], ...rest: unknown[]): void;
  }
  export interface Simulation<N extends SimNode> {
    force(name: string, force: Force<N> | null): this;
    stop(): this;
    tick(iterations?: number): this;
    alpha(a: number): this;
    alphaDecay(d: number): this;
    nodes(): N[];
  }
  export function forceSimulation<N extends SimNode>(nodes: N[], dimensions?: 1 | 2 | 3): Simulation<N>;
  export interface LinkForce<N, L> extends Force<N> {
    id(fn: (n: N) => string): this;
    distance(d: number | ((l: L) => number)): this;
    strength(s: number | ((l: L) => number)): this;
  }
  export function forceLink<N extends SimNode, L extends SimLink<N>>(links: L[]): LinkForce<N, L>;
  export interface ManyBodyForce<N> extends Force<N> {
    strength(s: number): this;
    distanceMax(d: number): this;
  }
  export function forceManyBody<N extends SimNode>(): ManyBodyForce<N>;
  export interface CollideForce<N> extends Force<N> {
    radius(r: number): this;
    strength(s: number): this;
  }
  export function forceCollide<N extends SimNode>(radius?: number): CollideForce<N>;
  export interface AxisForce<N> extends Force<N> {
    strength(s: number): this;
  }
  export function forceY<N extends SimNode>(y?: number): AxisForce<N>;
  export function forceCenter<N extends SimNode>(x?: number, y?: number, z?: number): Force<N>;
}
