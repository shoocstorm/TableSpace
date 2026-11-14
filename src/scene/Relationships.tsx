// Foreign keys as curves from the key column's row on the child table to the
// referenced table. Each line starts at a dot on the column that holds the
// key and ends in an arrowhead on the table it points at, and carries a
// label: the cardinality, or the whole reference ("orders.user_id →
// users.id") once the line belongs to the selected or focused tables.
// Particles flow along it to show the cardinality: one going back and forth
// for 1:1, a stream from the one side to the many for 1:N, both ways for M:N.

import { Billboard, Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { CanvasTexture, Color, CubicBezierCurve3, LinearFilter, MathUtils, Object3D, SRGBColorSpace, Vector3, type Group, type InstancedMesh, type Mesh, type MeshBasicMaterial } from 'three';
import type { Line2 } from 'three-stdlib';
import type { Edge } from '../schema/graph';
import type { Cardinality, SchemaDef } from '../schema/types';
import { CARD_W, columnY, drawPill } from './card';
import { isMoving, live } from './live';
import { useFonts } from './useCanvasTexture';

const SEGMENTS = 32;
/** The arrowhead's length; the line stops at its base. */
const ARROW = 0.62;
const UP = new Vector3(0, 1, 0);
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

function RelationshipLine({ edge, schema, colorFrom, colorTo, lit, strong }: { edge: Edge; schema: SchemaDef; colorFrom: string; colorTo: string; lit: boolean; strong: boolean }) {
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
        const stop = 1 - Math.min(0.2, (ARROW * 0.9) / Math.max(1, curve.v0.distanceTo(curve.v3)));
        for (let i = 0; i <= SEGMENTS; i++) {
          curve.getPoint((i / SEGMENTS) * stop, p);
          flat[i * 3] = p.x;
          flat[i * 3 + 1] = p.y;
          flat[i * 3 + 2] = p.z;
        }
        l.geometry.setPositions(flat);
        built.current = true;
      }
    }
    l.visible = built.current;
    const k = 1 - Math.exp(-dt * 6);
    l.material.opacity += ((lit ? (strong ? 1 : 0.72) : 0.04) - l.material.opacity) * k;
    l.material.linewidth += ((strong ? 3.4 : 1.9) - l.material.linewidth) * k;
  });

  // no `visible` prop here: drei spreads the rest of the props onto the material too, which would hide it for good
  return <Line ref={line} points={initial} vertexColors={colors} lineWidth={1.9} transparent opacity={0.72} depthWrite={false} toneMapped={false} raycast={() => null} />;
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

/** The arrowhead on the referenced table and the dot on the column that holds the key, for every edge. */
function EndMarkers({ edges, lit, colorOf }: { edges: Edge[]; lit: (e: Edge) => boolean; colorOf: (table: string) => string }) {
  const heads = useRef<InstancedMesh>(null);
  const dots = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const tangent = useMemo(() => new Vector3(), []);
  const sizes = useRef<number[]>([]);

  useEffect(() => {
    const c = new Color();
    edges.forEach((e, i) => {
      heads.current?.setColorAt(i, c.set(colorOf(e.to)).multiplyScalar(1.9));
      dots.current?.setColorAt(i, c.set(colorOf(e.from)).multiplyScalar(1.9));
    });
    for (const m of [heads.current, dots.current]) if (m?.instanceColor) m.instanceColor.needsUpdate = true;
  }, [edges, colorOf]);

  useFrame((_, dt) => {
    const h = heads.current;
    const d = dots.current;
    if (!h || !d) return;
    const k = 1 - Math.exp(-dt * 8);
    edges.forEach((e, i) => {
      const curve = live.curves.get(e.id);
      const a = live.tables.get(e.from);
      const b = live.tables.get(e.to);
      const want = curve && a && b && lit(e) ? Math.min(a.dim, b.dim) : 0;
      const s = (sizes.current[i] = MathUtils.lerp(sizes.current[i] ?? 0, want, k));
      if (!curve || s < 0.01) {
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        h.setMatrixAt(i, dummy.matrix);
        d.setMatrixAt(i, dummy.matrix);
        return;
      }
      curve.getTangent(1, tangent);
      dummy.position.copy(curve.v3).addScaledVector(tangent, -ARROW / 2);
      dummy.quaternion.setFromUnitVectors(UP, tangent);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      h.setMatrixAt(i, dummy.matrix);
      dummy.position.copy(curve.v0);
      dummy.quaternion.identity();
      dummy.updateMatrix();
      d.setMatrixAt(i, dummy.matrix);
    });
    h.instanceMatrix.needsUpdate = true;
    d.instanceMatrix.needsUpdate = true;
  });

  const n = Math.max(1, edges.length);
  return (
    <>
      <instancedMesh ref={heads} args={[undefined, undefined, n]} key={`h${n}`} frustumCulled={false} raycast={() => null}>
        <coneGeometry args={[0.23, ARROW, 16]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={dots} args={[undefined, undefined, n]} key={`d${n}`} frustumCulled={false} raycast={() => null}>
        <sphereGeometry args={[0.11, 12, 12]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </>
  );
}

const pillCache = new Map<string, { texture: CanvasTexture; aspect: number }>();
function pill(text: string, fonts: number, color = '#94a3b8', ink = color) {
  // drawn again once the page's fonts are in
  const key = `${text}|${color}|${ink}|${fonts}`;
  let hit = pillCache.get(key);
  if (!hit) {
    const canvas = document.createElement('canvas');
    const { w, h } = drawPill(canvas, text, { color: ink, stroke: color, fill: 'rgba(6,10,18,0.9)' });
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.generateMipmaps = false;
    hit = { texture, aspect: w / h };
    pillCache.set(key, hit);
  }
  return hit;
}

/** Read along the arrow, from the table holding the key to the one it references. */
const alongArrow = (c: Cardinality) => (c === '1:N' ? 'N:1' : c);

/** The label at the middle of a line: its cardinality, or the whole reference when the line is in focus. */
function EdgeLabel({ edge, lit, strong, color, brief }: { edge: Edge; lit: boolean; strong: boolean; color: string; brief: boolean }) {
  const group = useRef<Group>(null);
  const mesh = useRef<Mesh>(null);
  const fonts = useFonts((s) => s.ready);
  const short = useMemo(() => pill(alongArrow(edge.cardinality), fonts), [edge.cardinality, fonts]);
  const full = useMemo(
    () => pill(`${edge.from}.${edge.column}  →  ${edge.to}.${edge.refColumn}   ${alongArrow(edge.cardinality)}`, fonts, color, '#f1f5f9'),
    [edge, color, fonts],
  );
  const shown = strong ? full : short;
  const size = strong ? 0.46 : 0.32;
  const fade = useRef(0);
  useFrame(({ camera }, dt) => {
    const curve = live.curves.get(edge.id);
    const g = group.current;
    const m = mesh.current;
    if (!g || !m || !curve) return;
    curve.getPoint(0.5, g.position);
    // labels keep to a readable size: smaller than perspective would make them up close, larger far away
    const k = MathUtils.clamp(camera.position.distanceTo(g.position) / 24, 0.6, 1.8);
    m.scale.set(size * shown.aspect * k, size * k, 1);
    const on = lit && (strong || !brief) && live.tables.has(edge.from);
    fade.current = MathUtils.lerp(fade.current, on ? 1 : 0, 1 - Math.exp(-dt * 8));
    g.visible = fade.current > 0.02;
    (m.material as MeshBasicMaterial).opacity = fade.current;
  });
  return (
    <group ref={group} visible={false}>
      <Billboard>
        <mesh ref={mesh} raycast={() => null} renderOrder={strong ? 6 : 5}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial map={shown.texture} transparent depthWrite={false} depthTest={!strong} toneMapped={false} />
        </mesh>
      </Billboard>
    </group>
  );
}

type Props = { schema: SchemaDef; edges: Edge[]; lit: string[] | null; selected: string | null; light: boolean; still: boolean };

export function Relationships({ schema, edges, lit, selected, light, still }: Props) {
  const colorOf = useMemo(() => {
    const byTable = new Map(schema.tables.map((t) => [t.name, schema.domains.find((d) => d.id === t.domain)?.color ?? '#94a3b8']));
    return (table: string) => byTable.get(table) ?? '#94a3b8';
  }, [schema]);
  const isLit = useMemo(() => {
    const set = lit ? new Set(lit) : null;
    return (e: Edge) => !set || (set.has(e.from) && set.has(e.to));
  }, [lit]);
  // the lines of the selected table, or of whatever is in focus, are drawn heavier and fully labelled
  const isStrong = (e: Edge) => (lit ? isLit(e) : selected !== null && (e.from === selected || e.to === selected));
  return (
    <>
      {edges.map((e) => (
        <RelationshipLine key={e.id} edge={e} schema={schema} colorFrom={colorOf(e.from)} colorTo={colorOf(e.to)} lit={isLit(e)} strong={isStrong(e)} />
      ))}
      <EndMarkers edges={edges} lit={isLit} colorOf={colorOf} />
      <FlowParticles edges={edges} lit={isLit} colorOf={colorOf} light={light} still={still} />
      {edges.map((e) => (
        <EdgeLabel key={e.id} edge={e} lit={isLit(e)} strong={isStrong(e)} color={colorOf(e.to)} brief={light || selected !== null} />
      ))}
    </>
  );
}
