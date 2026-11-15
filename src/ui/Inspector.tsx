// The selected table in detail: every column with its type and keys, its
// indexes, what the audit said about it, and sample rows once it is seeded.

import { ChevronsDownUp, ChevronsUpDown, KeyRound, Link2, ScanEye, X } from 'lucide-react';
import { useMemo } from 'react';
import { formatRows, isIndexed } from '../schema/graph';
import { focusTables, selectTable, toggleExpanded, useScene } from '../state/scene';
import { neighbours } from '../schema/graph';
import { SEVERITY_COLOR } from '../scene/WarningBadges';
import { tip } from './Tooltip';

export function Inspector({ compact }: { compact: boolean }) {
  const schema = useScene((s) => s.schema);
  const name = useScene((s) => s.selected);
  const rows = useScene((s) => (s.selected ? s.rows[s.selected] : 0));
  const expanded = useScene((s) => (s.selected ? !!s.expanded[s.selected] : false));
  const findings = useScene((s) => (s.selected ? s.badges[s.selected] : undefined));
  const samples = useScene((s) => (s.selected ? s.samples[s.selected] : undefined));
  const table = useMemo(() => schema.tables.find((t) => t.name === name), [schema, name]);
  if (!table) return null;
  const domain = schema.domains.find((d) => d.id === table.domain);
  const fks = new Map(table.fks.map((f) => [f.column, f]));
  const sampleCols = samples?.length ? Object.keys(samples[0]).slice(0, 6) : [];

  return (
    <aside
      aria-label={`Table ${table.name}`}
      className={`glass rise pointer-events-auto flex flex-col overflow-hidden rounded-2xl ${compact ? 'max-h-[40dvh] w-full' : 'max-h-[calc(100dvh-190px)] w-[330px]'}`}
    >
      <div className="flex items-start justify-between gap-2 px-4 pb-2 pt-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: domain?.color }} />
            <span className="label">{domain?.label}</span>
          </div>
          <h2 className="font-display truncate text-xl font-semibold text-slate-50">{table.name}</h2>
          <p className="font-mono text-[11.5px] text-slate-400">
            {formatRows(rows)} rows · {table.columns.length} columns · {table.indexes.length} indexes
          </p>
        </div>
        <button onClick={() => selectTable(null)} aria-label="Close the table details" {...tip('Close', 'Lets go of the selection.', 'deselect')} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex gap-1.5 px-4 pb-3">
        <button onClick={() => toggleExpanded(table.name)} {...tip(expanded ? 'Fold the table' : 'Unfold the table', 'Show or hide the column list on this table in the scene.', 'fold')} className="flex h-9 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 text-[12.5px] font-medium text-slate-200 hover:bg-white/5">
          {expanded ? <ChevronsDownUp className="h-4 w-4" /> : <ChevronsUpDown className="h-4 w-4" />}
          {expanded ? 'Fold' : 'Unfold'}
        </button>
        <button
          onClick={() => focusTables(neighbours(schema, [table.name], 1), `${table.name} + neighbours`)}
          {...tip('Isolate dependencies', 'Light this table and every table one relationship away; dim the rest.', 'deps')}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 text-[12.5px] font-medium text-slate-200 hover:bg-white/5"
        >
          <ScanEye className="h-4 w-4" />
          Isolate dependencies
        </button>
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {table.comment && <p className="mb-3 text-[12.5px] italic leading-snug text-slate-400">{table.comment}</p>}

        {findings?.map((f, i) => (
          <div key={i} className="mb-2 rounded-xl border p-2.5 text-[12.5px] leading-snug" style={{ borderColor: `${SEVERITY_COLOR[f.severity]}55`, background: `${SEVERITY_COLOR[f.severity]}12` }}>
            <div className="font-semibold" style={{ color: SEVERITY_COLOR[f.severity] }}>
              {f.title}
            </div>
            <div className="text-slate-300">{f.detail}</div>
          </div>
        ))}

        <h3 className="label mb-1.5 mt-1">Columns</h3>
        <ul className="font-mono text-[12px]">
          {table.columns.map((c) => {
            const fk = fks.get(c.name);
            return (
              <li key={c.name} className="flex items-baseline gap-2 border-b border-white/5 py-1.5">
                <span className="w-4 shrink-0 self-center">
                  {c.pk ? <KeyRound className="h-3.5 w-3.5 text-amber-300" aria-label="primary key" /> : fk ? <Link2 className="h-3.5 w-3.5 text-cyan-300" aria-label="foreign key" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`break-all ${c.pk ? 'text-amber-100' : fk ? 'text-cyan-100' : 'text-slate-200'}`}>{c.name}</span>
                  {fk && (
                    <button onClick={() => selectTable(fk.refTable, { fly: true, expand: true })} className="ml-1.5 text-cyan-400 underline decoration-cyan-400/30 underline-offset-2 hover:text-cyan-200">
                      → {fk.refTable}
                    </button>
                  )}
                  {fk && !isIndexed(table, c.name) && <span className="ml-1.5 text-amber-400">no index</span>}
                </span>
                <span className="shrink-0 text-slate-500">
                  {c.type}
                  {c.nullable ? '?' : ''}
                </span>
              </li>
            );
          })}
        </ul>

        {table.indexes.length > 0 && (
          <>
            <h3 className="label mb-1.5 mt-4">Indexes</h3>
            <ul className="space-y-1 font-mono text-[11.5px] text-slate-400">
              {table.indexes.map((i) => (
                <li key={i.name} className="break-all">
                  {i.unique ? 'unique ' : ''}({i.columns.join(', ')}){i.whatIf && <span className="ml-1.5 text-teal-300">what-if</span>}
                </li>
              ))}
            </ul>
          </>
        )}

        {samples && samples.length > 0 && (
          <>
            <h3 className="label mb-1.5 mt-4">Seeded rows · mock data</h3>
            <div className="thin-scroll overflow-x-auto rounded-lg border border-white/8">
              <table className="w-max min-w-full font-mono text-[11px]">
                <thead>
                  <tr className="bg-white/[0.03] text-left text-slate-400">
                    {sampleCols.map((c) => (
                      <th key={c} className="px-2 py-1.5 font-medium">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {samples.slice(0, 6).map((r, i) => (
                    <tr key={i} className="border-t border-white/5 text-slate-300">
                      {sampleCols.map((c) => (
                        <td key={c} className="max-w-[150px] truncate px-2 py-1">
                          {r[c] === null ? <span className="text-slate-600">null</span> : String(r[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
