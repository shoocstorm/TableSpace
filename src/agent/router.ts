// PURE: scripted mode. With no model loaded, requests are matched to tools
// by keywords, so the whole app can be tried before any download. This is
// pattern matching, not understanding, and the UI says so.

import { looksLikeSql } from '../analysis/sql';
import { mentionedColumnNames, mentionedKind } from '../schema/insight';
import type { SchemaDef } from '../schema/types';
import { mentionedDomain, mentionedTables, mentionedTablesInOrder, toolByName, type ToolCall } from './tools';

const has = (text: string, re: RegExp) => re.test(text);

export function route(schema: SchemaDef, text: string): ToolCall | null {
  const t = text.toLowerCase();
  if (looksLikeSql(text)) return { tool: 'trace_query', args: { preset: schema.presets[0]?.id } };
  const named = mentionedTables(schema, text);
  // the indexes that exist, as against the ones that are missing (the audit) or imagined (the what-if)
  if (has(t, /\b(list|show|which|what|describe|inspect|redundant|duplicate|existing)\b.*\bindex(es)?\b|\bindex(es)?\b.*\b(redundant|duplicated?|unused|exist)\b/) && !has(t, /\b(missing|lack(s|ing)?|what if|without)\b/)) return { tool: 'inspect_indexes', args: { tables: named.slice(0, 8) } };
  if (has(t, /\b(what if|add|create|try|put)\b.*\bindex(es|ed)?\b|\bindex(ed)?\b.*\b(on|were|was)\b/)) return { tool: 'what_if_index', args: { columns: [] } };
  if (has(t, /\b(audit|index(es)?|what('s| is) wrong|anything wrong|anti.?patterns?|orphan(ed)?|god tables?|health|radar|problems?|smells?|issues? with|unused|nobody uses|not used)\b/)) {
    const rule = has(t, /orphan|unused|nobody uses|not used/) ? 'orphaned_table' : has(t, /god/) ? 'god_table' : has(t, /index/) ? 'missing_fk_index' : 'all';
    return { tool: 'audit_schema', args: { rule } };
  }
  if (has(t, /\b(normali[sz]e|split|refactor|bloat(ed)?|ghosts?|decompose|clean up)\b/)) {
    return { tool: 'propose_refactor', args: { table: mentionedTables(schema, text)[0] ?? 'auto', strategy: has(t, /lookup|enum/) ? 'extract_lookup' : 'auto' } };
  }
  if (has(t, /\b(seed|mock|synthetic|populate|fake data|(test|sample|dummy|demo) (data|rows|records)|generate (data|rows|records)|insert (data|rows|records))\b/)) {
    return { tool: 'seed_data', args: { scope: mentionedDomain(schema, text) ?? 'all', size: has(t, /\b(lots|large|many|big)\b/) ? 'large' : has(t, /\bmedium\b/) ? 'medium' : 'small' } };
  }
  // questions about the schema itself, answered by reading it
  const counting = has(t, /\b(how many|count|number of|sum|average|avg|top \d+|per|for each)\b/);
  if (has(t, /\b(which|what|find|any|all|every|where)\b.*\b(tables?|columns?|fields?)\b/) && !named.length && (mentionedColumnNames(schema, text).length || mentionedKind(text) !== 'any')) {
    return { tool: 'find_columns', args: { columns: mentionedColumnNames(schema, text).slice(0, 3), kind: mentionedKind(text) } };
  }
  const aboutQuery = has(t, /\b(trace|simulate|execution|plan|query|slow)\b/);
  if (named.length && !aboutQuery && has(t, /\b(relat(e|es|ed|ion|ions|ionship|ionships)|join(s|ed|ing)?|path (between|from)|depend(s|ents?|ing)? on|referenc(e|es|ed|ing)|connect(s|ed)?|linked|parents?|child(ren)?)\b/)) {
    return { tool: 'relate_tables', args: { tables: named.slice(0, 4), depth: '2' } };
  }
  if (named.length && !counting && has(t, /\b(describe|columns?|fields?|structure|definition|primary key|foreign keys?|data types?|types?)\b/)) return { tool: 'describe_tables', args: { tables: named.slice(0, 6) } };
  if (!has(t, /\btop \d+\b/) && (!named.length || mentionedDomain(schema, text)) && has(t, /\b(overview|summar(y|ize|ise)|statistics|stats|how (big|large)|how many tables|(biggest|largest|widest|most connected) tables?|shape of)\b/)) {
    return { tool: 'schema_overview', args: { domain: mentionedDomain(schema, text) ?? 'all' } };
  }
  // a question about the data: asked for as SQL outright, or a listing/counting verb with a table named
  const tracing = has(t, /\b(trace|simulate|explain|execution|plan|slow)\b/);
  const asksForSql = has(t, /\b(write|generate|give me|build|compose|need)\b.*\b(sql|query)\b|\b(sql|query) (to|for|that|which)\b/);
  const asksAboutRows = has(t, /\b(how many|count|number of|list|find|get|fetch|top \d+|\d+ (latest|newest|most)|average|avg|total|sum|latest|newest|per|for each)\b/);
  if (!tracing && (asksForSql || (asksAboutRows && mentionedTables(schema, text).length))) return { tool: 'write_sql', args: { tables: mentionedTablesInOrder(schema, text).slice(0, 4) } };
  if (has(t, /\b(trace|simulate|explain|execution|plan|joins?|query|slow)\b/) || schema.presets.some((p) => t.includes(p.id.replace(/_/g, ' ')))) {
    // the preset sharing the most words with the request
    const score = (p: { id: string; label: string }) => `${p.id} ${p.label}`.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3 && t.includes(w)).length;
    const best = [...schema.presets].sort((a, b) => score(b) - score(a))[0];
    return best ? { tool: 'trace_query', args: { preset: best.id } } : null;
  }
  if (has(t, /\b(reset|zoom out|show (all|everything)|whole (schema|database)|clear (all|everything|view))\b/)) return { tool: 'reset_view', args: {} };
  const tables = mentionedTables(schema, text);
  const domain = mentionedDomain(schema, text);
  if (tables.length || domain) return { tool: 'focus_tables', args: { domain: tables.length ? 'none' : domain, tables, hops: '1' } };
  return null;
}

/**
 * What else a request plainly asks for, part by part: "describe orders and check its indexes" is two requests.
 * Each part after a comma, "and", "then" or "also" is matched on its own (with the tables the whole request
 * names, when the part names none), and only tools that read and report are kept. No model is involved, so a
 * compound request is worked through the same way every time, in scripted mode too.
 */
export function alsoAsked(schema: SchemaDef, text: string): ToolCall[] {
  if (looksLikeSql(text)) return [];
  const parts = text.split(/[,;]|\b(?:and then|and also|and|then|also|plus)\b/i).map((p) => p.trim()).filter((p) => p.length > 3);
  if (parts.length < 2) return [];
  const named = mentionedTables(schema, text);
  const out: ToolCall[] = [];
  for (const part of parts) {
    const call = route(schema, mentionedTables(schema, part).length ? part : `${part} ${named.join(' ')}`);
    // "explain how payments connects to users" is not a query to trace: a part reaches the trace only when it is about one
    if (call?.tool === 'trace_query' && !/\b(slow|trace|simulate|query|plan|execution)\b/i.test(part) && !schema.presets.some((p) => part.toLowerCase().includes(p.id.replace(/_/g, ' ')))) continue;
    if (call && toolByName(call.tool)?.reads && !out.some((c) => c.tool === call.tool)) out.push(call);
  }
  return out;
}

export const SCRIPTED_HELP =
  "I'm in **scripted mode** (no model loaded), so I match keywords rather than understand. Try: *audit the schema*, *describe orders*, *how do I join order items to users?*, *trace the checkout query*, *normalize orders*, *count orders per user*, *seed mock data*, *show payments* — or paste a `SELECT … JOIN …` query. Load a model from the top bar for free-form questions.";
