// Foreign keys as curves from the key column's row on the child table to the
// row of the key it references. Both rows carry on around the slab's side as
// a pad, in the color the faces give that key: the line leaves the foreign
// key's pad and its arrowhead lands on the referenced key's pad. With labels
// turned on in the dock it carries one: the cardinality, or the whole
// reference ("orders.user_id → users.id") once the line belongs to the selected or
// focused tables. Darts travel along it the way the arrow points, from the
// foreign key to the key it references: one for 1:1, a stream otherwise.

import { Billboard, Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { CanvasTexture, Color, CubicBezierCurve3, LinearFilter, MathUtils, Object3D, SRGBColorSpace, Vector3, type Group, type InstancedMesh, type Mesh, type MeshBasicMaterial } from 'three';
import type { Line2 } from 'three-stdlib';
import type { Edge } from '../schema/graph';
import type { Cardinality, SchemaDef } from '../schema/types';
import { CARD_W, columnY, drawPill, KEY_COLOR } from './card';
import { lineReveal } from './intro';
import { isMoving, live } from './live';
import { useFonts } from './useCanvasTexture';

const SEGMENTS = 40;
/** The arrowhead's length. A curve ends at the arrowhead's base; its tip is on the table's side. */
const ARROW = 0.46;
const ARROW_R = 0.14;
/** How far a pad stands out of a table's side, and how tall it is: a little less than a row. */
const PAD_OUT = 0.05;
const PAD_H = 0.2;
/** Tables nearer than this in x have no room for a bend between their facing sides. */
const TIGHT = CARD_W + 2.4;
const UP = new Vector3(0, 1, 0);
const tmp = { a: new Vector3(), b: new Vector3() };

/**
 * Rebuilds an edge's curve from where its two tables are right now. False
 * until both exist. Both ends are level: the line leaves its row straight
 * out of the table's side and the arrowhead meets the other row head-on.
 */
function updateCurve(curve: CubicBezierCurve3, edge: Edge, schema: SchemaDef): boolean {
  const from = live.tables.get(edge.from);
  const to = live.tables.get(edge.to);
  if (!from || !to) return false;
  const child = schema.tables.find((t) => t.name === edge.from)!;
  const parent = schema.tables.find((t) => t.name === edge.to)!;
  const yFrom = columnY(child, edge.column, from.height, from.expanded);
  const yTo = columnY(parent, edge.refColumn, to.height, to.expanded);
  if (edge.from === edge.to) {
    // a self-reference loops out of the right side and comes back in at the key
    const x = from.pos.x + CARD_W / 2;
    const out = MathUtils.clamp(Math.abs(yTo - yFrom) * 0.9 + 1.2, 1.6, 3.4);
    curve.v0.set(x, from.pos.y + yFrom, from.pos.z);
    curve.v3.set(x + PAD_OUT + ARROW, from.pos.y + yTo, from.pos.z);
    curve.v1.copy(curve.v0).add(tmp.a.set(out, 0, 0.9));
    curve.v2.copy(curve.v3).add(tmp.a.set(out, 0, 0.9));
    return true;
  }
  const dx = to.pos.x - from.pos.x;
  const dir = Math.sign(dx) || 1;
  // side by side, the line runs between the facing sides; stacked, it leaves and arrives on the same side
  const tight = Math.abs(dx) < TIGHT;
  const into = tight ? -dir : dir;
  curve.v0.set(from.pos.x + (dir * CARD_W) / 2, from.pos.y + yFrom, from.pos.z);
  curve.v3.set(to.pos.x - into * (CARD_W / 2 + PAD_OUT + ARROW), to.pos.y + yTo, to.pos.z);
  const span = curve.v0.distanceTo(curve.v3);
  const gap = Math.abs(curve.v3.x - curve.v0.x);
  // handles half the gap long make an S that never doubles back; a little more when the ends are far apart in height or depth
  const reach = tight ? MathUtils.clamp(span * 0.45, 1.6, 5) : MathUtils.clamp(gap * 0.5 + (span - gap) * 0.12, 0.9, 7);
  curve.v1.copy(curve.v0).add(tmp.a.set(dir * reach, 0, 0));
  curve.v2.copy(curve.v3).add(tmp.b.set(-into * reach, 0, 0));
  return true;
}

function RelationshipLine({ edge, schema, colorFrom, colorTo, lit, strong }: { edge: Edge; schema: SchemaDef; colorFrom: string; colorTo: string; lit: boolean; strong: boolean }) {
  const line = useRef<Line2>(null);
  const curve = useMemo(() => new CubicBezierCurve3(new Vector3(), new Vector3(), new Vector3(), new Vector3(1, 0, 0)), []);
  const flat = useMemo(() => new Float32Array((SEGMENTS + 1) * 3), []);
  const built = useRef(false);
  const drawn = useRef(-1);
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
    // while the scene builds, the line grows out of the foreign key toward the key it references
    const reveal = lineReveal(edge.from, edge.to);
    if (!built.current || isMoving() || reveal !== drawn.current) {
      if (updateCurve(curve, edge, schema)) {
        const p = tmp.a;
        for (let i = 0; i <= SEGMENTS; i++) {
          curve.getPoint((i / SEGMENTS) * reveal, p);
          // the last point reaches a little into the arrowhead, so the two never part
          if (i === SEGMENTS && reveal === 1) p.addScaledVector(tmp.b.subVectors(curve.v3, curve.v2).normalize(), ARROW * 0.3);
          flat[i * 3] = p.x;
          flat[i * 3 + 1] = p.y;
          flat[i * 3 + 2] = p.z;
        }
        l.geometry.setPositions(flat);
        built.current = true;
        drawn.current = reveal;
      }
    }
    l.visible = built.current && reveal > 0;
    const k = 1 - Math.exp(-dt * 6);
    l.material.opacity += ((lit ? (strong ? 1 : 0.72) : 0.04) - l.material.opacity) * k;
    l.material.linewidth += ((strong ? 3.4 : 1.9) - l.material.linewidth) * k;
  });

  // no `visible` prop here: drei spreads the rest of the props onto the material too, which would hide it for good
  return <Line ref={line} points={initial} vertexColors={colors} lineWidth={1.9} transparent opacity={0.72} depthWrite={false} toneMapped={false} raycast={() => null} />;
}

const perEdge = (c: Cardinality, light: boolean) => (c === '1:1' ? 1 : light ? 2 : 3);

type EdgeTest = (e: Edge) => boolean;

/** Every dart of every relationship, as one instanced mesh. They all travel the way the arrow points. */
function FlowParticles({ edges, lit, strong, colorOf, light, still }: { edges: Edge[]; lit: EdgeTest; strong: EdgeTest; colorOf: (table: string) => string; light: boolean; still: boolean }) {
  const mesh = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const tangent = useMemo(() => new Vector3(), []);
  const particles = useMemo(() => {
    const out: { edge: Edge; offset: number }[] = [];
    for (const e of edges) {
      const n = perEdge(e.cardinality, light);
      for (let i = 0; i < n; i++) out.push({ edge: e, offset: i / n });
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
    const time = clock.elapsedTime;
    particles.forEach((p, i) => {
      const curve = live.curves.get(p.edge.id);
      const a = live.tables.get(p.edge.from);
      const b = live.tables.get(p.edge.to);
      if (!curve || !a || !b || !lit(p.edge) || still || lineReveal(p.edge.from, p.edge.to) < 1) {
        dummy.scale.setScalar(0);
      } else {
        // 0 is the foreign key's row, 1 the arrowhead
        const t = (time * 0.2 + p.offset) % 1;
        curve.getPoint(t, dummy.position);
        dummy.quaternion.setFromUnitVectors(UP, curve.getTangent(t, tangent));
        // fade in and out at the ends, so they don't pop
        dummy.scale.setScalar(Math.min(1, Math.sin(t * Math.PI) * 4) * Math.min(a.dim, b.dim) * (strong(p.edge) ? 1.3 : 1));
      }
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, Math.max(1, particles.length)]} key={particles.length} frustumCulled={false} raycast={() => null}>
      <coneGeometry args={[0.075, 0.3, 10]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

/**
 * The two ends of every edge: a pad across the slab's side at the foreign
 * key's row, where the line leaves, and one at the referenced key's row, with
 * the arrowhead's tip on it.
 */
function EndMarkers({ edges, lit, strong, colorOf }: { edges: Edge[]; lit: EdgeTest; strong: EdgeTest; colorOf: (table: string) => string }) {
  const heads = useRef<InstancedMesh>(null);
  const pads = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const tangent = useMemo(() => new Vector3(), []);
  const sizes = useRef<number[]>([]);

  useEffect(() => {
    const c = new Color();
    edges.forEach((e, i) => {
      heads.current?.setColorAt(i, c.set(colorOf(e.to)).multiplyScalar(1.9));
      pads.current?.setColorAt(i * 2, c.set(KEY_COLOR.fk).multiplyScalar(1.5));
      pads.current?.setColorAt(i * 2 + 1, c.set(KEY_COLOR.pk).multiplyScalar(1.5));
    });
    for (const m of [heads.current, pads.current]) if (m?.instanceColor) m.instanceColor.needsUpdate = true;
  }, [edges, colorOf]);

  useFrame((_, dt) => {
    const h = heads.current;
    const p = pads.current;
    if (!h || !p) return;
    const k = 1 - Math.exp(-dt * 8);
    edges.forEach((e, i) => {
      const curve = live.curves.get(e.id);
      const a = live.tables.get(e.from);
      const b = live.tables.get(e.to);
      // the ends appear when the line has reached them
      const want = curve && a && b && lit(e) && lineReveal(e.from, e.to) === 1 ? Math.min(a.dim, b.dim) * (strong(e) ? 1.35 : 1) : 0;
      const s = (sizes.current[i] = MathUtils.lerp(sizes.current[i] ?? 0, want, k));
      if (!curve || !a || !b || s < 0.01) {
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        h.setMatrixAt(i, dummy.matrix);
        p.setMatrixAt(i * 2, dummy.matrix);
        p.setMatrixAt(i * 2 + 1, dummy.matrix);
        return;
      }
      // the arrowhead: its tip stays on the pad whatever its size
      tangent.subVectors(curve.v3, curve.v2).normalize();
      dummy.scale.setScalar(s);
      dummy.position.copy(curve.v3).addScaledVector(tangent, ARROW * (1 - s / 2));
      dummy.quaternion.setFromUnitVectors(UP, tangent);
      dummy.updateMatrix();
      h.setMatrixAt(i, dummy.matrix);
      // the pads run the depth of their slabs, from the row on the front face to the same row on the back
      dummy.quaternion.identity();
      dummy.scale.set(PAD_OUT, PAD_H * s, b.depth + 0.03);
      dummy.position.copy(curve.v3).addScaledVector(tangent, ARROW + PAD_OUT / 2);
      dummy.updateMatrix();
      p.setMatrixAt(i * 2 + 1, dummy.matrix);
      dummy.scale.z = a.depth + 0.03;
      dummy.position.copy(curve.v0);
      dummy.position.x += Math.sign(curve.v1.x - curve.v0.x) * (PAD_OUT / 2);
      dummy.updateMatrix();
      p.setMatrixAt(i * 2, dummy.matrix);
    });
    h.instanceMatrix.needsUpdate = true;
    p.instanceMatrix.needsUpdate = true;
  });

  const n = Math.max(1, edges.length);
  return (
    <>
      <instancedMesh ref={heads} args={[undefined, undefined, n]} key={`h${n}`} frustumCulled={false} raycast={() => null}>
        <coneGeometry args={[ARROW_R, ARROW, 20]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={pads} args={[undefined, undefined, n * 2]} key={`p${n}`} frustumCulled={false} raycast={() => null}>
        <boxGeometry args={[1, 1, 1]} />
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
    const on = lit && (strong || !brief) && live.tables.has(edge.from) && lineReveal(edge.from, edge.to) === 1;
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

type Props = { schema: SchemaDef; edges: Edge[]; lit: string[] | null; selected: string | null; /** Whether the lines carry labels. */ labels: boolean; light: boolean; still: boolean };

export function Relationships({ schema, edges, lit, selected, labels, light, still }: Props) {
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
      <EndMarkers edges={edges} lit={isLit} strong={isStrong} colorOf={colorOf} />
      <FlowParticles edges={edges} lit={isLit} strong={isStrong} colorOf={colorOf} light={light} still={still} />
      {labels && edges.map((e) => (
        <EdgeLabel key={e.id} edge={e} lit={isLit(e)} strong={isStrong(e)} color={colorOf(e.to)} brief={light || selected !== null} />
      ))}
    </>
  );
}
