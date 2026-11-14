// PURE: runs a QuerySpec over in-memory rows, the way the SQL compiled from
// the same spec would run: the same joins (inner, on the foreign keys of
// `joinPath`), filters, grouping, ordering and limit. This is what lets a
// generated query show results without a database. The rows are mock data.

import { tableByName } from '../schema/graph';
import type { SchemaDef } from '../schema/types';
import { defaultColumns, joinPath, type ColRef, type QuerySpec } from './querybuilder';
import type { Row, Value } from './seed';

export type ResultSet = { columns: string[]; rows: Value[][]; /** Rows before the limit was applied. */ total: number; /** Rows read across the joined tables. */ scanned: number };
export type Executed = { ok: true; result: ResultSet } | { ok: false; error: string };

const split = (ref: ColRef): [string, string] => [ref.slice(0, ref.indexOf('.')), ref.slice(ref.indexOf('.') + 1)];
/** A joined row: one source row per table. */
type Joined = Record<string, Row>;
const read = (j: Joined, ref: ColRef): Value => {
  const [t, c] = split(ref);
  return j[t]?.[c] ?? null;
};

const isNumericType = (type: string) => /int|numeric|decimal|real|double|float|serial/i.test(type);

function compare(a: Value, b: Value): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1; // nulls last
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** A join that would produce more rows than this is stopped: the mock data is small, so this only guards against a runaway. */
const MAX_JOINED = 200_000;

export function executeSpec(schema: SchemaDef, spec: QuerySpec, data: Record<string, Row[]>): Executed {
  const refs = [...spec.select, ...spec.groupBy, ...spec.filters.map((f) => f.column), ...(spec.aggregateColumn ? [spec.aggregateColumn] : []), ...(spec.orderBy && spec.orderBy !== 'aggregate' ? [spec.orderBy] : [])];
  const wanted = [...new Set([...spec.tables, ...refs.map((r) => split(r)[0])])];
  const path = joinPath(schema, wanted);
  if (!path) return { ok: false, error: 'The tables are not connected by foreign keys.' };
  for (const t of path.order) if (!data[t]) return { ok: false, error: `There is no mock data for ${t}.` };

  // ── joins: each step looks its rows up by key in a hash of the new table ──
  let joined: Joined[] = data[path.order[0]].map((r) => ({ [path.order[0]]: r }));
  let scanned = joined.length;
  for (const { table, edge } of path.steps) {
    const other = edge.from === table ? edge.to : edge.from;
    const mine = edge.from === table ? edge.column : edge.refColumn;
    const theirs = edge.from === table ? edge.refColumn : edge.column;
    const index = new Map<Value, Row[]>();
    for (const r of data[table]) {
      const k = r[mine];
      if (k === null || k === undefined) continue;
      const bucket = index.get(k);
      if (bucket) bucket.push(r);
      else index.set(k, [r]);
    }
    scanned += data[table].length;
    const next: Joined[] = [];
    for (const j of joined) {
      for (const r of index.get(j[other]?.[theirs] ?? null) ?? []) {
        next.push({ ...j, [table]: r });
        if (next.length > MAX_JOINED) return { ok: false, error: 'The join grew too large to run on the mock data.' };
      }
    }
    joined = next;
  }

  // ── where ──
  for (const f of spec.filters) {
    const [t, c] = split(f.column);
    const numeric = isNumericType(tableByName(schema, t)?.columns.find((x) => x.name === c)?.type ?? '');
    const want: Value = numeric ? Number(f.value) : /^(true|yes)$/i.test(f.value) ? true : /^(false|no)$/i.test(f.value) ? false : f.value;
    joined = joined.filter((j) => {
      const v = read(j, f.column);
      if (v === null) return false;
      if (f.op === 'contains') return String(v).toLowerCase().includes(String(f.value).toLowerCase());
      const left: Value = typeof v === 'boolean' ? v : numeric ? Number(v) : String(v);
      const right: Value = typeof v === 'boolean' ? want === true || want === 'true' : numeric ? Number(want) : String(want);
      const d = compare(left, right);
      return f.op === '=' ? d === 0 : f.op === '!=' ? d !== 0 : f.op === '>' ? d > 0 : f.op === '>=' ? d >= 0 : f.op === '<' ? d < 0 : d <= 0;
    });
  }

  // ── select / group ──
  const first = tableByName(schema, path.order[0])!;
  const agg = spec.aggregate;
  const plain = agg !== 'none' ? [...new Set(spec.groupBy)] : spec.select.length ? [...new Set(spec.select)] : defaultColumns(first).map((c) => `${first.name}.${c}`);
  const header = (ref: ColRef) => split(ref)[1];
  let columns = plain.map(header);
  let rows: Value[][];
  let aggIndex = -1;

  if (agg === 'none') {
    let ordered = joined;
    if (spec.orderBy && spec.orderBy !== 'aggregate') {
      const by = spec.orderBy;
      const sign = spec.direction === 'asc' ? 1 : -1;
      ordered = [...joined].sort((a, b) => compare(read(a, by), read(b, by)) * sign);
    }
    rows = ordered.map((j) => plain.map((ref) => read(j, ref)));
  } else {
    const groups = new Map<string, { key: Value[]; items: Joined[] }>();
    for (const j of joined) {
      const key = plain.map((ref) => read(j, ref));
      const id = JSON.stringify(key);
      const g = groups.get(id);
      if (g) g.items.push(j);
      else groups.set(id, { key, items: [j] });
    }
    // an aggregate with no grouping returns one row, even over nothing
    if (!plain.length && !groups.size) groups.set('[]', { key: [], items: [] });
    const col = spec.aggregateColumn;
    const value = (items: Joined[]): Value => {
      if (agg === 'count') return col ? new Set(items.map((j) => read(j, col)).filter((v) => v !== null)).size : items.length;
      const vals = items.map((j) => read(j, col!)).filter((v): v is Exclude<Value, null> => v !== null);
      if (!vals.length) return null;
      if (agg === 'min' || agg === 'max') return vals.reduce((a, b) => ((agg === 'min' ? compare(a, b) <= 0 : compare(a, b) >= 0) ? a : b));
      const sum = vals.reduce((n: number, v) => n + Number(v), 0);
      return agg === 'sum' ? sum : Math.round((sum / vals.length) * 100) / 100;
    };
    const name = agg === 'count' ? 'row_count' : `${{ sum: 'total', avg: 'average', min: 'minimum', max: 'maximum' }[agg]}_${split(col!)[1]}`;
    columns = [...columns, name];
    aggIndex = columns.length - 1;
    rows = [...groups.values()].map((g) => [...g.key, value(g.items)]);
    const orderIndex = spec.orderBy === 'aggregate' ? aggIndex : spec.orderBy ? plain.indexOf(spec.orderBy) : -1;
    if (orderIndex >= 0) {
      const sign = spec.direction === 'asc' ? 1 : -1;
      rows.sort((a, b) => compare(a[orderIndex], b[orderIndex]) * sign);
    }
  }

  const total = rows.length;
  const limit = spec.limit ?? (agg === 'none' ? 100 : null);
  return { ok: true, result: { columns, rows: limit ? rows.slice(0, limit) : rows, total, scanned } };
}
