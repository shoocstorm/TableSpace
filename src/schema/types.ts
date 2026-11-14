// The shape of a database TableSpace can show. A schema is plain data: add a
// file like ecommerce.ts and list it in registry.ts to get a new database.

export type Cardinality = '1:1' | '1:N' | 'M:N';

export type Column = {
  name: string;
  /** The SQL type as written in DDL, e.g. `bigint`, `varchar(64)`, `timestamptz`. */
  type: string;
  pk?: boolean;
  nullable?: boolean;
  unique?: boolean;
};

export type ForeignKey = { column: string; refTable: string; refColumn: string };

export type Index = { name: string; columns: string[]; unique?: boolean };

export type Table = {
  name: string;
  /** A `Domain.id`: tables of a domain share a color and cluster together. */
  domain: string;
  /** Row count from the (mock) statistics; drives the monolith's volume. */
  rows: number;
  columns: Column[];
  fks: ForeignKey[];
  indexes: Index[];
  comment?: string;
};

export type Domain = { id: string; label: string; color: string };

/** A named query the agent can trace without anyone typing SQL. */
export type QueryPreset = { id: string; label: string; sql: string };

export type SchemaDef = {
  id: string;
  name: string;
  /** Shown in the switcher, e.g. `PostgreSQL 16 · mock`. */
  engine: string;
  description: string;
  domains: Domain[];
  tables: Table[];
  presets: QueryPreset[];
};

// ── small builders, so schema files read like DDL ────────────────────────

export const pk = (name = 'id', type = 'bigint'): Column => ({ name, type, pk: true });
export const col = (name: string, type: string, opts: Partial<Omit<Column, 'name' | 'type'>> = {}): Column => ({ name, type, ...opts });
export const fk = (column: string, refTable: string, refColumn = 'id'): ForeignKey => ({ column, refTable, refColumn });
export const idx = (table: string, columns: string[], unique = false): Index => ({ name: `${table}_${columns.join('_')}_${unique ? 'key' : 'idx'}`, columns, unique });
