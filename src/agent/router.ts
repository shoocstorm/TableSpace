// PURE: scripted mode. With no model loaded, requests are matched to tools
// by keywords, so the whole app can be tried before any download. This is
// pattern matching, not understanding, and the UI says so.

import { looksLikeSql } from '../analysis/sql';
import type { SchemaDef } from '../schema/types';
import { mentionedDomain, mentionedTables, mentionedTablesInOrder, type ToolCall } from './tools';

const has = (text: string, re: RegExp) => re.test(text);

export function route(schema: SchemaDef, text: string): ToolCall | null {
  const t = text.toLowerCase();
  if (looksLikeSql(text)) return { tool: 'trace_query', args: { preset: schema.presets[0]?.id } };
  if (has(t, /\b(audit|index(es)?|anti.?patterns?|orphan(ed)?|god tables?|health|radar|problems?|smells?|issues? with|unused|nobody uses|not used)\b/)) {
    const rule = has(t, /orphan|unused|nobody uses|not used/) ? 'orphaned_table' : has(t, /god/) ? 'god_table' : has(t, /index/) ? 'missing_fk_index' : 'all';
    return { tool: 'audit_schema', args: { rule } };
  }
  if (has(t, /\b(normali[sz]e|split|refactor|bloat(ed)?|ghosts?|decompose|clean up)\b/)) {
    return { tool: 'propose_refactor', args: { table: mentionedTables(schema, text)[0] ?? 'auto', strategy: has(t, /lookup|enum/) ? 'extract_lookup' : 'auto' } };
  }
  if (has(t, /\b(seed|mock|synthetic|populate|fake data|(test|sample|dummy|demo) (data|rows|records)|generate (data|rows|records)|insert (data|rows|records))\b/)) {
    return { tool: 'seed_data', args: { scope: mentionedDomain(schema, text) ?? 'all', size: has(t, /\b(lots|large|many|big)\b/) ? 'large' : has(t, /\bmedium\b/) ? 'medium' : 'small' } };
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
  if (has(t, /\b(reset|zoom out|overview|show (all|everything)|whole (schema|database)|clear (all|everything|view))\b/)) return { tool: 'reset_view', args: {} };
  const tables = mentionedTables(schema, text);
  const domain = mentionedDomain(schema, text);
  if (tables.length || domain) return { tool: 'focus_tables', args: { domain: tables.length ? 'none' : domain, tables, hops: '1' } };
  return null;
}

export const SCRIPTED_HELP =
  "I'm in **scripted mode** (no model loaded), so I match keywords rather than understand. Try: *audit the schema*, *trace the checkout query*, *normalize orders*, *count orders per user*, *seed mock data*, *show payments* — or paste a `SELECT … JOIN …` query. Load a model from the top bar for free-form questions.";
