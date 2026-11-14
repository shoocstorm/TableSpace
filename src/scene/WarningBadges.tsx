// Audit findings as badges floating above the tables they are about.

import { Billboard } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { type Group } from 'three';
import type { Finding, Severity } from '../analysis/audit';
import { drawPill } from './card';
import { live } from './live';
import { useCanvasTexture } from './useCanvasTexture';

export const SEVERITY_COLOR: Record<Severity, string> = { critical: '#ff5c5c', warning: '#fbbf24', info: '#7dd3fc' };

function Badge({ table, findings, index }: { table: string; findings: Finding[]; index: number }) {
  const group = useRef<Group>(null);
  const size = useRef({ w: 300, h: 60 });
  const worst = findings[0];
  const text = findings.length > 1 ? `${worst.title} +${findings.length - 1}` : worst.title;
  const color = SEVERITY_COLOR[worst.severity];
  const texture = useCanvasTexture((c) => void (size.current = drawPill(c, text, { color, fill: 'rgba(10,8,12,0.9)', icon: '⚠', font: '600 30px "Inter", system-ui, sans-serif' })), [text, color]);
  const stem = useMemo(() => [0, -0.9, 0] as const, []);

  useFrame(({ clock }) => {
    const g = group.current;
    const t = live.tables.get(table);
    if (!g || !t) return;
    g.visible = true;
    g.position.set(t.pos.x, t.pos.y + t.height / 2 + 1.75 + Math.sin(clock.elapsedTime * 1.8 + index) * 0.1, t.pos.z);
    const plane = g.children[0]?.children[0];
    if (plane) plane.scale.set((size.current.w / size.current.h) * 0.62, 0.62, 1);
  });

  return (
    <group ref={group} visible={false}>
      <Billboard>
        <mesh raycast={() => null} renderOrder={10}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial map={texture} transparent depthTest={false} toneMapped={false} />
        </mesh>
      </Billboard>
      <mesh position={stem} raycast={() => null}>
        <cylinderGeometry args={[0.012, 0.012, 1.2, 6]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
    </group>
  );
}

export function WarningBadges({ badges }: { badges: Record<string, Finding[]> }) {
  return (
    <>
      {Object.entries(badges).map(([table, findings], i) => (
        <Badge key={table} table={table} findings={findings} index={i} />
      ))}
    </>
  );
}
