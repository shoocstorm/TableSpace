// Import your own schema: paste SQL DDL, see what was understood, and open
// it as a database in the switcher. The DDL stays in this browser.

import { Check, Trash2, TriangleAlert, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { EXAMPLE_DDL, parseDdl } from '../schema/ddl';
import { edgesOf } from '../schema/graph';
import { removeImported, saveImported, useRegistry } from '../schema/registry';
import { setSchema, useScene } from '../state/scene';
import { useUi } from '../state/ui';

/** Past this size, parsing on every keystroke would stutter. */
const MAX_DDL = 600_000;

export function ImportDialog() {
  const open = useUi((s) => s.importOpen);
  const setImport = useUi((s) => s.setImport);
  const saved = useRegistry((s) => s.saved);
  const activeId = useScene((s) => s.schema.id);
  const [name, setName] = useState('My database');
  const [ddl, setDdl] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => area.current?.focus(), 0);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setImport(false);
    window.addEventListener('keydown', key);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', key);
    };
  }, [open, setImport]);

  const tooBig = ddl.length > MAX_DDL;
  const parsed = useMemo(() => (ddl.trim() && !tooBig ? parseDdl(ddl, name.trim() || 'My database') : null), [ddl, name, tooBig]);
  if (!open) return null;

  const submit = () => {
    if (!parsed?.ok) return;
    saveImported(parsed.schema, ddl);
    // the same name replaces the earlier import, so the scene is rebuilt even when the id is unchanged
    setSchema(parsed.schema.id, true);
    setImport(false);
    setDdl('');
  };
  const readFile = async (f: File | undefined) => {
    if (!f) return;
    setDdl((await f.text()).slice(0, MAX_DDL + 1));
    setName(f.name.replace(/\.(sql|ddl|txt)$/i, '') || 'My database');
  };

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-3 sm:items-center" onPointerDown={(e) => e.target === e.currentTarget && setImport(false)}>
      <div role="dialog" aria-modal aria-label="Import a schema" className="glass rise !bg-panel flex max-h-[calc(100dvh-24px)] w-full max-w-[680px] flex-col rounded-2xl">
        <div className="flex items-start justify-between gap-3 px-5 pb-2 pt-4">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-50">Import your schema</h2>
            <p className="mt-0.5 text-[13px] leading-snug text-slate-400">
              Paste SQL DDL — <code className="font-mono text-[12px] text-slate-300">CREATE TABLE</code>, <code className="font-mono text-[12px] text-slate-300">CREATE INDEX</code>, <code className="font-mono text-[12px] text-slate-300">ALTER TABLE … ADD FOREIGN KEY</code> — for example from{' '}
              <code className="font-mono text-[12px] text-slate-300">pg_dump --schema-only</code>. It is read and kept in this browser only.
            </p>
          </div>
          <button onClick={() => setImport(false)} aria-label="Close" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="thin-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-4">
          <label className="block">
            <span className="label">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value.slice(0, 40))} className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-black/25 px-3 text-[14px] text-slate-100" />
          </label>
          <div>
            <div className="flex items-end justify-between">
              <label htmlFor="ddl" className="label">
                SQL DDL
              </label>
              <div className="flex gap-1.5">
                <button onClick={() => (setDdl(EXAMPLE_DDL), setName('Library'))} className="h-8 rounded-lg border border-white/10 px-2.5 text-[12px] text-slate-300 hover:bg-white/5">
                  Use the example
                </button>
                <button onClick={() => file.current?.click()} className="flex h-8 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 text-[12px] text-slate-300 hover:bg-white/5">
                  <Upload className="h-3.5 w-3.5" /> Open a .sql file
                </button>
                <input ref={file} type="file" accept=".sql,.ddl,.txt,text/plain" className="hidden" onChange={(e) => void readFile(e.target.files?.[0])} />
              </div>
            </div>
            <textarea
              id="ddl"
              ref={area}
              value={ddl}
              onChange={(e) => setDdl(e.target.value)}
              spellCheck={false}
              placeholder={'CREATE TABLE users (\n  id bigserial PRIMARY KEY,\n  email text NOT NULL UNIQUE\n);'}
              className="thin-scroll mt-1 h-52 w-full resize-y rounded-xl border border-white/10 bg-black/30 p-3 font-mono text-[12.5px] leading-relaxed text-slate-200 placeholder:text-slate-600"
            />
          </div>

          {tooBig && <p className="text-[13px] text-rose-300">That is more than {Math.round(MAX_DDL / 1000)} KB of DDL. Import the schema of one database, without data.</p>}
          {parsed && !parsed.ok && (
            <p role="alert" className="flex gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-[13px] leading-snug text-rose-200">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {parsed.error}
            </p>
          )}
          {parsed?.ok && (
            <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.05] p-3 text-[13px] leading-snug">
              <div className="flex items-center gap-2 font-semibold text-emerald-200">
                <Check className="h-4 w-4" />
                {parsed.schema.tables.length} tables · {parsed.schema.tables.reduce((n, t) => n + t.columns.length, 0)} columns · {edgesOf(parsed.schema).length} relationships · {parsed.schema.domains.length} domains
              </div>
              <p className="mt-1 text-slate-400">DDL has no row counts or domains, so tables are grouped by how they reference each other and sized by an estimate.</p>
              {parsed.warnings.length > 0 && (
                <ul className="mt-2 space-y-1 text-amber-100/90">
                  {parsed.warnings.slice(0, 5).map((w, i) => (
                    <li key={i} className="flex gap-2">
                      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" /> {w}
                    </li>
                  ))}
                  {parsed.warnings.length > 5 && <li className="text-slate-500">and {parsed.warnings.length - 5} more</li>}
                </ul>
              )}
            </div>
          )}

          {saved.length > 0 && (
            <div>
              <div className="label mb-1">Imported in this browser</div>
              <ul className="space-y-1">
                {saved.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 rounded-lg border border-white/8 px-3 py-1.5 text-[13px] text-slate-200">
                    <span className="truncate">{s.name}</span>
                    <button
                      onClick={() => {
                        if (!window.confirm(`Remove the imported schema "${s.name}" from this browser?`)) return;
                        if (activeId === s.id) setSchema('demo');
                        removeImported(s.id);
                      }}
                      aria-label={`Remove ${s.name}`}
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-white/5 hover:text-rose-300"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-white/8 px-5 py-3">
          <button onClick={() => setImport(false)} className="h-10 rounded-xl border border-white/10 px-4 text-[13.5px] font-medium text-slate-200 hover:bg-white/5">
            Cancel
          </button>
          <button onClick={submit} disabled={!parsed?.ok} className="h-10 rounded-xl bg-cyan-400 px-4 text-[13.5px] font-semibold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-35">
            Open in 3D
          </button>
        </div>
      </div>
    </div>
  );
}
