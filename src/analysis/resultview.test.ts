import { describe, expect, it } from 'vitest';
import { applyView, EMPTY_VIEW, kindOf, matchCell, summarize, toDelimited, toObjects } from './resultview';
import type { Value } from './seed';

const rows: Value[][] = [
  ['Ada', 30, 'paid', '2025-03-01'],
  ['bob', 5, 'pending', '2025-01-15'],
  ['Cy', null, 'paid', '2024-11-02'],
  ['Dee', 120, 'refunded', null],
];

describe('matchCell', () => {
  it('reads plain text as contains, without case', () => {
    expect(matchCell('Pending', 'pend')).toBe(true);
    expect(matchCell('paid', 'pend')).toBe(false);
    expect(matchCell(null, 'a')).toBe(false);
    expect(matchCell('x', '  ')).toBe(true);
  });
  it('compares numbers as numbers', () => {
    expect(matchCell(30, '>5')).toBe(true);
    expect(matchCell(30, '>= 30')).toBe(true);
    expect(matchCell(5, '>30')).toBe(false);
    expect(matchCell(120, '<30')).toBe(false); // not the text comparison "120" < "30"
    expect(matchCell(30, '10..50')).toBe(true);
    expect(matchCell(120, '10..50')).toBe(false);
  });
  it('compares text and dates, and handles equality and null', () => {
    expect(matchCell('2025-03-01', '>2025-01')).toBe(true);
    expect(matchCell('paid', '=PAID')).toBe(true);
    expect(matchCell('paid', '!=paid')).toBe(false);
    expect(matchCell('paid', '!refunded')).toBe(true);
    expect(matchCell(null, 'null')).toBe(true);
    expect(matchCell(3, '!null')).toBe(true);
    expect(matchCell(null, '>3')).toBe(false);
  });
});

describe('applyView', () => {
  it('returns the rows untouched with nothing set', () => {
    expect(applyView(rows, EMPTY_VIEW)).toBe(rows);
  });
  it('searches every column and combines with column filters', () => {
    expect(applyView(rows, { ...EMPTY_VIEW, search: 'paid' }).map((r) => r[0])).toEqual(['Ada', 'Cy']);
    expect(applyView(rows, { search: 'paid', filters: { 1: '>10' }, sort: null }).map((r) => r[0])).toEqual(['Ada']);
  });
  it('sorts both ways with nulls last, and leaves the input alone', () => {
    const before = rows.map((r) => r[0]);
    expect(applyView(rows, { ...EMPTY_VIEW, sort: { column: 1, dir: 'asc' } }).map((r) => r[1])).toEqual([5, 30, 120, null]);
    expect(applyView(rows, { ...EMPTY_VIEW, sort: { column: 1, dir: 'desc' } }).map((r) => r[1])).toEqual([120, 30, 5, null]);
    expect(applyView(rows, { ...EMPTY_VIEW, sort: { column: 0, dir: 'asc' } }).map((r) => r[0])).toEqual(['Ada', 'bob', 'Cy', 'Dee']);
    expect(rows.map((r) => r[0])).toEqual(before);
  });
});

describe('summaries and kinds', () => {
  it('finds the kind of a column', () => {
    expect(kindOf(rows, 1)).toBe('number');
    expect(kindOf(rows, 2)).toBe('text');
    expect(kindOf([[1], ['a']], 0)).toBe('text');
  });
  it('totals a measure and counts distinct values otherwise', () => {
    expect(summarize(rows, 1, true)).toEqual({ kind: 'number', sum: 155, avg: 155 / 3, min: 5, max: 120 });
    expect(summarize(rows, 2, false)).toEqual({ kind: 'distinct', distinct: 3, nulls: 0 });
    expect(summarize(rows, 3, false)).toEqual({ kind: 'distinct', distinct: 3, nulls: 1 });
  });
});

describe('export', () => {
  it('quotes CSV and defuses formulas, but keeps negative numbers', () => {
    const csv = toDelimited(['name', 'note', 'n'], [['a,b', 'say "hi"', -4], ['=SUM(A1)', null, 2], ['-5', 'x\ny', 1]]);
    expect(csv).toBe(['name,note,n', '"a,b","say ""hi""",-4', "'=SUM(A1),,2", '-5,"x\ny",1'].join('\r\n'));
  });
  it('writes tab-separated text for pasting', () => {
    expect(toDelimited(['a', 'b'], [['x,y', 1]], '\t')).toBe('a\tb\r\nx,y\t1');
  });
  it('keeps both of two columns with the same name', () => {
    expect(toObjects(['name', 'name', 'n'], [['Ada', 'Acme', 1]])).toEqual([{ name: 'Ada', name_2: 'Acme', n: 1 }]);
  });
});
