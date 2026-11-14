import { describe, expect, it } from 'vitest';
import { computeLayout, explode } from '../layout/force';
import { ecommerce } from '../schema/ecommerce';
import { edgesOf, formatRows, isJunction, neighbours, tableByName, topoOrder } from '../schema/graph';
import { SCHEMAS } from '../schema/registry';
import { audit } from './audit';
import { bloatedTables, proposeRefactor } from './normalize';
import { simulatePlan } from './plan';
import { runSeed, seedPlan } from './seed';
import { extractSql, parseQuery } from './sql';

describe('schemas', () => {
  it.each(SCHEMAS)('$id is internally consistent', (schema) => {
    const names = schema.tables.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of schema.tables) {
      expect(schema.domains.some((d) => d.id === t.domain), `${t.name} domain`).toBe(true);
      for (const f of t.fks) {
        expect(t.columns.some((c) => c.name === f.column), `${t.name}.${f.column}`).toBe(true);
        expect(tableByName(schema, f.refTable)?.columns.some((c) => c.name === f.refColumn), `${t.name}.${f.column} → ${f.refTable}.${f.refColumn}`).toBe(true);
      }
      for (const i of t.indexes) for (const c of i.columns) expect(t.columns.some((x) => x.name === c), `${i.name}`).toBe(true);
    }
    for (const p of schema.presets) {
      const parsed = parseQuery(p.sql);
      expect(parsed.ok, p.id).toBe(true);
      if (parsed.ok) expect(simulatePlan(schema, parsed.query).ok, p.id).toBe(true);
    }
  });
});

describe('graph', () => {
  it('reads cardinality from keys', () => {
    const edges = edgesOf(ecommerce);
    expect(edges.find((e) => e.id === 'user_profiles.user_id')?.cardinality).toBe('1:1');
    expect(edges.find((e) => e.id === 'orders.user_id')?.cardinality).toBe('1:N');
    expect(edges.find((e) => e.id === 'user_roles.role_id')?.cardinality).toBe('M:N');
    expect(isJunction(tableByName(ecommerce, 'product_categories')!)).toBe(true);
    expect(isJunction(tableByName(ecommerce, 'orders')!)).toBe(false);
  });
  it('finds neighbours by hops', () => {
    expect(neighbours(ecommerce, ['refunds'], 0)).toEqual(['refunds']);
    expect(neighbours(ecommerce, ['refunds'], 1).sort()).toEqual(['payments', 'refunds']);
    expect(neighbours(ecommerce, ['refunds'], 2)).toContain('orders');
  });
  it('orders parents before children, each table once', () => {
    const order = topoOrder(ecommerce);
    expect(order.length).toBe(ecommerce.tables.length);
    for (const e of edgesOf(ecommerce)) if (e.from !== e.to) expect(order.indexOf(e.to), e.id).toBeLessThan(order.indexOf(e.from));
  });
  it('formats row counts', () => {
    expect([6, 1250, 42_800, 2_310_000, 48_200_000].map(formatRows)).toEqual(['6', '1.3K', '43K', '2.31M', '48.2M']);
  });
});

describe('layout', () => {
  it('is deterministic and keeps tables apart', () => {
    const a = computeLayout(ecommerce);
    expect(computeLayout(ecommerce)).toEqual(a);
    const pts = Object.values(a);
    expect(pts.length).toBe(ecommerce.tables.length);
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) expect(Math.hypot(pts[i][0] - pts[j][0], pts[i][2] - pts[j][2]) + Math.abs(pts[i][1] - pts[j][1])).toBeGreaterThan(2);
  });
  it('explode moves domains apart without reshaping them', () => {
    const a = computeLayout(ecommerce);
    const b = explode(a, ecommerce);
    const d = (l: typeof a, x: string, y: string) => Math.hypot(...l[x].map((v, i) => v - l[y][i]));
    expect(d(b, 'payments', 'refunds')).toBeCloseTo(d(a, 'payments', 'refunds'), 1);
    expect(d(b, 'refunds', 'roles')).toBeGreaterThan(d(a, 'refunds', 'roles'));
  });
});

describe('audit', () => {
  const findings = audit(ecommerce);
  it('finds the planted problems', () => {
    const missing = findings.filter((f) => f.rule === 'missing_fk_index').map((f) => `${f.table}.${f.column}`).sort();
    expect(missing).toEqual(['events.user_id', 'inventory.variant_id', 'order_items.variant_id', 'payments.order_id']);
    expect(findings.filter((f) => f.rule === 'orphaned_table').map((f) => f.table)).toEqual(['legacy_import_log']);
    expect(findings.filter((f) => f.rule === 'god_table').map((f) => f.table)).toEqual(['orders']);
    expect(findings.find((f) => f.table === 'events')?.severity).toBe('critical');
    expect(findings.find((f) => f.table === 'inventory')?.severity).toBe('warning');
  });
  it('respects the rule filter', () => {
    expect(audit(ecommerce, ['orphaned_table']).every((f) => f.rule === 'orphaned_table')).toBe(true);
  });
});

describe('sql + plan', () => {
  it('reads tables, aliases, joins and filters', () => {
    const r = parseQuery(ecommerce.presets[0].sql);
    if (!r.ok) throw new Error(r.error);
    expect(r.query.from).toEqual({ table: 'carts', alias: 'c' });
    expect(r.query.joins.map((j) => j.table)).toEqual(['users', 'cart_items', 'product_variants', 'products', 'inventory']);
    expect(r.query.filters).toEqual([{ alias: 'c', column: 'id', op: '=' }]);
  });
  it('flags the unindexed join of the checkout query', () => {
    const r = parseQuery(ecommerce.presets[0].sql);
    if (!r.ok) throw new Error(r.error);
    const p = simulatePlan(ecommerce, r.query);
    if (!p.ok) throw new Error(p.error);
    expect(p.plan.steps.map((s) => [s.table, s.scan, s.slow])).toEqual([
      ['carts', 'index', false],
      ['users', 'index', false],
      ['cart_items', 'index', false],
      ['product_variants', 'index', false],
      ['products', 'index', false],
      ['inventory', 'seq', true],
    ]);
    expect(p.plan.steps[5]).toMatchObject({ from: 'product_variants', via: 'variant_id' });
  });
  it('reads a filter on a string with a dot in it as a filter, not a join', () => {
    const r = parseQuery(ecommerce.presets[1].sql);
    if (!r.ok) throw new Error(r.error);
    expect(r.query.filters).toEqual([{ alias: 'u', column: 'email', op: '=' }]);
    const p = simulatePlan(ecommerce, r.query);
    if (!p.ok) throw new Error(p.error);
    expect(p.plan.steps.map((s) => [s.table, s.via, s.scan, s.slow])).toEqual([
      ['users', 'email', 'index', false],
      ['orders', 'user_id', 'index', false],
      ['payments', 'order_id', 'seq', true],
      ['shipments', 'order_id', 'index', false],
    ]);
  });
  it('handles AS, unaliased tables, comma joins and comments', () => {
    const r = parseQuery('select * -- hi\nfrom orders as o, payments where payments.order_id = o.id and o.status = \'paid\'');
    if (!r.ok) throw new Error(r.error);
    const p = simulatePlan(ecommerce, r.query);
    if (!p.ok) throw new Error(p.error);
    expect(p.plan.steps.map((s) => [s.table, s.via, s.scan])).toEqual([['orders', 'status', 'seq'], ['payments', 'order_id', 'seq']]);
  });
  it('rejects what it cannot trace', () => {
    expect(parseQuery('delete from users').ok).toBe(false);
    expect(parseQuery('select * from a where id in (select id from b)').ok).toBe(false);
    const r = parseQuery('select * from nope');
    expect(r.ok && simulatePlan(ecommerce, r.query).ok).toBe(false);
  });
  it('pulls SQL out of a chat message', () => {
    expect(extractSql('trace this: ```sql\nselect 1 from users\n```')).toBe('select 1 from users');
    expect(extractSql('please run SELECT * FROM orders o')).toBe('SELECT * FROM orders o');
    expect(extractSql('select the payments domain')).toBeNull();
  });
});

describe('normalize', () => {
  it('splits the prefix groups of orders', () => {
    const p = proposeRefactor(ecommerce, 'orders')!;
    expect(p.strategy).toBe('split_groups');
    expect(p.ghosts.map((g) => g.name)).toEqual(['order_shipping', 'order_billing', 'order_gift']);
    expect(p.ghosts[0].columns.map((c) => c.name)).toEqual(['order_id', 'name', 'phone', 'line1', 'line2', 'city', 'region', 'postal_code', 'country']);
    expect(p.columnsAfter).toBe(p.columnsBefore - 19);
    expect(p.sql).toContain('CREATE TABLE order_shipping');
    expect(p.sql).toContain('DROP COLUMN shipping_name');
  });
  it('falls back to lookups, and names the bloated tables', () => {
    const p = proposeRefactor(ecommerce, 'payments')!;
    expect(p.strategy).toBe('extract_lookup');
    expect(p.ghosts.map((g) => g.name)).toEqual(['payment_currencies', 'payment_statuses']);
    expect(bloatedTables(ecommerce)).toEqual(['orders']);
    expect(proposeRefactor(ecommerce, 'nope')).toBeNull();
  });
});

describe('seed', () => {
  it.each(SCHEMAS)('$id: every foreign key points at a row that exists', (schema) => {
    const plan = seedPlan(schema, null, 'small');
    const { rows } = runSeed(schema, plan);
    for (const t of schema.tables) {
      expect(rows[t.name].length, t.name).toBeGreaterThan(0);
      for (const f of t.fks) {
        const parent = tableByName(schema, f.refTable)!;
        const ids = new Set(rows[f.refTable].map((r) => r[f.refColumn]));
        for (const r of rows[t.name]) {
          const v = r[f.column];
          if (v === null) continue;
          expect(ids.has(v) || (typeof v === 'number' && v >= 1 && v <= parent.rows), `${t.name}.${f.column}=${v}`).toBe(true);
        }
      }
    }
  });
  it('is repeatable and keeps unique keys unique', () => {
    const plan = seedPlan(ecommerce, null, 'small');
    const a = runSeed(ecommerce, plan);
    expect(runSeed(ecommerce, plan).rows.users).toEqual(a.rows.users);
    const profileUsers = a.rows.user_profiles.map((r) => r.user_id);
    expect(new Set(profileUsers).size).toBe(profileUsers.length);
    const pairs = a.rows.user_roles.map((r) => `${r.user_id}|${r.role_id}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });
  it('seeds a subset against existing parents', () => {
    const plan = seedPlan(ecommerce, ['refunds'], 'small');
    expect(plan.order).toEqual(['refunds']);
    const { rows } = runSeed(ecommerce, plan);
    for (const r of rows.refunds) expect(r.payment_id).toBeGreaterThanOrEqual(1);
  });
});
