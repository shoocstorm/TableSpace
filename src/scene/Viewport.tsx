// The full-screen 3D view: the chosen environment (sky, fog, floor grid),
// the active schema's tables and relationships, and whatever the agent has added.

import { Canvas, useFrame } from '@react-three/fiber';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { useEffect, useMemo, useRef } from 'react';
import { litTables, positionsOf, selectTable, toggleExpanded, useScene } from '../state/scene';
import { isMobileDevice, useEngine } from '../llm/engine';
import { useUi } from '../state/ui';
import { usePhone, useReducedMotion } from '../ui/usePhone';
import { Backdrop } from './Backdrop';
import { CameraRig } from './CameraRig';
import { environmentById } from './environments';
import { topoOrder } from '../schema/graph';
import { Ghosts } from './Ghosts';
import { introOrder, replayAssembly, tickIntro } from './intro';
import { resetLive } from './live';
import { QueryPulses } from './QueryPulses';
import { Relationships } from './Relationships';
import { TableMonolith, type Accent } from './TableMonolith';
import { WarningBadges } from './WarningBadges';

function Scene({ phone, still }: { phone: boolean; still: boolean }) {
  const schema = useScene((s) => s.schema);
  const edges = useScene((s) => s.edges);
  const layout = useScene((s) => positionsOf(s));
  const selected = useScene((s) => s.selected);
  const expanded = useScene((s) => s.expanded);
  const rows = useScene((s) => s.rows);
  const fill = useScene((s) => s.fill);
  const badges = useScene((s) => s.badges);
  const ghosts = useScene((s) => s.ghosts);
  const trace = useScene((s) => s.trace);
  const traceStep = useScene((s) => s.traceStep);
  const xray = useScene((s) => s.xray);
  const focus = useScene((s) => s.focus);
  const env = environmentById(useUi((s) => s.env));
  const labels = useUi((s) => s.labels);

  const lit = useMemo(() => litTables({ xray, focus, selected, schema }), [xray, focus, selected, schema]);
  const litSet = useMemo(() => (lit ? new Set(lit) : null), [lit]);
  const colors = useMemo(() => new Map(schema.domains.map((d) => [d.id, d.color])), [schema]);
  const floor = useMemo(() => Math.min(...Object.values(layout).map((p) => p[1])) - 5, [layout]);

  useEffect(() => resetLive, [schema.id]);

  // the scene builds itself when the app opens and when another database is opened: parents land before their children
  const order = useMemo(() => topoOrder(schema), [schema]);
  const opened = useRef(schema.id);
  useEffect(() => {
    introOrder(order);
    if (opened.current !== schema.id) replayAssembly();
    opened.current = schema.id;
  }, [order, schema.id]);
  useFrame(tickIntro);

  // the columns at both ends of the selected table's relationships: their rows light up on the faces
  const linked = useMemo(() => {
    const sets = new Map<string, Set<string>>();
    const add = (table: string, column: string) => void (sets.get(table) ?? sets.set(table, new Set()).get(table)!).add(column);
    for (const e of edges) {
      if (e.from !== selected && e.to !== selected) continue;
      add(e.from, e.column);
      add(e.to, e.refColumn);
    }
    return new Map([...sets].map(([table, columns]) => [table, [...columns].join('\n')]));
  }, [edges, selected]);

  // the tables the trace has reached so far, colored by how they were read
  const accents = useMemo(() => {
    const out = new Map<string, Accent>();
    trace?.steps.slice(0, traceStep + 1).forEach((s) => out.set(s.table, s.scan === 'index' ? 'index' : s.slow ? 'slow' : 'seq'));
    return out;
  }, [trace, traceStep]);

  const onSelect = (name: string) => {
    const s = useScene.getState();
    // a second click on the selected table folds or unfolds it
    if (s.selected === name) toggleExpanded(name);
    else selectTable(name, { fly: true, expand: !phone });
  };

  return (
    <>
      <Backdrop env={env} floor={floor} phone={phone} still={still} />

      {schema.tables.map((t) => (
        <TableMonolith
          key={`${schema.id}:${t.name}`}
          table={t}
          color={colors.get(t.domain) ?? '#94a3b8'}
          position={layout[t.name]}
          floor={floor}
          rows={rows[t.name] ?? t.rows}
          expanded={!!expanded[t.name]}
          selected={selected === t.name}
          dimmed={!!litSet && !litSet.has(t.name)}
          fill={fill[t.name]}
          accent={accents.get(t.name) ?? null}
          linked={linked.get(t.name) ?? ''}
          still={still}
          onSelect={onSelect}
        />
      ))}
      <Relationships key={schema.id} schema={schema} edges={edges} lit={lit} selected={selected} labels={labels} light={phone} still={still} />
      {trace && <QueryPulses key={trace.sql} steps={trace.steps} edges={edges} still={still} />}
      <Ghosts ghosts={ghosts} layout={layout} />
      <WarningBadges badges={badges} />
      <CameraRig still={still} />
      <EffectComposer multisampling={phone ? 0 : 4} enabled>
        <Bloom mipmapBlur luminanceThreshold={1} luminanceSmoothing={0.2} intensity={(phone ? 0.55 : 0.9) * env.bloom} radius={0.7} />
        <Vignette offset={0.28} darkness={0.62} />
      </EffectComposer>
    </>
  );
}

export function Viewport() {
  const phone = usePhone();
  const still = useReducedMotion();
  // while a phone warms a model up, the scene holds still: the load gets the CPU, and no frame allocates beside it
  const warming = useEngine((s) => s.status === 'loading') && isMobileDevice;
  return (
    <Canvas frameloop={warming ? 'never' : 'always'} dpr={[1, phone ? 1.5 : 2]} camera={{ fov: 50, near: 0.5, far: 600, position: [8, 14, 60] }} gl={{ antialias: !phone, powerPreference: 'high-performance' }} onPointerMissed={() => selectTable(null)}>
      <Scene phone={phone} still={still} />
    </Canvas>
  );
}
