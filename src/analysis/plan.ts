// PURE: a *simulated* execution plan. There is no database here, so this
// applies the rule a planner mostly follows for nested-loop joins: reaching
// a table through an indexed column is an index scan, through an unindexed
// one a sequential scan. Costs are rows touched, from the mock statistics.

import { isIndexed, tableByName } from '../schema/graph';
import type { SchemaDef } from '../schema/types';
import type { ParsedQuery } from './sql';

export type PlanStep = {
  /** The table reached in this step. */
  table: string;
  alias: string;
  /** The table it was reached from; null for the first one. */
  from: string | null;
  /** The column of `table` used to find rows; null when every row is read with no condition. */
  via: string | null;
  scan: 'index' | 'seq';
  /** Rows the step has to read. */
  rowsRead: number;
  /** A sequential scan over a table large enough to hurt. */
  slow: boolean;
  note: string;
};

export type Plan = { steps: PlanStep[]; totalRows: number; slowSteps: number };
export type PlanResult = { ok: true; plan: Plan } | { ok: false; error: string };

/** A sequential scan under this many rows is cheap enough not to flag. */
export const SLOW_SCAN_ROWS = 50_000;

export function simulatePlan(schema: SchemaDef, q: ParsedQuery): PlanResult {
  const refs = [q.from, ...q.joins];
  for (const r of refs) if (!tableByName(schema, r.table)) return { ok: false, error: `There is no table "${r.table}" in ${schema.name}.` };
  const tableOf = (alias: string) => refs.find((r) => r.alias === alias)?.table;
  const steps: PlanStep[] = [];

  const make = (table: string, alias: string, from: string | null, via: string | null): PlanStep => {
    const t = tableByName(schema, table)!;
    const indexed = via !== null && isIndexed(t, via);
    const rowsRead = indexed ? Math.max(1, Math.round(Math.log2(t.rows + 2))) : t.rows;
    const slow = !indexed && t.rows >= SLOW_SCAN_ROWS;
    const note = via === null ? `reads all of ${table} (no condition on it)` : indexed ? `index lookup on ${table}.${via}` : `no index on ${table}.${via}: reads every row`;
    return { table, alias, from, via, scan: indexed ? 'index' : 'seq', rowsRead, slow, note };
  };

  // the driving table: found through its filter, if it has one
  const filterOn = (alias: string, table: string) => {
    const mine = q.filters.filter((f) => f.alias === alias || (f.alias === '' && tableByName(schema, table)!.columns.some((c) => c.name === f.column) && refs.filter((r) => tableByName(schema, r.table)!.columns.some((c) => c.name === f.column)).length === 1));
    const t = tableByName(schema, table)!;
    return mine.find((f) => f.op === '=' && isIndexed(t, f.column)) ?? mine.find((f) => f.op === '=') ?? mine[0] ?? null;
  };
  const first = filterOn(q.from.alias, q.from.table);
  steps.push(make(q.from.table, q.from.alias, null, first?.column ?? null));

  const reached = new Set([q.from.alias]);
  for (const j of q.joins) {
    // the ON equality that ties this table to one already reached
    let via: string | null = null;
    let from: string | null = null;
    for (const { left, right } of j.on) {
      const mine = left.alias === j.alias ? left : right.alias === j.alias ? right : null;
      const other = mine === left ? right : left;
      if (mine && reached.has(other.alias)) {
        const t = tableByName(schema, j.table)!;
        if (!t.columns.some((c) => c.name === mine.column)) return { ok: false, error: `${j.table} has no column "${mine.column}".` };
        // prefer an indexed equality when the ON clause has several
        if (via === null || (!isIndexed(t, via) && isIndexed(t, mine.column))) {
          via = mine.column;
          from = tableOf(other.alias) ?? null;
        }
      }
    }
    if (via === null) {
      const f = filterOn(j.alias, j.table);
      via = f?.column ?? null;
      from = steps[steps.length - 1].table;
    }
    steps.push(make(j.table, j.alias, from, via));
    reached.add(j.alias);
  }
  return { ok: true, plan: { steps, totalRows: steps.reduce((n, s) => n + s.rowsRead, 0), slowSteps: steps.filter((s) => s.slow).length } };
}
