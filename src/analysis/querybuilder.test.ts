import { describe, expect, it } from 'vitest';
import { mentionedTablesInOrder } from '../agent/tools';
import { ecommerce } from '../schema/ecommerce';
import { SCHEMAS } from '../schema/registry';
import { simulatePlan } from './plan';
import { compileQuery, emptySpec, explainSpec, gateSpec, inferSpec, joinPath, mentionedColumns, mergeSpecs, repairSpec, valueCandidates, type QuerySpec } from './querybuilder';
import { parseQuery } from './sql';

const ask = (text: string) => {
  const spec = inferSpec(ecommerce, text, mentionedTablesInOrder(ecommerce, text));
  if (!spec) throw new Error('no table');
  const out = compileQuery(ecommerce, repairSpec(ecommerce, spec));
  if (!out.ok) throw new Error(out.error);
  return out;
};

describe('join path', () => {
  it('connects tables through the tables between them', () => {
    expect(joinPath(ecommerce, ['users', 'refunds'])!.order).toEqual(['users', 'orders', 'payments', 'refunds']);
    expect(joinPath(ecommerce, ['orders', 'payments'])!.steps.map((s) => s.edge.id)).toEqual(['payments.order_id']);
    expect(joinPath(ecommerce, ['orders', 'legacy_import_log'])).toBeNull();
  });
});

describe('compile', () => {
  it('lists a table with default columns and a limit', () => {
    expect(compileQuery(ecommerce, emptySpec(['users'])).ok && (compileQuery(ecommerce, emptySpec(['users'])) as { sql: string }).sql).toBe('SELECT u.id, u.email, u.status, u.created_at\nFROM users u\nLIMIT 100;');
  });
  it('joins on foreign keys, in either direction, and quotes what needs it', () => {
    const spec: QuerySpec = { ...emptySpec(['orders', 'users']), select: ['orders.number', 'users.email'], filters: [{ column: 'users.email', op: '=', value: "o'brien@example.com" }, { column: 'orders.total_cents', op: '>', value: '5000' }], orderBy: 'orders.placed_at', limit: 5 };
    const out = compileQuery(ecommerce, spec);
    if (!out.ok) throw new Error(out.error);
    expect(out.sql).toBe("SELECT o.number, u.email\nFROM orders o\nJOIN users u ON u.id = o.user_id\nWHERE u.email = 'o''brien@example.com'\n  AND o.total_cents > 5000\nORDER BY o.placed_at DESC\nLIMIT 5;");
    expect(out.checks.some((c) => !c.ok && c.text.includes('cents'))).toBe(true);
  });
  it('groups consistently and names the aggregate', () => {
    const out = compileQuery(ecommerce, { ...emptySpec(['orders']), aggregate: 'sum', aggregateColumn: 'orders.total_cents', groupBy: ['users.email'], select: ['orders.number'], orderBy: 'aggregate', limit: 10 });
    if (!out.ok) throw new Error(out.error);
    expect(out.sql).toBe('SELECT u.email, SUM(o.total_cents) AS total_total_cents\nFROM orders o\nJOIN users u ON u.id = o.user_id\nGROUP BY u.email\nORDER BY total_total_cents DESC\nLIMIT 10;');
  });
  it('warns when a sum would repeat across child rows', () => {
    const out = compileQuery(ecommerce, { ...emptySpec(['orders', 'order_items']), aggregate: 'sum', aggregateColumn: 'orders.total_cents' });
    expect(out.ok && out.checks.some((c) => !c.ok && c.text.includes('inflated'))).toBe(true);
  });
  it('refuses what it cannot make correct', () => {
    expect(compileQuery(ecommerce, emptySpec(['nope'])).ok).toBe(false);
    expect(compileQuery(ecommerce, { ...emptySpec(['orders']), select: ['orders.nope'] }).ok).toBe(false);
    expect(compileQuery(ecommerce, { ...emptySpec(['orders']), filters: [{ column: 'orders.total_cents', op: '>', value: 'lots' }] }).ok).toBe(false);
    expect(compileQuery(ecommerce, { ...emptySpec(['orders']), aggregate: 'sum', aggregateColumn: 'orders.status' }).ok).toBe(false);
    expect(compileQuery(ecommerce, emptySpec(['orders', 'legacy_import_log'])).ok).toBe(false);
  });
  it('types booleans and escapes LIKE patterns', () => {
    const out = compileQuery(ecommerce, { ...emptySpec(['orders']), filters: [{ column: 'orders.gift_wrap', op: '=', value: 'yes' }, { column: 'orders.notes', op: 'contains', value: '50%' }] });
    expect(out.ok && out.sql).toContain("WHERE o.gift_wrap = TRUE\n  AND o.notes ILIKE '%50\\%%'");
  });
});

describe('reading a request', () => {
  it('finds columns by their plain names', () => {
    expect(mentionedColumns(ecommerce, ['orders'], 'show the number, status and total of orders')).toEqual(['orders.number', 'orders.status', 'orders.total_cents']);
  });
  it('counts per group', () => {
    expect(ask('how many orders per user').sql).toBe('SELECT u.email, COUNT(*) AS row_count\nFROM orders o\nJOIN users u ON u.id = o.user_id\nGROUP BY u.email\nORDER BY row_count DESC;');
    expect(ask('count payments by status').sql).toBe('SELECT p.status, COUNT(*) AS row_count\nFROM payments p\nGROUP BY p.status\nORDER BY row_count DESC;');
  });
  it('reads filters, comparisons and status words', () => {
    expect(ask('list cancelled orders with total over 10000').sql).toBe("SELECT o.id, o.number, o.status, o.total_cents, o.placed_at\nFROM orders o\nWHERE o.total_cents > 10000\n  AND o.status = 'cancelled'\nLIMIT 100;");
    expect(ask("find users whose email is 'ada@example.com'").sql).toContain("WHERE u.email = 'ada@example.com'");
    expect(ask('orders where currency = EUR').sql).toContain("WHERE o.currency = 'EUR'");
  });
  it('reads top-N, latest and sums', () => {
    expect(ask('top 5 brands by number of products').sql).toBe('SELECT b.name, COUNT(*) AS row_count\nFROM brands b\nJOIN products p ON p.brand_id = b.id\nGROUP BY b.name\nORDER BY row_count DESC\nLIMIT 5;');
    expect(ask('the latest orders').sql).toContain('ORDER BY o.placed_at DESC\nLIMIT 10;');
    expect(ask('total amount of payments per order').sql).toContain('SUM(p.amount_cents) AS total_amount_cents');
  });
  it('does not take ordinary words for values', () => {
    expect(ask('show the status and currency of orders').sql).not.toContain('WHERE');
    expect(inferSpec(ecommerce, 'hello', [])).toBeNull();
  });
  it('explains what it understood', () => {
    const spec = inferSpec(ecommerce, 'how many orders per user', ['orders', 'users'])!;
    expect(explainSpec(ecommerce, spec)).toBe('Returns the number of orders rows, for each users.email, highest first.');
  });
});

describe('what a model may add', () => {
  it('drops what the request does not support (seen from Qwen3 0.6B)', () => {
    const text = 'show the email and name of users who signed up most recently';
    const model: QuerySpec = { ...emptySpec(['users']), select: ['users.id', 'users.email'], aggregate: 'max', aggregateColumn: 'users.last_login_at', groupBy: ['users.id'], filters: [{ column: 'users.status', op: '=', value: 'signed' }], orderBy: 'users.last_login_at', limit: 1 };
    expect(gateSpec(ecommerce, text, model)).toEqual({ ...emptySpec(['users']), select: ['users.email'] });
    const junk: QuerySpec = { ...emptySpec(['reviews', 'products']), filters: [{ column: 'products.name', op: 'contains', value: 'product' }] };
    expect(gateSpec(ecommerce, 'average rating of reviews per product', junk).filters).toEqual([]);
  });
  it('keeps what the request does say', () => {
    const model: QuerySpec = { ...emptySpec(['orders']), select: ['orders.number', 'orders.notes'], filters: [{ column: 'orders.status', op: '=', value: 'shipped' }, { column: 'orders.currency', op: '=', value: 'EUR' }], orderBy: 'orders.total_cents' };
    const g = gateSpec(ecommerce, 'order number for shipped orders in currency EUR sorted by total', model);
    expect([g.select, g.filters.map((f) => f.column), g.orderBy]).toEqual([['orders.number'], ['orders.status', 'orders.currency'], 'orders.total_cents']);
  });
});

describe('phrasings', () => {
  it('reads each, most, recently and table-column groups', () => {
    expect(ask('how many orders does each user have? top 10').sql).toBe('SELECT u.email, COUNT(*) AS row_count\nFROM orders o\nJOIN users u ON u.id = o.user_id\nGROUP BY u.email\nORDER BY row_count DESC\nLIMIT 10;');
    expect(ask('which brands have the most products?').sql).toBe('SELECT b.name, COUNT(*) AS row_count\nFROM brands b\nJOIN products p ON p.brand_id = b.id\nGROUP BY b.name\nORDER BY row_count DESC;');
    expect(ask('show the email and name of users who signed up most recently').sql).toBe('SELECT u.email, u.full_name\nFROM users u\nORDER BY u.created_at DESC\nLIMIT 100;');
    expect(ask('total refunds amount per payment status').sql).toBe('SELECT p.status, SUM(r.amount_cents) AS total_amount_cents\nFROM refunds r\nJOIN payments p ON p.id = r.payment_id\nGROUP BY p.status\nORDER BY total_amount_cents DESC;');
  });
});

describe('merge and repair', () => {
  it('a listing is not narrowed to the column it filters on', () => {
    const r = repairSpec(ecommerce, { ...emptySpec(['payments']), select: ['payments.currency'], filters: [{ column: 'payments.currency', op: '=', value: 'EUR' }] });
    expect(r.select).toEqual([]);
    expect(ask('find payments in currency EUR that failed').sql).toBe("SELECT p.id, p.amount_cents, p.status, p.created_at\nFROM payments p\nWHERE p.currency = 'EUR'\n  AND p.status = 'failed'\nLIMIT 100;");
    expect(gateSpec(ecommerce, 'find payments in currency EUR', { ...emptySpec(['payments']), select: ['payments.payment_method_id'] }).select).toEqual([]);
    expect(gateSpec(ecommerce, 'payments in currency EUR', { ...emptySpec(['payments']), filters: [{ column: 'payments.currency', op: 'contains', value: 'currency' }] }).filters).toEqual([]);
  });
  it('keeps what the text states and takes the rest', () => {
    const base = inferSpec(ecommerce, 'top 3 orders', ['orders'])!;
    const model: QuerySpec = { ...emptySpec(['orders']), select: ['orders.number'], limit: 50, orderBy: 'orders.total_cents' };
    const m = mergeSpecs(base, model);
    expect([m.limit, m.select, m.orderBy]).toEqual([3, ['orders.number'], 'orders.total_cents']);
  });
  it('repairs an aggregate that cannot run', () => {
    const r = repairSpec(ecommerce, { ...emptySpec(['orders']), aggregate: 'sum', aggregateColumn: 'orders.status', orderBy: 'aggregate', filters: [{ column: 'orders.status', op: '=', value: ' ' }] });
    expect([r.aggregate, r.orderBy, r.filters]).toEqual(['none', null, []]);
  });
  it('offers the literals of a request as values', () => {
    expect(valueCandidates("orders over 250 for 'ada@example.com' that shipped").slice(0, 3)).toEqual(['250', 'ada@example.com', 'orders']);
  });
});

describe('every generated query round-trips', () => {
  const requests = ['how many orders per user', 'list cancelled orders with total over 10000', 'top 5 brands by number of products', 'the latest orders', 'average rating of reviews per product', 'refunds for users'];
  it.each(requests)('%s', (text) => {
    const { sql, tables } = ask(text);
    const parsed = parseQuery(sql);
    if (!parsed.ok) throw new Error(parsed.error);
    expect([parsed.query.from.table, ...parsed.query.joins.map((j) => j.table)]).toEqual(tables);
    // every join the reader sees is tied to a table already joined
    expect(parsed.query.joins.every((j) => j.on.length === 1)).toBe(true);
    expect(simulatePlan(ecommerce, parsed.query).ok).toBe(true);
  });
  it.each(SCHEMAS)('$id: any two connected tables join', (schema) => {
    for (const a of schema.tables) for (const b of schema.tables) {
      if (a === b || !joinPath(schema, [a.name, b.name])) continue;
      const out = compileQuery(schema, emptySpec([a.name, b.name]));
      expect(out.ok && parseQuery(out.sql).ok, `${a.name} + ${b.name}`).toBe(true);
    }
  });
});
