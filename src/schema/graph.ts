// PURE: a schema as a graph. Tables are nodes; each foreign key is an edge
// from the child (the table holding the column) to the parent it references.

import type { Cardinality, Column, SchemaDef, Table } from './types';

export type Edge = {
  id: string;
  /** The table holding the foreign key column. */
  from: string;
  column: string;
  /** The referenced table and column. */
  to: string;
  refColumn: string;
  cardinality: Cardinality;
};

export const tableByName = (schema: SchemaDef, name: string): Table | undefined => schema.tables.find((t) => t.name === name);
export const columnOf = (table: Table, name: string): Column | undefined => table.columns.find((c) => c.name === name);
export const pkColumns = (table: Table): string[] => table.columns.filter((c) => c.pk).map((c) => c.name);

/** Whether a lookup by `column` can use an index: the primary key, a unique column, or an index led by it. */
export function isIndexed(table: Table, column: string): boolean {
  const pks = pkColumns(table);
  if (pks[0] === column) return true;
  if (columnOf(table, column)?.unique) return true;
  return table.indexes.some((i) => i.columns[0] === column);
}

/** Whether `column` holds at most one row per value (so the relationship is 1:1). */
function isUniqueColumn(table: Table, column: string): boolean {
  const pks = pkColumns(table);
  if (pks.length === 1 && pks[0] === column) return true;
  if (columnOf(table, column)?.unique) return true;
  return table.indexes.some((i) => i.unique && i.columns.length === 1 && i.columns[0] === column);
}

/**
 * A junction table: its primary key is made of two or more foreign keys, so
 * it stands for a many-to-many relationship between the tables it references.
 */
export function isJunction(table: Table): boolean {
  const pks = pkColumns(table);
  return pks.length >= 2 && pks.every((p) => table.fks.some((f) => f.column === p));
}

export function edgesOf(schema: SchemaDef): Edge[] {
  const edges: Edge[] = [];
  for (const t of schema.tables) {
    const junction = isJunction(t);
    for (const f of t.fks) {
      if (!tableByName(schema, f.refTable)) continue;
      edges.push({
        id: `${t.name}.${f.column}`,
        from: t.name,
        column: f.column,
        to: f.refTable,
        refColumn: f.refColumn,
        cardinality: junction && pkColumns(t).includes(f.column) ? 'M:N' : isUniqueColumn(t, f.column) ? '1:1' : '1:N',
      });
    }
  }
  return edges;
}

/** The tables within `hops` relationships of `start` (either direction), `start` included. */
export function neighbours(schema: SchemaDef, start: string[], hops: number): string[] {
  const edges = edgesOf(schema);
  const seen = new Set(start.filter((n) => tableByName(schema, n)));
  let frontier = [...seen];
  for (let h = 0; h < hops && frontier.length; h++) {
    const next: string[] = [];
    for (const e of edges) {
      for (const [a, b] of [[e.from, e.to], [e.to, e.from]] as const) {
        if (frontier.includes(a) && !seen.has(b)) {
          seen.add(b);
          next.push(b);
        }
      }
    }
    frontier = next;
  }
  return schema.tables.map((t) => t.name).filter((n) => seen.has(n));
}

export const tablesOfDomain = (schema: SchemaDef, domain: string): string[] => schema.tables.filter((t) => t.domain === domain).map((t) => t.name);

/** The edge joining two tables on the given columns, in either direction. */
export function edgeBetween(edges: Edge[], a: string, b: string): Edge | undefined {
  return edges.find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
}

/**
 * Parents before children (Kahn). Self-references are ignored, and a cycle is
 * broken at the table with the fewest unmet parents, so every table appears once.
 */
export function topoOrder(schema: SchemaDef, only?: string[]): string[] {
  const names = schema.tables.map((t) => t.name).filter((n) => !only || only.includes(n));
  const parents = new Map<string, Set<string>>();
  for (const n of names) parents.set(n, new Set());
  for (const e of edgesOf(schema)) {
    if (e.from !== e.to && parents.has(e.from) && parents.has(e.to)) parents.get(e.from)!.add(e.to);
  }
  const order: string[] = [];
  const left = new Set(names);
  while (left.size) {
    let ready = names.filter((n) => left.has(n) && [...parents.get(n)!].every((p) => !left.has(p)));
    if (!ready.length) {
      const unmet = (n: string) => [...parents.get(n)!].filter((p) => left.has(p)).length;
      ready = [[...left].sort((a, b) => unmet(a) - unmet(b) || names.indexOf(a) - names.indexOf(b))[0]];
    }
    for (const n of ready) {
      order.push(n);
      left.delete(n);
    }
  }
  return order;
}

/** `1.2K`, `48.2M`: row counts as shown on a monolith. */
export function formatRows(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '')}K`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1).replace(/\.?0+$/, '')}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}
