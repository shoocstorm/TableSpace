// PURE: a small reader for SELECT … FROM … JOIN … ON … WHERE. It finds the
// tables, the order they are joined in and the columns they are joined and
// filtered on: what the plan simulation and the 3D trace need. It is not a
// SQL parser: subqueries, CTEs and set operations are not understood.

export type TableRef = { table: string; alias: string };
export type JoinStep = TableRef & {
  kind: string;
  /** Equalities from the ON clause: `left` and `right` as alias.column. */
  on: { left: ColumnRef; right: ColumnRef }[];
};
export type ColumnRef = { alias: string; column: string };
export type Filter = ColumnRef & { op: string };

export type ParsedQuery = {
  from: TableRef;
  joins: JoinStep[];
  filters: Filter[];
};

export type ParseResult = { ok: true; query: ParsedQuery } | { ok: false; error: string };

const KEYWORDS = new Set(['select', 'from', 'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'on', 'where', 'and', 'or', 'group', 'order', 'having', 'limit', 'offset', 'as', 'by', 'union', 'using']);

type Token = { text: string; lower: string };

function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  // strings, quoted identifiers, numbers, words (with dots), operators, punctuation
  const re = /'(?:[^']|'')*'|"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*(?:\.[A-Za-z_*][\w$]*)*|\d+(?:\.\d+)?|<>|!=|<=|>=|[=<>(),;*]/g;
  const clean = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const m of clean.matchAll(re)) {
    const text = m[0].replace(/^["`]|["`]$/g, '');
    out.push({ text, lower: text.toLowerCase() });
  }
  return out;
}

const END_OF_FROM = new Set(['where', 'group', 'order', 'having', 'limit', 'offset', 'union', ';']);
const JOIN_WORDS = new Set(['join', 'inner', 'left', 'right', 'full', 'cross', 'outer']);

function columnRef(text: string): ColumnRef | null {
  // a string or number literal is a value, even when it has a dot in it ('ada@example.com', 9.5)
  if (!/^[A-Za-z_]/.test(text)) return null;
  const parts = text.split('.');
  if (parts.length === 2) return { alias: parts[0].toLowerCase(), column: parts[1].toLowerCase() };
  if (parts.length === 3) return { alias: parts[1].toLowerCase(), column: parts[2].toLowerCase() };
  if (parts.length === 1 && /^[A-Za-z_]/.test(text) && !KEYWORDS.has(text.toLowerCase())) return { alias: '', column: text.toLowerCase() };
  return null;
}

export function looksLikeSql(text: string): boolean {
  return /\bselect\b[\s\S]+\bfrom\b/i.test(text);
}

/** The SQL inside a message: a fenced block if there is one, else from SELECT to the end. */
export function extractSql(text: string): string | null {
  const fenced = /```(?:sql)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  if (fenced && looksLikeSql(fenced)) return fenced.trim();
  const at = text.search(/\bselect\b/i);
  return at >= 0 && looksLikeSql(text.slice(at)) ? text.slice(at).trim() : null;
}

export function parseQuery(sql: string): ParseResult {
  const t = tokenize(sql);
  let i = t.findIndex((x) => x.lower === 'from');
  if (t[0]?.lower !== 'select' || i < 0) return { ok: false, error: 'Only SELECT … FROM … queries can be traced.' };
  if (t.filter((x) => x.lower === 'select').length > 1) return { ok: false, error: 'Subqueries and CTEs are not supported by the trace.' };
  i++;

  const readRef = (): TableRef | null => {
    const name = t[i];
    if (!name || KEYWORDS.has(name.lower) || !/^[A-Za-z_]/.test(name.text)) return null;
    i++;
    const table = name.lower.split('.').pop()!;
    if (t[i]?.lower === 'as') i++;
    const next = t[i];
    if (next && /^[A-Za-z_]/.test(next.text) && !KEYWORDS.has(next.lower) && !next.text.includes('.')) {
      i++;
      return { table, alias: next.lower };
    }
    return { table, alias: table };
  };

  const from = readRef();
  if (!from) return { ok: false, error: 'No table after FROM.' };
  const joins: JoinStep[] = [];

  while (i < t.length && !END_OF_FROM.has(t[i].lower)) {
    if (t[i].text === ',') {
      // old-style comma join: the join condition, if any, is in WHERE
      i++;
      const ref = readRef();
      if (!ref) return { ok: false, error: 'No table after the comma in FROM.' };
      joins.push({ ...ref, kind: 'cross', on: [] });
      continue;
    }
    if (!JOIN_WORDS.has(t[i].lower)) return { ok: false, error: `Unexpected "${t[i].text}" in the FROM clause.` };
    const kindWords: string[] = [];
    while (t[i] && JOIN_WORDS.has(t[i].lower) && t[i].lower !== 'join') kindWords.push(t[i++].lower);
    if (t[i]?.lower !== 'join') return { ok: false, error: 'Expected JOIN.' };
    i++;
    const ref = readRef();
    if (!ref) return { ok: false, error: 'No table after JOIN.' };
    const step: JoinStep = { ...ref, kind: kindWords.filter((w) => w !== 'outer')[0] ?? 'inner', on: [] };
    if (t[i]?.lower === 'on') {
      i++;
      while (i < t.length && !END_OF_FROM.has(t[i].lower) && !JOIN_WORDS.has(t[i].lower) && t[i].text !== ',') {
        const left = columnRef(t[i].text);
        const right = t[i + 2] ? columnRef(t[i + 2].text) : null;
        if (left && right && t[i + 1]?.text === '=') {
          step.on.push({ left, right });
          i += 3;
        } else i++;
      }
    }
    joins.push(step);
  }

  const filters: Filter[] = [];
  if (t[i]?.lower === 'where') {
    i++;
    const stop = new Set(['group', 'order', 'having', 'limit', 'offset', 'union', ';']);
    while (i < t.length && !stop.has(t[i].lower)) {
      const left = columnRef(t[i].text);
      const op = t[i + 1];
      if (left && op && /^(=|<>|!=|<=|>=|<|>|like|ilike|in|between|is)$/i.test(op.text)) {
        const right = t[i + 2] ? columnRef(t[i + 2].text) : null;
        // alias.col = alias.col in WHERE is a join condition (comma joins)
        const joinLike = op.text === '=' && right && right.alias && left.alias && right.alias !== left.alias;
        if (joinLike) {
          const step = joins.find((j) => j.alias === left.alias || j.alias === right!.alias);
          step?.on.push({ left, right: right! });
          i += 3;
          continue;
        }
        filters.push({ ...left, op: op.lower });
        i += 2;
      } else i++;
    }
  }
  return { ok: true, query: { from, joins, filters } };
}
