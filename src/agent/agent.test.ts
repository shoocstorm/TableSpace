import { describe, expect, it } from 'vitest';
import { ecommerce } from '../schema/ecommerce';
import { choiceGrammar, schemaGrammar, validate } from './grammar';
import { schemaDigest, stripThink } from './prompt';
import { route } from './router';
import { mentionedDomain, mentionedTables, TOOLS } from './tools';

describe('grammar', () => {
  const spec = TOOLS.find((t) => t.name === 'focus_tables')!.schema(ecommerce);
  it('accepts valid arguments and de-duplicates lists', () => {
    expect(validate(spec, { domain: 'none', tables: ['orders', 'orders', 'payments'], hops: '1' })).toEqual({ ok: true, value: { domain: 'none', tables: ['orders', 'payments'], hops: '1' } });
  });
  it('rejects unknown tables, keys and shapes', () => {
    expect(validate(spec, { domain: 'none', tables: ['nope'], hops: '1' }).ok).toBe(false);
    expect(validate(spec, { domain: 'none', tables: [], hops: '1', extra: 1 }).ok).toBe(false);
    expect(validate(spec, { domain: 'none', tables: 'orders', hops: '1' }).ok).toBe(false);
    expect(validate(spec, { tables: [] }).ok).toBe(false);
    expect(validate(spec, 'orders').ok).toBe(false);
  });
  it('writes GBNF with the database\'s names as the only strings', () => {
    const g = schemaGrammar(spec).split('\n');
    expect(g[0]).toBe('root ::= "{" ws "\\"domain\\"" ws ":" ws v0 ws "," ws "\\"tables\\"" ws ":" ws "[" ws (v1 (ws "," ws v1){0,4})? ws "]" ws "," ws "\\"hops\\"" ws ":" ws v2 ws "}"');
    expect(g[1]).toBe('v0 ::= "\\"none\\"" | "\\"identity\\"" | "\\"catalog\\"" | "\\"orders\\"" | "\\"payments\\"" | "\\"fulfilment\\"" | "\\"analytics\\""');
    expect(g[2]).toContain('"\\"order_items\\""');
    expect(g[3]).toBe('v2 ::= "\\"0\\"" | "\\"1\\"" | "\\"2\\""');
    expect(g[4]).toBe('ws ::= [ \\t\\n]{0,2}');
    expect(choiceGrammar(['a', 'b'])).toBe('root ::= "a" | "b"');
  });
  it('every tool has a schema the grammar can express', () => {
    for (const t of TOOLS) expect(schemaGrammar(t.schema(ecommerce))).toMatch(/^root ::= "\{"/);
  });
});

describe('mentions', () => {
  it('finds tables by name, spaced or singular, longest first', () => {
    expect(mentionedTables(ecommerce, 'how do order items relate to products?')).toEqual(['products', 'order_items']);
    expect(mentionedTables(ecommerce, 'show the orders table')).toEqual(['orders']);
    expect(mentionedTables(ecommerce, 'what about a user and their payment?')).toEqual(['users', 'payments']);
    expect(mentionedTables(ecommerce, 'hello there')).toEqual([]);
  });
  it('finds a domain', () => {
    expect(mentionedDomain(ecommerce, 'Show the Payments domain')).toBe('payments');
    expect(mentionedDomain(ecommerce, 'anything')).toBeNull();
  });
});

describe('scripted router', () => {
  const r = (text: string) => route(ecommerce, text);
  it('routes the prompt chips and their paraphrases', () => {
    expect(r('Audit missing indexes')).toEqual({ tool: 'audit_schema', args: { rule: 'missing_fk_index' } });
    expect(r('any orphaned tables?')).toEqual({ tool: 'audit_schema', args: { rule: 'orphaned_table' } });
    expect(r('Simulate checkout join')).toEqual({ tool: 'trace_query', args: { preset: 'checkout' } });
    expect(r('trace the order history query')).toEqual({ tool: 'trace_query', args: { preset: 'order_history' } });
    expect(r('Normalize bloated tables')).toEqual({ tool: 'propose_refactor', args: { table: 'auto', strategy: 'auto' } });
    expect(r('split the payments table into lookups')).toEqual({ tool: 'propose_refactor', args: { table: 'payments', strategy: 'extract_lookup' } });
    expect(r('seed lots of mock data for catalog')).toEqual({ tool: 'seed_data', args: { scope: 'catalog', size: 'large' } });
    expect(r('zoom out')).toEqual({ tool: 'reset_view', args: {} });
  });
  it('sends questions about the data to the SQL writer', () => {
    expect(r('how many orders per user')).toEqual({ tool: 'write_sql', args: { tables: ['orders', 'users'] } });
    expect(r('write a query for the latest refunds')).toEqual({ tool: 'write_sql', args: { tables: ['refunds'] } });
    expect(r('list cancelled orders')?.tool).toBe('write_sql');
    expect(r('explain why the orders query is slow')?.tool).toBe('trace_query');
    expect(r('show the orders table')?.tool).toBe('focus_tables');
  });
  it('treats SQL as a query to trace and names as a place to go', () => {
    expect(r('select * from orders o join payments p on p.order_id = o.id')?.tool).toBe('trace_query');
    expect(r('where is inventory?')).toEqual({ tool: 'focus_tables', args: { domain: 'none', tables: ['inventory'], hops: '1' } });
    expect(r('fulfilment')).toEqual({ tool: 'focus_tables', args: { domain: 'fulfilment', tables: [], hops: '1' } });
    expect(r('what is a foreign key?')).toBeNull();
  });
});

describe('prompts', () => {
  it('digest names every table', () => {
    const d = schemaDigest(ecommerce);
    for (const t of ecommerce.tables) expect(d).toContain(t.name);
    expect(d).toContain('payments.order_id→orders');
  });
  it('strips think blocks, closed or open', () => {
    expect(stripThink('<think>\n\n</think>\n\nHello')).toBe('Hello');
    expect(stripThink('<think>still going')).toBe('');
    expect(stripThink('Plain')).toBe('Plain');
  });
});
