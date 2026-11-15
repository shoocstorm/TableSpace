// PURE: the one-click prompts offered for a database. Each names its tool
// outright, so a chip (or its number key) never depends on a guess.

import { edgesOf } from '../schema/graph';
import type { SchemaDef } from '../schema/types';
import type { ToolCall } from './tools';

export type Chip = { label: string; call: ToolCall };

/** A count worth asking for in any schema: the rows of the largest child table, per row of its parent. */
function sqlChip(schema: SchemaDef): Chip | null {
  const rows = (name: string) => schema.tables.find((t) => t.name === name)?.rows ?? 0;
  const edge = edgesOf(schema)
    .filter((e) => e.cardinality === '1:N' && e.from !== e.to)
    .sort((a, b) => rows(b.from) - rows(a.from))[0];
  if (!edge) return null;
  const one = edge.to.replace(/ies$/, 'y').replace(/s$/, '').replace(/_/g, ' ');
  return { label: `Write SQL: count ${edge.from.replace(/_/g, ' ')} per ${one}`, call: { tool: 'write_sql', args: { tables: [edge.from, edge.to] }, useText: true } };
}

export function chipsFor(schema: SchemaDef): Chip[] {
  const preset = schema.presets[0];
  const domain = schema.domains[Math.min(3, schema.domains.length - 1)];
  const sql = sqlChip(schema);
  return [
    { label: 'Audit missing indexes', call: { tool: 'audit_schema', args: { rule: 'missing_fk_index' } } },
    ...(preset ? [{ label: `Simulate ${preset.id.replace(/_/g, ' ')} join`, call: { tool: 'trace_query' as const, args: { preset: preset.id } } }] : []),
    ...(sql ? [sql] : []),
    { label: 'Normalize bloated tables', call: { tool: 'propose_refactor', args: { table: 'auto', strategy: 'auto' } } },
    { label: 'Full anti-pattern radar', call: { tool: 'audit_schema', args: { rule: 'all' } } },
    { label: `Show the ${domain.label.toLowerCase()} domain`, call: { tool: 'focus_tables', args: { domain: domain.id, tables: [], hops: '0' } } },
    { label: 'Seed mock data', call: { tool: 'seed_data', args: { scope: 'all', size: 'small' } } },
  ];
}
