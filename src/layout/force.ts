// PURE: where each table stands. A 3D force simulation (d3-force-3d) pulls
// related tables together and tables of a domain toward each other, run to
// rest once per schema. d3's random source is a fixed-seed LCG and its
// starting positions are a fixed spiral, so the same schema always lays out
// the same way.

import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceY, type SimNode } from 'd3-force-3d';
import { edgesOf } from '../schema/graph';
import type { SchemaDef } from '../schema/types';

export type Vec3 = [number, number, number];
export type Layout = Record<string, Vec3>;

type Node = SimNode & { id: string; domain: string };


export function computeLayout(schema: SchemaDef): Layout {
  const nodes: Node[] = schema.tables.map((t) => ({ id: t.name, domain: t.domain }));
  const links = edgesOf(schema)
    .filter((e) => e.from !== e.to)
    .map((e) => ({ source: e.from, target: e.to, same: schema.tables.find((t) => t.name === e.from)!.domain === schema.tables.find((t) => t.name === e.to)!.domain }));

  // Pulls each table toward its domain's centroid: clusters by domain even where few keys connect them.
  const byDomain = new Map<string, Node[]>();
  for (const n of nodes) byDomain.set(n.domain, [...(byDomain.get(n.domain) ?? []), n]);
  const cluster = (alpha: number) => {
    for (const group of byDomain.values()) {
      const c = [0, 0, 0];
      for (const n of group) {
        c[0] += n.x! / group.length;
        c[1] += n.y! / group.length;
        c[2] += n.z! / group.length;
      }
      for (const n of group) {
        n.vx! += (c[0] - n.x!) * 0.35 * alpha;
        n.vy! += (c[1] - n.y!) * 0.35 * alpha;
        n.vz! += (c[2] - n.z!) * 0.35 * alpha;
      }
    }
  };

  const sim = forceSimulation(nodes, 3)
    .force('link', forceLink<Node, (typeof links)[number]>(links).id((n) => n.id).distance((l) => (l.same ? 5.5 : 8.5)).strength((l) => (l.same ? 0.9 : 0.35)))
    .force('charge', forceManyBody<Node>().strength(-6).distanceMax(20))
    // tables are 3.6 wide: this keeps them from standing inside each other
    .force('collide', forceCollide<Node>(3.1).strength(1))
    // a landscape over the floor rather than a ball: height is kept within a few units
    .force('flat', forceY<Node>(0).strength(0.4))
    .force('cluster', cluster)
    .force('center', forceCenter<Node>(0, 0, 0))
    .stop();
  sim.tick(400);

  const out: Layout = {};
  for (const n of nodes) out[n.id] = [round(n.x!), round(n.y!), round(n.z!)];
  return out;
}

const round = (v: number) => Math.round(v * 100) / 100;

/** The exploded view: every domain's cluster moves away from the middle, keeping its own shape. */
export function explode(layout: Layout, schema: SchemaDef, factor = 1.9): Layout {
  const centroids = new Map<string, Vec3>();
  for (const d of schema.domains) {
    const members = schema.tables.filter((t) => t.domain === d.id && layout[t.name]);
    if (!members.length) continue;
    const c: Vec3 = [0, 0, 0];
    for (const t of members) for (let i = 0; i < 3; i++) c[i] += layout[t.name][i] / members.length;
    centroids.set(d.id, c);
  }
  const out: Layout = {};
  for (const t of schema.tables) {
    const p = layout[t.name];
    const c = centroids.get(t.domain);
    if (!p) continue;
    out[t.name] = c ? [round(p[0] + c[0] * (factor - 1)), round(p[1] + c[1] * (factor - 1)), round(p[2] + c[2] * (factor - 1))] : p;
  }
  return out;
}

/** The box around a set of tables' positions: its centre and the radius that holds them. */
export function bounds(layout: Layout, names: string[], extra: Vec3[] = []): { center: Vec3; radius: number } {
  const pts = [...names.map((n) => layout[n]).filter(Boolean), ...extra];
  if (!pts.length) return { center: [0, 0, 0], radius: 12 };
  const center: Vec3 = [0, 0, 0];
  for (const p of pts) for (let i = 0; i < 3; i++) center[i] += p[i] / pts.length;
  const radius = Math.max(...pts.map((p) => Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2])));
  return { center, radius: radius + 4 };
}
