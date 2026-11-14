import { describe, expect, it } from 'vitest';
import { ecommerce } from '../schema/ecommerce';
import { SCHEMAS } from '../schema/registry';
import { executeSpec } from './execute';
import { compileQuery, emptySpec, joinPath, type QuerySpec } from './querybuilder';
import { runSeed, seedPlan } from './seed';

const data = runSeed(ecommerce, seedPlan(ecommerce, null, 'small')).rows;
const run = (spec: QuerySpec) => {
  const out = executeSpec(ecommerce, spec, data);
  if (!out.ok) throw new Error(out.error);
  return out.result;
};

describe('running a query spec on mock rows', () => {
  it('lists default columns with the default limit', () => {
    const r = run(emptySpec(['users']));
    expect(r.columns).toEqual(['id', 'email', 'status', 'created_at']);
    expect(r.rows.length).toBe(Math.min(100, data.users.length));
    expect(r.rows[0][1]).toBe(data.users[0].email);
  });
  it('joins on the foreign key: every joined row agrees on it', () => {
    const r = run({ ...emptySpec(['orders', 'users']), select: ['orders.user_id', 'users.id', 'users.email'] });
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) expect(row[0]).toBe(row[1]);
    expect(r.total).toBe(data.orders.filter((o) => data.users.some((u) => u.id === o.user_id)).length);
  });
  it('filters by type', () => {
    const r = run({ ...emptySpec(['orders']), select: ['orders.status', 'orders.total_cents'], filters: [{ column: 'orders.status', op: '=', value: 'cancelled' }, { column: 'orders.total_cents', op: '>', value: '5000' }] });
    expect(r.total).toBe(data.orders.filter((o) => o.status === 'cancelled' && (o.total_cents as number) > 5000).length);
    for (const row of r.rows) expect(row[0] === 'cancelled' && (row[1] as number) > 5000).toBe(true);
    expect(run({ ...emptySpec(['users']), filters: [{ column: 'users.email', op: 'contains', value: 'EXAMPLE.com' }] }).total).toBe(data.users.length);
  });
  it('counts per group, in order, and the counts add up', () => {
    const r = run({ ...emptySpec(['orders']), aggregate: 'count', groupBy: ['orders.status'], orderBy: 'aggregate' });
    expect(r.columns).toEqual(['status', 'row_count']);
    expect(r.rows.reduce((n, row) => n + (row[1] as number), 0)).toBe(data.orders.length);
    for (let i = 1; i < r.rows.length; i++) expect(r.rows[i - 1][1] as number).toBeGreaterThanOrEqual(r.rows[i][1] as number);
  });
  it('sums, averages and limits', () => {
    const total = data.orders.reduce((n, o) => n + (o.total_cents as number), 0);
    expect(run({ ...emptySpec(['orders']), aggregate: 'sum', aggregateColumn: 'orders.total_cents' }).rows).toEqual([[total]]);
    expect(run({ ...emptySpec(['orders']), aggregate: 'avg', aggregateColumn: 'orders.total_cents' }).rows[0][0]).toBeCloseTo(total / data.orders.length, 1);
    const top = run({ ...emptySpec(['orders']), select: ['orders.total_cents'], orderBy: 'orders.total_cents', limit: 3 });
    expect(top.rows.map((r) => r[0])).toEqual(data.orders.map((o) => o.total_cents as number).sort((a, b) => b - a).slice(0, 3));
    expect(top.total).toBe(data.orders.length);
  });
  it('counts nothing as zero', () => {
    expect(run({ ...emptySpec(['orders']), aggregate: 'count', filters: [{ column: 'orders.status', op: '=', value: 'nope' }] }).rows).toEqual([[0]]);
  });
  it('has the columns the SQL selects, for whatever compiles', () => {
    for (const schema of SCHEMAS) {
      const rows = runSeed(schema, seedPlan(schema, null, 'small')).rows;
      for (const a of schema.tables) for (const b of schema.tables) {
        if (a === b || !joinPath(schema, [a.name, b.name])) continue;
        const spec: QuerySpec = { ...emptySpec([a.name, b.name]), aggregate: 'count', groupBy: [`${b.name}.${b.columns[0].name}`] };
        const sql = compileQuery(schema, spec);
        const out = executeSpec(schema, spec, rows);
        expect(sql.ok && out.ok, `${a.name}+${b.name}`).toBe(true);
        if (sql.ok && out.ok) expect(sql.sql.split('\n')[0]).toContain(out.result.columns.at(-1)!);
      }
    }
  });
});
