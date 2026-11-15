import { describe, expect, it } from 'vitest';
import { ecommerce } from './ecommerce';
import { cardsText, columnNames, dependents, describeTables, findColumns, indexReport, joinPath, mentionedColumnNames, mentionedKind, pathTables, redundantIndexes, relateTables, schemaOverview } from './insight';
import { col, fk, idx, pk, type SchemaDef, type Table } from './types';

const table = (name: string, extra: Partial<Table> = {}): Table => ({ name, domain: 'main', rows: 1000, columns: [pk()], fks: [], indexes: [], ...extra });
const tiny: SchemaDef = {
  id: 'tiny',
  name: 'Tiny',
  engine: 'PostgreSQL · test',
  description: '',
  domains: [{ id: 'main', label: 'Main', color: '#fff' }],
  presets: [],
  tables: [
    table('authors', { columns: [pk(), col('email', 'varchar(255)', { unique: true }), col('bio', 'text', { nullable: true })] }),
    table('books', { rows: 2_000_000, columns: [pk(), col('author_id', 'bigint'), col('title', 'text'), col('published_at', 'timestamptz', { nullable: true })], fks: [fk('author_id', 'authors')], indexes: [idx('books', ['title']), idx('books', ['title', 'published_at']), idx('books', ['id'])] }),
    table('reviews', { columns: [pk(), col('book_id', 'bigint'), col('meta', 'jsonb')], fks: [fk('book_id', 'books')], indexes: [idx('reviews', ['book_id'])] }),
    table('settings', { columns: [col('key', 'text'), col('value', 'text')] }),
  ],
};

describe('describeTables', () => {
  it('describes several tables in one call: columns, keys, both directions of relationships, indexes', () => {
    const cards = describeTables(tiny, ['books', 'authors', 'nope']);
    expect(cards.map((c) => c.table)).toEqual(['books', 'authors']);
    const text = cardsText(cards);
    expect(cards[0].head).toBe('books: Main domain, 2M rows, 4 columns');
    expect(text).toContain('author_id bigint [→ authors.id, no index]');
    expect(text).toContain('published_at timestamptz [nullable]');
    expect(text).toContain('References: authors (author_id → id, 1:N)');
    expect(text).toContain('Referenced by: reviews.book_id');
    expect(text).toContain('Foreign keys with no index: author_id');
    expect(text).toContain('email varchar(255) [unique]');
    expect(text).toContain('Referenced by: books.author_id');
  });
  it('caps the columns of a wide table', () => {
    const wide = describeTables(ecommerce, ['orders'], 5)[0].lines[0];
    expect(wide).toMatch(/; and \d+ more$/);
  });
});

describe('relationships', () => {
  it('finds the shortest join path in either direction, with the columns', () => {
    const path = joinPath(tiny, 'reviews', 'authors')!;
    expect(path.map((e) => `${e.from}.${e.column}=${e.to}.${e.refColumn}`)).toEqual(['reviews.book_id=books.id', 'books.author_id=authors.id']);
    expect(pathTables('reviews', path)).toEqual(['reviews', 'books', 'authors']);
    expect(pathTables('authors', joinPath(tiny, 'authors', 'reviews')!)).toEqual(['authors', 'books', 'reviews']);
    expect(joinPath(tiny, 'authors', 'settings')).toBeNull();
    expect(joinPath(tiny, 'authors', 'authors')).toEqual([]);
  });
  it('lists what depends on a table, by distance', () => {
    expect(dependents(tiny, 'authors', 3)).toEqual([['books'], ['reviews']]);
    expect(dependents(tiny, 'authors', 1)).toEqual([['books']]);
    expect(dependents(tiny, 'reviews', 3)).toEqual([]);
  });
  it('reports the path between each pair and each table’s parents and children', () => {
    const text = cardsText(relateTables(tiny, ['reviews', 'authors', 'settings']));
    expect(text).toContain('Join path reviews → books → authors: 2 joins');
    expect(text).toContain('JOIN books ON reviews.book_id = books.id (reviews → books, 1:N)');
    expect(text).toContain('reviews and settings: no foreign keys connect them');
    expect(text).toContain('Also depend on it, through those: reviews');
    expect(text).toContain('No relationships at all.');
  });
});

describe('indexes', () => {
  it('finds indexes another one covers', () => {
    expect(redundantIndexes(tiny.tables[1])).toEqual([
      { index: 'books_title_idx', coveredBy: 'books_title_published_at_idx' },
      { index: 'books_id_idx', coveredBy: 'the primary key' },
    ]);
    // a unique index enforces something a longer index does not
    expect(redundantIndexes(table('t', { indexes: [idx('t', ['a'], true), idx('t', ['a', 'b'])] }))).toEqual([]);
  });
  it('reports named tables in full, and for the whole schema only the tables to fix', () => {
    const named = indexReport(tiny, ['reviews']);
    expect(named[0].head).toBe('1 index besides primary keys on 1 table; 1 foreign key, 0 with no index; 0 redundant indexes');
    expect(named[1].lines).toContain('Foreign keys with an index: book_id');
    const all = indexReport(tiny, []);
    expect(all.map((c) => c.table)).toEqual([undefined, 'books']);
    expect(cardsText(all)).toContain('Foreign keys with no index: author_id (joins on them read all 2M rows)');
    expect(all[0].lines[0]).toBe('Tables with no index besides the primary key: authors, settings');
  });
});

describe('overview', () => {
  it('counts the schema and names the tables that stand out', () => {
    const [card] = schemaOverview(tiny);
    expect(card.head).toBe('Tiny (PostgreSQL · test): 4 tables, 12 columns, 2 foreign keys, 4 indexes, 2M rows in total');
    const text = card.lines.join('\n');
    expect(text).toContain('Largest by rows: books (2M)');
    expect(text).toContain('Most connected: books (2 relationships)');
    expect(text).toContain('Root tables (referenced, reference nothing): authors');
    expect(text).toContain('Tables with no relationships: settings');
    expect(text).toContain('Tables with no primary key: settings');
  });
  it('covers one domain of a real schema', () => {
    const [card] = schemaOverview(ecommerce, 'payments');
    expect(card.head).toMatch(/^The Payments domain of /);
    expect(card.lines.some((l) => l.startsWith('Domains:'))).toBe(false);
  });
});

describe('columns', () => {
  it('reads column names and kinds out of a request', () => {
    expect(mentionedColumnNames(tiny, 'which tables have an author id or published at?')).toEqual(['published_at', 'author_id']);
    expect(mentionedColumnNames(tiny, 'hello')).toEqual([]);
    expect(mentionedKind('find every timestamp column')).toBe('time');
    expect(mentionedKind('where are the nullable ones')).toBe('nullable');
    expect(mentionedKind('anything')).toBe('any');
    expect(columnNames(tiny)[0]).toBe('id');
  });
  it('finds columns by name, by part of a name, and by kind', () => {
    expect(findColumns(tiny, ['email']).tables).toEqual(['authors']);
    expect(findColumns(tiny, ['_id']).cards[0].head).toBe('2 columns in 2 tables match: named like _id');
    expect(findColumns(tiny, [], 'json').tables).toEqual(['reviews']);
    expect(findColumns(tiny, [], 'nullable').count).toBe(2);
    expect(findColumns(tiny, [], 'foreign_key').tables).toEqual(['books', 'reviews']);
    expect(findColumns(tiny, ['nope']).count).toBe(0);
  });
});
