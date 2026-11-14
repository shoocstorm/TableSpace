// Everything the 3D scene shows, in one store: the active schema and its
// layout, what is selected, focused or dimmed, and the overlays the agent
// adds (audit badges, a query trace, ghost tables, seeding progress). The
// agent's tools and the dock's buttons call the same actions.

import { create } from 'zustand';
import { audit, badgesFor, type AuditRule, type Finding } from '../analysis/audit';
import type { GhostTable } from '../analysis/normalize';
import { simulatePlan, type PlanStep } from '../analysis/plan';
import { parseQuery } from '../analysis/sql';
import { runSeed, seedPlan, type Row, type SeedSize } from '../analysis/seed';
import { computeLayout, explode, type Layout, type Vec3 } from '../layout/force';
import { edgesOf, isIndexed, neighbours, type Edge } from '../schema/graph';
import { DEFAULT_SCHEMA, schemaById } from '../schema/registry';
import type { SchemaDef } from '../schema/types';

export type Trace = { label: string; sql: string; steps: PlanStep[] };
export type CameraCmd = { nonce: number; tables: string[] | null; /** Other points to keep in view (ghost tables). */ extra?: Vec3[] };
export type Seeding = { order: string[]; current: string | null; done: number };

export type WhatIf = { table: string; column: string };

type SceneState = {
  /** The schema in effect: the database's own, plus any what-if indexes. */
  schema: SchemaDef;
  /** The schema as the database has it. */
  base: SchemaDef;
  /** Indexes being tried out: the audit and query plans see them, the database doesn't have them. */
  whatIf: WhatIf[];
  /** The rules of the audit on show, so it can be re-run when the schema changes. */
  auditRules: AuditRule[] | null;
  /** A complete, consistent set of mock rows for running queries; made on first use. */
  mock: Record<string, Row[]> | null;
  edges: Edge[];
  layout: Layout;
  explodedLayout: Layout;
  exploded: boolean;
  xray: boolean;
  selected: string | null;
  /** Tables whose column list is unfolded. */
  expanded: Record<string, boolean>;
  /** Tables the agent (or a trace) isolated; null when nothing is. */
  focus: string[] | null;
  focusLabel: string | null;
  findings: Finding[];
  badges: Record<string, Finding[]>;
  ghosts: GhostTable[];
  trace: Trace | null;
  /** The step the trace animation is on (scene/QueryPulses.tsx writes it). */
  traceStep: number;
  /** Live row counts: the schema's statistics plus what seeding added. */
  rows: Record<string, number>;
  /** How full a monolith's volume is while and after seeding, 0–1. */
  fill: Record<string, number>;
  samples: Record<string, Row[]>;
  seeding: Seeding | null;
  camera: CameraCmd;
};

const SCHEMA_KEY = 'tablespace.schema';
const stored = (): string | null => {
  try {
    return localStorage.getItem(SCHEMA_KEY);
  } catch {
    return null;
  }
};

function fresh(schema: SchemaDef): Omit<SceneState, 'camera'> {
  const layout = computeLayout(schema);
  return {
    schema,
    base: schema,
    whatIf: [],
    auditRules: null,
    mock: null,
    edges: edgesOf(schema),
    layout,
    explodedLayout: explode(layout, schema),
    exploded: false,
    xray: false,
    selected: null,
    expanded: {},
    focus: null,
    focusLabel: null,
    findings: [],
    badges: {},
    ghosts: [],
    trace: null,
    traceStep: 0,
    rows: Object.fromEntries(schema.tables.map((t) => [t.name, t.rows])),
    fill: {},
    samples: {},
    seeding: null,
  };
}

export const useScene = create<SceneState>(() => ({ ...fresh(schemaById(typeof localStorage === 'undefined' ? DEFAULT_SCHEMA : stored())), camera: { nonce: 0, tables: null } }));

const set = useScene.setState;
const get = useScene.getState;

/** Where tables stand right now (the exploded layout when that view is on). */
export const positionsOf = (s: Pick<SceneState, 'layout' | 'explodedLayout' | 'exploded'>): Layout => (s.exploded ? s.explodedLayout : s.layout);

/**
 * The tables that stay lit; null when nothing is dimmed. The agent's focus
 * wins; otherwise X-ray isolates the selected table and what it touches.
 */
export function litTables(s: Pick<SceneState, 'xray' | 'focus' | 'selected' | 'schema'>): string[] | null {
  if (!s.xray) return null;
  if (s.focus) return s.focus;
  return s.selected ? neighbours(s.schema, [s.selected], 1) : null;
}

let seedRun = 0;

/** Switches database. `force` rebuilds the scene even for the same id (an import that replaced it). */
export function setSchema(id: string, force = false): void {
  if (get().base.id === id && !force) return;
  seedRun++;
  try {
    localStorage.setItem(SCHEMA_KEY, id);
  } catch {
    // private mode: the choice just isn't remembered
  }
  set({ ...fresh(schemaById(id)), camera: { nonce: get().camera.nonce + 1, tables: null } });
}

/** Flies the camera to these tables, or to the whole schema with `null`. */
export function flyTo(tables: string[] | null, extra?: Vec3[]): void {
  set((s) => ({ camera: { nonce: s.camera.nonce + 1, tables, extra } }));
}

export function selectTable(name: string | null, opts: { fly?: boolean; expand?: boolean } = {}): void {
  set((s) => ({ selected: name, expanded: name && opts.expand ? { ...s.expanded, [name]: true } : s.expanded }));
  if (name && opts.fly) flyTo(get().xray && !get().focus ? neighbours(get().schema, [name], 1) : [name]);
}

export function toggleExpanded(name: string): void {
  set((s) => ({ expanded: { ...s.expanded, [name]: !s.expanded[name] } }));
}

export function toggleXray(): void {
  // turning X-ray off also lets go of whatever the agent had isolated
  set((s) => (s.xray ? { xray: false, focus: null, focusLabel: null } : { xray: true }));
}

export function toggleExploded(): void {
  set((s) => ({ exploded: !s.exploded }));
  const s = get();
  flyTo(s.focus ?? null);
}

/** Isolates tables: lights them, dims the rest and flies there. */
export function focusTables(tables: string[], label: string, extra?: Vec3[]): void {
  const known = tables.filter((t) => get().schema.tables.some((x) => x.name === t));
  if (!known.length) return;
  set({ focus: known, focusLabel: label, xray: true });
  flyTo(known, extra);
}

export function clearFocus(): void {
  set({ focus: null, focusLabel: null, xray: false });
}

export function showFindings(findings: Finding[], rules: AuditRule[] | null = null): void {
  set({ findings, badges: badgesFor(findings), auditRules: rules });
}
export const clearBadges = () => set({ findings: [], badges: {}, auditRules: null });

/** The base schema with the what-if indexes added. */
function withIndexes(base: SchemaDef, whatIf: WhatIf[]): SchemaDef {
  if (!whatIf.length) return base;
  return {
    ...base,
    tables: base.tables.map((t) => {
      const mine = whatIf.filter((w) => w.table === t.name);
      return mine.length ? { ...t, indexes: [...t.indexes, ...mine.map((w) => ({ name: `${t.name}_${w.column}_idx`, columns: [w.column], whatIf: true }))] } : t;
    }),
  };
}

/** After the effective schema changes: the audit on show and the running trace are worked out again. */
function applyWhatIf(whatIf: WhatIf[]): void {
  const s = get();
  const schema = withIndexes(s.base, whatIf);
  const patch: Partial<SceneState> = { schema, whatIf };
  if (s.auditRules) {
    const findings = audit(schema, s.auditRules);
    Object.assign(patch, { findings, badges: badgesFor(findings) });
  }
  if (s.trace) {
    const parsed = parseQuery(s.trace.sql);
    const planned = parsed.ok ? simulatePlan(schema, parsed.query) : null;
    if (planned?.ok) Object.assign(patch, { trace: { ...s.trace, steps: planned.plan.steps }, traceStep: 0 });
  }
  set(patch);
}

/** Tries out indexes. Returns the ones that were new (a column already indexed is left alone). */
export function addWhatIf(items: WhatIf[]): WhatIf[] {
  const s = get();
  const added = items.filter((w, i) => {
    const t = s.schema.tables.find((x) => x.name === w.table);
    return t?.columns.some((c) => c.name === w.column) && !isIndexed(t, w.column) && items.findIndex((x) => x.table === w.table && x.column === w.column) === i;
  });
  if (added.length) applyWhatIf([...s.whatIf, ...added]);
  return added;
}
export const clearWhatIf = () => get().whatIf.length && applyWhatIf([]);

/** Mock rows for every table, consistent across foreign keys, for running generated queries. Made once per schema. */
export function mockData(): Record<string, Row[]> {
  const s = get();
  if (s.mock) return s.mock;
  const mock = runSeed(s.base, seedPlan(s.base, null, 'medium'), 7).rows;
  set({ mock });
  return mock;
}

export function showGhosts(ghosts: GhostTable[]): void {
  set((s) => ({ ghosts: [...s.ghosts.filter((g) => !ghosts.some((n) => n.source === g.source)), ...ghosts] }));
}
export const clearGhosts = () => set({ ghosts: [] });

export function startTrace(trace: Trace): void {
  const tables = [...new Set(trace.steps.map((s) => s.table))];
  set({ trace, traceStep: 0, focus: tables, focusLabel: `Trace · ${trace.label}`, xray: true });
  flyTo(tables);
}
export function clearTrace(): void {
  set((s) => ({ trace: null, traceStep: 0, ...(s.focusLabel?.startsWith('Trace') ? { focus: null, focusLabel: null, xray: false } : {}) }));
}
export const setTraceStep = (i: number) => get().traceStep !== i && set({ traceStep: i });

/** Clears focus and trace and shows the whole schema again. Badges and ghosts stay until dismissed. */
export function resetView(): void {
  set({ focus: null, focusLabel: null, xray: false, trace: null, traceStep: 0, selected: null });
  flyTo(null);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Seeds tables parents first, filling one monolith at a time. Resolves with
 * what was inserted; stops quietly when the schema changes under it.
 */
export async function seedTables(tables: string[] | null, size: SeedSize): Promise<{ order: string[]; counts: Record<string, number>; total: number } | null> {
  const run = ++seedRun;
  const { schema } = get();
  const plan = seedPlan(schema, tables, size);
  const result = runSeed(schema, plan, 20261113 + run);
  set((s) => ({ seeding: { order: plan.order, current: null, done: 0 }, fill: { ...s.fill, ...Object.fromEntries(plan.order.map((n) => [n, 0])) } }));
  flyTo(tables);
  await wait(500);
  const counts: Record<string, number> = {};
  const STEPS = 6;
  const perTable = Math.max(180, Math.min(520, 9000 / plan.order.length));
  for (let i = 0; i < plan.order.length; i++) {
    const name = plan.order[i];
    const rows = result.rows[name];
    counts[name] = rows.length;
    set({ seeding: { order: plan.order, current: name, done: i } });
    for (let k = 1; k <= STEPS; k++) {
      if (run !== seedRun) return null;
      const part = Math.round((rows.length * k) / STEPS) - Math.round((rows.length * (k - 1)) / STEPS);
      set((s) => ({ fill: { ...s.fill, [name]: k / STEPS }, rows: { ...s.rows, [name]: (s.rows[name] ?? 0) + part } }));
      await wait(perTable / STEPS);
    }
    set((s) => ({ samples: { ...s.samples, [name]: rows.slice(0, 12) } }));
  }
  if (run !== seedRun) return null;
  set({ seeding: null });
  return { order: plan.order, counts, total: result.total };
}
