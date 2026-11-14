// PURE: SQL that is right by construction. Nobody — not the model, not the
// keyword reader — writes SQL text. A request becomes a `QuerySpec` (which
// tables, columns, filters, aggregate, order), every part of which is a name
// that exists in the schema, and `compileQuery` turns the spec into SQL:
// - joins are derived from the foreign keys (shortest path between the
//   tables, adding the tables in between), never guessed;
// - literals are typed from the column's SQL type and escaped;
// - GROUP BY is made consistent with the select list.
// So the SQL always names real tables and columns and joins them on real
// keys. Whether it is the query the user *meant* still depends on how the
// request was read; `explainSpec` says in words what was understood, and
// the checks list what was verified and what to look at.

import { edgesOf, pkColumns, tableByName, type Edge } from '../schema/graph';
import type { Column, SchemaDef, Table } from '../schema/types';
import { STATUS } from './seed';

export type Aggregate = 'none' | 'count' | 'sum' | 'avg' | 'min' | 'max';
export const AGGREGATES: Aggregate[] = ['none', 'count', 'sum', 'avg', 'min', 'max'];
export type Op = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'contains';
export const OPS: Op[] = ['=', '!=', '>', '>=', '<', '<=', 'contains'];

/** A column as `table.column`. */
export type ColRef = string;
export type FilterSpec = { column: ColRef; op: Op; value: string };

export type QuerySpec = {
  /** The tables the request is about; the first one drives the query. */
  tables: string[];
  /** Columns to return. Empty means a sensible default for the first table. */
  select: ColRef[];
  aggregate: Aggregate;
  /** What to sum, average, etc. Not needed for count. */
  aggregateColumn: ColRef | null;
  groupBy: ColRef[];
  filters: FilterSpec[];
  /** A column, or `aggregate` to order by the aggregated value. */
  orderBy: ColRef | 'aggregate' | null;
  direction: 'asc' | 'desc';
  limit: number | null;
};

export const emptySpec = (tables: string[]): QuerySpec => ({ tables, select: [], aggregate: 'none', aggregateColumn: null, groupBy: [], filters: [], orderBy: null, direction: 'desc', limit: null });

export type Check = { ok: boolean; text: string };
export type Compiled = { ok: true; sql: string; tables: string[]; joins: string[]; checks: Check[] } | { ok: false; error: string };

const split = (ref: ColRef): [string, string] => {
  const at = ref.indexOf('.');
  return [ref.slice(0, at), ref.slice(at + 1)];
};
const columnOf = (schema: SchemaDef, ref: ColRef): { table: Table; column: Column } | null => {
  const [t, c] = split(ref);
  const table = tableByName(schema, t);
  const column = table?.columns.find((x) => x.name === c);
  return table && column ? { table, column } : null;
};

const isNumeric = (type: string) => /int|numeric|decimal|real|double|float|serial/i.test(type);
const isBoolean = (type: string) => /^bool/i.test(type);
const isTime = (type: string) => /^(timestamp|date|time)/i.test(type);

// Words that can't be used bare as a PostgreSQL identifier.
const RESERVED = new Set(['user', 'order', 'group', 'table', 'select', 'where', 'from', 'to', 'desc', 'asc', 'limit', 'offset', 'default', 'check', 'column', 'references', 'end', 'all', 'and', 'or', 'not', 'null', 'true', 'false', 'primary', 'unique', 'when', 'then', 'case', 'in', 'as', 'on', 'do']);
export const ident = (name: string) => (/^[a-z_][a-z0-9_]*$/.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`);
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The column people recognise a row by: a name, email, number… else the primary key. */
export function labelColumn(table: Table): string {
  for (const n of ['name', 'email', 'title', 'number', 'sku', 'code', 'slug', 'full_name', 'display_name', 'label', 'key']) if (table.columns.some((c) => c.name === n)) return n;
  return pkColumns(table)[0] ?? table.columns[0].name;
}

/** The column that says when a row happened, for "latest" and "newest". */
export function timeColumn(table: Table): string | null {
  for (const n of ['created_at', 'placed_at', 'occurred_at', 'issued_at', 'added_at', 'imported_at', 'joined_at', 'updated_at']) if (table.columns.some((c) => c.name === n)) return n;
  return table.columns.find((c) => isTime(c.type))?.name ?? null;
}

/** What a table shows when no columns were asked for: its key, its label, a status, a time. */
export function defaultColumns(table: Table): string[] {
  const out = new Set<string>([...pkColumns(table).slice(0, 2), labelColumn(table)]);
  for (const c of table.columns) if (out.size < 5 && /^(status|total_cents|amount_cents|price_cents|quantity|rating)$/.test(c.name)) out.add(c.name);
  const t = timeColumn(table);
  if (t && out.size < 6) out.add(t);
  return table.columns.map((c) => c.name).filter((n) => out.has(n));
}

/**
 * The foreign keys that connect `tables`, in the order to join them: each
 * table is reached from those already joined by the shortest chain of keys,
 * and the tables in between are added. Null when a table can't be reached.
 */
export function joinPath(schema: SchemaDef, tables: string[]): { order: string[]; steps: { table: string; edge: Edge }[] } | null {
  const edges = edgesOf(schema).filter((e) => e.from !== e.to);
  const order = [tables[0]];
  const steps: { table: string; edge: Edge }[] = [];
  for (const target of tables.slice(1)) {
    if (order.includes(target)) continue;
    // breadth-first from everything joined so far
    const prev = new Map<string, { from: string; edge: Edge }>();
    const queue = [...order];
    const seen = new Set(order);
    while (queue.length && !seen.has(target)) {
      const at = queue.shift()!;
      for (const e of edges) {
        const next = e.from === at ? e.to : e.to === at ? e.from : null;
        if (!next || seen.has(next)) continue;
        seen.add(next);
        prev.set(next, { from: at, edge: e });
        queue.push(next);
      }
    }
    if (!seen.has(target)) return null;
    const chain: { table: string; edge: Edge }[] = [];
    for (let t = target; !order.includes(t); t = prev.get(t)!.from) chain.unshift({ table: t, edge: prev.get(t)!.edge });
    for (const s of chain) {
      order.push(s.table);
      steps.push(s);
    }
  }
  return { order, steps };
}

/** `order_items` → `oi`; a second table with the same letters gets a number. */
function aliases(tables: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const t of tables) {
    const base = t.split('_').map((p) => p[0]).join('');
    let a = RESERVED.has(base) ? `${base}1` : base;
    for (let n = 2; used.has(a); n++) a = `${base}${n}`;
    used.add(a);
    out.set(t, a);
  }
  return out;
}

function literal(column: Column, op: Op, raw: string): { sql: string } | { error: string } {
  const v = raw.trim().replace(/^["']|["']$/g, '');
  if (op === 'contains') return { sql: quote(`%${v.replace(/[%_]/g, (m) => `\\${m}`)}%`) };
  if (isNumeric(column.type)) return /^-?\d+(\.\d+)?$/.test(v) ? { sql: v } : { error: `${column.name} is a number (${column.type}) but was compared to "${v}"` };
  if (isBoolean(column.type)) {
    if (/^(true|yes|1|on)$/i.test(v)) return { sql: 'TRUE' };
    if (/^(false|no|0|off)$/i.test(v)) return { sql: 'FALSE' };
    return { error: `${column.name} is true/false but was compared to "${v}"` };
  }
  return { sql: quote(v) };
}

const AGG_NAME: Record<Exclude<Aggregate, 'none'>, string> = { count: 'row_count', sum: 'total', avg: 'average', min: 'minimum', max: 'maximum' };

export function compileQuery(schema: SchemaDef, spec: QuerySpec): Compiled {
  const checks: Check[] = [];
  const wanted = [...new Set(spec.tables)];
  if (!wanted.length) return { ok: false, error: 'No table was named.' };
  for (const t of wanted) if (!tableByName(schema, t)) return { ok: false, error: `There is no table "${t}" in ${schema.name}.` };

  // every column the spec mentions must exist, and its table joins in
  const refs = [...spec.select, ...spec.groupBy, ...spec.filters.map((f) => f.column), ...(spec.aggregateColumn ? [spec.aggregateColumn] : []), ...(spec.orderBy && spec.orderBy !== 'aggregate' ? [spec.orderBy] : [])];
  for (const r of refs) {
    if (!columnOf(schema, r)) return { ok: false, error: `There is no column "${r}" in ${schema.name}.` };
    const [t] = split(r);
    if (!wanted.includes(t)) wanted.push(t);
  }

  const path = joinPath(schema, wanted);
  if (!path) return { ok: false, error: `No chain of foreign keys connects ${wanted.join(', ')}, so they can't be joined.` };
  const alias = aliases(path.order);
  const col = (ref: ColRef) => {
    const [t, c] = split(ref);
    return `${alias.get(t)}.${ident(c)}`;
  };
  const first = tableByName(schema, path.order[0])!;

  // ── select list ──
  const agg = spec.aggregate;
  let aggSql: string | null = null;
  if (agg !== 'none') {
    if (agg === 'count') aggSql = `COUNT(${spec.aggregateColumn ? `DISTINCT ${col(spec.aggregateColumn)}` : '*'}) AS ${AGG_NAME.count}`;
    else {
      const target = spec.aggregateColumn && columnOf(schema, spec.aggregateColumn);
      if (!target) return { ok: false, error: `To ${agg === 'avg' ? 'average' : agg} something I need the column to ${agg === 'avg' ? 'average' : agg}.` };
      if ((agg === 'sum' || agg === 'avg') && !isNumeric(target.column.type)) return { ok: false, error: `${spec.aggregateColumn} is ${target.column.type}, which can't be ${agg === 'sum' ? 'summed' : 'averaged'}.` };
      aggSql = `${agg.toUpperCase()}(${col(spec.aggregateColumn!)}) AS ${AGG_NAME[agg]}_${target.column.name}`;
    }
  }
  const aggName = aggSql?.split(' AS ')[1] ?? null;
  // with an aggregate, only grouped columns may be selected: the select list is the grouping
  const plain = agg !== 'none' ? [...new Set(spec.groupBy)] : spec.select.length ? [...new Set(spec.select)] : defaultColumns(first).map((c) => `${first.name}.${c}`);
  if (agg !== 'none' && spec.select.some((s) => !spec.groupBy.includes(s))) checks.push({ ok: true, text: 'Columns that are not grouped were left out of the select list, as an aggregate requires.' });
  const selectList = [...plain.map(col), ...(aggSql ? [aggSql] : [])];

  // ── joins ──
  const joins = path.steps.map(({ table, edge }) => {
    const other = edge.from === table ? edge.to : edge.from;
    const mine = edge.from === table ? edge.column : edge.refColumn;
    const theirs = edge.from === table ? edge.refColumn : edge.column;
    return `JOIN ${ident(table)} ${alias.get(table)} ON ${alias.get(table)}.${ident(mine)} = ${alias.get(other)}.${ident(theirs)}`;
  });

  // ── where ──
  const where: string[] = [];
  for (const f of spec.filters) {
    const hit = columnOf(schema, f.column)!;
    const lit = literal(hit.column, f.op, f.value);
    if ('error' in lit) return { ok: false, error: lit.error };
    where.push(f.op === 'contains' ? `${col(f.column)} ILIKE ${lit.sql}` : `${col(f.column)} ${f.op === '!=' ? '<>' : f.op} ${lit.sql}`);
    if (/_cents$/.test(hit.column.name)) checks.push({ ok: false, text: `${f.column} is stored in cents: ${f.value} means ${(Number(f.value) / 100).toFixed(2)} in currency. Multiply by 100 if you meant whole units.` });
  }

  // ── order, limit ──
  let order: string | null = null;
  if (spec.orderBy === 'aggregate' && aggName) order = `${aggName} ${spec.direction.toUpperCase()}`;
  else if (spec.orderBy && spec.orderBy !== 'aggregate') {
    if (agg !== 'none' && !spec.groupBy.includes(spec.orderBy)) checks.push({ ok: true, text: `Ordering by ${spec.orderBy} was dropped: it is not grouped.` });
    else order = `${col(spec.orderBy)} ${spec.direction.toUpperCase()}`;
  }
  // an unbounded listing of a large table is rarely what anyone wants
  const limit = spec.limit ?? (agg === 'none' ? 100 : null);

  const lines = [`SELECT ${selectList.join(', ')}`, `FROM ${ident(first.name)} ${alias.get(first.name)}`, ...joins];
  if (where.length) lines.push(`WHERE ${where.join('\n  AND ')}`);
  if (agg !== 'none' && plain.length) lines.push(`GROUP BY ${plain.map(col).join(', ')}`);
  if (order) lines.push(`ORDER BY ${order}`);
  if (limit) lines.push(`LIMIT ${limit}`);
  const sql = `${lines.join('\n')};`;

  // ── what was verified ──
  const nCols = new Set([...plain, ...refs]).size;
  checks.unshift(
    { ok: true, text: `All ${path.order.length} table${path.order.length === 1 ? '' : 's'} and ${nCols} column${nCols === 1 ? '' : 's'} exist in ${schema.name}.` },
    ...(path.steps.length ? [{ ok: true, text: `Joins follow foreign keys: ${path.steps.map((s) => `${s.edge.from}.${s.edge.column} → ${s.edge.to}.${s.edge.refColumn}`).join(', ')}.` }] : []),
  );
  const added = path.order.filter((t) => !spec.tables.includes(t) && !refs.some((r) => split(r)[0] === t));
  if (added.length) checks.push({ ok: true, text: `Added ${added.join(', ')} to connect the tables.` });
  if (where.length) checks.push({ ok: true, text: 'Values are typed from the column type and escaped.' });
  if (spec.limit == null && limit) checks.push({ ok: true, text: `LIMIT ${limit} was added: no row limit was asked for.` });
  // summing a parent's column across its children's rows counts it once per child
  if ((agg === 'sum' || agg === 'avg') && spec.aggregateColumn) {
    const [t] = split(spec.aggregateColumn);
    const children = path.steps.filter((s) => s.edge.to === t && s.edge.from !== t && s.edge.cardinality !== '1:1').map((s) => s.edge.from);
    if (children.length) checks.push({ ok: false, text: `${spec.aggregateColumn} repeats once per ${children.join(' / ')} row, so the ${agg} may be inflated. Aggregate ${t} on its own if that isn't intended.` });
  }
  return { ok: true, sql, tables: path.order, joins, checks };
}

// ── reading a request ────────────────────────────────────────────────────

/** The text with punctuation as spaces; comparison signs are kept as words of their own. */
const cased = (s: string) => s.replace(/(>=|<=|!=|<>|[=<>])/g, ' $1 ').replace(/[^A-Za-z0-9_@.'"+<>=!-]+/g, ' ').trim();
const words = (s: string) => cased(s).toLowerCase();
const singular = (w: string) => (w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.endsWith('ses') ? w.slice(0, -2) : w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

/** How a column may be written in a request: `total_cents` as "total cents" or "total". (`cancelled_at` is not read from "cancelled": that is a status, or just a verb.) */
function columnForms(name: string): string[] {
  const spaced = name.replace(/_/g, ' ');
  const short = spaced.replace(/ (cents|id)$/, '');
  // full_name, display_name: people just say "name"
  const last = /_name$/.test(name) ? ['name'] : [];
  return [...new Set([name, spaced, short, ...last])].filter((f) => f.length > 2);
}

/** The columns of `tables` that the text names, as `table.column`, in the order tables were given. */
export function mentionedColumns(schema: SchemaDef, tables: string[], text: string): ColRef[] {
  const t = ` ${words(text)} `;
  const out: ColRef[] = [];
  for (const name of tables) {
    const table = tableByName(schema, name);
    for (const c of table?.columns ?? []) {
      if (c.pk && c.name === 'id') continue;
      if (columnForms(c.name).some((f) => t.includes(` ${f} `) || t.includes(` ${f}s `))) out.push(`${name}.${c.name}`);
    }
  }
  // the same column name on two tables: keep the first table's, the one the request leads with
  const seen = new Set<string>();
  return out.filter((r) => !seen.has(split(r)[1]) && seen.add(split(r)[1]));
}

/** A table or column a phrase like "user", "brand" or "status" points at, for "per …" and "by …". */
function resolveGroup(schema: SchemaDef, tables: string[], phrase: string): ColRef | null {
  const parts = phrase.trim().split(' ');
  // "payment status": a table and one of its columns
  if (parts.length === 2) {
    const owner = schema.tables.find((t) => singular(t.name) === singular(parts[0]));
    const c = owner?.columns.find((x) => columnForms(x.name).includes(parts[1]));
    if (owner && c) return `${owner.name}.${c.name}`;
  }
  const p = singular(phrase.trim().replace(/ /g, '_'));
  // a table first: "per user" means each user, shown by its label, not the user_id column
  const table = schema.tables.find((t) => singular(t.name) === p || t.name === p);
  if (table) return `${table.name}.${labelColumn(table)}`;
  for (const t of tables) {
    const owner = tableByName(schema, t);
    const c = owner?.columns.find((x) => !x.pk && columnForms(x.name).some((f) => singular(f.replace(/ /g, '_')) === p));
    if (!c) continue;
    const fk = owner!.fks.find((f) => f.column === c.name);
    const parent = fk && tableByName(schema, fk.refTable);
    return parent ? `${parent.name}.${labelColumn(parent)}` : `${t}.${c.name}`;
  }
  return null;
}

const COMPARE: [RegExp, Op][] = [
  [/^(>=|at least|no less than|from)$/, '>='],
  [/^(<=|at most|no more than|up to)$/, '<='],
  [/^(>|over|above|greater than|more than|after|exceeds?)$/, '>'],
  [/^(<|under|below|less than|fewer than|before)$/, '<'],
  [/^(!=|<>|is not|isn't|not|except)$/, '!='],
  [/^(contains?|containing|like|includes?|matching)$/, 'contains'],
];
const OP_WORDS = '>=|<=|!=|<>|>|<|=|at least|no less than|at most|no more than|up to|over|above|greater than|more than|after|exceeds?|under|below|less than|fewer than|before|is not|isn\'t|not|except|contains?|containing|like|includes?|matching|is|are|was|equals?|of|:';
const VALUE = `"[^"]+"|'[^']+'|[\\w.+-]+@[\\w.-]+|-?\\d+(?:\\.\\d+)?|[a-z][\\w-]*`;
const NOT_A_VALUE = new Set(['the', 'a', 'an', 'and', 'or', 'by', 'per', 'for', 'in', 'on', 'with', 'from', 'to', 'of', 'is', 'are', 'that', 'which', 'each', 'all', 'any', 'than', 'desc', 'asc', 'descending', 'ascending', 'order', 'sorted', 'highest', 'lowest']);

/**
 * What a request plainly says, read with patterns: no model. A field is set
 * only when the text states it (a table's name, "how many", "top 5",
 * "per user", `status is paid`, "over 100"); everything else stays empty
 * for the model to fill or for the defaults. Null when no table is named.
 */
export function inferSpec(schema: SchemaDef, text: string, tables: string[]): QuerySpec | null {
  if (!tables.length) return null;
  const t = ` ${words(text)} `;
  // the same text with its capitals, so a value keeps the case it was written in
  const original = ` ${cased(text)} `;
  const spec = emptySpec(tables);
  const counting = / (how many|count|number of) /.test(t);
  // "number of orders" counts orders; it does not name a column called number
  const cols = mentionedColumns(schema, tables, counting ? text.replace(/\bnumber of\b/gi, ' ') : text);
  const tableWords = new Set(schema.tables.flatMap((x) => [x.name, singular(x.name), ...x.name.split('_')]));

  // filters: "<column> <operator?> <value>"
  const filtered = new Set<string>();
  for (const ref of cols) {
    const [, c] = split(ref);
    const hit = columnOf(schema, ref)!;
    for (const form of columnForms(c).sort((a, b) => b.length - a.length)) {
      const m = new RegExp(` ${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s? (?:(${OP_WORDS}) )?(${VALUE}) `).exec(t);
      if (!m) continue;
      const [, opWord, raw] = m;
      const end = m.index + m[0].length - 1;
      const value = original.slice(end - raw.length, end).replace(/^["']|["']$/g, '');
      // an operator, quotes, or a code written in capitals (EUR, US) marks a value
      const explicit = !!opWord || /^["']/.test(raw) || /^[A-Z][A-Z0-9]+$/.test(value);
      const fits = isNumeric(hit.column.type) ? /^-?\d/.test(value) : !/^-?\d/.test(value) || !isTime(hit.column.type);
      // a bare word after a column name is a value only when something marks it as one
      if (!fits || NOT_A_VALUE.has(value.toLowerCase()) || (!explicit && !/[@\d]/.test(value))) continue;
      // "status of orders", "total per user": a table's name after "of" is not a value
      if (!/^["']/.test(raw) && (tableWords.has(value.toLowerCase()) || (opWord === 'of' && !/^-?\d/.test(value)))) continue;
      const op = COMPARE.find(([re]) => opWord && re.test(opWord))?.[1] ?? '=';
      spec.filters.push({ column: ref, op, value });
      filtered.add(ref);
      break;
    }
  }
  // a status value named outright: "cancelled orders", "paid payments"
  for (const name of tables) {
    const table = tableByName(schema, name)!;
    const status = table.columns.find((c) => c.name === 'status');
    if (!status || filtered.has(`${name}.status`)) continue;
    const value = (STATUS[name] ?? STATUS.default).find((v) => t.includes(` ${v.replace(/_/g, ' ')} `) || t.includes(` ${v} `));
    if (value) {
      spec.filters.push({ column: `${name}.status`, op: '=', value });
      filtered.add(`${name}.status`);
      break;
    }
  }

  // aggregate
  const numerics = cols.filter((r) => !filtered.has(r) && isNumeric(columnOf(schema, r)!.column.type) && !/_id$/.test(r));
  // in "total amount", total is the sum and amount is the column
  const numeric = (/ (total|sum) /.test(t) && numerics.find((r) => !/\.total_/.test(r))) || numerics[0];
  if (counting) spec.aggregate = 'count';
  else if (/ (average|avg|mean) /.test(t) && numeric) spec.aggregate = 'avg';
  else if (/ (total|sum|revenue) /.test(t) && numeric) spec.aggregate = 'sum';
  if (spec.aggregate === 'sum' || spec.aggregate === 'avg') spec.aggregateColumn = numeric!;

  // "per user", "by status", "for each brand"
  for (const m of t.matchAll(/ (?:per|by|for each|for every|each|every|grouped by|group by) ([a-z_]+(?: [a-z_]+)?) /g)) {
    const g = resolveGroup(schema, tables, m[1]) ?? resolveGroup(schema, tables, m[1].split(' ')[0]);
    if (g && !spec.groupBy.includes(g) && !/ (order|sort|sorted|ordered) by /.test(t.slice(Math.max(0, m.index - 8), m.index + 4))) spec.groupBy.push(g);
  }
  if (spec.groupBy.length && spec.aggregate === 'none') spec.aggregate = 'count';
  // "top 5 brands by number of products": several tables, a count and no grouping means one row per the first table named
  if (spec.aggregate !== 'none' && !spec.groupBy.length && tables.length > 1) spec.groupBy.push(`${tables[0]}.${labelColumn(tableByName(schema, tables[0])!)}`);

  // "top 5", "10 latest", "first 20"
  const top = / (?:top|first|best|limit) (\d+) | (\d+) (?:most|largest|biggest|highest|latest|newest|recent|top) /.exec(t);
  if (top) spec.limit = Math.min(1000, Number(top[1] ?? top[2]));
  const ranked = !!top || / (most|highest|largest|biggest|best|top|fewest|least) /.test(t);
  // "which brands have the most products": ranking one table by another is a count per row of the first
  if (spec.aggregate === 'none' && tables.length > 1 && / (most|fewest) /.test(t) && !/ most (recent|recently) /.test(t)) {
    spec.aggregate = 'count';
    if (!spec.groupBy.length) spec.groupBy.push(`${tables[0]}.${labelColumn(tableByName(schema, tables[0])!)}`);
  }
  const sorted = / (?:order|sort|sorted|ordered) by ([a-z_]+(?: [a-z_]+)?) /.exec(t);
  const sortCol = sorted && (resolveGroup(schema, tables, sorted[1]) ?? resolveGroup(schema, tables, sorted[1].split(' ')[0]));
  if (/ (ascending|asc|lowest|smallest|oldest|fewest|least|cheapest) /.test(t)) spec.direction = 'asc';
  if (sortCol) spec.orderBy = sortCol;
  else if (spec.aggregate !== 'none' && (ranked || spec.groupBy.length)) spec.orderBy = 'aggregate';
  else if (/ (latest|newest|recent|recently|oldest|last) /.test(t)) {
    const time = timeColumn(tableByName(schema, tables[0])!);
    if (time) spec.orderBy = `${tables[0]}.${time}`;
    spec.limit ??= / (the )?(latest|newest|oldest|last) [a-z_]+ /.test(t) && !top ? 10 : null;
  } else if (ranked && numeric) spec.orderBy = numeric;

  // the columns asked for, minus the ones only used to filter or aggregate
  if (spec.aggregate === 'none') spec.select = cols.filter((r) => !filtered.has(r));
  return spec;
}

/** Fields `base` states win; `extra` fills the ones it left empty. Used to put a model's reading under what the text plainly says. */
export function mergeSpecs(base: QuerySpec, extra: QuerySpec): QuerySpec {
  const filters = [...base.filters, ...extra.filters.filter((f) => !base.filters.some((b) => b.column === f.column))];
  const aggregate = base.aggregate !== 'none' ? base.aggregate : extra.aggregate;
  return {
    tables: [...new Set([...base.tables, ...extra.tables])],
    select: base.select.length ? base.select : extra.select,
    aggregate,
    aggregateColumn: base.aggregateColumn ?? (aggregate === extra.aggregate ? extra.aggregateColumn : null),
    groupBy: base.groupBy.length ? base.groupBy : extra.groupBy,
    filters,
    orderBy: base.orderBy ?? extra.orderBy,
    direction: base.orderBy ? base.direction : extra.orderBy ? extra.direction : base.direction,
    limit: base.limit ?? extra.limit,
  };
}

const stem = (w: string) => singular(w).replace(/(ing|ed)$/, '');

/**
 * A model's reading of a request, cut down to what the request's own words
 * support. Measured with Qwen3 0.6B: left alone it invents filters
 * (`status = 'signed'`), aggregates and limits. So a model may add:
 * - a column to return, when the request uses a word of its name;
 * - a filter, when the value is written in the request, fits the column's
 *   type (and its known status values), and isn't just a table's name;
 * - an ordering, when the request asks for one and names the column.
 * Aggregates, grouping and limits are never taken from the model: the text
 * either states them (inferSpec) or they aren't there.
 */
export function gateSpec(schema: SchemaDef, text: string, model: QuerySpec): QuerySpec {
  const said = new Set(words(text).split(' ').map(stem));
  const tableWords = new Set(schema.tables.flatMap((x) => [x.name, ...x.name.split('_')]).map(stem));
  // a word that is only a table's name ("payments" for payment_method_id) doesn't name a column
  const named = (ref: ColRef) => split(ref)[1].split('_').some((w) => !/^(id|at|cents)$/.test(w) && !tableWords.has(stem(w)) && said.has(stem(w)));
  const lower = ` ${words(text)} `;
  const out = emptySpec(model.tables);
  out.select = model.select.filter((r) => columnOf(schema, r) && named(r));
  const seen = new Set<string>();
  for (const f of model.filters) {
    const hit = columnOf(schema, f.column);
    const v = f.value.trim();
    if (!hit || !v || seen.has(f.column) || !lower.includes(` ${v.toLowerCase()} `)) continue;
    if (tableWords.has(stem(v.toLowerCase())) || NOT_A_VALUE.has(v.toLowerCase())) continue;
    // "currency contains currency": a word of the column's own name is not its value
    if (split(f.column)[1].split('_').some((w) => stem(w) === stem(v.toLowerCase()))) continue;
    if (isNumeric(hit.column.type) !== /^-?\d+(\.\d+)?$/.test(v)) continue;
    const [t, c] = split(f.column);
    if (c === 'status' && !(STATUS[t] ?? STATUS.default).includes(v.toLowerCase())) continue;
    // a column the request never mentions can still be filtered by a value that could only be its (a status word)
    if (!named(f.column) && c !== 'status') continue;
    seen.add(f.column);
    out.filters.push({ ...f, value: v });
  }
  const wantsOrder = / (order|sort|sorted|ordered|most|highest|lowest|largest|smallest|latest|newest|oldest|recent|recently|top|best) /.test(lower);
  if (wantsOrder && model.orderBy && model.orderBy !== 'aggregate' && columnOf(schema, model.orderBy) && named(model.orderBy)) {
    out.orderBy = model.orderBy;
    out.direction = model.direction;
  }
  return out;
}

/** A spec that can't compile as given, made compilable: an aggregate without its column, an order by an aggregate that isn't there. */
export function repairSpec(schema: SchemaDef, spec: QuerySpec): QuerySpec {
  const s = { ...spec, filters: spec.filters.filter((f) => f.value.trim() && columnOf(schema, f.column)) };
  if (s.aggregate !== 'none' && s.aggregate !== 'count') {
    const target = s.aggregateColumn && columnOf(schema, s.aggregateColumn);
    const numericOk = target && ((s.aggregate !== 'sum' && s.aggregate !== 'avg') || isNumeric(target.column.type));
    if (!numericOk) {
      s.aggregate = s.groupBy.length ? 'count' : 'none';
      s.aggregateColumn = null;
    }
  }
  if (s.aggregate === 'count' && s.aggregateColumn) s.aggregateColumn = null;
  if (s.aggregate === 'none') {
    // a column that is only there to filter on doesn't narrow what a listing shows
    const filtered = new Set(s.filters.map((f) => f.column));
    if (s.select.every((r) => filtered.has(r))) s.select = [];
    s.groupBy = [];
    if (s.orderBy === 'aggregate') s.orderBy = null;
  }
  return s;
}

/** The query in words: what was understood, for the user to check against what they meant. */
export function explainSpec(schema: SchemaDef, spec: QuerySpec): string {
  // "brands by number of products" counts products: the table that isn't the one grouped by
  const grouped = new Set(spec.groupBy.map((g) => split(g)[0]));
  const counted = spec.tables.find((t) => !grouped.has(t)) ?? spec.tables[0];
  const what =
    spec.aggregate === 'count'
      ? `the number of ${counted} rows`
      : spec.aggregate !== 'none'
        ? `the ${{ sum: 'total', avg: 'average', min: 'smallest', max: 'largest' }[spec.aggregate]} ${spec.aggregateColumn}`
        : spec.select.length
          ? spec.select.join(', ')
          : `${spec.tables[0]} (${defaultColumns(tableByName(schema, spec.tables[0])!).join(', ')})`;
  const parts = [`Returns ${what}`];
  if (spec.groupBy.length) parts.push(`for each ${spec.groupBy.join(' and ')}`);
  if (spec.filters.length) parts.push(`where ${spec.filters.map((f) => `${f.column} ${f.op} ${f.value}`).join(' and ')}`);
  if (spec.orderBy) parts.push(`${spec.direction === 'desc' ? 'highest' : 'lowest'} ${spec.orderBy === 'aggregate' ? 'first' : `${spec.orderBy} first`}`);
  if (spec.limit) parts.push(`limited to ${spec.limit}`);
  return `${parts.join(', ')}.`;
}

/** Literals a request contains, which a filter value may be chosen from: quoted text, numbers, emails, then plain words. */
export function valueCandidates(text: string, max = 28): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"]+)"|'([^']+)'|([\w.+-]+@[\w.-]+\.\w+)|(-?\d+(?:\.\d+)?)/g)) out.push((m[1] ?? m[2] ?? m[3] ?? m[4]).slice(0, 60));
  for (const w of words(text).split(' ')) if (w.length > 2 && !NOT_A_VALUE.has(w) && /^[a-z][\w-]*$/.test(w)) out.push(w);
  return [...new Set(out)].slice(0, max);
}
