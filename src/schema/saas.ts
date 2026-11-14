// A second database, to show the switcher and that nothing is tied to the
// shop schema: a multi-tenant project tracker.

import { col, fk, idx, pk, type SchemaDef } from './types';

const ts = (name: string, nullable = false) => col(name, 'timestamptz', { nullable });

export const saas: SchemaDef = {
  id: 'saas',
  name: 'Trackline · SaaS',
  engine: 'PostgreSQL 16 · mock',
  description: 'A multi-tenant project tracker: workspaces, projects, issues, billing and audit.',
  domains: [
    { id: 'tenancy', label: 'Tenancy', color: '#38bdf8' },
    { id: 'work', label: 'Work', color: '#a78bfa' },
    { id: 'billing', label: 'Billing', color: '#34d399' },
    { id: 'audit', label: 'Audit', color: '#fb923c' },
  ],
  tables: [
    {
      name: 'workspaces',
      domain: 'tenancy',
      rows: 12_400,
      columns: [pk(), col('slug', 'varchar(60)', { unique: true }), col('name', 'varchar(120)'), col('plan_id', 'bigint'), ts('created_at')],
      fks: [fk('plan_id', 'plans')],
      indexes: [idx('workspaces', ['slug'], true), idx('workspaces', ['plan_id'])],
    },
    {
      name: 'members',
      domain: 'tenancy',
      rows: 96_000,
      columns: [pk(), col('email', 'varchar(255)', { unique: true }), col('display_name', 'varchar(120)'), ts('created_at')],
      fks: [],
      indexes: [idx('members', ['email'], true)],
    },
    {
      name: 'workspace_members',
      domain: 'tenancy',
      rows: 131_000,
      columns: [col('workspace_id', 'bigint', { pk: true }), col('member_id', 'bigint', { pk: true }), col('role', 'varchar(16)'), ts('joined_at')],
      fks: [fk('workspace_id', 'workspaces'), fk('member_id', 'members')],
      indexes: [idx('workspace_members', ['member_id'])],
    },
    {
      name: 'api_keys',
      domain: 'tenancy',
      rows: 8_900,
      columns: [pk(), col('workspace_id', 'bigint'), col('created_by', 'bigint'), col('token_hash', 'char(64)', { unique: true }), col('label', 'varchar(80)'), ts('last_used_at', true)],
      fks: [fk('workspace_id', 'workspaces'), fk('created_by', 'members')],
      // created_by is unindexed
      indexes: [idx('api_keys', ['workspace_id']), idx('api_keys', ['token_hash'], true)],
    },
    {
      name: 'projects',
      domain: 'work',
      rows: 58_000,
      columns: [pk(), col('workspace_id', 'bigint'), col('key', 'varchar(10)'), col('name', 'varchar(120)'), col('archived', 'boolean'), ts('created_at')],
      fks: [fk('workspace_id', 'workspaces')],
      indexes: [idx('projects', ['workspace_id'])],
    },
    {
      name: 'issues',
      domain: 'work',
      rows: 4_700_000,
      comment: 'Custom fields were added as columns, one integration at a time.',
      columns: [
        pk(),
        col('project_id', 'bigint'),
        col('reporter_id', 'bigint'),
        col('assignee_id', 'bigint', { nullable: true }),
        col('number', 'integer'),
        col('title', 'varchar(240)'),
        col('body', 'text'),
        col('status', 'varchar(16)'),
        col('priority', 'varchar(12)'),
        col('estimate_points', 'smallint', { nullable: true }),
        col('github_repo', 'varchar(140)', { nullable: true }),
        col('github_pr_number', 'integer', { nullable: true }),
        col('github_branch', 'varchar(140)', { nullable: true }),
        col('github_synced_at', 'timestamptz', { nullable: true }),
        col('sla_policy', 'varchar(40)', { nullable: true }),
        col('sla_due_at', 'timestamptz', { nullable: true }),
        col('sla_breached', 'boolean'),
        col('sla_paused_at', 'timestamptz', { nullable: true }),
        col('customer_name', 'varchar(120)', { nullable: true }),
        col('customer_email', 'varchar(255)', { nullable: true }),
        col('customer_tier', 'varchar(16)', { nullable: true }),
        col('customer_account_ref', 'varchar(60)', { nullable: true }),
        ts('created_at'),
        ts('updated_at'),
        ts('closed_at', true),
      ],
      fks: [fk('project_id', 'projects'), fk('reporter_id', 'members'), fk('assignee_id', 'members')],
      // assignee_id is unindexed: "my open issues" scans 4.7M rows
      indexes: [idx('issues', ['project_id']), idx('issues', ['reporter_id'])],
    },
    {
      name: 'comments',
      domain: 'work',
      rows: 13_900_000,
      columns: [pk(), col('issue_id', 'bigint'), col('author_id', 'bigint'), col('body', 'text'), ts('created_at'), ts('edited_at', true)],
      fks: [fk('issue_id', 'issues'), fk('author_id', 'members')],
      indexes: [idx('comments', ['issue_id']), idx('comments', ['author_id'])],
    },
    {
      name: 'labels',
      domain: 'work',
      rows: 41_000,
      columns: [pk(), col('workspace_id', 'bigint'), col('name', 'varchar(60)'), col('color', 'char(7)')],
      fks: [fk('workspace_id', 'workspaces')],
      indexes: [idx('labels', ['workspace_id'])],
    },
    {
      name: 'issue_labels',
      domain: 'work',
      rows: 7_300_000,
      columns: [col('issue_id', 'bigint', { pk: true }), col('label_id', 'bigint', { pk: true })],
      fks: [fk('issue_id', 'issues'), fk('label_id', 'labels')],
      indexes: [idx('issue_labels', ['label_id'])],
    },
    {
      name: 'plans',
      domain: 'billing',
      rows: 5,
      columns: [pk(), col('code', 'varchar(24)', { unique: true }), col('name', 'varchar(60)'), col('price_cents', 'integer'), col('seat_limit', 'integer', { nullable: true })],
      fks: [],
      indexes: [idx('plans', ['code'], true)],
    },
    {
      name: 'subscriptions',
      domain: 'billing',
      rows: 12_400,
      columns: [pk(), col('workspace_id', 'bigint', { unique: true }), col('plan_id', 'bigint'), col('status', 'varchar(16)'), col('seats', 'integer'), ts('current_period_end')],
      fks: [fk('workspace_id', 'workspaces'), fk('plan_id', 'plans')],
      indexes: [idx('subscriptions', ['workspace_id'], true), idx('subscriptions', ['plan_id'])],
    },
    {
      name: 'invoices',
      domain: 'billing',
      rows: 214_000,
      columns: [pk(), col('subscription_id', 'bigint'), col('number', 'varchar(24)', { unique: true }), col('amount_cents', 'integer'), col('status', 'varchar(16)'), ts('issued_at'), ts('paid_at', true)],
      fks: [fk('subscription_id', 'subscriptions')],
      // subscription_id is unindexed
      indexes: [idx('invoices', ['number'], true)],
    },
    {
      name: 'audit_log',
      domain: 'audit',
      rows: 31_000_000,
      columns: [pk(), col('workspace_id', 'bigint'), col('actor_id', 'bigint', { nullable: true }), col('action', 'varchar(60)'), col('target', 'varchar(120)'), col('metadata', 'jsonb'), ts('occurred_at')],
      fks: [fk('workspace_id', 'workspaces'), fk('actor_id', 'members')],
      indexes: [idx('audit_log', ['workspace_id']), idx('audit_log', ['actor_id']), idx('audit_log', ['occurred_at'])],
    },
    {
      name: 'feature_flags_old',
      domain: 'audit',
      rows: 240,
      comment: 'Replaced by the config service; kept "just in case".',
      columns: [pk(), col('name', 'varchar(80)'), col('enabled', 'boolean'), col('rollout_percent', 'smallint'), ts('updated_at')],
      fks: [],
      indexes: [],
    },
  ],
  presets: [
    {
      id: 'my_issues',
      label: 'My open issues with labels',
      sql: `SELECT i.number, i.title, l.name
FROM members m
JOIN issues i ON i.assignee_id = m.id
JOIN issue_labels il ON il.issue_id = i.id
JOIN labels l ON l.id = il.label_id
WHERE m.email = 'ada@example.com'`,
    },
    {
      id: 'billing_overview',
      label: 'Workspace billing overview',
      sql: `SELECT w.name, p.name, s.seats, inv.amount_cents
FROM workspaces w
JOIN subscriptions s ON s.workspace_id = w.id
JOIN plans p ON p.id = s.plan_id
JOIN invoices inv ON inv.subscription_id = s.id
WHERE w.slug = 'acme'`,
    },
  ],
};
