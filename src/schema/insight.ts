// PURE: what the schema says about itself, worked out for the agent's lookup
// tools: a table's columns and keys, how tables join, what depends on what,
// which indexes exist and which are missing or redundant, the schema's shape,
// and where a column lives. Each answer is a list of cards (a heading and a
// few lines), which is both what the drawer shows and, as text, the facts the
// model is given. Every function takes several tables at once, so one tool
// call covers what would otherwise be several.

import { edgesOf, formatRows, isIndexed, isJunction, pkColumns, tableByName, type Edge } from './graph';
import type { Column, Index, SchemaDef, Table } from './types';

export type Card = { /** The table the card is about, when it is about one. */ table?: string; head: string; lines: string[] };

export const cardText = (c: Card): string => [c.head, ...c.lines.map((l) => `  ${l}`)].join('\n');
export const cardsText = (cards: Card[]): string => cards.map(cardText).join('\n');

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const capped = (items: string[], max: number) => (items.length > max ? [...items.slice(0, max), `and ${items.length - max} more`] : items);
const domainLabel = (schema: SchemaDef, id: string) => schema.domains.find((d) => d.id === id)?.label ?? id;
const known = (schema: SchemaDef, names: string[]): Table[] => [...new Set(names)].flatMap((n) => tableByName(schema, n) ?? []);

// ── one table, in full ───────────────────────────────────────────────────

function columnText(t: Table, c: Column): string {
  const fk = t.fks.find((f) => f.column === c.name);
  const marks = [c.pk && 'PK', c.unique && 'unique', c.nullable && 'nullable', fk && `→ ${fk.refTable}.${fk.refColumn}`, fk && !isIndexed(t, c.name) && 'no index'].filter(Boolean);
  return `${c.name} ${c.type}${marks.length ? ` [${marks.join(', ')}]` : ''}`;
}

const indexText = (i: Index) => `${i.name} (${i.columns.join(', ')})${i.unique ? ' unique' : ''}${i.whatIf ? ' what-if' : ''}`;

/** Foreign key columns of `t` that no index leads with. */
export const unindexedFks = (t: Table): string[] => t.fks.filter((f) => !isIndexed(t, f.column)).map((f) => f.column);

/**
 * Columns with their types and keys, what the table references and what
 * references it, and its indexes. `maxColumns` caps the column list of a wide
 * table, so several tables still fit in what the model is given.
 */
export function describeTables(schema: SchemaDef, names: string[], maxColumns = 40): Card[] {
  const edges = edgesOf(schema);
  return known(schema, names).map((t) => {
    const parents = edges.filter((e) => e.from === t.name);
    const children = edges.filter((e) => e.to === t.name);
    const pks = pkColumns(t);
    const bare = unindexedFks(t);
    return {
      table: t.name,
      head: `${t.name}: ${domainLabel(schema, t.domain)} domain, ${formatRows(t.rows)} rows, ${plural(t.columns.length, 'column')}${isJunction(t) ? ', a junction (many-to-many) table' : ''}${t.comment ? `. ${t.comment}` : ''}`,
      lines: [
        `Columns: ${capped(t.columns.map((c) => columnText(t, c)), maxColumns).join('; ')}`,
        `Primary key: ${pks.length ? pks.join(', ') : 'none'}`,
        `References: ${parents.length ? parents.map((e) => `${e.to} (${e.column} → ${e.refColumn}, ${e.cardinality})`).join('; ') : 'nothing'}`,
        `Referenced by: ${children.length ? capped(children.map((e) => `${e.from}.${e.column}`), 12).join(', ') : 'nothing'}`,
        `Indexes: ${t.indexes.length ? t.indexes.map(indexText).join('; ') : 'none besides the primary key'}`,
        ...(bare.length ? [`Foreign keys with no index: ${bare.join(', ')}`] : []),
      ],
    };
  });
}

// ── how tables connect ───────────────────────────────────────────────────

/** The fewest foreign keys joining `a` to `b`, followed in either direction; null when nothing connects them. */
export function joinPath(schema: SchemaDef, a: string, b: string): Edge[] | null {
  if (!tableByName(schema, a) || !tableByName(schema, b)) return null;
  if (a === b) return [];
  const edges = edgesOf(schema).filter((e) => e.from !== e.to);
  const via = new Map<string, { edge: Edge; prev: string }>();
  const seen = new Set([a]);
  let frontier = [a];
  while (frontier.length && !seen.has(b)) {
    const next: string[] = [];
    for (const at of frontier) {
      for (const e of edges) {
        const other = e.from === at ? e.to : e.to === at ? e.from : null;
        if (!other || seen.has(other)) continue;
        seen.add(other);
        via.set(other, { edge: e, prev: at });
        next.push(other);
      }
    }
    frontier = next;
  }
  if (!seen.has(b)) return null;
  const path: Edge[] = [];
  for (let at = b; at !== a; at = via.get(at)!.prev) path.unshift(via.get(at)!.edge);
  return path;
}

/** The tables on a join path, in order from `a`. */
export function pathTables(a: string, path: Edge[]): string[] {
  const out = [a];
  for (const e of path) out.push(e.from === out[out.length - 1] ? e.to : e.from);
  return out;
}

/** Tables that reference `table`, directly or through others, by distance (1 = directly), up to `depth`. */
export function dependents(schema: SchemaDef, table: string, depth: number): string[][] {
  const edges = edgesOf(schema).filter((e) => e.from !== e.to);
  const seen = new Set([table]);
  const levels: string[][] = [];
  let frontier = [table];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next = [...new Set(edges.filter((e) => frontier.includes(e.to) && !seen.has(e.from)).map((e) => e.from))];
    for (const n of next) seen.add(n);
    if (next.length) levels.push(next);
    frontier = next;
  }
  return levels;
}

/**
 * For two or more tables, the join path between each pair (with the exact
 * columns); for every table, its parents, its children, and what depends on
 * it further out.
 */
export function relateTables(schema: SchemaDef, names: string[], depth = 2): Card[] {
  const tables = known(schema, names);
  const edges = edgesOf(schema);
  const cards: Card[] = [];
  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      const [a, b] = [tables[i].name, tables[j].name];
      const path = joinPath(schema, a, b);
      if (!path) cards.push({ head: `${a} and ${b}: no foreign keys connect them, directly or through other tables`, lines: [] });
      else {
        const stops = pathTables(a, path);
        cards.push({
          head: `Join path ${stops.join(' → ')}: ${plural(path.length, 'join')}${path.length === 1 ? ' (directly related)' : ''}`,
          lines: path.map((e, k) => `JOIN ${stops[k + 1]} ON ${e.from}.${e.column} = ${e.to}.${e.refColumn} (${e.from} → ${e.to}, ${e.cardinality})`),
        });
      }
    }
  }
  for (const t of tables) {
    const parents = edges.filter((e) => e.from === t.name);
    const children = edges.filter((e) => e.to === t.name);
    const further = dependents(schema, t.name, depth).slice(1).flat();
    cards.push({
      table: t.name,
      head: `${t.name}: references ${plural(new Set(parents.map((e) => e.to)).size, 'table')}, referenced by ${plural(new Set(children.map((e) => e.from)).size, 'table')}${isJunction(t) ? '; a junction table' : ''}`,
      lines: [
        ...(parents.length ? [`Parents (it holds the key): ${parents.map((e) => `${e.to} via ${e.column} (${e.cardinality})`).join('; ')}`] : []),
        ...(children.length ? [`Children (they hold the key): ${capped(children.map((e) => `${e.from}.${e.column}`), 12).join(', ')}`] : []),
        ...(further.length ? [`Also depend on it, through those: ${capped(further, 12).join(', ')}`] : []),
        ...(!parents.length && !children.length ? ['No relationships at all.'] : []),
      ],
    });
  }
  return cards;
}

// ── indexes ──────────────────────────────────────────────────────────────

/** Indexes another index (or the primary key) already covers: the same leading columns, and not unique in its own right. */
export function redundantIndexes(t: Table): { index: string; coveredBy: string }[] {
  const pks = pkColumns(t);
  const all = [...(pks.length ? [{ name: 'the primary key', columns: pks, unique: true }] : []), ...t.indexes];
  const prefix = (a: string[], b: string[]) => a.length <= b.length && a.every((c, i) => b[i] === c);
  const out: { index: string; coveredBy: string }[] = [];
  t.indexes.forEach((i, at) => {
    const cover = all.find((o) => {
      if (o === i || !prefix(i.columns, o.columns)) return false;
      const same = o.columns.length === i.columns.length;
      // a unique index enforces something a longer index does not; of two identical ones, the later is the spare
      if (!same) return !i.unique;
      return (!i.unique || !!o.unique) && (o.name === 'the primary key' || t.indexes.indexOf(o as Index) < at);
    });
    if (cover) out.push({ index: i.name, coveredBy: cover.name });
  });
  return out;
}

/**
 * Every index of the named tables (or, with none named, a summary of the
 * whole schema and the tables with something to fix): what each covers, which
 * foreign keys have none, and which indexes are redundant.
 */
export function indexReport(schema: SchemaDef, names: string[]): Card[] {
  const scoped = known(schema, names);
  const tables = scoped.length ? scoped : schema.tables;
  const rows = tables.map((t) => ({ t, bare: unindexedFks(t), spare: redundantIndexes(t) }));
  const total = tables.reduce((n, t) => n + t.indexes.length, 0);
  const fks = tables.reduce((n, t) => n + t.fks.length, 0);
  const bare = rows.reduce((n, r) => n + r.bare.length, 0);
  const spare = rows.reduce((n, r) => n + r.spare.length, 0);
  const none = rows.filter((r) => !r.t.indexes.length).map((r) => r.t.name);
  const summary: Card = {
    head: `${plural(total, 'index', 'indexes')} besides primary keys on ${plural(tables.length, 'table')}; ${plural(fks, 'foreign key')}, ${bare} with no index; ${plural(spare, 'redundant index', 'redundant indexes')}`,
    lines: none.length && !scoped.length ? [`Tables with no index besides the primary key: ${capped(none, 12).join(', ')}`] : [],
  };
  // the whole schema: only the tables with something to fix, worst (largest) first
  const shown = scoped.length ? rows : rows.filter((r) => r.bare.length || r.spare.length).sort((a, b) => b.t.rows - a.t.rows).slice(0, 10);
  return [
    summary,
    ...shown.map(({ t, bare: b, spare: s }) => {
      const pks = pkColumns(t);
      const covered = t.fks.filter((f) => isIndexed(t, f.column)).map((f) => f.column);
      return {
        table: t.name,
        head: `${t.name}: ${plural(t.indexes.length, 'index', 'indexes')}, ${formatRows(t.rows)} rows`,
        lines: [
          `Primary key: ${pks.length ? pks.join(', ') : 'none'}`,
          ...(t.indexes.length ? [`Indexes: ${t.indexes.map(indexText).join('; ')}`] : []),
          ...(covered.length ? [`Foreign keys with an index: ${covered.join(', ')}`] : []),
          ...(b.length ? [`Foreign keys with no index: ${b.join(', ')} (joins on them read all ${formatRows(t.rows)} rows)`] : []),
          ...s.map((r) => `Redundant: ${r.index} is covered by ${r.coveredBy}`),
        ],
      };
    }),
  ];
}

// ── the shape of the whole schema ────────────────────────────────────────

/** Sizes, the largest, widest and most connected tables, and the structural odd ones out; for one domain or all. */
export function schemaOverview(schema: SchemaDef, domain: string | null = null): Card[] {
  const tables = schema.tables.filter((t) => !domain || t.domain === domain);
  const inScope = new Set(tables.map((t) => t.name));
  const edges = edgesOf(schema).filter((e) => inScope.has(e.from) || inScope.has(e.to));
  const degree = (n: string) => edges.filter((e) => e.from === n || e.to === n).length;
  const top = <T,>(items: T[], score: (t: T) => number, n = 5) => [...items].sort((a, b) => score(b) - score(a)).slice(0, n);
  const sum = (ts: Table[], f: (t: Table) => number) => ts.reduce((n, t) => n + f(t), 0);
  const roots = tables.filter((t) => !t.fks.some((f) => f.refTable !== t.name && tableByName(schema, f.refTable)) && edges.some((e) => e.to === t.name && e.from !== t.name));
  const orphans = tables.filter((t) => !degree(t.name));
  const junctions = tables.filter(isJunction);
  const selfRefs = tables.filter((t) => t.fks.some((f) => f.refTable === t.name));
  const noPk = tables.filter((t) => !pkColumns(t).length);
  const names = (ts: Table[]) => capped(ts.map((t) => t.name), 10).join(', ');
  const scope = domain ? `The ${domainLabel(schema, domain)} domain of ${schema.name}` : `${schema.name} (${schema.engine})`;
  return [
    {
      head: `${scope}: ${plural(tables.length, 'table')}, ${plural(sum(tables, (t) => t.columns.length), 'column')}, ${plural(sum(tables, (t) => t.fks.length), 'foreign key')}, ${plural(sum(tables, (t) => t.indexes.length), 'index', 'indexes')}, ${formatRows(sum(tables, (t) => t.rows))} rows in total`,
      lines: [
        ...(domain ? [] : [`Domains: ${schema.domains.map((d) => ({ d, ts: schema.tables.filter((t) => t.domain === d.id) })).filter((x) => x.ts.length).map(({ d, ts }) => `${d.label} (${plural(ts.length, 'table')}, ${formatRows(sum(ts, (t) => t.rows))} rows)`).join('; ')}`]),
        `Largest by rows: ${top(tables, (t) => t.rows).map((t) => `${t.name} (${formatRows(t.rows)})`).join(', ')}`,
        `Widest by columns: ${top(tables, (t) => t.columns.length).map((t) => `${t.name} (${t.columns.length})`).join(', ')}`,
        `Most connected: ${top(tables.filter((t) => degree(t.name)), (t) => degree(t.name)).map((t) => `${t.name} (${plural(degree(t.name), 'relationship')})`).join(', ') || 'none'}`,
        ...(roots.length ? [`Root tables (referenced, reference nothing): ${names(roots)}`] : []),
        ...(junctions.length ? [`Junction (many-to-many) tables: ${names(junctions)}`] : []),
        ...(selfRefs.length ? [`Self-referencing tables: ${names(selfRefs)}`] : []),
        ...(orphans.length ? [`Tables with no relationships: ${names(orphans)}`] : []),
        ...(noPk.length ? [`Tables with no primary key: ${names(noPk)}`] : []),
      ],
    },
  ];
}

// ── where a column lives ─────────────────────────────────────────────────

export const COLUMN_KINDS = ['any', 'time', 'number', 'text', 'json', 'boolean', 'uuid', 'nullable', 'unique', 'foreign_key'] as const;
export type ColumnKind = (typeof COLUMN_KINDS)[number];

const KIND_TEST: Record<Exclude<ColumnKind, 'any'>, (t: Table, c: Column) => boolean> = {
  time: (_t, c) => /time|date|interval/i.test(c.type),
  number: (_t, c) => /int|numeric|decimal|real|double|float|money|serial/i.test(c.type),
  text: (_t, c) => /char|text|citext|string/i.test(c.type),
  json: (_t, c) => /json/i.test(c.type),
  boolean: (_t, c) => /bool/i.test(c.type),
  uuid: (_t, c) => /uuid/i.test(c.type),
  nullable: (_t, c) => !!c.nullable,
  unique: (_t, c) => !!c.unique,
  foreign_key: (t, c) => t.fks.some((f) => f.column === c.name),
};

/** Words in a request that mean a kind of column. */
const KIND_WORDS: [ColumnKind, RegExp][] = [
  ['json', /\bjsonb?\b/],
  ['uuid', /\buuids?\b/],
  ['boolean', /\bbool(ean)?s?\b|\bflags?\b/],
  ['time', /\b(timestamps?|dates?|datetime|time)\b/],
  ['nullable', /\bnull(able|s)?\b|\boptional\b/],
  ['unique', /\bunique\b/],
  ['foreign_key', /\bforeign keys?\b|\bfks?\b/],
  ['number', /\b(numeric|numbers?|integers?|decimals?|money|amounts?)\b/],
  ['text', /\b(text|strings?|varchar)\b/],
];
export const mentionedKind = (text: string): ColumnKind => KIND_WORDS.find(([, re]) => re.test(text.toLowerCase()))?.[0] ?? 'any';

/** Every distinct column name of the schema, most used first. */
export function columnNames(schema: SchemaDef): string[] {
  const uses = new Map<string, number>();
  for (const t of schema.tables) for (const c of t.columns) uses.set(c.name, (uses.get(c.name) ?? 0) + 1);
  return [...uses.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
}

/** Column names written in the text (`user_id`, or spaced: `created at`), longest first so `order_id` isn't also read as `id`. */
export function mentionedColumnNames(schema: SchemaDef, text: string): string[] {
  let rest = ` ${text.toLowerCase().replace(/[^a-z0-9_]+/g, ' ')} `;
  const out: string[] = [];
  for (const n of columnNames(schema).sort((a, b) => b.length - a.length)) {
    if (n.length < 3) continue;
    for (const form of [n.toLowerCase(), n.toLowerCase().replace(/_/g, ' ')]) {
      if (rest.includes(` ${form} `)) {
        out.push(n);
        rest = rest.replaceAll(` ${form} `, '  ');
        break;
      }
    }
  }
  return out;
}

/**
 * The columns with one of `names` (exactly, or as part of the name when
 * nothing matches exactly) and of the given kind, grouped by table.
 */
export function findColumns(schema: SchemaDef, names: string[], kind: ColumnKind = 'any'): { cards: Card[]; tables: string[]; count: number } {
  const wanted = names.map((n) => n.toLowerCase());
  const exact = (c: Column) => wanted.includes(c.name.toLowerCase());
  const anyExact = schema.tables.some((t) => t.columns.some(exact));
  const byName = (c: Column) => !wanted.length || (anyExact ? exact(c) : wanted.some((w) => c.name.toLowerCase().includes(w)));
  const byKind = (t: Table, c: Column) => kind === 'any' || KIND_TEST[kind](t, c);
  const hits = schema.tables.map((t) => ({ t, cols: t.columns.filter((c) => byName(c) && byKind(t, c)) })).filter((h) => h.cols.length);
  const count = hits.reduce((n, h) => n + h.cols.length, 0);
  const what = [kind !== 'any' && `${kind.replace('_', ' ')} columns`, wanted.length && `named ${anyExact ? '' : 'like '}${names.join(' or ')}`].filter(Boolean).join(' ') || 'columns';
  const shown = hits.slice(0, 14);
  return {
    count,
    tables: shown.map((h) => h.t.name),
    cards: [
      { head: `${plural(count, 'column')} in ${plural(hits.length, 'table')} match: ${what}`, lines: hits.length > shown.length ? [`Showing the first ${shown.length} tables.`] : [] },
      ...shown.map(({ t, cols }) => ({ table: t.name, head: `${t.name} (${formatRows(t.rows)} rows)`, lines: [capped(cols.map((c) => columnText(t, c)), 10).join('; ')] })),
    ],
  };
}
