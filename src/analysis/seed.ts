// PURE: dependency-aware synthetic data. Tables are filled parents first
// (topological order), and every foreign key value is the id of a row that
// exists: one generated earlier in the same run, or, when the parent isn't
// being seeded, one of the parent's existing rows. A seeded PRNG makes a run
// repeatable. Nothing is written anywhere but memory: this is mock data.

import { isJunction, pkColumns, tableByName, topoOrder } from '../schema/graph';
import type { Column, SchemaDef, Table } from '../schema/types';

export type SeedSize = 'small' | 'medium' | 'large';
export const SEED_SIZES: SeedSize[] = ['small', 'medium', 'large'];
const BASE: Record<SeedSize, number> = { small: 20, medium: 120, large: 600 };

export type Value = string | number | boolean | null;
export type Row = Record<string, Value>;

export type SeedPlan = { order: string[]; counts: Record<string, number> };

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Which tables, in which order, and how many rows each: more for the tables that are larger in production. */
export function seedPlan(schema: SchemaDef, tables: string[] | null, size: SeedSize): SeedPlan {
  const order = topoOrder(schema, tables ?? undefined);
  const sorted = schema.tables.map((t) => t.rows).sort((a, b) => a - b);
  const median = Math.max(1, sorted[Math.floor(sorted.length / 2)]);
  const counts: Record<string, number> = {};
  for (const name of order) {
    const t = tableByName(schema, name)!;
    const share = Math.min(4, Math.max(0.25, Math.sqrt(t.rows / median)));
    // a reference table with a handful of rows gets a handful more, not hundreds
    counts[name] = Math.max(2, Math.min(Math.round(BASE[size] * share), Math.max(3, t.rows)));
  }
  return { order, counts };
}

const FIRST = ['Ada', 'Grace', 'Linus', 'Margaret', 'Alan', 'Barbara', 'Dennis', 'Radia', 'Ken', 'Frances', 'Edsger', 'Hedy', 'Tim', 'Joan', 'Donald', 'Katherine'];
const LAST = ['Lovelace', 'Hopper', 'Torvalds', 'Hamilton', 'Turing', 'Liskov', 'Ritchie', 'Perlman', 'Thompson', 'Allen', 'Dijkstra', 'Lamarr', 'Berners-Lee', 'Clarke', 'Knuth', 'Johnson'];
const CITIES = ['Lisbon', 'Toronto', 'Osaka', 'Nairobi', 'Austin', 'Leeds', 'Lyon', 'Pune', 'Bergen', 'Cusco', 'Tallinn', 'Hobart'];
const COUNTRIES = ['PT', 'CA', 'JP', 'KE', 'US', 'GB', 'FR', 'IN', 'NO', 'PE', 'EE', 'AU'];
const ADJ = ['Aurora', 'Nimbus', 'Cedar', 'Quartz', 'Ember', 'Tidal', 'Summit', 'Velvet', 'Copper', 'Lumen', 'Orbit', 'Juniper'];
const NOUN = ['Backpack', 'Kettle', 'Lamp', 'Notebook', 'Headphones', 'Jacket', 'Bottle', 'Keyboard', 'Blanket', 'Tripod', 'Sneakers', 'Mug'];
/** The values a `status` column takes, per table: seeding writes these, and the query builder recognises them in a request. */
export const STATUS: Record<string, string[]> = {
  default: ['active', 'pending', 'archived'],
  orders: ['placed', 'paid', 'shipped', 'delivered', 'cancelled'],
  payments: ['authorized', 'captured', 'failed', 'refunded'],
  shipments: ['label_created', 'in_transit', 'delivered', 'returned'],
  carts: ['open', 'converted', 'abandoned'],
  issues: ['open', 'in_progress', 'in_review', 'closed'],
};
const WORDS = ['fast', 'reliable', 'needs', 'review', 'after', 'the', 'last', 'release', 'works', 'as', 'expected', 'with', 'minor', 'delay', 'on', 'delivery'];

type Ctx = { rand: () => number; ids: Record<string, Value[]>; schema: SchemaDef };

const pick = <T,>(rand: () => number, list: T[]): T => list[Math.floor(rand() * list.length)];
const int = (rand: () => number, min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const hex = (rand: () => number, n: number) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('');
const uuid = (rand: () => number) => `${hex(rand, 8)}-${hex(rand, 4)}-4${hex(rand, 3)}-a${hex(rand, 3)}-${hex(rand, 12)}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const stamp = (rand: () => number, daysBack = 720) => new Date(Date.UTC(2026, 10, 1) - Math.floor(rand() * daysBack * 86_400_000)).toISOString().replace(/\.\d+Z$/, 'Z');

/** A believable value for a column, from its name first and its type second. `n` is the row's number in the run. */
function valueFor(table: Table, c: Column, n: number, rand: () => number): Value {
  const name = c.name;
  const type = c.type.toLowerCase();
  const person = `${pick(rand, FIRST)} ${pick(rand, LAST)}`;
  if (type === 'uuid') return uuid(rand);
  if (type === 'boolean') return rand() < 0.3;
  if (type.startsWith('timestamp') || type === 'date') return stamp(rand);
  if (type === 'jsonb' || type === 'json') return JSON.stringify({ path: `/${pick(rand, NOUN).toLowerCase()}`, ms: int(rand, 20, 900) });
  if (type === 'inet') return `${int(rand, 11, 223)}.${int(rand, 0, 255)}.${int(rand, 0, 255)}.${int(rand, 1, 254)}`;
  if (/int|numeric|decimal/.test(type)) {
    if (/cents|amount|price|total|subtotal/.test(name)) return int(rand, 4, 400) * 50 - 1;
    if (/quantity|seats|points/.test(name)) return int(rand, 1, 5);
    if (/rating/.test(name)) return int(rand, 1, 5);
    if (/month/.test(name)) return int(rand, 1, 12);
    if (/year/.test(name)) return int(rand, 2027, 2032);
    if (/percent/.test(name)) return int(rand, 0, 100);
    if (/on_hand|reserved|weight|limit|max_/.test(name)) return int(rand, 0, 900);
    return n;
  }
  // text
  if (/email/.test(name)) return `${slug(person).replace('-', '.')}${n}@example.com`;
  if (/(full_|display_|shipping_|billing_|customer_)name$/.test(name)) return person;
  if (name === 'name' || name === 'title') {
    if (/user|member|customer/.test(table.name)) return person;
    if (/role/.test(table.name)) return `${pick(rand, ['admin', 'editor', 'viewer', 'support', 'finance', 'ops'])}-${n}`;
    if (/issue|review|comment/.test(table.name)) return Array.from({ length: 4 }, () => pick(rand, WORDS)).join(' ');
    return `${pick(rand, ADJ)} ${pick(rand, NOUN)} ${n}`;
  }
  if (/slug|key$/.test(name)) return `${slug(`${pick(rand, ADJ)} ${pick(rand, NOUN)}`)}-${n}`;
  if (/sku/.test(name)) return `SKU-${hex(rand, 4).toUpperCase()}-${n}`;
  if (/^code$|number$|_ref$|token/.test(name)) return `${table.name.slice(0, 3).toUpperCase()}-${hex(rand, 6).toUpperCase()}${n}`;
  if (/hash/.test(name)) return hex(rand, 40);
  if (/status|state/.test(name)) return pick(rand, STATUS[table.name] ?? STATUS.default);
  if (/currency/.test(name)) return pick(rand, ['USD', 'EUR', 'GBP', 'JPY']);
  if (/country/.test(name)) return pick(rand, COUNTRIES);
  if (/city/.test(name)) return pick(rand, CITIES);
  if (/region/.test(name)) return pick(rand, ['North', 'South', 'East', 'West', 'Central']);
  if (/postal/.test(name)) return String(int(rand, 10000, 99999));
  if (/line1/.test(name)) return `${int(rand, 1, 980)} ${pick(rand, ADJ)} Street`;
  if (/line2/.test(name)) return `Unit ${int(rand, 1, 40)}`;
  if (/phone/.test(name)) return `+1 555 ${int(rand, 100, 999)} ${int(rand, 1000, 9999)}`;
  if (/url|website|avatar/.test(name)) return `https://example.com/${slug(pick(rand, NOUN))}/${n}`;
  if (/locale/.test(name)) return pick(rand, ['en-US', 'pt-PT', 'ja-JP', 'fr-FR']);
  if (/timezone/.test(name)) return pick(rand, ['UTC', 'Europe/Lisbon', 'Asia/Tokyo', 'America/Toronto']);
  if (/last4/.test(name)) return String(int(rand, 1000, 9999));
  if (/provider|brand|carrier|source|type|kind|tier|priority|policy|role|action|label/.test(name)) return pick(rand, ['standard', 'express', 'web', 'mobile', 'partner', 'priority']);
  if (/color/.test(name)) return `#${hex(rand, 6)}`;
  const m = /\((\d+)\)/.exec(type);
  const text = Array.from({ length: 6 }, () => pick(rand, WORDS)).join(' ');
  return m ? text.slice(0, Number(m[1])) : text;
}

/**
 * `count` rows for `table` (fewer when unique keys run out of parents).
 * `ctx.ids` holds the primary keys already generated per table and gets this table's.
 */
export function generateRows(table: Table, count: number, ctx: Ctx): Row[] {
  const { rand, ids, schema } = ctx;
  const pks = pkColumns(table);
  const rows: Row[] = [];
  const mine: Value[] = [];
  const parentIds = (ref: string): Value[] | null => (ref === table.name ? mine : (ids[ref] ?? null));
  const existing = (ref: string) => Math.max(1, tableByName(schema, ref)?.rows ?? 1);
  const junction = isJunction(table);
  const usedPairs = new Set<string>();
  const usedUnique: Record<string, Set<Value>> = {};

  for (let n = 1; n <= count; n++) {
    const row: Row = {};
    let ok = true;
    for (const c of table.columns) {
      const f = table.fks.find((x) => x.column === c.name);
      if (f) {
        const pool = parentIds(f.refTable);
        const self = f.refTable === table.name;
        if ((c.nullable && rand() < 0.15) || (self && !mine.length)) {
          row[c.name] = c.nullable || self ? null : 1;
          continue;
        }
        const unique = c.unique || table.indexes.some((i) => i.unique && i.columns.length === 1 && i.columns[0] === c.name);
        let v: Value = pool?.length ? pick(rand, pool) : int(rand, 1, existing(f.refTable));
        if (unique) {
          const used = (usedUnique[c.name] ??= new Set());
          for (let tries = 0; used.has(v) && tries < 40; tries++) v = pool?.length ? pick(rand, pool) : int(rand, 1, existing(f.refTable));
          if (used.has(v)) ok = false;
          used.add(v);
        }
        row[c.name] = v;
        continue;
      }
      if (c.pk && pks.length === 1) {
        // new rows continue after the table's existing ones
        row[c.name] = c.type.toLowerCase() === 'uuid' ? uuid(rand) : table.rows + n;
        continue;
      }
      row[c.name] = valueFor(table, c, n, rand);
    }
    if (junction) {
      const key = pks.map((p) => row[p]).join('|');
      if (usedPairs.has(key)) ok = false;
      usedPairs.add(key);
    }
    if (!ok) continue;
    rows.push(row);
    if (pks.length === 1) mine.push(row[pks[0]]);
  }
  ids[table.name] = mine;
  return rows;
}

export type SeedResult = { plan: SeedPlan; rows: Record<string, Row[]>; total: number };

/** Runs a whole plan. `onTable` is called after each table, in order. */
export function runSeed(schema: SchemaDef, plan: SeedPlan, seed = 20261113): SeedResult {
  const ctx: Ctx = { rand: rng(seed), ids: {}, schema };
  const rows: Record<string, Row[]> = {};
  let total = 0;
  for (const name of plan.order) {
    rows[name] = generateRows(tableByName(schema, name)!, plan.counts[name], ctx);
    total += rows[name].length;
  }
  return { plan, rows, total };
}
