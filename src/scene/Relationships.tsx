// Foreign keys as curves from the key column's row on the child table to the
// referenced table, with particles flowing along them. The flow shows the
// cardinality: one particle going back and forth for 1:1, a stream from the
// one side to the many for 1:N, streams both ways for M:N.

import { Billboard, Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { CanvasTexture, Color, CubicBezierCurve3, LinearFilter, Object3D, SRGBColorSpace, Vector3, type Group, type InstancedMesh } from 'three';
import type { Line2 } from 'three-stdlib';
import type { Edge } from '../schema/graph';
import type { Cardinality, SchemaDef } from '../schema/types';
import { CARD_W, columnY, drawPill } from './card';
import { isMoving, live } from './live';

const SEGMENTS = 28;
const tmp = { a: new Vector3(), b: new Vector3() };

/** Rebuilds an edge's curve from where its two tables are right now. False until both exist. */
function updateCurve(curve: CubicBezierCurve3, edge: Edge, schema: SchemaDef): boolean {
  const from = live.tables.get(edge.from);
  const to = live.tables.get(edge.to);
  if (!from || !to) return false;
  const child = schema.tables.find((t) => t.name === edge.from)!;
  const parent = schema.tables.find((t) => t.name === edge.to)!;
  const yFrom = columnY(child, edge.column, from.height, from.expanded);
  const yTo = columnY(parent, edge.refColumn, to.height, to.expanded);
  if (edge.from === edge.to) {
    // a self-reference loops out of the right side
    curve.v0.set(from.pos.x + CARD_W / 2, from.pos.y + yFrom, from.pos.z);
    curve.v3.set(from.pos.x + CARD_W / 2, from.pos.y + from.height / 2 - 0.2, from.pos.z);
    curve.v1.copy(curve.v0).add(tmp.a.set(2.6, -0.6, 1.2));
    curve.v2.copy(curve.v3).add(tmp.a.set(2.6, 1.2, 1.2));
    return true;
  }
  const dir = Math.sign(to.pos.x - from.pos.x) || 1;
  curve.v0.set(from.pos.x + (dir * CARD_W) / 2, from.pos.y + yFrom, from.pos.z);
  curve.v3.set(to.pos.x - (dir * CARD_W) / 2, to.pos.y + yTo, to.pos.z);
  // when the tables overlap in x, both ends leave from the same side
  const overlap = Math.abs(to.pos.x - from.pos.x) < CARD_W;
  if (overlap) curve.v3.x = to.pos.x + (dir * CARD_W) / 2;
  const reach = Math.min(5, Math.max(1.6, curve.v0.distanceTo(curve.v3) * 0.36));
  curve.v1.copy(curve.v0).add(tmp.a.set(dir * reach, 0, 0));
  curve.v2.copy(curve.v3).add(tmp.b.set((overlap ? dir : -dir) * reach, 0, 0));
  return true;
}

function RelationshipLine({ edge, schema, colorFrom, colorTo, lit }: { edge: Edge; schema: SchemaDef; colorFrom: string; colorTo: string; lit: boolean }) {
  const line = useRef<Line2>(null);
  const curve = useMemo(() => new CubicBezierCurve3(new Vector3(), new Vector3(), new Vector3(), new Vector3(1, 0, 0)), []);
  const flat = useMemo(() => new Float32Array((SEGMENTS + 1) * 3), []);
  const built = useRef(false);
  const colors = useMemo(() => {
    const a = new Color(colorFrom);
    const b = new Color(colorTo);
    return Array.from({ length: SEGMENTS + 1 }, (_, i) => a.clone().lerp(b, i / SEGMENTS).multiplyScalar(1.3)) as unknown as [number, number, number][];
  }, [colorFrom, colorTo]);
  const initial = useMemo(() => Array.from({ length: SEGMENTS + 1 }, (_, i) => [i * 0.001, 0, 0] as [number, number, number]), []);

  useEffect(() => {
    live.curves.set(edge.id, curve);
    return () => void live.curves.delete(edge.id);
  }, [edge.id, curve]);

  useFrame((_, dt) => {
    const l = line.current;
    if (!l) return;
    if (!built.current || isMoving()) {
      if (updateCurve(curve, edge, schema)) {
        const p = tmp.a;
        for (let i = 0; i <= SEGMENTS; i++) {
          curve.getPoint(i / SEGMENTS, p);
          flat[i * 3] = p.x;
          flat[i * 3 + 1] = p.y;
          flat[i * 3 + 2] = p.z;
        }
        l.geometry.setPositions(flat);
        built.current = true;
      }
    }
    l.visible = built.current;
    const want = lit ? 0.78 : 0.04;
    l.material.opacity += (want - l.material.opacity) * (1 - Math.exp(-dt * 6));
  });

  // no `visible` prop here: drei spreads the rest of the props onto the material too, which would hide it for good
  return <Line ref={line} points={initial} vertexColors={colors} lineWidth={1.6} transparent opacity={0.78} depthWrite={false} toneMapped={false} raycast={() => null} />;
}

const perEdge = (c: Cardinality, light: boolean) => (c === '1:1' ? 1 : c === '1:N' ? (light ? 2 : 4) : light ? 2 : 4);

/** Every particle of every relationship, as one instanced mesh. */
function FlowParticles({ edges, lit, colorOf, light, still }: { edges: Edge[]; lit: (e: Edge) => boolean; colorOf: (table: string) => string; light: boolean; still: boolean }) {
  const mesh = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const particles = useMemo(() => {
    const out: { edge: Edge; offset: number; reverse: boolean; pingPong: boolean }[] = [];
    for (const e of edges) {
      const n = perEdge(e.cardinality, light);
      for (let i = 0; i < n; i++) {
        // 1:N flows from the parent (the "one") to the child; M:N alternates directions
        out.push({ edge: e, offset: i / n, reverse: e.cardinality === 'M:N' ? i % 2 === 0 : true, pingPong: e.cardinality === '1:1' });
      }
    }
    return out;
  }, [edges, light]);

  useEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const c = new Color();
    particles.forEach((p, i) => m.setColorAt(i, c.set(colorOf(p.edge.to)).multiplyScalar(2.4)));
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [particles, colorOf]);

  useFrame(({ clock }) => {
    const m = mesh.current;
    if (!m) return;
    const time = still ? 0 : clock.elapsedTime;
    particles.forEach((p, i) => {
      const curve = live.curves.get(p.edge.id);
      const a = live.tables.get(p.edge.from);
      const b = live.tables.get(p.edge.to);
      if (!curve || !a || !b || !lit(p.edge) || still) {
        dummy.scale.setScalar(0);
      } else {
        let t = (time * (p.pingPong ? 0.16 : 0.22) + p.offset) % 1;
        if (p.pingPong) t = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
        else if (p.reverse) t = 1 - t;
        curve.getPoint(t, dummy.position);
        // fade in and out at the ends, so particles don't pop
        dummy.scale.setScalar(Math.min(1, Math.sin(Math.min(1, Math.max(0, t)) * Math.PI) * 3) * Math.min(a.dim, b.dim));
      }
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, Math.max(1, particles.length)]} key={particles.length} frustumCulled={false} raycast={() => null}>
      <sphereGeometry args={[0.085, 10, 10]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

const pillCache = new Map<string, { texture: CanvasTexture; aspect: number }>();
function pill(text: string) {
  let hit = pillCache.get(text);
  if (!hit) {
    const canvas = document.createElement('canvas');
    const { w, h } = drawPill(canvas, text, { color: '#94a3b8', fill: 'rgba(7,11,20,0.82)' });
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.generateMipmaps = false;
    hit = { texture, aspect: w / h };
    pillCache.set(text, hit);
  }
  return hit;
}

function CardinalityTag({ edge, lit }: { edge: Edge; lit: boolean }) {
  const group = useRef<Group>(null);
  const { texture, aspect } = useMemo(() => pill(edge.cardinality), [edge.cardinality]);
  useFrame(() => {
    const curve = live.curves.get(edge.id);
    const g = group.current;
    if (!g || !curve) return;
    curve.getPoint(0.5, g.position);
    g.visible = lit && live.tables.has(edge.from);
  });
  return (
    <group ref={group} visible={false}>
      <Billboard>
        <mesh raycast={() => null}>
          <planeGeometry args={[0.34 * aspect, 0.34]} />
          <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
        </mesh>
      </Billboard>
    </group>
  );
}

type Props = { schema: SchemaDef; edges: Edge[]; lit: string[] | null; light: boolean; still: boolean };

export function Relationships({ schema, edges, lit, light, still }: Props) {
  const colorOf = useMemo(() => {
    const byTable = new Map(schema.tables.map((t) => [t.name, schema.domains.find((d) => d.id === t.domain)?.color ?? '#94a3b8']));
    return (table: string) => byTable.get(table) ?? '#94a3b8';
  }, [schema]);
  const isLit = useMemo(() => {
    const set = lit ? new Set(lit) : null;
    return (e: Edge) => !set || (set.has(e.from) && set.has(e.to));
  }, [lit]);
  return (
    <>
      {edges.map((e) => (
        <RelationshipLine key={e.id} edge={e} schema={schema} colorFrom={colorOf(e.from)} colorTo={colorOf(e.to)} lit={isLit(e)} />
      ))}
      <FlowParticles edges={edges} lit={isLit} colorOf={colorOf} light={light} still={still} />
      {!light && edges.map((e) => <CardinalityTag key={e.id} edge={e} lit={isLit(e)} />)}
    </>
  );
}
