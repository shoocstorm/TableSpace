// PURE: the anti-pattern radar. Each rule reads the schema and reports
// findings against a table; the scene turns them into floating badges.

import { edgesOf, isIndexed, pkColumns } from '../schema/graph';
import type { SchemaDef } from '../schema/types';

export type AuditRule = 'missing_fk_index' | 'orphaned_table' | 'god_table' | 'missing_primary_key';
export const AUDIT_RULES: AuditRule[] = ['missing_fk_index', 'orphaned_table', 'god_table', 'missing_primary_key'];

export type Severity = 'critical' | 'warning' | 'info';

export type Finding = {
  rule: AuditRule;
  table: string;
  column?: string;
  severity: Severity;
  /** A few words, for the badge. */
  title: string;
  detail: string;
  /** The SQL that would fix it, when there is an obvious one. */
  fix?: string;
};

export const RULE_LABEL: Record<AuditRule, string> = {
  missing_fk_index: 'Missing FK index',
  orphaned_table: 'Orphaned table',
  god_table: 'God table',
  missing_primary_key: 'No primary key',
};

/** More columns than this, and a table is doing several jobs. */
export const GOD_TABLE_COLUMNS = 24;
/** An unindexed foreign key on a table this large is critical rather than a warning. */
const LARGE_TABLE = 1_000_000;

export function audit(schema: SchemaDef, rules: AuditRule[] = AUDIT_RULES): Finding[] {
  const findings: Finding[] = [];
  const edges = edgesOf(schema);
  for (const t of schema.tables) {
    if (rules.includes('missing_fk_index')) {
      for (const f of t.fks) {
        if (isIndexed(t, f.column)) continue;
        findings.push({
          rule: 'missing_fk_index',
          table: t.name,
          column: f.column,
          severity: t.rows >= LARGE_TABLE ? 'critical' : 'warning',
          title: `No index on ${f.column}`,
          detail: `${t.name}.${f.column} references ${f.refTable}.${f.refColumn} but has no index, so joins and cascading deletes scan all ${t.rows.toLocaleString('en-US')} rows.`,
          fix: `CREATE INDEX CONCURRENTLY ${t.name}_${f.column}_idx ON ${t.name} (${f.column});`,
        });
      }
    }
    if (rules.includes('orphaned_table') && !edges.some((e) => e.from === t.name || e.to === t.name)) {
      findings.push({
        rule: 'orphaned_table',
        table: t.name,
        severity: 'info',
        title: 'Orphaned',
        detail: `${t.name} has no foreign keys and nothing references it.${t.comment ? ` (${t.comment})` : ''} Confirm it is still used, or archive it.`,
      });
    }
    if (rules.includes('god_table') && t.columns.length > GOD_TABLE_COLUMNS) {
      findings.push({
        rule: 'god_table',
        table: t.name,
        severity: 'warning',
        title: `God table · ${t.columns.length} cols`,
        detail: `${t.name} has ${t.columns.length} columns covering several concerns. Wide rows slow every read and write; consider splitting it.`,
      });
    }
    if (rules.includes('missing_primary_key') && !pkColumns(t).length) {
      findings.push({
        rule: 'missing_primary_key',
        table: t.name,
        severity: 'critical',
        title: 'No primary key',
        detail: `${t.name} has no primary key, so rows can't be addressed or replicated reliably.`,
      });
    }
  }
  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** The worst severity per table, with its findings: what a badge shows. */
export function badgesFor(findings: Finding[]): Record<string, Finding[]> {
  const out: Record<string, Finding[]> = {};
  for (const f of findings) (out[f.table] ??= []).push(f);
  return out;
}
