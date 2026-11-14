// One SQL table: a glass slab whose height and depth grow with its row
// count, in its domain's color, with the table's name and keys (and, unfolded,
// every column) on both faces. It glides to wherever the layout puts it and
// fades when X-ray dims it. Selected, it lifts a little, its frame and the
// ring on the floor under it light up, and the rows its relationships hang on
// are picked out.

import { Billboard } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { AdditiveBlending, BoxGeometry, CanvasTexture, Color, EdgesGeometry, MathUtils, Vector3, type Group, type LineBasicMaterial, type LineSegments, type Mesh, type MeshBasicMaterial, type MeshStandardMaterial } from 'three';
import type { Table } from '../schema/types';
import { CARD_W, depthOf, drawCard, drawPill, heightOf } from './card';
import { tableReveal } from './intro';
import { live, touch } from './live';
import { useCanvasTexture } from './useCanvasTexture';

const BOX = new BoxGeometry(1, 1, 1);
const BOX_EDGES = new EdgesGeometry(BOX);
/** How far above its place a table starts when the scene builds. */
const DROP = 7;
/** How far the selected table rises. */
const LIFT = 0.35;
const WHITE = new Color('#ffffff');

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D) => void): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!);
  return new CanvasTexture(c);
}

/** A soft round glow, shared by every table's pool of light on the floor and by the selected table's aura. */
let glow: CanvasTexture | null = null;
const glowTexture = () =>
  (glow ??= canvasTexture(128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.28)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }));

/** The ring on the floor under the selected table: a dashed circle around a fine one. */
let ring: CanvasTexture | null = null;
const ringTexture = () =>
  (ring ??= canvasTexture(512, (ctx) => {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.setLineDash([46, 34.4]);
    ctx.beginPath();
    ctx.arc(256, 256, 230, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(256, 256, 196, 0, Math.PI * 2);
    ctx.stroke();
  }));

export type Accent = 'index' | 'seq' | 'slow' | null;
const ACCENT: Record<Exclude<Accent, null>, string> = { index: '#67e8f9', seq: '#fbbf24', slow: '#ff4d4d' };

type Props = {
  table: Table;
  color: string;
  position: [number, number, number];
  /** The height of the floor grid, where the table's light falls. */
  floor: number;
  rows: number;
  expanded: boolean;
  selected: boolean;
  dimmed: boolean;
  /** 0–1 while and after seeding; undefined when the table was never seeded. */
  fill: number | undefined;
  /** Set while a query trace has reached this table. */
  accent: Accent;
  /** The columns at the ends of the selected table's relationships, one per line; empty when there are none. */
  linked: string;
  /** Reduced motion: nothing breathes or turns. */
  still: boolean;
  onSelect: (name: string) => void;
};

export function TableMonolith({ table, color, position, floor, rows, expanded, selected, dimmed, fill, accent, linked, still, onSelect }: Props) {
  const group = useRef<Group>(null);
  const body = useRef<Mesh>(null);
  const edges = useRef<LineSegments>(null);
  const cap = useRef<Mesh>(null);
  const foot = useRef<Mesh>(null);
  const aura = useRef<Mesh>(null);
  const ringMesh = useRef<Mesh>(null);
  const liquid = useRef<Mesh>(null);
  const front = useRef<Mesh>(null);
  const back = useRef<Mesh>(null);
  const hovered = useRef(false);
  const pool = useRef<Mesh>(null);
  const tether = useRef<Mesh>(null);
  const tag = useRef<Group>(null);
  const tagPlane = useRef<Mesh>(null);
  const tagSize = useRef({ w: 300, h: 60 });

  const targetH = heightOf(table, rows, expanded);
  const depth = depthOf(table.rows);
  const state = useRef({ h: targetH, dim: 1, fill: 0, sel: 0, hov: 0, drop: 0, placed: false });
  const target = useMemo(() => new Vector3(position[0], position[1] + (selected ? LIFT : 0), position[2]), [position, selected]);
  const tint = useMemo(() => new Color(color), [color]);
  const edgeColor = useMemo(() => new Color(), []);
  const linkedSet = useMemo(() => (linked ? new Set(linked.split('\n')) : null), [linked]);

  const texture = useCanvasTexture((canvas) => drawCard(canvas, table, targetH, { color, expanded, rows, selected, linked: linkedSet }), [table, targetH, color, expanded, rows, selected, linkedSet]);

  // the name again as a tag that faces the camera: from across the schema the face is too small to read
  const tagTexture = useCanvasTexture((c) => void (tagSize.current = drawPill(c, table.name, { color: '#f8fafc', stroke: color, fill: 'rgba(6,10,18,0.86)', font: '600 34px "Space Grotesk", "Inter", system-ui, sans-serif' })), [table.name, color]);

  useEffect(() => {
    touch(1400);
  }, [target, targetH]);
  useEffect(() => () => void live.tables.delete(table.name), [table.name]);

  useFrame(({ camera, clock }, dt) => {
    const g = group.current;
    if (!g) return;
    const s = state.current;
    if (!s.placed) {
      g.position.copy(target);
      s.placed = true;
    }
    // while the scene builds, the table falls into its place, growing as it lands and flaring as it arrives
    const landing = tableReveal(table.name);
    g.visible = landing > 0;
    const settle = 1 - (1 - landing) ** 3;
    const flare = landing < 1 ? Math.sin(landing * Math.PI) ** 0.6 : 0;
    g.position.y -= s.drop;
    const k = 1 - Math.exp(-dt * 5.5);
    if (g.position.distanceToSquared(target) > 1e-5) {
      g.position.lerp(target, k);
      touch();
    }
    s.drop = (1 - settle) * DROP;
    g.position.y += s.drop;
    if (Math.abs(s.h - targetH) > 1e-3) {
      s.h = MathUtils.lerp(s.h, targetH, 1 - Math.exp(-dt * 9));
      touch();
    } else s.h = targetH;
    s.dim = MathUtils.lerp(s.dim, dimmed ? 0.04 : 1, 1 - Math.exp(-dt * 6));
    s.fill = MathUtils.lerp(s.fill, fill ?? 0, 1 - Math.exp(-dt * 7));
    s.sel = MathUtils.lerp(s.sel, selected ? 1 : 0, 1 - Math.exp(-dt * 7));
    s.hov = MathUtils.lerp(s.hov, hovered.current ? 1 : 0, 1 - Math.exp(-dt * 12));
    const { sel, hov } = s;
    const h = s.h * (0.12 + 0.88 * settle);
    const dim = s.dim * Math.min(1, landing * 3);
    const time = still ? 0 : clock.elapsedTime;
    const breath = 0.5 + 0.5 * Math.sin(time * 2.2);

    body.current!.scale.set(CARD_W, h, depth);
    edges.current!.scale.set(CARD_W, h, depth);
    cap.current!.position.y = h / 2 + 0.03;
    foot.current!.position.y = -h / 2 - 0.015;
    for (const [face, z] of [[front.current!, depth / 2 + 0.012], [back.current!, -depth / 2 - 0.012]] as const) {
      face.scale.set(CARD_W, h, 1);
      face.position.z = z;
      (face.material as MeshBasicMaterial).opacity = dim;
    }
    const lq = liquid.current!;
    lq.visible = s.fill > 0.005;
    lq.scale.set(CARD_W - 0.08, Math.max(0.001, (h - 0.08) * s.fill), Math.max(0.05, depth - 0.08));
    lq.position.y = -h / 2 + 0.04 + lq.scale.y / 2;
    (lq.material as MeshStandardMaterial).opacity = 0.55 * dim;

    const glass = body.current!.material as MeshStandardMaterial;
    glass.opacity = (0.54 + 0.1 * sel) * dim + 0.02;
    glass.emissiveIntensity = (0.2 + 0.14 * hov + 0.2 * sel) * dim;
    // the frame keeps the domain's hue when selected, only hotter: white would wash the face out
    const line = edges.current!.material as LineBasicMaterial;
    if (accent) edgeColor.set(ACCENT[accent]).multiplyScalar(2.6);
    else edgeColor.copy(tint).lerp(WHITE, Math.max(0.35 * sel, 0.5 * flare)).multiplyScalar(1.25 + 0.65 * hov + 1.5 * sel + 3 * flare);
    line.color.copy(edgeColor);
    line.opacity = Math.min(1, dim * 1.2);
    const capMat = cap.current!.material as MeshBasicMaterial;
    if (accent) capMat.color.set(ACCENT[accent]).multiplyScalar(3);
    else capMat.color.copy(tint).multiplyScalar(1.35 + 0.45 * hov + 1.1 * sel + 2.5 * flare);
    capMat.opacity = dim;
    const footMat = foot.current!.material as MeshBasicMaterial;
    footMat.color.copy(tint).multiplyScalar(0.7 + 0.3 * hov + 1.1 * sel);
    footMat.opacity = dim;

    const au = aura.current!;
    au.visible = sel * dim > 0.01;
    au.scale.set(CARD_W * 2.5, h * 1.5 + 2.4, 1);
    (au.material as MeshBasicMaterial).opacity = sel * dim * (0.12 + 0.05 * breath);

    // the pool of light under the table, the thread that ties it to the floor, and the ring that marks the selected one
    const drop = g.position.y - h / 2 - floor;
    const onFloor = floor - g.position.y;
    pool.current!.position.y = onFloor + 0.04;
    pool.current!.scale.setScalar(6.5 + sel + depth + 3 * flare);
    (pool.current!.material as MeshBasicMaterial).opacity = (0.2 + 0.08 * hov + 0.14 * sel + 0.45 * flare) * dim;
    const rg = ringMesh.current!;
    rg.visible = sel * dim > 0.01;
    rg.position.y = onFloor + 0.06;
    rg.scale.setScalar((4.6 + depth) * (0.6 + 0.4 * sel));
    rg.rotation.z = time * 0.22;
    (rg.material as MeshBasicMaterial).opacity = sel * dim * 0.9;
    tether.current!.visible = drop > 0.2;
    tether.current!.scale.y = Math.max(0.01, drop);
    tether.current!.position.y = -h / 2 - drop / 2;
    (tether.current!.material as MeshBasicMaterial).opacity = (0.22 + 0.45 * sel + 0.6 * flare) * dim;

    // the name tag grows with distance and gives way to the face up close
    const dist = camera.position.distanceTo(g.position);
    const far = MathUtils.smoothstep(dist, 17, 30);
    const k2 = MathUtils.clamp(dist / 44, 0.8, 2.1);
    const t = tag.current!;
    t.visible = far * dim > 0.03;
    t.position.y = h / 2 + 0.3 + 0.27 * k2;
    const plane = tagPlane.current!;
    plane.scale.set((tagSize.current.w / tagSize.current.h) * 0.54 * k2, 0.54 * k2, 1);
    (plane.material as MeshBasicMaterial).opacity = far * dim;

    const l = live.tables.get(table.name);
    if (l) {
      l.pos.copy(g.position);
      l.height = h;
      l.depth = depth;
      l.expanded = expanded;
      l.dim = dim;
    } else live.tables.set(table.name, { pos: g.position.clone(), height: h, depth, expanded, dim });
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
      <mesh ref={foot} raycast={() => null}>
        <boxGeometry args={[CARD_W, 0.03, depth]} />
        <meshBasicMaterial color={color} transparent toneMapped={false} />
      </mesh>
      <Billboard>
        <mesh ref={aura} visible={false} raycast={() => null} renderOrder={-1}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial map={glowTexture()} color={color} transparent opacity={0} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      </Billboard>
      <mesh ref={ringMesh} rotation-x={-Math.PI / 2} visible={false} raycast={() => null}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={ringTexture()} color={color} transparent opacity={0} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh ref={pool} rotation-x={-Math.PI / 2} raycast={() => null}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={glowTexture()} color={color} transparent opacity={0.2} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh ref={tether} raycast={() => null}>
        <cylinderGeometry args={[0.018, 0.018, 1, 6]} />
        <meshBasicMaterial color={color} transparent opacity={0.22} depthWrite={false} toneMapped={false} />
      </mesh>
      <group ref={tag} visible={false}>
        <Billboard>
          <mesh ref={tagPlane} raycast={() => null}>
            <planeGeometry args={[1, 1]} />
            <meshBasicMaterial map={tagTexture} transparent depthWrite={false} toneMapped={false} />
          </mesh>
        </Billboard>
      </group>
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
