// The agent's tools. Each one does its work deterministically (the analysis
// modules) and shows the result in the 3D scene; the model only chooses the
// tool and its arguments, then explains what came back. Tools are registered
// here, in code, and nowhere else.

import { audit, AUDIT_RULES, RULE_LABEL, type AuditRule, type Finding } from '../analysis/audit';
import { bloatedTables, proposeRefactor, STRATEGIES, type GhostTable, type Strategy } from '../analysis/normalize';
import { simulatePlan, type PlanStep } from '../analysis/plan';
import { AGGREGATES, compileQuery, explainSpec, gateSpec, inferSpec, mentionedColumns, mergeSpecs, OPS, repairSpec, valueCandidates, type Aggregate, type Check, type Op, type QuerySpec } from '../analysis/querybuilder';
import { executeSpec, type ResultSet } from '../analysis/execute';
import { SEED_SIZES, type SeedSize } from '../analysis/seed';
import { extractSql, parseQuery } from '../analysis/sql';
import { formatRows, neighbours, tablesOfDomain } from '../schema/graph';
import { cardsText, COLUMN_KINDS, columnNames, describeTables, findColumns, indexReport, joinPath, mentionedColumnNames, mentionedKind, pathTables, relateTables, schemaOverview, unindexedFks, type Card, type ColumnKind } from '../schema/insight';
import type { SchemaDef } from '../schema/types';
import { ghostPositions } from '../scene/Ghosts';
import { addWhatIf, clearBadges, clearGhosts, clearWhatIf, focusTables, mockData, positionsOf, resetView, seedTables, showFindings, showGhosts, startTrace, useScene, type WhatIf } from '../state/scene';
import type { ObjectSchema } from './grammar';

export type ToolName = 'focus_tables' | 'describe_tables' | 'relate_tables' | 'inspect_indexes' | 'schema_overview' | 'find_columns' | 'write_sql' | 'what_if_index' | 'trace_query' | 'propose_refactor' | 'audit_schema' | 'seed_data' | 'reset_view';
export type ToolCall = { tool: ToolName; args: Record<string, unknown>; /** A prompt chip whose own text is the request (the tool reads it). */ useText?: boolean };

/** Structured results the chat drawer renders under the answer. */
export type Block =
  | { kind: 'findings'; findings: Finding[] }
  | { kind: 'plan'; label: string; sql: string; steps: PlanStep[] }
  | { kind: 'ghosts'; table: string; ghosts: GhostTable[]; before: number; after: number }
  | { kind: 'sql'; title: string; sql: string }
  | { kind: 'checks'; understood: string; checks: Check[] }
  | { kind: 'result'; result: ResultSet; sql?: string }
  | { kind: 'whatif'; added: WhatIf[]; before: PlanStep[] | null; after: PlanStep[] | null; resolved: number; sql: string }
  | { kind: 'seed'; order: string[]; counts: Record<string, number>; total: number }
  | { kind: 'tables'; label: string; tables: string[] }
  | { kind: 'info'; title: string; cards: Card[] };

export type ToolResult = {
  ok: boolean;
  /** What happened, as plain facts: all the model is given to explain. */
  facts: string;
  /** The answer shown when no model is loaded (scripted mode). */
  text: string;
  blocks: Block[];
  /** What would be worth doing next, offered as one-click follow-ups. */
  next?: Suggestion[];
};

export type Suggestion = { label: string; call: ToolCall };

const tryIndex = (table: string, column: string): Suggestion => ({ label: `What if ${table}.${column} were indexed?`, call: { tool: 'what_if_index', args: { columns: [`${table}.${column}`] } } });
/** Up to two slow steps of a plan that an index would fix. */
const indexIdeas = (steps: PlanStep[]): Suggestion[] => steps.filter((s) => s.slow && s.via).slice(0, 2).map((s) => tryIndex(s.table, s.via!));

/**
 * How far a tool reaches. None of them can change a database: there is no connection to one.
 * - view: moves the camera and the highlight, nothing else.
 * - analyze: reads the schema and works something out; what it shows is a report.
 * - preview: adds something pretend to the scene (ghost tables, a what-if index, mock rows), kept in memory until dismissed.
 */
export type ToolEffect = 'view' | 'analyze' | 'preview';

export type Tool = {
  name: ToolName;
  effect: ToolEffect;
  /** What running it leaves in the scene, and how to take that away again. Shown to the user. */
  leaves: string;
  /** Requests that reach this tool, as a user would type them. {t} is a table, {p} its parent, {fk} the column joining them, {d} a domain, {q} a named query. */
  examples: string[];
  /** One line for the model's tool list. */
  description: string;
  /** Shown on the chip while the tool runs. */
  label: string;
  schema: (schema: SchemaDef) => ObjectSchema;
  /**
   * The tools worth running after this one in the same turn, for the model to choose from (agent/run.ts).
   * Only tools that read and report are listed: anything that adds to the scene stays the user's click.
   * None listed: the turn ends with this tool, and no decision is spent asking.
   */
  then?: ToolName[];
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
};

export type ToolContext = {
  schema: SchemaDef;
  userText: string;
  /** A later step of a turn: report, but leave the camera and the highlight where the first step put them. */
  quiet?: boolean;
  /**
   * Asks the loaded model for one more JSON object held to `spec` (a second, narrower question a tool
   * can only pose once it knows which tables are involved). Absent in scripted mode; null when the model's answer didn't validate.
   */
  fill?: (spec: ObjectSchema, instructions: string) => Promise<Record<string, unknown> | null>;
};

const names = (schema: SchemaDef) => schema.tables.map((t) => t.name);

/** Table names written in the text, longest first so `order_items` isn't read as `orders`. */
export function mentionedTables(schema: SchemaDef, text: string): string[] {
  let rest = ` ${text.toLowerCase().replace(/[^a-z0-9_]+/g, ' ')} `;
  const out: string[] = [];
  for (const n of [...names(schema)].sort((a, b) => b.length - a.length)) {
    const spaced = n.replace(/_/g, ' ');
    for (const form of [n, spaced, n.replace(/s$/, ''), spaced.replace(/s$/, '')]) {
      if (form.length > 2 && rest.includes(` ${form} `)) {
        out.push(n);
        rest = rest.replaceAll(` ${form} `, '  ');
        break;
      }
    }
  }
  return names(schema).filter((n) => out.includes(n));
}

/** The same tables in the order the text names them: the first one drives a generated query. */
export function mentionedTablesInOrder(schema: SchemaDef, text: string): string[] {
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9_]+/g, ' ')} `;
  const at = (n: string) => Math.min(...[n, n.replace(/_/g, ' '), n.replace(/s$/, ''), n.replace(/_/g, ' ').replace(/s$/, '')].map((f) => lower.indexOf(` ${f}`)).filter((i) => i >= 0), 1e9);
  return mentionedTables(schema, text).sort((a, b) => at(a) - at(b));
}

export function mentionedDomain(schema: SchemaDef, text: string): string | null {
  const lower = text.toLowerCase();
  return schema.domains.find((d) => new RegExp(`\\b${d.id}s?\\b|\\b${d.label.toLowerCase()}\\b`).test(lower))?.id ?? null;
}

/** The tables a lookup is about: the ones the request names, then the ones the model added, in schema order. */
function pickTables(schema: SchemaDef, userText: string, fromModel: unknown, max: number): string[] {
  const said = mentionedTables(schema, userText);
  const more = (Array.isArray(fromModel) ? (fromModel as string[]) : []).filter((t) => names(schema).includes(t) && !said.includes(t));
  return [...said, ...more].slice(0, max);
}

const list = (items: string[], max = 6) => (items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', '));

export const TOOLS: Tool[] = [
  {
    name: 'focus_tables',
    effect: 'view',
    leaves: "Lights the tables it found, dims the rest and flies the camera there. Take it away with the Focus pill above the dock, or Reset.",
    examples: ["show {t}", "where is {p}?", "show the {d} domain"],
    label: 'Flying to tables',
    description: 'Show, find or locate tables or a whole domain in the 3D view: flies the camera there, highlights them and dims the rest.',
    schema: (s) => ({
      type: 'object',
      properties: {
        domain: { type: 'string', enum: ['none', ...s.domains.map((d) => d.id)], description: 'a whole domain, or none' },
        tables: { type: 'array', items: { type: 'string', enum: names(s) }, maxItems: 5, description: 'specific tables' },
        hops: { type: 'string', enum: ['0', '1', '2'], description: 'how many relationships out to include' },
      },
      required: ['domain', 'tables', 'hops'],
    }),
    run: (args, { schema, userText }) => {
      // what the user wrote wins over what the model guessed: names in the request are certain
      const said = mentionedTables(schema, userText);
      const saidDomain = mentionedDomain(schema, userText);
      const domain = said.length ? null : (saidDomain ?? (args.domain !== 'none' ? (args.domain as string) : null));
      const picked = said.length ? said : ((args.tables as string[] | undefined) ?? []);
      const hops = Number(args.hops ?? 1);
      const label = domain && !picked.length ? schema.domains.find((d) => d.id === domain)!.label : picked.join(', ');
      const tables = domain && !picked.length ? tablesOfDomain(schema, domain) : neighbours(schema, picked, said.length > 1 ? 0 : hops);
      if (!tables.length) return { ok: false, facts: 'No matching table or domain was found.', text: "I couldn't tell which tables you mean. Name a table or a domain, or press ⌘K to search.", blocks: [] };
      focusTables(tables, label);
      const edges = useScene.getState().edges.filter((e) => tables.includes(e.from) && tables.includes(e.to));
      const rel = edges.slice(0, 8).map((e) => `${e.from}.${e.column} → ${e.to}.${e.refColumn} (${e.cardinality})`);
      const sizes = tables.map((t) => `${t} (${formatRows(schema.tables.find((x) => x.name === t)!.rows)} rows)`);
      return {
        ok: true,
        facts: `Highlighted ${tables.length} tables${domain && !picked.length ? ` of the ${label} domain` : ''}: ${sizes.join(', ')}.\nRelationships among them: ${rel.length ? rel.join('; ') : 'none'}.`,
        text: `Here ${tables.length === 1 ? 'is' : 'are'} **${label}**${tables.length > 1 ? ` — ${tables.length} tables` : ''}. Everything else is dimmed; ${edges.length} relationship${edges.length === 1 ? '' : 's'} connect${edges.length === 1 ? 's' : ''} them.`,
        blocks: [{ kind: 'tables', label, tables }],
      };
    },
  },
  {
    name: 'describe_tables',
    effect: 'analyze',
    leaves: "Reports each table's columns, keys, relationships and indexes, and lights those tables. Changes nothing else. Take the highlight away with the Focus pill, or Reset.",
    examples: ["describe {t}", "what columns do {t} and {p} have?", "what is the primary key of {p}?"],
    label: 'Reading the tables',
    description: 'Describe tables in full, several at once: columns with types, primary key, nullable and unique columns, foreign keys in and out, indexes.',
    schema: (s) => ({ type: 'object', properties: { tables: { type: 'array', items: { type: 'string', enum: names(s) }, maxItems: 6, description: 'the tables to describe, all in one call' } }, required: ['tables'] }),
    then: ['relate_tables', 'inspect_indexes', 'audit_schema'],
    run: (args, { schema, userText, quiet }) => {
      const tables = pickTables(schema, userText, args.tables, 6);
      if (!tables.length) return { ok: false, facts: 'No table was named, so nothing was described.', text: 'Tell me which tables to describe, for example *describe orders and payments*.', blocks: [] };
      // several tables share what the model can read: wide ones list fewer columns each
      const cards = describeTables(schema, tables, tables.length > 3 ? 14 : tables.length > 1 ? 24 : 40);
      if (!quiet) focusTables(tables, tables.join(', '));
      const t0 = schema.tables.find((t) => t.name === tables[0])!;
      return {
        ok: true,
        facts: `Table details (read from the schema):\n${cardsText(cards)}`,
        text: tables.length === 1 ? `**${t0.name}** has ${t0.columns.length} columns, ${t0.fks.length} foreign key${t0.fks.length === 1 ? '' : 's'} and ${t0.indexes.length} index${t0.indexes.length === 1 ? '' : 'es'} besides its primary key. The details are below.` : `Here are **${tables.length} tables** in full: ${list(tables)}. Columns, keys, relationships and indexes are below.`,
        blocks: [{ kind: 'info', title: 'Table details', cards: describeTables(schema, tables) }],
        next: tables.some((t) => unindexedFks(schema.tables.find((x) => x.name === t)!).length) ? [{ label: `Inspect the indexes of ${list(tables, 2)}`, call: { tool: 'inspect_indexes', args: { tables } } }] : [],
      };
    },
  },
  {
    name: 'relate_tables',
    effect: 'analyze',
    leaves: "Reports how tables join (the exact columns, through other tables if need be) and what depends on them, and lights the tables on the path. Changes nothing else. Take the highlight away with the Focus pill, or Reset.",
    examples: ["how do {t} and {p} relate?", "how do I join {t} to {p}?", "what depends on {p}?"],
    label: 'Following the relationships',
    description: 'Relate tables: the join path between two or more tables with the exact join columns, each table’s parents and children, and what depends on it.',
    schema: (s) => ({
      type: 'object',
      properties: {
        tables: { type: 'array', items: { type: 'string', enum: names(s) }, maxItems: 4, description: 'the tables to relate: two or more for a join path, one for its parents and children' },
        depth: { type: 'string', enum: ['1', '2', '3'], description: 'how many relationships out to follow dependants' },
      },
      required: ['tables', 'depth'],
    }),
    then: ['describe_tables', 'inspect_indexes'],
    run: (args, { schema, userText, quiet }) => {
      const tables = pickTables(schema, userText, args.tables, 4);
      if (!tables.length) return { ok: false, facts: 'No table was named, so no relationship was followed.', text: 'Tell me which tables to relate, for example *how do I join order_items to users?*', blocks: [] };
      const cards = relateTables(schema, tables, Number(args.depth ?? 2));
      // light every table a join path passes through, not only its two ends
      const onPaths = new Set(tables);
      for (let i = 0; i < tables.length; i++) for (let j = i + 1; j < tables.length; j++) for (const t of pathTables(tables[i], joinPath(schema, tables[i], tables[j]) ?? [])) onPaths.add(t);
      const lit = tables.length > 1 ? names(schema).filter((n) => onPaths.has(n)) : neighbours(schema, tables, 1);
      if (!quiet) focusTables(lit, `Relationships · ${list(tables, 3)}`);
      const first = tables.length > 1 ? joinPath(schema, tables[0], tables[1]) : null;
      return {
        ok: true,
        facts: `Relationships (read from the foreign keys):\n${cardsText(cards)}`,
        text:
          tables.length > 1
            ? first
              ? `**${tables[0]}** reaches **${tables[1]}** in ${first.length} join${first.length === 1 ? '' : 's'}${first.length > 1 ? `, through ${pathTables(tables[0], first).slice(1, -1).join(', ')}` : ''}. The join columns are below.`
              : `No foreign keys connect **${tables[0]}** and **${tables[1]}**, directly or through other tables.`
            : `Here is what **${tables[0]}** references and what references it.`,
        blocks: [{ kind: 'info', title: 'Relationships', cards }],
      };
    },
  },
  {
    name: 'inspect_indexes',
    effect: 'analyze',
    leaves: "Reports the indexes of the tables named (or of the whole schema): what each covers, foreign keys with none, and redundant ones. Lights the tables it reports on. Changes nothing else.",
    examples: ["which indexes does {t} have?", "list the indexes on {t} and {p}", "are any indexes redundant?"],
    label: 'Reading the indexes',
    description: 'Inspect or list the indexes that exist on several tables at once (or all tables): the columns each covers, foreign keys with and without an index, redundant indexes.',
    schema: (s) => ({ type: 'object', properties: { tables: { type: 'array', items: { type: 'string', enum: names(s) }, maxItems: 8, description: 'the tables to inspect; leave empty for the whole schema' } }, required: ['tables'] }),
    then: ['describe_tables', 'audit_schema'],
    run: (args, { schema, userText, quiet }) => {
      const tables = pickTables(schema, userText, args.tables, 8);
      const cards = indexReport(schema, tables);
      const reported = cards.flatMap((c) => c.table ?? []);
      if (!quiet && reported.length) focusTables(reported, `Indexes · ${tables.length ? list(tables, 3) : 'tables to fix'}`);
      const bare = (tables.length ? tables : names(schema)).flatMap((t) => unindexedFks(schema.tables.find((x) => x.name === t)!).map((c) => `${t}.${c}`));
      return {
        ok: true,
        facts: `Index report for ${tables.length ? list(tables) : 'the whole schema (only tables with something to fix are listed)'}:\n${cardsText(cards)}`,
        text: `${tables.length ? `Indexes of **${list(tables)}**` : 'Indexes across **the whole schema**'}: ${cards[0].head}.`,
        blocks: [{ kind: 'info', title: 'Indexes', cards }],
        next: bare.length ? [{ label: bare.length === 1 ? `What if ${bare[0]} were indexed?` : `What if these ${Math.min(bare.length, 4)} foreign keys were indexed?`, call: { tool: 'what_if_index', args: { columns: bare.slice(0, 4) } } }] : [],
      };
    },
  },
  {
    name: 'schema_overview',
    effect: 'analyze',
    leaves: "Reports the size and shape of the schema or of one domain: counts, the largest, widest and most connected tables, junction and unrelated tables. Changes nothing in the scene unless a domain is named, which it lights.",
    examples: ["give me an overview of the schema", "which tables are the biggest?", "summarize the {d} domain"],
    label: 'Sizing up the schema',
    description: 'Overview, summary or statistics of the whole schema or one domain: how many tables, columns, keys, indexes and rows; the largest, widest and most connected tables.',
    schema: (s) => ({ type: 'object', properties: { domain: { type: 'string', enum: ['all', ...s.domains.map((d) => d.id)], description: 'one domain, or all' } }, required: ['domain'] }),
    then: ['audit_schema', 'inspect_indexes', 'describe_tables'],
    run: (args, { schema, userText, quiet }) => {
      const domain = mentionedDomain(schema, userText) ?? (args.domain && args.domain !== 'all' ? (args.domain as string) : null);
      const cards = schemaOverview(schema, domain);
      if (domain && !quiet) focusTables(tablesOfDomain(schema, domain), schema.domains.find((d) => d.id === domain)!.label);
      return { ok: true, facts: `Overview (counted from the schema; row counts are its statistics):\n${cardsText(cards)}`, text: `${cards[0].head}.`, blocks: [{ kind: 'info', title: 'Overview', cards }] };
    },
  },
  {
    name: 'find_columns',
    effect: 'analyze',
    leaves: "Reports every table holding a column of the given name or kind, and lights those tables. Changes nothing else. Take the highlight away with the Focus pill, or Reset.",
    examples: ["which tables have a {fk} column?", "find every timestamp column", "where are the nullable foreign keys?"],
    label: 'Searching the columns',
    description: 'Find columns across all tables by name or by kind (time, number, text, json, boolean, uuid, nullable, unique, foreign key): which tables hold them.',
    schema: (s) => ({
      type: 'object',
      properties: {
        columns: { type: 'array', items: { type: 'string', enum: columnNames(s).length ? columnNames(s) : ['none'] }, maxItems: 3, description: 'column names to look for; leave empty to search by kind only' },
        kind: { type: 'string', enum: [...COLUMN_KINDS], description: 'a kind of column, or any' },
      },
      required: ['columns', 'kind'],
    }),
    then: ['describe_tables', 'relate_tables'],
    run: (args, { schema, userText, quiet }) => {
      // names and kinds written in the request are certain; then the model's
      const said = mentionedColumnNames(schema, userText);
      const wanted = said.length ? said.slice(0, 3) : ((args.columns as string[] | undefined) ?? []).filter((c) => c !== 'none');
      const saidKind = mentionedKind(userText);
      const kind = saidKind !== 'any' ? saidKind : ((args.kind as ColumnKind | undefined) ?? 'any');
      if (!wanted.length && kind === 'any') return { ok: false, facts: 'No column name or kind was given, so nothing was searched.', text: 'Tell me a column name or a kind, for example *which tables have an email column?* or *find every timestamp column*.', blocks: [] };
      const found = findColumns(schema, wanted, kind);
      if (!found.count) return { ok: false, facts: `${found.cards[0].head}.`, text: `No column matches: ${found.cards[0].head.split('match: ')[1]}.`, blocks: [] };
      if (!quiet) focusTables(found.tables, `Columns · ${[kind !== 'any' ? kind.replace('_', ' ') : '', ...wanted].filter(Boolean).join(', ')}`);
      return { ok: true, facts: `Column search:\n${cardsText(found.cards)}`, text: `${found.cards[0].head}. The tables holding them are lit.`, blocks: [{ kind: 'info', title: 'Columns found', cards: found.cards }] };
    },
  },
  {
    name: 'write_sql',
    effect: 'analyze',
    leaves: "Shows a SELECT built by code from a checked description, runs it on invented rows in this browser, and traces its plan across the tables. Take the trace away with its pill, or Reset.",
    examples: ["count {t} per {p}", "list the 10 latest {t}", "write a query for {t} with their {p}"],
    label: 'Writing SQL',
    description: 'Write, generate or give the SQL for a question about the data: list, find, count, total, average, top or latest rows, with filters. Shows the query, what was checked, and traces it.',
    schema: (s) => ({ type: 'object', properties: { tables: { type: 'array', items: { type: 'string', enum: names(s) }, maxItems: 4, description: 'the tables the question is about, the main one first' } }, required: ['tables'] }),
    run: async (args, { schema, userText, fill }) => {
      // tables named in the request are certain; the model's are used when it named none
      const said = mentionedTablesInOrder(schema, userText);
      const tables = said.length ? said : ((args.tables as string[] | undefined) ?? []);
      const read = inferSpec(schema, userText, tables);
      if (!read) return { ok: false, facts: 'No table was named, so no SQL was written.', text: "Tell me which table the query is about — for example *count orders per user* or *list cancelled orders with total over 10000*.", blocks: [] };

      // What the text plainly states is kept. The model may add columns, filters and an ordering,
      // but only ones the request's own words support (gateSpec): it proposes, the text decides.
      let spec = read;
      if (fill) {
        const asked = await fill(querySpecSchema(schema, tables, userText), querySpecInstructions(schema, tables)).catch(() => null);
        const merged = asked && repairSpec(schema, mergeSpecs(read, gateSpec(schema, userText, fromModel(tables, asked))));
        if (merged && compileQuery(schema, merged).ok) {
          spec = merged;
        }
      }
      spec = repairSpec(schema, spec);
      const out = compileQuery(schema, spec);
      if (!out.ok) return { ok: false, facts: `No SQL was written: ${out.error}`, text: `I couldn't write that query. ${out.error}`, blocks: [] };

      // the finished text goes back through the SQL reader and the plan simulation: a second, independent look
      const understood = explainSpec(schema, spec);
      const checks: Check[] = [...out.checks];
      const blocks: Block[] = [{ kind: 'sql', title: 'Generated SQL · PostgreSQL', sql: out.sql }];
      const parsed = parseQuery(out.sql);
      const planned = parsed.ok ? simulatePlan(schema, parsed.query) : null;
      let planFacts = '';
      let resultFacts = '';
      let next: Suggestion[] = [];
      if (planned?.ok) {
        const { steps } = planned.plan;
        checks.push({ ok: true, text: `Read back and planned: ${steps.length} step${steps.length === 1 ? '' : 's'}, the same tables in the same order.` });
        for (const s of steps.filter((x) => x.slow)) checks.push({ ok: false, text: `${s.table} would be read in full (${formatRows(s.rowsRead)} rows): ${s.note}.` });
        startTrace({ label: 'generated query', sql: out.sql, steps });
        blocks.push({ kind: 'checks', understood, checks });
        const ran = executeSpec(schema, spec, mockData());
        if (ran.ok) {
          blocks.push({ kind: 'result', result: ran.result, sql: out.sql });
          resultFacts = `\nRun on mock data: ${ran.result.total} row${ran.result.total === 1 ? '' : 's'}${ran.result.rows[0] ? `; first row: ${ran.result.columns.map((c, i) => `${c}=${ran.result.rows[0][i]}`).join(', ')}` : ''}. These are invented rows, not real data.`;
        }
        blocks.push({ kind: 'plan', label: 'generated query', sql: out.sql, steps });
        next = indexIdeas(steps);
        planFacts = `\nSimulated plan: ${steps.map((s) => `${s.table} (${s.scan === 'index' ? 'index scan' : s.slow ? 'slow sequential scan' : 'sequential scan'})`).join(' → ')}.`;
      } else {
        checks.push({ ok: false, text: 'The query could not be read back for a plan, so it was not traced.' });
        focusTables(out.tables, 'Generated query');
        blocks.push({ kind: 'checks', understood, checks });
      }
      const cautions = checks.filter((c) => !c.ok);
      return {
        ok: true,
        facts: `SQL was generated and is shown to the user. In words: ${understood}\nTables: ${out.tables.join(', ')}. ${out.joins.length ? `Joined on foreign keys (${out.joins.length} join${out.joins.length === 1 ? '' : 's'}).` : 'No joins.'}${planFacts}${resultFacts}${cautions.length ? `\nThings to check: ${cautions.map((c) => c.text).join(' ')}` : ''}`,
        text: `Here is the query. **${understood}** It uses ${out.tables.length === 1 ? `\`${out.tables[0]}\`` : `${out.tables.length} tables joined on their foreign keys`}.${cautions.length ? ` ${cautions.length === 1 ? 'One thing' : `${cautions.length} things`} to check below.` : ''}`,
        blocks,
        next,
      };
    },
  },
  {
    name: 'what_if_index',
    effect: 'preview',
    leaves: "Adds a pretend index to the schema held in memory, then re-runs the audit and the traced plan with it. Take it away with the what-if pill above the dock.",
    examples: ["what if {t}.{fk} were indexed?", "try an index on every foreign key that lacks one"],
    label: 'Trying an index',
    description: 'Add, create or try an index on a column (what if it were indexed?): re-plans the traced query and re-runs the audit with the index in place, without changing the database.',
    schema: (s) => ({ type: 'object', properties: { columns: { type: 'array', items: { type: 'string', enum: s.tables.flatMap((t) => t.columns.filter((c) => !c.pk).map((c) => `${t.name}.${c.name}`)) }, maxItems: 4, description: 'the columns to index, as table.column' } }, required: ['columns'] }),
    run: (args, { schema, userText }) => {
      // columns written in the request are certain; then the model's; then every foreign key the audit says lacks one
      const saidTables = mentionedTables(schema, userText);
      const said = saidTables.length ? mentionedColumns(schema, saidTables, userText) : [];
      const missing = () => audit(schema, ['missing_fk_index']).map((f) => `${f.table}.${f.column}`);
      const refs = said.length ? said : ((args.columns as string[] | undefined)?.length ? (args.columns as string[]) : saidTables.length ? missing().filter((r) => saidTables.includes(r.split('.')[0])) : missing());
      const before = useScene.getState().trace?.steps ?? null;
      const findingsBefore = useScene.getState().findings.length;
      const added = addWhatIf(refs.map((r) => ({ table: r.slice(0, r.indexOf('.')), column: r.slice(r.indexOf('.') + 1) })));
      if (!added.length) {
        return { ok: false, facts: refs.length ? `${refs.join(', ')} already ${refs.length === 1 ? 'has' : 'have'} an index, so nothing changed.` : 'No column to index was named, and no foreign key is missing an index.', text: refs.length ? `${refs.map((r) => `\`${r}\``).join(', ')} ${refs.length === 1 ? 'is' : 'are'} already indexed, so there is nothing to try.` : 'Tell me which column to index, for example *what if payments.order_id were indexed?*', blocks: [] };
      }
      const s = useScene.getState();
      const after = s.trace?.steps ?? null;
      const resolved = Math.max(0, findingsBefore - s.findings.length);
      if (!s.trace) focusTables([...new Set(added.map((a) => a.table))], 'What-if index');
      const sum = (steps: PlanStep[]) => steps.reduce((n, x) => n + x.rowsRead, 0);
      const planFact = before && after ? ` The traced query now reads about ${formatRows(sum(after))} rows instead of ${formatRows(sum(before))}; slow scans went from ${before.filter((x) => x.slow).length} to ${after.filter((x) => x.slow).length}.` : '';
      const sql = added.map((a) => `CREATE INDEX CONCURRENTLY ${a.table}_${a.column}_idx ON ${a.table} (${a.column});`).join('\n');
      return {
        ok: true,
        facts: `What-if: ${added.length} index${added.length === 1 ? '' : 'es'} tried out on ${added.map((a) => `${a.table}.${a.column}`).join(', ')}. Nothing in the database changed.${planFact}${resolved ? ` ${resolved} audit finding${resolved === 1 ? '' : 's'} would be resolved.` : ''} An index also costs disk space and slows writes to the table a little.`,
        text: `Trying ${added.length === 1 ? 'an index' : `${added.length} indexes`} on ${added.map((a) => `\`${a.table}.${a.column}\``).join(', ')} — a what-if, nothing in the database changed.${planFact}${resolved ? ` ${resolved} audit finding${resolved === 1 ? '' : 's'} would be resolved.` : ''}`,
        blocks: [{ kind: 'whatif', added, before, after, resolved, sql }],
        next: [{ label: 'Run the full audit', call: { tool: 'audit_schema', args: { rule: 'all' } } }],
      };
    },
  },
  {
    name: 'trace_query',
    effect: 'analyze',
    leaves: "Animates the query's join order along the relationship lines and marks slow scans red. The plan is simulated from row counts and indexes; no query is sent anywhere. Take it away with the trace pill, or Reset.",
    examples: ["trace the {q} query", "why is this slow?  + a pasted SELECT … JOIN …"],
    label: 'Tracing the query',
    description: 'Simulate, trace, explain or run a SQL query or a named flow (like checkout): animates its join order across the tables and marks slow scans red.',
    schema: (s) => ({ type: 'object', properties: { preset: { type: 'string', enum: s.presets.length ? s.presets.map((p) => p.id) : ['none'], description: 'the named query closest to the request' } }, required: ['preset'] }),
    then: ['inspect_indexes', 'describe_tables'],
    run: (args, { schema, userText }) => {
      const typed = extractSql(userText);
      const preset = schema.presets.find((p) => p.id === args.preset) ?? schema.presets[0];
      if (!typed && !preset) return { ok: false, facts: 'There is no query to trace: none was given and this schema has no named queries.', text: 'Paste a `SELECT … JOIN …` query and I will trace it. This schema has no relationships to build one from.', blocks: [] };
      const sql = typed ?? preset.sql;
      const label = typed ? 'your query' : preset.label;
      const parsed = parseQuery(sql);
      if (!parsed.ok) return { ok: false, facts: `The query could not be traced: ${parsed.error}`, text: `I couldn't trace that query. ${parsed.error}`, blocks: [{ kind: 'sql', title: 'Query', sql }] };
      const planned = simulatePlan(schema, parsed.query);
      if (!planned.ok) return { ok: false, facts: `The query could not be traced: ${planned.error}`, text: `I couldn't trace that query. ${planned.error}`, blocks: [{ kind: 'sql', title: 'Query', sql }] };
      const { steps, slowSteps } = planned.plan;
      startTrace({ label, sql, steps });
      const slow = steps.filter((s) => s.slow);
      const lines = steps.map((s, i) => `${i + 1}. ${s.table}: ${s.scan === 'index' ? 'index scan' : 'SEQUENTIAL scan'} — ${s.note}, about ${formatRows(s.rowsRead)} rows read`);
      const fixes = slow.filter((s) => s.via).map((s) => `CREATE INDEX ${s.table}_${s.via}_idx ON ${s.table} (${s.via});`);
      return {
        ok: true,
        facts: `Simulated plan for ${label} (${steps.length} tables, joined in this order):\n${lines.join('\n')}\nSlow sequential scans: ${slowSteps}.${fixes.length ? `\nAn index would fix each: ${fixes.join(' ')}` : ''}`,
        text: slow.length
          ? `Tracing **${label}** across ${steps.length} tables. ${slow.length === 1 ? 'One step turns' : `${slow.length} steps turn`} red: ${slow.map((s) => `**${s.table}** is read in full (${formatRows(s.rowsRead)} rows) because ${s.via ? `\`${s.via}\` has no index` : 'nothing filters it'}`).join('; ')}.`
          : `Tracing **${label}** across ${steps.length} tables. Every step uses an index — no slow scans.`,
        blocks: [{ kind: 'plan', label, sql, steps }, ...(fixes.length ? [{ kind: 'sql' as const, title: 'Suggested fix', sql: fixes.join('\n') }] : [])],
        next: indexIdeas(steps),
      };
    },
  },
  {
    name: 'propose_refactor',
    effect: 'preview',
    leaves: "Floats the proposed tables as ghosts beside the original and writes migration SQL for you to copy. Nothing is applied. Take the ghosts away with the Ghosts button on the dock.",
    examples: ["normalize {t}", "split the bloated tables", "extract lookup tables from {p}"],
    label: 'Drafting ghost tables',
    description: 'Normalize, split, refactor or clean up a bloated table: previews the new tables as ghosts beside it and writes the migration SQL.',
    schema: (s) => ({
      type: 'object',
      properties: { table: { type: 'string', enum: ['auto', ...names(s)], description: 'the table to split, or auto for the most bloated' }, strategy: { type: 'string', enum: STRATEGIES } },
      required: ['table', 'strategy'],
    }),
    run: (args, { schema, userText }) => {
      const said = mentionedTables(schema, userText);
      const targets = said.length ? said.slice(0, 2) : args.table && args.table !== 'auto' ? [args.table as string] : bloatedTables(schema);
      const proposals = targets.map((t) => proposeRefactor(schema, t, (args.strategy as Strategy) ?? 'auto')).filter((p) => p && p.ghosts.length) as NonNullable<ReturnType<typeof proposeRefactor>>[];
      if (!proposals.length) {
        return { ok: false, facts: `No split was found for ${list(targets) || 'any table'}: no column groups or lookup columns stand out.`, text: `I found nothing worth splitting in ${list(targets) || 'this schema'}: no column groups or repeated lookup values stand out.`, blocks: [] };
      }
      clearGhosts();
      showGhosts(proposals.flatMap((p) => p.ghosts));
      const ghosts = proposals.flatMap((p) => p.ghosts);
      // the camera frames the live tables and their ghosts together
      focusTables(proposals.map((p) => p.table), `Refactor · ${proposals.map((p) => p.table).join(', ')}`, [...ghostPositions(ghosts, positionsOf(useScene.getState())).values()]);
      const facts = proposals.map((p) => `${p.table} (${p.columnsBefore} columns) → ${p.ghosts.map((g) => `${g.name} [${g.moved.length} columns moved: ${g.reason}]`).join('; ')}. ${p.table} would keep ${p.columnsAfter} columns.`);
      return {
        ok: true,
        facts: `Proposed refactoring, shown as ghost tables (a preview; nothing was changed):\n${facts.join('\n')}`,
        text: proposals.map((p) => `**${p.table}** has ${p.columnsBefore} columns. I'd split out ${p.ghosts.map((g) => `**${g.name}**`).join(', ')}, leaving ${p.columnsAfter}. The ghost tables floating above it are a preview — nothing has changed.`).join('\n\n'),
        blocks: proposals.flatMap((p) => [{ kind: 'ghosts' as const, table: p.table, ghosts: p.ghosts, before: p.columnsBefore, after: p.columnsAfter }, { kind: 'sql' as const, title: `Migration · ${p.table}`, sql: p.sql }]),
      };
    },
  },
  {
    name: 'audit_schema',
    effect: 'analyze',
    leaves: "Pins a warning badge on each table with a finding and lists them. Take the badges away with the warnings pill above the dock.",
    examples: ["audit the schema", "any missing indexes?", "are any tables unused?"],
    label: 'Auditing the schema',
    description: 'Audit, check or review the schema for problems: missing foreign-key indexes, orphaned tables, God tables. Pins warning badges on the tables.',
    schema: () => ({ type: 'object', properties: { rule: { type: 'string', enum: ['all', ...AUDIT_RULES], description: 'one rule, or all' } }, required: ['rule'] }),
    then: ['inspect_indexes', 'describe_tables'],
    run: (args, { schema }) => {
      const rule = (args.rule as string) ?? 'all';
      const findings = audit(schema, rule === 'all' ? AUDIT_RULES : [rule as AuditRule]);
      showFindings(findings, rule === 'all' ? AUDIT_RULES : [rule as AuditRule]);
      if (!findings.length) {
        return { ok: true, facts: `The audit (${rule === 'all' ? 'all rules' : RULE_LABEL[rule as AuditRule]}) found no problems.`, text: 'The audit found nothing to flag.', blocks: [] };
      }
      const tables = [...new Set(findings.map((f) => f.table))];
      focusTables(tables, `Audit · ${findings.length} findings`);
      const byRule = AUDIT_RULES.map((r) => [r, findings.filter((f) => f.rule === r)] as const).filter(([, f]) => f.length);
      return {
        ok: true,
        facts: `Audit findings (${findings.length}):\n${findings.map((f) => `- [${f.severity}] ${RULE_LABEL[f.rule]}: ${f.detail}`).join('\n')}`,
        text: `I found **${findings.length} issue${findings.length === 1 ? '' : 's'}** on ${tables.length} table${tables.length === 1 ? '' : 's'}: ${byRule.map(([r, f]) => `${f.length} × ${RULE_LABEL[r].toLowerCase()}`).join(', ')}. Each affected table now carries a badge.`,
        blocks: [{ kind: 'findings', findings }, ...(findings.some((f) => f.fix) ? [{ kind: 'sql' as const, title: 'Suggested indexes', sql: findings.filter((f) => f.fix).map((f) => f.fix).join('\n') }] : [])],
        next: [
          ...(findings.some((f) => f.rule === 'missing_fk_index') ? [{ label: 'What if every missing index were added?', call: { tool: 'what_if_index' as const, args: { columns: findings.filter((f) => f.rule === 'missing_fk_index').map((f) => `${f.table}.${f.column}`) } } }] : []),
          ...findings.filter((f) => f.rule === 'god_table').slice(0, 1).map((f) => ({ label: `Normalize ${f.table}`, call: { tool: 'propose_refactor' as const, args: { table: f.table, strategy: 'auto' } } })),
        ],
      };
    },
  },
  {
    name: 'seed_data',
    effect: 'preview',
    leaves: "Fills the tables with invented rows, parents before children, held in memory; row counts in the scene go up. They are gone when you switch database or reload.",
    examples: ["seed mock data", "generate lots of test data for {t}"],
    label: 'Seeding mock data',
    description: 'Seed, generate, insert or populate realistic mock data, parents before children, and animate the tables filling up.',
    schema: (s) => ({ type: 'object', properties: { scope: { type: 'string', enum: ['all', ...s.domains.map((d) => d.id)], description: 'everything, or one domain' }, size: { type: 'string', enum: SEED_SIZES } }, required: ['scope', 'size'] }),
    run: async (args, { schema, userText }) => {
      const said = mentionedTables(schema, userText);
      const domain = mentionedDomain(schema, userText) ?? (args.scope && args.scope !== 'all' ? (args.scope as string) : null);
      const tables = said.length ? said : domain ? tablesOfDomain(schema, domain) : null;
      const result = await seedTables(tables, (args.size as SeedSize) ?? 'small');
      if (!result) return { ok: false, facts: 'Seeding was interrupted.', text: 'Seeding was interrupted.', blocks: [] };
      return {
        ok: true,
        facts: `Inserted ${result.total} mock rows into ${result.order.length} tables, parents before children, in this order: ${result.order.map((n) => `${n} (${result.counts[n]})`).join(' → ')}. Every foreign key points at an existing row. This is in-memory mock data.`,
        text: `Seeded **${result.total.toLocaleString('en-US')} rows** across ${result.order.length} tables, parents first (${list(result.order, 5)}), so every foreign key points at a row that exists. Select a table to see sample rows. This is mock data, kept in memory.`,
        blocks: [{ kind: 'seed', ...result }],
      };
    },
  },
  {
    name: 'reset_view',
    effect: 'view',
    leaves: "Shows the whole schema again and removes highlights, traces, badges, ghosts and what-if indexes.",
    examples: ["reset the view", "zoom out", "show everything"],
    label: 'Resetting the view',
    description: 'Reset, clear or zoom out: shows the whole database again and removes highlights, traces, badges and ghosts.',
    schema: () => ({ type: 'object', properties: {}, required: [] }),
    run: () => {
      clearBadges();
      clearGhosts();
      clearWhatIf();
      resetView();
      return { ok: true, facts: 'The view was reset: the whole schema is shown, with no highlights, traces, badges, ghost tables or what-if indexes.', text: 'Back to the full schema. Highlights, traces, badges, ghosts and what-if indexes are cleared.', blocks: [] };
    },
  },
];

// ── write_sql: the second question, asked once the tables are known ──

const LIMITS = ['none', '1', '5', '10', '20', '50', '100'];
const columnRefs = (schema: SchemaDef, tables: string[]) => tables.flatMap((t) => (schema.tables.find((x) => x.name === t)?.columns ?? []).map((c) => `${t}.${c.name}`));

/** The query as a flat JSON object whose every value is an enum: columns of the tables involved, operators, and literals taken from the request. */
export function querySpecSchema(schema: SchemaDef, tables: string[], userText: string): ObjectSchema {
  const cols = columnRefs(schema, tables);
  const values = ['none', ...valueCandidates(userText)];
  const col = (description: string) => ({ type: 'string' as const, enum: ['none', ...cols], description });
  return {
    type: 'object',
    properties: {
      select: { type: 'array', items: { type: 'string', enum: cols }, maxItems: 6, description: 'columns to return' },
      aggregate: { type: 'string', enum: AGGREGATES, description: 'none, or how rows are combined' },
      aggregate_column: col('the column to sum/avg/min/max; none for count'),
      group_by: { type: 'array', items: { type: 'string', enum: cols }, maxItems: 2, description: 'one result row per value of these' },
      filter1_column: col('a column to filter on, or none'),
      filter1_op: { type: 'string', enum: OPS },
      filter1_value: { type: 'string', enum: values, description: 'the value, copied from the request' },
      filter2_column: col('a second filter, or none'),
      filter2_op: { type: 'string', enum: OPS },
      filter2_value: { type: 'string', enum: values },
      order_by: { type: 'string', enum: ['none', 'aggregate', ...cols], description: 'a column, aggregate, or none' },
      direction: { type: 'string', enum: ['desc', 'asc'] },
      limit: { type: 'string', enum: LIMITS },
    },
    required: ['select', 'aggregate', 'aggregate_column', 'group_by', 'filter1_column', 'filter1_op', 'filter1_value', 'filter2_column', 'filter2_op', 'filter2_value', 'order_by', 'direction', 'limit'],
  };
}

export function querySpecInstructions(schema: SchemaDef, tables: string[]): string {
  const listing = tables.map((t) => `${t}: ${(schema.tables.find((x) => x.name === t)?.columns ?? []).map((c) => `${c.name} ${c.type}`).join(', ')}`);
  return [
    'Describe the SQL query the user wants as one JSON object. Do not write SQL.',
    'Use "none" for anything the request does not ask for. Filter values must be words or numbers copied from the request.',
    'Columns are written table.column.',
    '',
    'Tables and columns:',
    ...listing,
  ].join('\n');
}

const none = (v: unknown): string | null => (typeof v === 'string' && v !== 'none' ? v : null);

/** The model's flat answer as a QuerySpec. */
export function fromModel(tables: string[], a: Record<string, unknown>): QuerySpec {
  const filters = [1, 2].flatMap((n) => {
    const column = none(a[`filter${n}_column`]);
    const value = none(a[`filter${n}_value`]);
    return column && value ? [{ column, op: (a[`filter${n}_op`] as Op) ?? '=', value }] : [];
  });
  const order = none(a.order_by);
  return {
    tables,
    select: (a.select as string[] | undefined) ?? [],
    aggregate: (a.aggregate as Aggregate) ?? 'none',
    aggregateColumn: none(a.aggregate_column),
    groupBy: (a.group_by as string[] | undefined) ?? [],
    filters,
    orderBy: order,
    direction: a.direction === 'asc' ? 'asc' : 'desc',
    limit: none(a.limit) ? Number(a.limit) : null,
  };
}

export const toolByName = (name: string): Tool | undefined => TOOLS.find((t) => t.name === name);
