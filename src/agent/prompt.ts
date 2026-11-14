// PURE: every prompt the agent sends. Small models do better with short,
// literal instructions and a compact picture of the database.

import { edgesOf, isJunction } from '../schema/graph';
import type { SchemaDef } from '../schema/types';
import type { ChatMessage } from '../llm/engine';
import type { Tool } from './tools';

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

export function pickToolMessages(schema: SchemaDef, tools: Tool[], userText: string): ChatMessage[] {
  const system = [
    `You route requests in TableSpace, a 3D viewer of the SQL database "${schema.name}".`,
    'Reply with exactly one name from this list and nothing else:',
    ...tools.map((t) => `- ${t.name}: ${t.description}`),
    `- ${ANSWER}: a general question about databases that names no table and asks for no action.`,
    '',
    'Examples:',
    'how do two tables relate? -> focus_tables',
    'list, count or total some rows; write a query -> write_sql',
    'are any tables unused, or missing indexes? -> audit_schema',
    'why is a query or page slow? -> trace_query',
    'this table is too wide -> propose_refactor',
    'what if this column had an index? -> what_if_index',
    'add some test data -> seed_data',
    'what is a foreign key? -> answer',
    '',
    'Tables by domain:',
    schemaDigest(schema, 'names'),
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: userText.slice(0, 1200) },
  ];
}

export function fillArgsMessages(schema: SchemaDef, tool: Tool, userText: string): ChatMessage[] {
  const props = Object.entries(tool.schema(schema).properties).map(([k, p]) => `- ${k}: ${p.description ?? ''}`);
  const presets = tool.name === 'trace_query' ? `\nNamed queries:\n${schema.presets.map((p) => `- ${p.id}: ${p.label}`).join('\n')}` : '';
  const system = [`Write the arguments for the tool "${tool.name}" as one JSON object, from the user's request.`, `The tool: ${tool.description}`, 'Arguments:', ...props, '', 'Tables by domain:', schemaDigest(schema, 'names') + presets].join('\n');
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

export function answerMessages(schema: SchemaDef, history: ChatMessage[], userText: string): ChatMessage[] {
  return [
    { role: 'system', content: `${PERSONA}\nAnswer in at most 5 sentences.\n\nThe database "${schema.name}" (${schema.engine}): ${schema.description}\n${schemaDigest(schema)}` },
    ...history.slice(-4),
    { role: 'user', content: userText.slice(0, 1500) },
  ];
}

/** Drops `<think>` blocks, closed or still open, from streamed text. */
export const stripThink = (text: string): string => text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/^\s+/, '');
