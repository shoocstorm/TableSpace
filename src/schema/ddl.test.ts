import { describe, expect, it } from 'vitest';
import { audit } from '../analysis/audit';
import { simulatePlan } from '../analysis/plan';
import { runSeed, seedPlan } from '../analysis/seed';
import { parseQuery } from '../analysis/sql';
import { computeLayout } from '../layout/force';
import { EXAMPLE_DDL, parseDdl } from './ddl';
import { edgesOf, isJunction, tableByName } from './graph';

const example = () => {
  const r = parseDdl(EXAMPLE_DDL, 'Library');
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe('importing DDL', () => {
  it('reads tables, columns, keys and indexes', () => {
    const { schema, warnings } = example();
    expect(schema.tables.map((t) => t.name)).toEqual(['members', 'authors', 'books', 'copies', 'branches', 'loans', 'book_tags', 'tags']);
    expect(warnings).toEqual([]);
    const books = tableByName(schema, 'books')!;
    expect(books.columns).toEqual([
      { name: 'id', type: 'bigserial', pk: true },
      { name: 'author_id', type: 'bigint' },
      { name: 'title', type: 'varchar(240)' },
      { name: 'isbn', type: 'char(13)', unique: true, nullable: true },
      { name: 'published_on', type: 'date', nullable: true },
    ]);
    expect(books.fks).toEqual([{ column: 'author_id', refTable: 'authors', refColumn: 'id' }]);
    expect(books.indexes.map((i) => i.columns)).toEqual([['author_id']]);
  });
  it('reads table-level, forward and ALTER TABLE foreign keys', () => {
    const { schema } = example();
    expect(edgesOf(schema).map((e) => `${e.id}→${e.to}`).sort()).toEqual(['book_tags.book_id→books', 'book_tags.tag_id→tags', 'books.author_id→authors', 'copies.book_id→books', 'copies.branch_id→branches', 'loans.copy_id→copies', 'loans.member_id→members']);
    expect(isJunction(tableByName(schema, 'book_tags')!)).toBe(true);
    expect(tableByName(schema, 'book_tags')!.columns.every((c) => c.pk)).toBe(true);
  });
  it('gives the scene what DDL does not: domains, sizes and queries to trace', () => {
    const { schema } = example();
    for (const t of schema.tables) expect(schema.domains.some((d) => d.id === t.domain)).toBe(true);
    expect(schema.domains.length).toBeGreaterThan(1);
    expect(tableByName(schema, 'loans')!.rows).toBeGreaterThan(tableByName(schema, 'authors')!.rows);
    expect(schema.presets.length).toBeGreaterThan(0);
    for (const p of schema.presets) {
      const q = parseQuery(p.sql);
      expect(q.ok && simulatePlan(schema, q.query).ok, p.id).toBe(true);
    }
  });
  it('produces a schema every feature accepts', () => {
    const { schema } = example();
    expect(Object.keys(computeLayout(schema)).length).toBe(8);
    expect(audit(schema).map((f) => `${f.rule}:${f.table}.${f.column ?? ''}`)).toEqual(expect.arrayContaining(['missing_fk_index:loans.copy_id', 'missing_fk_index:copies.branch_id']));
    const { rows } = runSeed(schema, seedPlan(schema, null, 'small'));
    expect(rows.loans.length).toBeGreaterThan(0);
  });
  it('handles MySQL and SQL Server spellings, quotes and schema prefixes', () => {
    const r = parseDdl(
      'CREATE TABLE IF NOT EXISTS `shop`.`Customers` (`ID` INT NOT NULL AUTO_INCREMENT, `Email` VARCHAR(255) NOT NULL, PRIMARY KEY (`ID`), UNIQUE KEY `uq_email` (`Email`)) ENGINE=InnoDB;\n' +
        'CREATE TABLE [dbo].[Orders] ([OrderID] int IDENTITY(1,1) PRIMARY KEY, [CustomerID] int NOT NULL, [Total] decimal(10, 2) DEFAULT 0, KEY idx_c (CustomerID), CONSTRAINT fk_c FOREIGN KEY ([CustomerID]) REFERENCES [dbo].[Customers]([ID]) ON DELETE CASCADE);',
      'Shop',
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.schema.tables.map((t) => [t.name, t.columns.map((c) => `${c.name}:${c.type}${c.pk ? ':pk' : ''}`)])).toEqual([
      ['customers', ['id:int:pk', 'email:varchar(255)']],
      ['orders', ['orderid:int:pk', 'customerid:int', 'total:decimal(10, 2)']],
    ]);
    expect(r.schema.tables[1].fks).toEqual([{ column: 'customerid', refTable: 'customers', refColumn: 'id' }]);
    expect(r.schema.tables[0].indexes).toEqual([{ name: 'customers_email_key', columns: ['email'], unique: true }]);
  });
  it('says what it left out, and refuses text with no tables', () => {
    const r = parseDdl('create table a (id int primary key, b_id int references missing(id)); insert into a values (1, 2);', 'x');
    expect(r.ok && r.warnings[0]).toContain('references missing');
    expect(r.ok && r.schema.tables[0].fks).toEqual([]);
    expect(parseDdl('select 1', 'x').ok).toBe(false);
  });
});
