// PURE: a SchemaDef from SQL DDL, so TableSpace can show a database of your
// own. Reads CREATE TABLE (columns, inline and table-level PRIMARY KEY,
// UNIQUE, FOREIGN KEY / REFERENCES), CREATE [UNIQUE] INDEX and ALTER TABLE …
// ADD FOREIGN KEY / PRIMARY KEY, in PostgreSQL, MySQL or SQLite spelling.
// Everything else (views, functions, grants, inserts) is skipped.
//
// DDL says nothing about two things the scene needs, so they are worked out:
// - domains: tables are grouped by how they reference each other;
// - row counts: estimated from a table's depth in the foreign-key graph
//   (tables many others hang off are small, tables at the end of long
//   chains are large). The UI says these are estimates.

import { compileQuery, emptySpec } from '../analysis/querybuilder';
import { edgesOf, isJunction } from './graph';
import type { Column, ForeignKey, Index, QueryPreset, SchemaDef, Table } from './types';

export type DdlResult = { ok: true; schema: SchemaDef; warnings: string[] } | { ok: false; error: string };

const PALETTE = ['#38bdf8', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb923c', '#f87171', '#2dd4bf', '#c084fc', '#a3e635'];

const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/^\s*#[^\n]*/gm, ' ');
/** `"public"."Order Items"`, `[dbo].[users]`, `` `users` `` → `order_items`, `users`. */
const ident = (raw: string) => {
  const last = raw.trim().split(/\.(?=(?:[^"`\]]*["`\[][^"`\]]*["`\]])*[^"`\]]*$)/).pop() ?? raw;
  return last.trim().replace(/^["`\[]|["`\]]$/g, '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
};
const identList = (s: string) => s.split(',').map((x) => ident(x.replace(/\s+(asc|desc)\b.*$/i, '').replace(/\(\d+\)/, ''))).filter(Boolean);
const NAME = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[\\w$]+)';
const QNAME = `${NAME}(?:\\s*\\.\\s*${NAME})*`;

/** Splits on commas that are not inside parentheses or quotes. */
function splitTop(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The text between a statement's first `(` and its matching `)`. */
function parenBody(sql: string, from: number): { body: string; end: number } | null {
  const open = sql.indexOf('(', from);
  if (open < 0) return null;
  let depth = 0;
  let quote = '';
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return { body: sql.slice(open + 1, i), end: i };
  }
  return null;
}

type Draft = { name: string; columns: Column[]; fks: ForeignKey[]; indexes: Index[]; pk: string[] };

const CONSTRAINT_START = /\b(not\s+null|null|primary\s+key|unique|references|default|check|constraint|generated|auto_increment|autoincrement|collate|comment|on\s+update|identity)\b/i;

function readColumn(def: string, t: Draft, warnings: string[]): void {
  const m = new RegExp(`^(${NAME})\\s+([\\s\\S]*)$`).exec(def);
  if (!m) return void warnings.push(`${t.name}: could not read "${def.slice(0, 40)}"`);
  const name = ident(m[1]);
  const rest = m[2];
  const cut = rest.search(CONSTRAINT_START);
  const type = (cut < 0 ? rest : rest.slice(0, cut)).trim().replace(/\s+/g, ' ').toLowerCase() || 'text';
  const tail = cut < 0 ? '' : rest.slice(cut);
  const col: Column = { name, type };
  if (/\bprimary\s+key\b/i.test(tail)) col.pk = true;
  if (/\bunique\b/i.test(tail)) col.unique = true;
  if (!col.pk && !/\bnot\s+null\b/i.test(tail)) col.nullable = true;
  const ref = new RegExp(`\\breferences\\s+(${QNAME})\\s*(?:\\(([^)]*)\\))?`, 'i').exec(tail);
  if (ref) t.fks.push({ column: name, refTable: ident(ref[1]), refColumn: ref[2] ? identList(ref[2])[0] : '' });
  t.columns.push(col);
}

function readConstraint(def: string, t: Draft): boolean {
  const body = def.replace(new RegExp(`^constraint\\s+${NAME}\\s+`, 'i'), '');
  let m: RegExpExecArray | null;
  if ((m = /^primary\s+key\s*\(([^)]*)\)/i.exec(body))) {
    t.pk.push(...identList(m[1]));
    return true;
  }
  if ((m = new RegExp(`^foreign\\s+key\\s*(?:${NAME}\\s*)?\\(([^)]*)\\)\\s*references\\s+(${QNAME})\\s*(?:\\(([^)]*)\\))?`, 'i').exec(body))) {
    const cols = identList(m[1]);
    const refs = m[3] ? identList(m[3]) : [];
    // a composite key is kept as its first column: relationships here are column to column
    t.fks.push({ column: cols[0], refTable: ident(m[2]), refColumn: refs[0] ?? '' });
    return true;
  }
  if ((m = new RegExp(`^unique(?:\\s+(?:key|index))?\\s*(?:${NAME}\\s*)?\\(([^)]*)\\)`, 'i').exec(body))) {
    const columns = identList(m[1]);
    t.indexes.push({ name: `${t.name}_${columns.join('_')}_key`, columns, unique: true });
    return true;
  }
  if ((m = new RegExp(`^(?:key|index|fulltext\\s+(?:key|index))\\s*(?:${NAME}\\s*)?\\(([^)]*)\\)`, 'i').exec(body))) {
    const columns = identList(m[1]);
    t.indexes.push({ name: `${t.name}_${columns.join('_')}_idx`, columns });
    return true;
  }
  return /^(check|exclude|like|period)\b/i.test(body);
}

/** Groups tables by label propagation over the foreign keys: a table takes the group most of its neighbours are in. */
function communities(names: string[], links: [string, string][], max: number): Map<string, number> {
  const label = new Map(names.map((n, i) => [n, i]));
  const near = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const [a, b] of links) {
    if (a === b || !near.has(a) || !near.has(b)) continue;
    near.get(a)!.push(b);
    near.get(b)!.push(a);
  }
  // most connected first, so hubs give their label to the tables around them
  const order = [...names].sort((a, b) => near.get(b)!.length - near.get(a)!.length || names.indexOf(a) - names.indexOf(b));
  for (let round = 0; round < 12; round++) {
    let changed = false;
    for (const n of order) {
      const counts = new Map<number, number>();
      for (const m of near.get(n)!) counts.set(label.get(m)!, (counts.get(label.get(m)!) ?? 0) + 1);
      if (!counts.size) continue;
      const best = [...counts].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
      if (best !== label.get(n)) {
        label.set(n, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // the largest groups keep their own domain; the rest share one
  const sizes = new Map<number, number>();
  for (const l of label.values()) sizes.set(l, (sizes.get(l) ?? 0) + 1);
  const ranked = [...sizes].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([l]) => l);
  const keep = new Map(ranked.slice(0, max - 1).map((l, i) => [l, i]));
  const out = new Map<string, number>();
  for (const n of names) out.set(n, keep.get(label.get(n)!) ?? Math.min(ranked.length, max) - 1);
  return out;
}

const title = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** A few queries worth tracing in any schema: the longest chains of foreign keys. */
export function autoPresets(schema: SchemaDef): QueryPreset[] {
  const edges = edgesOf(schema).filter((e) => e.from !== e.to);
  const chains: string[][] = [];
  for (const start of [...schema.tables].sort((a, b) => b.fks.length - a.fks.length).slice(0, 6)) {
    const chain = [start.name];
    for (let at = start.name; chain.length < 4; ) {
      const next = edges.find((e) => e.from === at && !chain.includes(e.to));
      if (!next) break;
      chain.push(next.to);
      at = next.to;
    }
    if (chain.length > 1 && !chains.some((c) => c.join() === chain.join())) chains.push(chain);
  }
  return chains
    .sort((a, b) => b.length - a.length)
    .slice(0, 3)
    .flatMap((chain) => {
      const out = compileQuery(schema, emptySpec(chain));
      return out.ok ? [{ id: chain.join('_to_').slice(0, 60), label: chain.map((c) => c.replace(/_/g, ' ')).join(' → '), sql: out.sql.replace(/;$/, '') }] : [];
    });
}

export function parseDdl(sql: string, name: string, id = `import-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`): DdlResult {
  const text = stripComments(sql);
  const warnings: string[] = [];
  const drafts = new Map<string, Draft>();

  for (const m of text.matchAll(new RegExp(`create\\s+(?:(?:global\\s+|local\\s+)?(?:temporary|temp|unlogged)\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?(${QNAME})\\s*\\(`, 'gi'))) {
    const tname = ident(m[1]);
    const inner = parenBody(text, m.index + m[0].length - 1);
    if (!inner) {
      warnings.push(`${tname}: unbalanced parentheses, skipped`);
      continue;
    }
    const t: Draft = { name: tname, columns: [], fks: [], indexes: [], pk: [] };
    for (const part of splitTop(inner.body)) {
      if (/^(constraint|primary\s+key|foreign\s+key|unique|key|index|fulltext|check|exclude|like|period)\b/i.test(part) && readConstraint(part, t)) continue;
      readColumn(part, t, warnings);
    }
    if (t.columns.length) drafts.set(tname, t);
  }
  if (!drafts.size) return { ok: false, error: 'No CREATE TABLE statement was found. Paste the DDL of your schema (for example the output of pg_dump --schema-only).' };

  for (const m of text.matchAll(new RegExp(`create\\s+(unique\\s+)?index\\s+(?:concurrently\\s+)?(?:if\\s+not\\s+exists\\s+)?(?:(${NAME})\\s+)?on\\s+(?:only\\s+)?(${QNAME})\\s*(?:using\\s+\\w+\\s*)?\\(`, 'gi'))) {
    const t = drafts.get(ident(m[3]));
    const inner = parenBody(text, m.index + m[0].length - 1);
    if (!t || !inner) continue;
    const columns = identList(inner.body).filter((c) => t.columns.some((x) => x.name === c));
    if (columns.length) t.indexes.push({ name: m[2] ? ident(m[2]) : `${t.name}_${columns.join('_')}_idx`, columns, unique: !!m[1] });
  }
  for (const m of text.matchAll(new RegExp(`alter\\s+table\\s+(?:only\\s+)?(?:if\\s+exists\\s+)?(${QNAME})\\s+add\\s+([^;]+)`, 'gi'))) {
    const t = drafts.get(ident(m[1]));
    if (t) readConstraint(m[2].trim(), t);
  }

  // ── tidy: keys onto columns, foreign keys that point somewhere real ──
  const tablesDraft = [...drafts.values()];
  for (const t of tablesDraft) {
    for (const p of t.pk) {
      const c = t.columns.find((x) => x.name === p);
      if (c) {
        c.pk = true;
        delete c.nullable;
      }
    }
    t.fks = t.fks.filter((f) => {
      const parent = drafts.get(f.refTable);
      if (!parent || !t.columns.some((c) => c.name === f.column)) {
        warnings.push(`${t.name}.${f.column} references ${f.refTable}, which is not in the DDL; the relationship was left out`);
        return false;
      }
      // REFERENCES t with no column means its primary key
      if (!f.refColumn) f.refColumn = parent.columns.find((c) => c.pk)?.name ?? parent.pk[0] ?? parent.columns[0].name;
      return parent.columns.some((c) => c.name === f.refColumn);
    });
    t.fks = t.fks.filter((f, i) => t.fks.findIndex((x) => x.column === f.column && x.refTable === f.refTable) === i);
    t.indexes = t.indexes.filter((x, i) => x.columns.every((c) => t.columns.some((k) => k.name === c)) && t.indexes.findIndex((y) => y.columns.join() === x.columns.join()) === i);
  }

  // ── domains ──
  const names = tablesDraft.map((t) => t.name);
  const links = tablesDraft.flatMap((t) => t.fks.map((f) => [t.name, f.refTable] as [string, string]));
  const group = communities(names, links, Math.min(8, Math.max(1, Math.ceil(names.length / 3))));
  const degree = (n: string) => links.filter(([a, b]) => a === n || b === n).length;
  const groupIds = [...new Set(group.values())].sort((a, b) => a - b);
  const domains = groupIds.map((g, i) => {
    const members = names.filter((n) => group.get(n) === g);
    const linked = members.some((n) => degree(n) > 0);
    // named after the table the others hang off
    const hub = [...members].sort((a, b) => links.filter(([, p]) => p === b).length - links.filter(([, p]) => p === a).length || degree(b) - degree(a))[0];
    return { id: `d${g}`, label: linked || members.length === 1 ? title(hub) : 'Standalone', color: PALETTE[i % PALETTE.length] };
  });

  // ── row estimates: depth below the tables nothing points out of ──
  const depth = new Map<string, number>();
  const depthOf = (n: string, seen: string[] = []): number => {
    if (depth.has(n)) return depth.get(n)!;
    const parents = drafts.get(n)!.fks.map((f) => f.refTable).filter((p) => p !== n && !seen.includes(p));
    const d = parents.length ? 1 + Math.max(...parents.map((p) => depthOf(p, [...seen, n]))) : 0;
    depth.set(n, d);
    return d;
  };
  const tables: Table[] = tablesDraft.map((t) => {
    const d = depthOf(t.name);
    const base: Table = { name: t.name, domain: `d${group.get(t.name)}`, rows: 0, columns: t.columns, fks: t.fks, indexes: t.indexes };
    const rows = Math.min(50_000_000, Math.round(400 * 9 ** d * (isJunction(base) ? 2 : 1)));
    return { ...base, rows };
  });

  const schema: SchemaDef = { id, name, engine: 'imported DDL · row counts estimated', description: `${tables.length} tables imported from DDL.`, domains, tables, presets: [] };
  schema.presets = autoPresets(schema);
  if (!links.length) warnings.push('No foreign keys were found, so tables are not connected. If your schema declares them with ALTER TABLE, include those statements.');
  return { ok: true, schema, warnings };
}

export const EXAMPLE_DDL = `-- A small library system. Replace this with your own DDL.
CREATE TABLE members (
  id          bigserial PRIMARY KEY,
  email       varchar(255) NOT NULL UNIQUE,
  full_name   varchar(120) NOT NULL,
  joined_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE authors (
  id    bigserial PRIMARY KEY,
  name  varchar(160) NOT NULL
);

CREATE TABLE books (
  id            bigserial PRIMARY KEY,
  author_id     bigint NOT NULL REFERENCES authors (id),
  title         varchar(240) NOT NULL,
  isbn          char(13) UNIQUE,
  published_on  date
);

CREATE TABLE copies (
  id        bigserial PRIMARY KEY,
  book_id   bigint NOT NULL REFERENCES books (id),
  branch_id bigint NOT NULL,
  status    varchar(16) NOT NULL
);

CREATE TABLE branches (
  id    bigserial PRIMARY KEY,
  name  varchar(80) NOT NULL,
  city  varchar(80) NOT NULL
);

CREATE TABLE loans (
  id          bigserial PRIMARY KEY,
  copy_id     bigint NOT NULL,
  member_id   bigint NOT NULL,
  loaned_at   timestamptz NOT NULL,
  due_at      timestamptz NOT NULL,
  returned_at timestamptz,
  CONSTRAINT loans_copy_fk FOREIGN KEY (copy_id) REFERENCES copies (id),
  CONSTRAINT loans_member_fk FOREIGN KEY (member_id) REFERENCES members (id)
);

CREATE TABLE book_tags (
  book_id bigint NOT NULL REFERENCES books (id),
  tag_id  bigint NOT NULL REFERENCES tags (id),
  PRIMARY KEY (book_id, tag_id)
);

CREATE TABLE tags (
  id    bigserial PRIMARY KEY,
  label varchar(60) NOT NULL UNIQUE
);

ALTER TABLE copies ADD CONSTRAINT copies_branch_fk FOREIGN KEY (branch_id) REFERENCES branches (id);

CREATE INDEX books_author_id_idx ON books (author_id);
CREATE INDEX loans_member_id_idx ON loans (member_id);
CREATE INDEX copies_book_id_idx ON copies USING btree (book_id);
`;
