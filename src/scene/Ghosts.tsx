// Ghost tables: a refactoring the agent proposes, drawn as translucent
// wireframes above the live table with dashed links, so the change can be
// looked at before any migration is run.

import { Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { BoxGeometry, EdgesGeometry, Vector3, type Group, type LineDashedMaterial, type LineSegments, type MeshBasicMaterial } from 'three';
import type { GhostTable } from '../analysis/normalize';
import type { Layout, Vec3 } from '../layout/force';
import { CARD_W, drawCard, unfoldedHeight } from './card';
import { useCanvasTexture } from './useCanvasTexture';

const GHOST = '#5eead4';
const EDGES = new EdgesGeometry(new BoxGeometry(1, 1, 1));

/** Where ghosts of one table stand: in a row floating above it, clear of the tables around it. */
export function ghostPositions(ghosts: GhostTable[], layout: Layout): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  const bySource = new Map<string, GhostTable[]>();
  for (const g of ghosts) bySource.set(g.source, [...(bySource.get(g.source) ?? []), g]);
  for (const [source, list] of bySource) {
    const p = layout[source];
    if (!p) continue;
    list.forEach((g, i) => {
      const k = (i - (list.length - 1) / 2) * (CARD_W + 0.9);
      out.set(g.name, [p[0] + k, p[1] + 8.5, p[2] + 1.5]);
    });
  }
  return out;
}

function Ghost({ ghost, position, from }: { ghost: GhostTable; position: Vec3; from: Vec3 }) {
  const group = useRef<Group>(null);
  const edges = useRef<LineSegments>(null);
  const face = useRef<MeshBasicMaterial>(null);
  const height = unfoldedHeight(ghost.columns.length);
  const table = useMemo(() => ({ name: ghost.name, columns: ghost.columns, fks: ghost.link.kind === 'child' ? [{ column: ghost.link.column, refTable: ghost.source, refColumn: 'id' }] : [] }), [ghost]);
  const texture = useCanvasTexture((c) => drawCard(c, table, height, { color: GHOST, expanded: true, rows: 0, ghost: true, subtitle: `proposed · from ${ghost.source}` }), [table, height]);
  const link = useMemo(() => {
    const a = new Vector3(from[0], from[1] + 2.4, from[2]);
    const b = new Vector3(position[0], position[1] - height / 2, position[2]);
    return [a, b];
  }, [from, position, height]);

  useFrame(({ clock }) => {
    const pulse = 0.62 + Math.sin(clock.elapsedTime * 2.2) * 0.22;
    if (edges.current) {
      if (!edges.current.geometry.attributes.lineDistance) edges.current.computeLineDistances();
      (edges.current.material as LineDashedMaterial).opacity = pulse;
    }
    if (face.current) face.current.opacity = 0.55 + pulse * 0.4;
    if (group.current) group.current.position.y = position[1] + Math.sin(clock.elapsedTime * 1.1 + position[0]) * 0.12;
  });

  return (
    <>
      <group ref={group} position={position}>
        <lineSegments ref={edges} geometry={EDGES} scale={[CARD_W, height, 0.5]} raycast={() => null}>
          <lineDashedMaterial color={GHOST} dashSize={0.045} gapSize={0.03} transparent toneMapped={false} />
        </lineSegments>
        <mesh scale={[CARD_W, height, 0.5]} raycast={() => null}>
          <boxGeometry args={[1, 1, 1]} />
          <meshBasicMaterial color={GHOST} transparent opacity={0.045} depthWrite={false} />
        </mesh>
        {[1, -1].map((side) => (
          <mesh key={side} position-z={side * 0.262} rotation-y={side === 1 ? 0 : Math.PI} scale={[CARD_W, height, 1]} raycast={() => null}>
            <planeGeometry args={[1, 1]} />
            <meshBasicMaterial ref={side === 1 ? face : undefined} map={texture} transparent depthWrite={false} toneMapped={false} />
          </mesh>
        ))}
      </group>
      <Line points={link} color={GHOST} lineWidth={1.4} dashed dashSize={0.35} gapSize={0.25} transparent opacity={0.7} toneMapped={false} raycast={() => null} />
    </>
  );
}

export function Ghosts({ ghosts, layout }: { ghosts: GhostTable[]; layout: Layout }) {
  const positions = useMemo(() => ghostPositions(ghosts, layout), [ghosts, layout]);
  return (
    <>
      {ghosts.map((g) => {
        const p = positions.get(g.name);
        const from = layout[g.source];
        return p && from ? <Ghost key={g.name} ghost={g} position={p} from={from} /> : null;
      })}
    </>
  );
}
