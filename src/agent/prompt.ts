// PURE: every prompt the agent sends. Small models do better with short,
// literal instructions and a compact picture of the database.

import { edgesOf, isJunction } from '../schema/graph';
import type { SchemaDef } from '../schema/types';
import type { ChatMessage } from '../llm/engine';
import type { DecisionOption } from '../llm/decide';
import type { Tool, ToolName } from './tools';

/** A tool that ran earlier in the turn, and the facts it reported. */
export type Observation = { tool: ToolName; args: Record<string, unknown>; ok: boolean; facts: string };

/** The database in a few hundred tokens: tables by domain, and what references what. */
export function schemaDigest(schema: SchemaDef, detail: 'names' | 'relations' = 'relations'): string {
  const lines = schema.domains.map((d) => `${d.label}: ${schema.tables.filter((t) => t.domain === d.id).map((t) => t.name).join(', ')}`);
  if (detail === 'names') return lines.join('\n');
  const edges = edgesOf(schema);
  const refs = edges.map((e) => `${e.from}.${e.column}→${e.to}`);
  // stated outright: a small model does not work these out from the key list
  const junctions = schema.tables.filter(isJunction).map((t) => t.name);
  const orphans = schema.tables.filter((t) => !edges.some((e) => e.from === t.name || e.to === t.name)).map((t) => t.name);
  return [
    ...lines,
    `Foreign keys: ${refs.join(', ')}`,
    `Junction (many-to-many) tables: ${junctions.join(', ') || 'none'}`,
    `Tables with no relationships: ${orphans.join(', ') || 'none'}`,
  ].join('\n');
}

export const ANSWER = 'answer';

/** Which kind of request goes to which tool: small models route better from examples than from descriptions alone. */
const ROUTES = [
  'where is a table? show a domain -> focus_tables',
  'what columns, keys or types does a table have? -> describe_tables',
  'how do two tables relate or join? what depends on a table? -> relate_tables',
  'which indexes exist on a table? -> inspect_indexes',
  'how big is the schema? which tables are largest? -> schema_overview',
  'which tables have a certain column? -> find_columns',
  'list, count or total some rows; write a query -> write_sql',
  'are any tables unused, or missing indexes? -> audit_schema',
  'why is a query or page slow? -> trace_query',
  'this table is too wide -> propose_refactor',
  'what if this column had an index? -> what_if_index',
  'add some test data -> seed_data',
  'what is a foreign key? -> answer',
];

export function pickToolMessages(schema: SchemaDef, tools: Tool[], userText: string): ChatMessage[] {
  const system = [
    `You route requests in TableSpace, a 3D viewer of the SQL database "${schema.name}".`,
    'Reply with exactly one name from this list and nothing else:',
    ...tools.map((t) => `- ${t.name}: ${t.description}`),
    `- ${ANSWER}: a general question about databases that names no table and asks for no action.`,
    '',
    'Examples:',
    ...ROUTES,
    '',
    'Tables by domain:',
    schemaDigest(schema, 'names'),
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: userText.slice(0, 1200) },
  ];
}

// ── one-token decisions (llm/decide.ts): a state, a question, lettered options ──

/** What earlier steps of the turn found, shortened so several fit in the prompt. */
export function observed(done: Observation[], budget = 1800): string {
  const each = Math.max(240, Math.floor(budget / Math.max(1, done.length)));
  return done.map((o, i) => `${i + 1}. ${o.tool} ${JSON.stringify(o.args)}${o.ok ? '' : ' (found nothing)'}:\n${o.facts.length > each ? `${o.facts.slice(0, each)}…` : o.facts}`).join('\n');
}

/** The situation a decision is made from: the database, the request, then what the turn's tools have found so far. */
export function decisionState(schema: SchemaDef, userText: string, done: Observation[] = []): string {
  return [
    `TableSpace, a 3D viewer of the SQL database "${schema.name}".`,
    'Tables by domain:',
    schemaDigest(schema, 'names'),
    '',
    `User request: ${userText.slice(0, 1200)}`,
    ...(done.length ? ['', 'Tools already run for this request, and what they found:', observed(done)] : []),
  ].join('\n');
}

/** EVAL VARIANT L: the router prompt with lettered options, the request last, so the long unchanging part is reused between turns. */
export function letteredRouterMessages(schema: SchemaDef, options: DecisionOption[], userText: string): ChatMessage[] {
  const L = 'ABCDEFGHIJKLMNOP';
  const letterOf = (id: string) => L[options.findIndex((o) => o.id === id)];
  const system = [
    `You route requests in TableSpace, a 3D viewer of the SQL database "${schema.name}".`,
    'Reply with exactly one option letter and nothing else:',
    ...options.map((o, i) => `${L[i]}. ${o.text}`),
    '',
    'Examples:',
    ...ROUTES.map((r) => `${r.slice(0, r.lastIndexOf('-> '))}-> ${letterOf(r.slice(r.lastIndexOf('-> ') + 3))}`),
    '',
    'Tables by domain:',
    schemaDigest(schema, 'names'),
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: userText.slice(0, 1200) },
  ];
}

export const FIRST_QUESTION = `Which option handles the user request? Typical requests:\n${ROUTES.join('\n')}`;
export const NEXT_QUESTION = 'Read the user request and what the tools already run have found. Does the request ask for something those results do not contain?';

/** The options of a turn's first decision: answering in words is always A, then every tool in the registry's order. */
export function firstOptions(tools: Tool[]): DecisionOption[] {
  return [{ id: ANSWER, text: 'answer: a general question about databases that names no table and asks for no action.' }, ...tools.map((t) => ({ id: t.name, text: `${t.name}: ${t.description}` }))];
}

/** The options of a later decision: stopping is always A, then the tools worth running after the last one. */
export function nextOptions(tools: Tool[]): DecisionOption[] {
  return [{ id: ANSWER, text: 'No: the results cover everything the request asks for.' }, ...tools.map((t) => ({ id: t.name, text: `Yes, it also needs ${t.name}: ${t.description}` }))];
}

/** The same later decision for a model that spells the name out under a grammar (when the one-token readout is off or failed). */
export function nextToolMessages(schema: SchemaDef, tools: Tool[], userText: string, done: Observation[]): ChatMessage[] {
  const system = [
    `You work through requests in TableSpace, a 3D viewer of the SQL database "${schema.name}".`,
    NEXT_QUESTION,
    'Reply with exactly one name from this list and nothing else:',
    `- ${ANSWER}: what was found already covers the request.`,
    ...tools.map((t) => `- ${t.name}: ${t.description}`),
    '',
    'Tools already run, and what they found:',
    observed(done),
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: userText.slice(0, 1200) },
  ];
}

export function fillArgsMessages(schema: SchemaDef, tool: Tool, userText: string, done: Observation[] = []): ChatMessage[] {
  const props = Object.entries(tool.schema(schema).properties).map(([k, p]) => `- ${k}: ${p.description ?? ''}`);
  const presets = tool.name === 'trace_query' ? `\nNamed queries:\n${schema.presets.map((p) => `- ${p.id}: ${p.label}`).join('\n')}` : '';
  // a later step may be about tables an earlier one turned up, not ones the request names
  const found = done.length ? `\n\nFound so far in this turn:\n${observed(done, 900)}` : '';
  const system = [`Write the arguments for the tool "${tool.name}" as one JSON object, from the user's request.`, `The tool: ${tool.description}`, 'Arguments:', ...props, '', 'Tables by domain:', schemaDigest(schema, 'names') + presets + found].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: userText.slice(0, 1200) },
  ];
}

const PERSONA = 'You are the data architect inside TableSpace, a 3D viewer of a SQL database. Be concrete and brief. Use table and column names exactly as given. Never invent tables, columns or numbers.';

export function narrateMessages(schema: SchemaDef, userText: string, tool: Tool, facts: string): ChatMessage[] {
  return [
    { role: 'system', content: `${PERSONA}\nA tool has just run and its result is already shown in the 3D view. Explain the result to the user in 2 to 4 sentences, using only the facts below. Say what matters most and what to do about it. Do not write SQL; it is shown separately.` },
    { role: 'user', content: `Database: ${schema.name}\nRequest: ${userText.slice(0, 600)}\n\nResult of ${tool.name}:\n${facts.slice(0, 2400)}` },
  ];
}

/** The explanation after several tools ran: one answer from all their facts. */
export function synthesisMessages(schema: SchemaDef, userText: string, done: Observation[]): ChatMessage[] {
  return [
    { role: 'system', content: `${PERSONA}\nSeveral tools have just run and their results are already shown to the user. Answer the request in 3 to 6 sentences, using only the facts below. Start with the direct answer, then what matters most across the results and what to do about it. Do not write SQL; it is shown separately.` },
    { role: 'user', content: `Database: ${schema.name}\nRequest: ${userText.slice(0, 600)}\n\n${done.map((o) => `Result of ${o.tool}:\n${o.facts.slice(0, Math.floor(3600 / done.length))}`).join('\n\n')}` },
  ];
}

export function answerMessages(schema: SchemaDef, history: ChatMessage[], userText: string): ChatMessage[] {
  return [
    { role: 'system', content: `${PERSONA}\nAnswer in at most 5 sentences.\n\nThe database "${schema.name}" (${schema.engine}): ${schema.description}\n${schemaDigest(schema)}` },
    ...history.slice(-4),
    { role: 'user', content: userText.slice(0, 1500) },
  ];
}

/** Drops `<think>` blocks, closed or still open, from streamed text. */
export const stripThink = (text: string): string => text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/^\s+/, '');
