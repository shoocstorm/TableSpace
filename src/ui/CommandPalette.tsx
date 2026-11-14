// Quick search (⌘K / Ctrl+K): type part of a table or column name, press
// Enter, and the camera flies there.

import { CornerDownLeft, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatRows } from '../schema/graph';
import type { SchemaDef, Table } from '../schema/types';
import { selectTable, useScene } from '../state/scene';
import { useUi } from '../state/ui';

type Hit = { table: Table; column?: string; score: number };

/** Tables whose name matches come first (prefix before substring), then tables with a matching column. */
export function searchTables(schema: SchemaDef, query: string): Hit[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, '_');
  if (!q) return schema.tables.map((table) => ({ table, score: 0 }));
  const hits: Hit[] = [];
  for (const table of schema.tables) {
    const at = table.name.indexOf(q);
    if (at === 0) hits.push({ table, score: 0 });
    else if (at > 0) hits.push({ table, score: 1 });
    else if (table.domain.startsWith(q)) hits.push({ table, score: 2 });
    else {
      const column = table.columns.find((c) => c.name.includes(q));
      if (column) hits.push({ table, column: column.name, score: 3 });
    }
  }
  return hits.sort((a, b) => a.score - b.score || a.table.name.length - b.table.name.length);
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setPalette = useUi((s) => s.setPalette);
  const schema = useScene((s) => s.schema);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const hits = useMemo(() => searchTables(schema, query), [schema, query]);
  const colors = useMemo(() => new Map(schema.domains.map((d) => [d.id, d])), [schema]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    // after the dialog is in the DOM
    const t = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;
  const go = (hit: Hit | undefined) => {
    if (!hit) return;
    selectTable(hit.table.name, { fly: true, expand: true });
    setPalette(false);
  };

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center bg-black/55 px-3 pt-[12dvh]" onPointerDown={(e) => e.target === e.currentTarget && setPalette(false)}>
      <div role="dialog" aria-label="Search tables" aria-modal className="glass rise w-full max-w-[540px] overflow-hidden rounded-2xl">
        <div className="flex items-center gap-3 border-b border-white/8 px-4">
          <Search className="h-[18px] w-[18px] shrink-0 text-slate-400" aria-hidden />
          <input
            ref={input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(hits.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') go(hits[active]);
              else if (e.key === 'Escape') setPalette(false);
            }}
            placeholder="Find a table or column…"
            aria-label="Find a table or column"
            aria-controls="palette-results"
            autoComplete="off"
            spellCheck={false}
            className="h-13 w-full bg-transparent text-[15px] text-slate-100 outline-none placeholder:text-slate-500"
          />
          <kbd className="label hidden rounded border border-white/10 px-1.5 py-0.5 sm:block">esc</kbd>
        </div>
        <ul ref={list} id="palette-results" role="listbox" className="thin-scroll max-h-[min(52dvh,420px)] overflow-y-auto p-1.5">
          {hits.map((h, i) => {
            const d = colors.get(h.table.domain);
            return (
              <li key={h.table.name} role="option" aria-selected={i === active}>
                <button
                  onClick={() => go(h)}
                  onPointerMove={() => setActive(i)}
                  className={`flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left ${i === active ? 'bg-white/8' : ''}`}
                >
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: d?.color }} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13.5px] text-slate-100">
                    {h.table.name}
                    {h.column && <span className="text-slate-500">.{h.column}</span>}
                  </span>
                  <span className="label shrink-0">{d?.label}</span>
                  <span className="w-14 shrink-0 text-right font-mono text-[11.5px] text-slate-400">{formatRows(h.table.rows)}</span>
                  {i === active && <CornerDownLeft className="hidden h-3.5 w-3.5 shrink-0 text-slate-500 sm:block" aria-hidden />}
                </button>
              </li>
            );
          })}
          {!hits.length && <li className="px-3 py-6 text-center text-sm text-slate-500">No table or column matches “{query}”.</li>}
        </ul>
      </div>
    </div>
  );
}
