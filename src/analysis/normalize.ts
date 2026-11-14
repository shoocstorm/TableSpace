// PURE: refactoring proposals for a table, as "ghost" tables to preview and
// the migration SQL that would create them. Two strategies:
// - split_groups: columns sharing a prefix (shipping_*, billing_*) become
//   their own table, one row per parent row;
// - extract_lookup: a short text column that names a state (status, type…)
//   becomes a lookup table with a foreign key.

import { pkColumns } from '../schema/graph';
import type { Column, SchemaDef, Table } from '../schema/types';

export type Strategy = 'auto' | 'split_groups' | 'extract_lookup';
export const STRATEGIES: Strategy[] = ['auto', 'split_groups', 'extract_lookup'];

export type GhostTable = {
  name: string;
  /** The live table it is split from. */
  source: string;
  columns: Column[];
  /** The ghost's column that references `source` (split) or is referenced by it (lookup). */
  link: { kind: 'child'; column: string } | { kind: 'lookup'; sourceColumn: string };
  /** Columns that would leave the source table. */
  moved: string[];
  reason: string;
};

export type Proposal = { table: string; strategy: Strategy; ghosts: GhostTable[]; sql: string; columnsBefore: number; columnsAfter: number };

/** A prefix needs this many columns to be worth a table of its own. */
const MIN_GROUP = 3;
const LOOKUP_NAMES = /^(status|state|type|kind|source|priority|currency|country|.*_(status|type|tier|policy))$/;

const singular = (name: string) => (name.endsWith('ies') ? `${name.slice(0, -3)}y` : name.endsWith('s') && !name.endsWith('ss') ? name.slice(0, -1) : name);

const plural = (name: string) => (name.endsWith("y") ? `${name.slice(0, -1)}ies` : name.endsWith("s") ? `${name}es` : `${name}s`);

function prefixGroups(table: Table): Map<string, Column[]> {
  const groups = new Map<string, Column[]>();
  const fkCols = new Set(table.fks.map((f) => f.column));
  for (const c of table.columns) {
    if (c.pk || fkCols.has(c.name)) continue;
    const at = c.name.indexOf('_');
    if (at <= 1) continue;
    const prefix = c.name.slice(0, at);
    groups.set(prefix, [...(groups.get(prefix) ?? []), c]);
  }
  for (const [k, v] of groups) if (v.length < MIN_GROUP) groups.delete(k);
  return groups;
}

function splitGroups(table: Table): GhostTable[] {
  const pkCol = pkColumns(table)[0] ?? 'id';
  const pkType = table.columns.find((c) => c.name === pkCol)?.type ?? 'bigint';
  const parentRef = `${singular(table.name)}_id`;
  return [...prefixGroups(table)].map(([prefix, cols]) => ({
    name: `${singular(table.name)}_${prefix}`,
    source: table.name,
    columns: [{ name: parentRef, type: pkType, pk: true }, ...cols.map((c) => ({ ...c, name: c.name.slice(prefix.length + 1) }))],
    link: { kind: 'child' as const, column: parentRef },
    moved: cols.map((c) => c.name),
    reason: `${cols.length} ${prefix}_* columns describe one thing and are read together.`,
  }));
}

function extractLookups(table: Table): GhostTable[] {
  const fkCols = new Set(table.fks.map((f) => f.column));
  return table.columns
    .filter((c) => !c.pk && !fkCols.has(c.name) && LOOKUP_NAMES.test(c.name) && /^(varchar|char|text)/.test(c.type))
    .slice(0, 3)
    .map((c) => ({
      name: `${singular(table.name)}_${plural(c.name)}`,
      source: table.name,
      columns: [
        { name: 'id', type: 'smallint', pk: true },
        { name: 'code', type: c.type, unique: true },
        { name: 'label', type: 'varchar(80)' },
      ],
      link: { kind: 'lookup' as const, sourceColumn: c.name },
      moved: [c.name],
      reason: `${c.name} repeats a handful of values as text on every row.`,
    }));
}

function migration(table: Table, ghosts: GhostTable[]): string {
  const pkCol = pkColumns(table)[0] ?? 'id';
  const out: string[] = ['BEGIN;', ''];
  for (const g of ghosts) {
    if (g.link.kind === 'child') {
      const defs = g.columns.map((c) => `  ${c.name} ${c.type}${c.pk ? ` PRIMARY KEY REFERENCES ${table.name} (${pkCol}) ON DELETE CASCADE` : c.nullable ? '' : ' NOT NULL'}`);
      const dest = g.columns.filter((c) => !c.pk).map((c) => c.name);
      out.push(`CREATE TABLE ${g.name} (`, defs.join(',\n'), ');', '');
      out.push(`INSERT INTO ${g.name} (${[g.link.column, ...dest].join(', ')})`, `SELECT ${[pkCol, ...g.moved].join(', ')}`, `FROM ${table.name};`, '');
      out.push(`ALTER TABLE ${table.name}`, g.moved.map((m) => `  DROP COLUMN ${m}`).join(',\n') + ';', '');
    } else {
      const src = g.link.sourceColumn;
      out.push(`CREATE TABLE ${g.name} (`, '  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,', `  code ${g.columns[1].type} NOT NULL UNIQUE,`, '  label varchar(80) NOT NULL', ');', '');
      out.push(`INSERT INTO ${g.name} (code, label)`, `SELECT DISTINCT ${src}, initcap(replace(${src}, '_', ' '))`, `FROM ${table.name};`, '');
      out.push(`ALTER TABLE ${table.name} ADD COLUMN ${src}_id smallint REFERENCES ${g.name} (id);`);
      out.push(`UPDATE ${table.name} t SET ${src}_id = l.id FROM ${g.name} l WHERE l.code = t.${src};`);
      out.push(`ALTER TABLE ${table.name} ALTER COLUMN ${src}_id SET NOT NULL, DROP COLUMN ${src};`);
      out.push(`CREATE INDEX ${table.name}_${src}_id_idx ON ${table.name} (${src}_id);`, '');
    }
  }
  out.push('COMMIT;');
  return out.join('\n');
}

export function proposeRefactor(schema: SchemaDef, tableName: string, strategy: Strategy = 'auto'): Proposal | null {
  const table = schema.tables.find((t) => t.name === tableName);
  if (!table) return null;
  let used = strategy;
  let ghosts: GhostTable[] = [];
  if (strategy === 'split_groups' || strategy === 'auto') {
    ghosts = splitGroups(table);
    used = 'split_groups';
  }
  if (strategy === 'extract_lookup' || (strategy === 'auto' && !ghosts.length)) {
    ghosts = extractLookups(table);
    used = 'extract_lookup';
  }
  // a name already taken by a live table would confuse the preview
  ghosts = ghosts.map((g) => (schema.tables.some((t) => t.name === g.name) ? { ...g, name: `${g.name}_new` } : g));
  const moved = ghosts.reduce((n, g) => n + (g.link.kind === 'child' ? g.moved.length : 0), 0);
  return { table: table.name, strategy: used, ghosts, sql: ghosts.length ? migration(table, ghosts) : '', columnsBefore: table.columns.length, columnsAfter: table.columns.length - moved };
}

/** The tables most worth splitting: the widest ones that have something to split. */
export function bloatedTables(schema: SchemaDef, limit = 2): string[] {
  return schema.tables
    .filter((t) => prefixGroups(t).size > 0)
    .sort((a, b) => b.columns.length - a.columns.length)
    .slice(0, limit)
    .map((t) => t.name);
}
