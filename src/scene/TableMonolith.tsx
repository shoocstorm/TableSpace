// One SQL table: a glass slab whose height and depth grow with its row
// count, in its domain's color, with the table's name, keys and (unfolded)
// columns on both faces. It glides to wherever the layout puts it and fades
// when X-ray dims it.

import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { BoxGeometry, Color, EdgesGeometry, MathUtils, Vector3, type Group, type LineBasicMaterial, type LineSegments, type Mesh, type MeshBasicMaterial, type MeshStandardMaterial } from 'three';
import type { Table } from '../schema/types';
import { CARD_W, depthOf, drawCard, heightOf } from './card';
import { live, touch } from './live';
import { useCanvasTexture } from './useCanvasTexture';

const BOX = new BoxGeometry(1, 1, 1);
const BOX_EDGES = new EdgesGeometry(BOX);

export type Accent = 'index' | 'seq' | 'slow' | null;
const ACCENT: Record<Exclude<Accent, null>, string> = { index: '#67e8f9', seq: '#fbbf24', slow: '#ff4d4d' };

type Props = {
  table: Table;
  color: string;
  position: [number, number, number];
  rows: number;
  expanded: boolean;
  selected: boolean;
  dimmed: boolean;
  /** 0–1 while and after seeding; undefined when the table was never seeded. */
  fill: number | undefined;
  /** Set while a query trace has reached this table. */
  accent: Accent;
  onSelect: (name: string) => void;
};

export function TableMonolith({ table, color, position, rows, expanded, selected, dimmed, fill, accent, onSelect }: Props) {
  const group = useRef<Group>(null);
  const body = useRef<Mesh>(null);
  const edges = useRef<LineSegments>(null);
  const cap = useRef<Mesh>(null);
  const liquid = useRef<Mesh>(null);
  const front = useRef<Mesh>(null);
  const back = useRef<Mesh>(null);
  const hovered = useRef(false);

  const targetH = heightOf(rows, table.columns.length, expanded);
  const depth = depthOf(table.rows);
  const state = useRef({ h: targetH, dim: 1, fill: 0, placed: false });
  const target = useMemo(() => new Vector3(...position), [position]);
  const tint = useMemo(() => new Color(color), [color]);
  const edgeColor = useMemo(() => new Color(), []);

  const texture = useCanvasTexture((canvas) => drawCard(canvas, table, targetH, { color, expanded, rows }), [table, targetH, color, expanded, rows]);

  useEffect(() => {
    touch(1400);
  }, [target, targetH]);
  useEffect(() => () => void live.tables.delete(table.name), [table.name]);

  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    const s = state.current;
    if (!s.placed) {
      g.position.copy(target);
      s.placed = true;
    }
    const k = 1 - Math.exp(-dt * 5.5);
    if (g.position.distanceToSquared(target) > 1e-5) {
      g.position.lerp(target, k);
      touch();
    }
    if (Math.abs(s.h - targetH) > 1e-3) {
      s.h = MathUtils.lerp(s.h, targetH, 1 - Math.exp(-dt * 9));
      touch();
    } else s.h = targetH;
    s.dim = MathUtils.lerp(s.dim, dimmed ? 0.04 : 1, 1 - Math.exp(-dt * 6));
    s.fill = MathUtils.lerp(s.fill, fill ?? 0, 1 - Math.exp(-dt * 7));
    const h = s.h;

    body.current!.scale.set(CARD_W, h, depth);
    edges.current!.scale.set(CARD_W, h, depth);
    cap.current!.position.y = h / 2 + 0.03;
    for (const [face, z] of [[front.current!, depth / 2 + 0.012], [back.current!, -depth / 2 - 0.012]] as const) {
      face.scale.set(CARD_W, h, 1);
      face.position.z = z;
      (face.material as MeshBasicMaterial).opacity = s.dim;
    }
    const lq = liquid.current!;
    lq.visible = s.fill > 0.005;
    lq.scale.set(CARD_W - 0.08, Math.max(0.001, (h - 0.08) * s.fill), Math.max(0.05, depth - 0.08));
    lq.position.y = -h / 2 + 0.04 + lq.scale.y / 2;
    (lq.material as MeshStandardMaterial).opacity = 0.55 * s.dim;

    const glass = body.current!.material as MeshStandardMaterial;
    glass.opacity = (selected ? 0.62 : 0.5) * s.dim + 0.02;
    glass.emissiveIntensity = (selected ? 0.5 : hovered.current ? 0.36 : 0.2) * s.dim;
    const line = edges.current!.material as LineBasicMaterial;
    edgeColor.set(accent ? ACCENT[accent] : selected ? '#ffffff' : color).multiplyScalar(accent ? 2.6 : selected ? 1.5 : hovered.current ? 1.9 : 1.25);
    line.color.copy(edgeColor);
    line.opacity = Math.min(1, s.dim * 1.2);
    const capMat = cap.current!.material as MeshBasicMaterial;
    capMat.color.set(accent ? ACCENT[accent] : color).multiplyScalar(accent ? 3 : 1.9);
    capMat.opacity = s.dim;

    const l = live.tables.get(table.name);
    if (l) {
      l.pos.copy(g.position);
      l.height = h;
      l.expanded = expanded;
      l.dim = s.dim;
    } else live.tables.set(table.name, { pos: g.position.clone(), height: h, expanded, dim: s.dim });
  });

  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect(table.name);
  };
  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    hovered.current = true;
    document.body.style.cursor = 'pointer';
  };
  const out = () => {
    hovered.current = false;
    document.body.style.cursor = '';
  };

  return (
    <group ref={group}>
      <mesh ref={body} geometry={BOX} onClick={click} onPointerOver={over} onPointerOut={out}>
        <meshStandardMaterial color="#0b1424" emissive={tint} emissiveIntensity={0.2} roughness={0.25} metalness={0.4} transparent opacity={0.5} depthWrite={false} />
      </mesh>
      <lineSegments ref={edges} geometry={BOX_EDGES} raycast={() => null}>
        <lineBasicMaterial color={color} transparent toneMapped={false} />
      </lineSegments>
      <mesh ref={cap} raycast={() => null}>
        <boxGeometry args={[CARD_W, 0.06, depth]} />
        <meshBasicMaterial color={color} transparent toneMapped={false} />
      </mesh>
      <mesh ref={liquid} geometry={BOX} visible={false} raycast={() => null}>
        <meshStandardMaterial color={color} emissive={tint} emissiveIntensity={1.6} transparent opacity={0.55} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh ref={front} raycast={() => null}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh ref={back} rotation-y={Math.PI} raycast={() => null}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}
