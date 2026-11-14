// A query trace: a glowing pulse travels the relationship lines in the
// order the (simulated) plan joins the tables. Cyan for an index lookup,
// amber for a small sequential scan, red and slower for a slow one.

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { Color, Object3D, QuadraticBezierCurve3, Vector3, type InstancedMesh } from 'three';
import type { PlanStep } from '../analysis/plan';
import { edgeBetween, type Edge } from '../schema/graph';
import { setTraceStep } from '../state/scene';
import { live } from './live';

const TRAIL = 9;
const PAUSE = 1.4;
export const scanColor = (s: Pick<PlanStep, 'scan' | 'slow'>) => (s.scan === 'index' ? '#67e8f9' : s.slow ? '#ff4d4d' : '#fbbf24');
const duration = (s: PlanStep) => (s.from === null ? 0.7 : s.slow ? 2.6 : s.scan === 'seq' ? 1.5 : 1.0);

export function QueryPulses({ steps, edges, still }: { steps: PlanStep[]; edges: Edge[]; still: boolean }) {
  const mesh = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const arc = useMemo(() => new QuadraticBezierCurve3(new Vector3(), new Vector3(), new Vector3()), []);
  const color = useMemo(() => new Color(), []);
  const started = useRef<number | null>(null);
  const timeline = useMemo(() => {
    let at = 0;
    const out = steps.map((s) => {
      const start = at;
      at += duration(s);
      return { step: s, start, end: at, edge: s.from ? edgeBetween(edges, s.from, s.table) : undefined };
    });
    return { items: out, total: at + PAUSE };
  }, [steps, edges]);

  useFrame(({ clock }) => {
    const m = mesh.current;
    if (!m || !timeline.items.length) return;
    started.current ??= clock.elapsedTime;
    const elapsed = clock.elapsedTime - started.current;
    // with reduced motion the trace doesn't loop: it rests on its last step
    const time = still ? timeline.total - PAUSE - 0.001 : elapsed % timeline.total;
    let idx = timeline.items.findIndex((x) => time < x.end);
    const resting = idx < 0;
    if (resting) idx = timeline.items.length - 1;
    setTraceStep(idx);
    const item = timeline.items[idx];
    const local = resting ? 1 : (time - item.start) / (item.end - item.start);
    color.set(scanColor(item.step)).multiplyScalar(3.2);

    const target = live.tables.get(item.step.table);
    for (let i = 0; i < TRAIL; i++) {
      dummy.scale.setScalar(0);
      if (target && !resting) {
        if (item.step.from === null) {
          // the driving table: the pulse swells where the query starts
          if (i === 0) {
            dummy.position.copy(target.pos);
            dummy.position.y += target.height / 2 + 0.5;
            dummy.scale.setScalar(0.6 + Math.sin(local * Math.PI) * 1.6);
          }
        } else {
          const t = local - i * 0.022;
          const curve = item.edge && live.curves.get(item.edge.id);
          if (t >= 0) {
            if (curve && item.edge) {
              // curves run child → parent; the pulse runs the way the plan does
              curve.getPoint(item.edge.from === item.step.from ? t : 1 - t, dummy.position);
            } else {
              const from = live.tables.get(item.step.from);
              if (from) {
                arc.v0.copy(from.pos);
                arc.v2.copy(target.pos);
                arc.v1.copy(from.pos).lerp(target.pos, 0.5);
                arc.v1.y += 3;
                arc.getPoint(t, dummy.position);
              }
            }
            dummy.scale.setScalar((1 - i / TRAIL) * (item.step.slow ? 1.5 : 1.15));
          }
        }
      }
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
      m.setColorAt(i, color);
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, TRAIL]} frustumCulled={false} raycast={() => null}>
      <sphereGeometry args={[0.2, 14, 14]} />
      <meshBasicMaterial toneMapped={false} transparent opacity={0.95} />
    </instancedMesh>
  );
}
