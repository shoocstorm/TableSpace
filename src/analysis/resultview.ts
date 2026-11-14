// PURE: what the result dialog does to a result set — search, per-column
// filters, sorting, column summaries and export. Nothing here touches the DOM.

import type { Value } from './seed';

export type Sort = { column: number; dir: 'asc' | 'desc' } | null;
export type View = { search: string; /** Filter text by column index. */ filters: Record<number, string>; sort: Sort };
export type Kind = 'number' | 'boolean' | 'text';

export const EMPTY_VIEW: View = { search: '', filters: {}, sort: null };

/** What a column holds, from its values; a column of mixed or no values is text. */
export function kindOf(rows: Value[][], column: number): Kind {
  let kind: Kind | null = null;
  for (const r of rows) {
    const v = r[column];
    if (v === null || v === undefined) continue;
    const k: Kind = typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'text';
    if (kind && kind !== k) return 'text';
    kind = k;
  }
  return kind ?? 'text';
}

/** Keys and years are numbers that are never added up or written with thousands separators. */
export const isIdLike = (name: string) => /(^|_)(id|number|year|code|zip|postal_code)$/i.test(name);

function cmp(a: Exclude<Value, null>, b: Exclude<Value, null>): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

const NUM = /^-?\d+(?:\.\d+)?$/;

/**
 * One cell against one column filter. Plain text means "contains". Also:
 * `=x` `!=x` `>x` `>=x` `<x` `<=x`, a range `10..50`, and `null` / `!null`.
 * Comparisons are numeric when both sides are numbers, otherwise by text
 * (which orders ISO dates correctly).
 */
export function matchCell(v: Value, raw: string): boolean {
  const f = raw.trim();
  if (!f) return true;
  const low = f.toLowerCase();
  if (low === 'null') return v === null;
  if (low === '!null') return v !== null;

  const range = /^(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)$/.exec(f);
  if (range) {
    if (v === null || typeof v === 'boolean' || !NUM.test(String(v))) return false;
    return Number(v) >= Number(range[1]) && Number(v) <= Number(range[2]);
  }

  const m = /^(>=|<=|!=|<>|>|<|=|!)\s*(.+)$/.exec(f);
  if (m) {
    const op = m[1] === '<>' || m[1] === '!' ? '!=' : m[1];
    const want = m[2].trim();
    if (v === null) return false; // as in SQL, a comparison with null matches nothing
    const numeric = NUM.test(want) && NUM.test(String(v));
    const d = numeric ? Number(v) - Number(want) : String(v).toLowerCase().localeCompare(want.toLowerCase(), 'en', { numeric: true });
    return op === '=' ? d === 0 : op === '!=' ? d !== 0 : op === '>' ? d > 0 : op === '>=' ? d >= 0 : op === '<' ? d < 0 : d <= 0;
  }
  return v !== null && String(v).toLowerCase().includes(low);
}

/** The rows that pass the search and every column filter, in the chosen order. Nulls sort last either way. */
export function applyView(rows: Value[][], view: View): Value[][] {
  const q = view.search.trim().toLowerCase();
  const filters = Object.entries(view.filters)
    .filter(([, f]) => f.trim())
    .map(([i, f]) => [Number(i), f] as const);
  let out = q || filters.length ? rows.filter((r) => filters.every(([i, f]) => matchCell(r[i] ?? null, f)) && (!q || r.some((v) => v !== null && String(v).toLowerCase().includes(q)))) : rows;
  if (view.sort) {
    const { column, dir } = view.sort;
    const sign = dir === 'asc' ? 1 : -1;
    out = [...out].sort((a, b) => {
      const x = a[column] ?? null;
      const y = b[column] ?? null;
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return cmp(x, y) * sign;
    });
  }
  return out;
}

export type Summary = { kind: 'number'; sum: number; avg: number; min: number; max: number } | { kind: 'distinct'; distinct: number; nulls: number };

/** A measure column is totalled; any other column says how many different values it holds. */
export function summarize(rows: Value[][], column: number, measure: boolean): Summary {
  if (measure) {
    const nums = rows.map((r) => r[column]).filter((v): v is number => typeof v === 'number');
    if (nums.length) {
      const sum = nums.reduce((a, b) => a + b, 0);
      return { kind: 'number', sum, avg: sum / nums.length, min: Math.min(...nums), max: Math.max(...nums) };
    }
  }
  const seen = new Set<Value>();
  let nulls = 0;
  for (const r of rows) {
    const v = r[column] ?? null;
    if (v === null) nulls++;
    else seen.add(v);
  }
  return { kind: 'distinct', distinct: seen.size, nulls };
}

/**
 * CSV (or, with a tab, what a spreadsheet accepts on paste). Quoted per
 * RFC 4180. Text starting with a formula character gets a leading apostrophe,
 * so a spreadsheet shows it instead of running it.
 */
export function toDelimited(columns: string[], rows: Value[][], sep: ',' | '\t' = ','): string {
  const cell = (v: Value | string): string => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !NUM.test(s)) s = `'${s}`;
    return s.includes(sep) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns, ...rows].map((r) => r.map(cell).join(sep)).join('\r\n');
}

/** One object per row. Two columns with the same name (name, name) become name and name_2. */
export function toObjects(columns: string[], rows: Value[][]): Record<string, Value>[] {
  const used = new Map<string, number>();
  const keys = columns.map((c) => {
    const n = (used.get(c) ?? 0) + 1;
    used.set(c, n);
    return n === 1 ? c : `${c}_${n}`;
  });
  return rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? null])));
}
