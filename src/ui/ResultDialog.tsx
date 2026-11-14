// A query result, opened from the chat into a full table: sort by a column,
// search, filter per column, hide columns, page through, and copy or download
// what is shown. The rows are mock data, and the dialog says so.

import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronLeft, ChevronRight, Columns3, Copy, Download, FilterX, ListFilter, Search, X } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ResultSet } from '../analysis/execute';
import { applyView, isIdLike, kindOf, summarize, toDelimited, toObjects, type Sort } from '../analysis/resultview';
import type { Value } from '../analysis/seed';
import { useUi } from '../state/ui';

const SIZES = [25, 50, 100, 0] as const;
const num = (n: number, digits = 0) => n.toLocaleString('en-US', { maximumFractionDigits: digits });

function download(name: string, mime: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Cell({ v, plain }: { v: Value; plain: boolean }) {
  if (v === null || v === undefined) return <span className="text-slate-600">null</span>;
  if (typeof v === 'number') return <>{plain ? String(v) : num(v, 2)}</>;
  if (typeof v === 'boolean') return <span className={v ? 'text-emerald-300' : 'text-slate-400'}>{String(v)}</span>;
  return <>{v}</>;
}

const tool = 'flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 text-[12.5px] font-medium text-slate-200 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-35';

function Body({ result, sql, onClose }: { result: ResultSet; sql?: string; onClose: () => void }) {
  const { columns, rows, total, scanned } = result;
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Record<number, string>>({});
  const [sort, setSort] = useState<Sort>(null);
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set());
  const [filterRow, setFilterRow] = useState(true);
  const [colsOpen, setColsOpen] = useState(false);
  const [size, setSize] = useState<number>(25);
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<Value[] | null>(null);
  const [copied, setCopied] = useState(false);
  const searchBox = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === '/' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        searchBox.current?.focus();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);

  const kinds = useMemo(() => columns.map((_, i) => kindOf(rows, i)), [columns, rows]);
  const plain = useMemo(() => columns.map(isIdLike), [columns]);
  const view = useMemo(() => applyView(rows, { search, filters, sort }), [rows, search, filters, sort]);
  const shownCols = columns.map((_, i) => i).filter((i) => !hidden.has(i));
  const summaries = useMemo(() => columns.map((_, i) => summarize(view, i, kinds[i] === 'number' && !plain[i])), [columns, view, kinds, plain]);

  const pages = size ? Math.max(1, Math.ceil(view.length / size)) : 1;
  const at = Math.min(page, pages - 1);
  const start = size ? at * size : 0;
  const pageRows = size ? view.slice(start, start + size) : view;
  const filtering = !!search.trim() || Object.values(filters).some((f) => f.trim());

  const cycle = (i: number) => {
    setSort((s) => (s?.column !== i ? { column: i, dir: kinds[i] === 'number' ? 'desc' : 'asc' } : s.dir === (kinds[i] === 'number' ? 'desc' : 'asc') ? { column: i, dir: s.dir === 'asc' ? 'desc' : 'asc' } : null));
    setPage(0);
  };
  const clear = () => {
    setSearch('');
    setFilters({});
    setPage(0);
  };
  const exported = () => [shownCols.map((i) => columns[i]), view.map((r) => shownCols.map((i) => r[i] ?? null))] as const;
  const copy = () => {
    const [c, r] = exported();
    void navigator.clipboard?.writeText(toDelimited(c, r, '\t')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const what = `${num(view.length)} row${view.length === 1 ? '' : 's'}${filtering ? ' shown' : ''}, ${shownCols.length} column${shownCols.length === 1 ? '' : 's'}`;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/65 sm:p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal aria-label="Query result" className={`glass rise !bg-panel flex h-full w-full max-w-[1180px] flex-col overflow-hidden sm:rounded-2xl ${rows.length > 10 ? 'sm:h-[min(88dvh,860px)]' : 'sm:h-auto sm:max-h-[88dvh] sm:min-h-[380px]'}`}>
        <div className="flex items-start justify-between gap-3 px-4 pb-2 pt-[max(14px,env(safe-area-inset-top))] sm:px-5">
          <div className="min-w-0">
            <h2 className="font-display text-lg font-semibold text-slate-50">Query result</h2>
            <p className="mt-0.5 text-[12.5px] leading-snug text-slate-400">
              <span className="mr-1.5 rounded-full border border-amber-300/30 px-1.5 py-px font-mono text-[10.5px] uppercase tracking-wider text-amber-200">mock data</span>
              {num(rows.length)} row{rows.length === 1 ? '' : 's'} returned
              {total > rows.length && ` of ${num(total)} (the query's LIMIT)`} · {num(scanned)} read<span className="hidden sm:inline"> · invented rows that show the query's shape, not your data</span>
            </p>
          </div>
          <button onClick={onClose} aria-label="Close the result" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        {sql && (
          <details className="mx-4 mb-2 rounded-xl border border-white/8 bg-black/25 sm:mx-5">
            <summary className="label cursor-pointer select-none px-3 py-2 hover:text-slate-300">Query</summary>
            <pre className="thin-scroll max-h-40 overflow-auto border-t border-white/8 p-3 font-mono text-[11.5px] leading-relaxed text-slate-300">{sql}</pre>
          </details>
        )}

        <div className="flex flex-wrap items-center gap-2 px-4 pb-3 sm:px-5">
          <label className="flex h-9 min-w-[180px] basis-full items-center gap-2 rounded-lg border border-white/10 bg-black/25 px-2.5 focus-within:border-cyan-400/50 sm:max-w-[320px] sm:flex-1 sm:basis-auto">
            <Search className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
            <input
              ref={searchBox}
              value={search}
              onChange={(e) => (setSearch(e.target.value), setPage(0))}
              placeholder="Search every column"
              aria-label="Search every column"
              className="min-w-0 flex-1 bg-transparent text-[14px] text-slate-100 !outline-none placeholder:text-slate-500 sm:text-[13px]"
            />
            {search && (
              <button onClick={() => (setSearch(''), setPage(0))} aria-label="Clear the search" className="text-slate-500 hover:text-white">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </label>
          <button onClick={() => setFilterRow((v) => !v)} aria-pressed={filterRow} aria-label="Column filters" className={`${tool} ${filterRow ? '!border-cyan-400/40 !text-cyan-200' : ''}`}>
            <ListFilter className="h-4 w-4" /> <span className="hidden sm:inline">Filters</span>
          </button>
          <div className="relative">
            <button onClick={() => setColsOpen((v) => !v)} aria-expanded={colsOpen} aria-label="Columns" className={tool}>
              <Columns3 className="h-4 w-4" /> <span className="hidden sm:inline">Columns</span>
              {hidden.size > 0 && <span className="font-mono text-[11px] text-slate-400">{shownCols.length}/{columns.length}</span>}
            </button>
            {colsOpen && (
              <>
                <div className="fixed inset-0 z-10" onPointerDown={() => setColsOpen(false)} />
                <div className="glass !bg-panel-2 thin-scroll absolute left-0 top-10 z-20 max-h-72 w-56 overflow-y-auto rounded-xl p-1.5">
                  {columns.map((c, i) => (
                    <label key={i} className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 font-mono text-[12px] text-slate-200 hover:bg-white/5">
                      <input
                        type="checkbox"
                        checked={!hidden.has(i)}
                        disabled={!hidden.has(i) && shownCols.length === 1}
                        onChange={() =>
                          setHidden((h) => {
                            const next = new Set(h);
                            if (!next.delete(i)) next.add(i);
                            return next;
                          })
                        }
                        className="accent-cyan-400"
                      />
                      <span className="truncate">{c}</span>
                    </label>
                  ))}
                  {hidden.size > 0 && (
                    <button onClick={() => setHidden(new Set())} className="mt-1 h-8 w-full rounded-lg text-[12px] text-cyan-300 hover:bg-white/5">
                      Show all
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
          {filtering && (
            <button onClick={clear} aria-label="Clear the search and filters" className={`${tool} !text-amber-200`}>
              <FilterX className="h-4 w-4" /> <span className="hidden sm:inline">Clear</span>
            </button>
          )}
          <div className="flex-1" />
          <button onClick={copy} disabled={!view.length} aria-label="Copy the rows shown" title={`Copy ${what} — pastes into a spreadsheet`} className={tool}>
            {copied ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
            <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
          </button>
          <button onClick={() => download('query-result.csv', 'text/csv;charset=utf-8', toDelimited(...exported()))} disabled={!view.length} title={`Download ${what} as CSV`} className={tool}>
            <Download className="h-4 w-4" /> CSV
          </button>
          <button onClick={() => download('query-result.json', 'application/json', JSON.stringify(toObjects(...exported()), null, 2))} disabled={!view.length} title={`Download ${what} as JSON`} className={tool}>
            <Download className="h-4 w-4" /> JSON
          </button>
        </div>

        <div className="thin-scroll min-h-0 flex-1 overflow-auto border-y border-white/8">
          <table className="w-max min-w-full border-separate border-spacing-0 font-mono text-[12px]">
            <thead className="sticky top-0 z-[1]">
              <tr>
                <th className="w-10 border-b border-white/8 bg-panel-2 px-2 py-0 text-right font-medium text-slate-600">#</th>
                {shownCols.map((i) => {
                  const dir = sort?.column === i ? sort.dir : null;
                  return (
                    <th key={i} aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'} className="border-b border-white/8 bg-panel-2 p-0 font-medium">
                      <button onClick={() => cycle(i)} title={`Sort by ${columns[i]}`} className={`flex h-9 w-full items-center gap-1.5 px-3 hover:bg-white/5 ${kinds[i] === 'number' ? 'justify-end' : ''} ${dir ? 'text-cyan-200' : 'text-slate-300'}`}>
                        {columns[i]}
                        {dir === 'asc' ? <ArrowUp className="h-3.5 w-3.5" /> : dir === 'desc' ? <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUpDown className="h-3.5 w-3.5 text-slate-600" />}
                      </button>
                    </th>
                  );
                })}
              </tr>
              {filterRow && (
                <tr>
                  <th className="border-b border-white/8 bg-panel-2" />
                  {shownCols.map((i) => (
                    <th key={i} className="border-b border-white/8 bg-panel-2 px-1.5 pb-1.5 pt-0 font-normal">
                      <input
                        value={filters[i] ?? ''}
                        onChange={(e) => (setFilters((f) => ({ ...f, [i]: e.target.value })), setPage(0))}
                        placeholder={kinds[i] === 'number' ? '>100, 10..50' : kinds[i] === 'boolean' ? 'true / false' : 'contains…'}
                        aria-label={`Filter ${columns[i]}`}
                        title="Text: contains. Also =x  !=x  >x  >=x  <x  <=x  10..50  null  !null"
                        className={`h-7 w-full min-w-[92px] rounded-md border bg-black/30 px-2 text-[16px] text-slate-100 placeholder:text-slate-600 sm:text-[11.5px] ${filters[i]?.trim() ? 'border-cyan-400/50' : 'border-white/8'} ${kinds[i] === 'number' ? 'text-right' : ''}`}
                      />
                    </th>
                  ))}
                </tr>
              )}
            </thead>
            <tbody>
              {pageRows.map((r, n) => {
                const open = detail === r;
                return (
                  <Fragment key={start + n}>
                    <tr onClick={() => setDetail(open ? null : r)} aria-expanded={open} className={`cursor-pointer text-slate-200 ${open ? 'bg-cyan-400/[0.08]' : 'odd:bg-white/[0.015] hover:bg-white/[0.05]'}`}>
                      <td className="border-b border-white/5 px-2 py-1.5 text-right text-slate-600">{start + n + 1}</td>
                      {shownCols.map((i) => (
                        <td key={i} className={`max-w-[280px] truncate border-b border-white/5 px-3 py-1.5 ${kinds[i] === 'number' ? 'text-right tabular-nums text-cyan-100' : ''}`}>
                          <Cell v={r[i] ?? null} plain={plain[i]} />
                        </td>
                      ))}
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={shownCols.length + 1} className="border-b border-cyan-400/20 bg-black/30 px-3 py-2.5">
                          <dl className="sticky left-3 grid w-[min(900px,calc(100vw-56px))] grid-cols-[max-content_1fr] gap-x-4 gap-y-1 whitespace-normal">
                            {columns.map((c, i) => (
                              <Fragment key={i}>
                                <dt className="text-slate-500">{c}</dt>
                                <dd className="select-text break-all text-slate-100">
                                  <Cell v={r[i] ?? null} plain={plain[i]} />
                                </dd>
                              </Fragment>
                            ))}
                          </dl>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            {view.length > 0 && (
              <tfoot className="sticky bottom-0">
                <tr className="text-[11px] text-slate-400">
                  <td className="border-t border-white/10 bg-panel-2 px-2 py-1.5 text-right text-slate-600">Σ</td>
                  {shownCols.map((i) => {
                    const s = summaries[i];
                    return (
                      <td key={i} className={`whitespace-nowrap border-t border-white/10 bg-panel-2 px-3 py-1.5 ${kinds[i] === 'number' ? 'text-right' : ''}`} title={s.kind === 'number' ? `min ${num(s.min, 2)} · max ${num(s.max, 2)}` : s.nulls ? `${s.nulls} null` : undefined}>
                        {s.kind === 'number' ? (
                          <>
                            <span className="text-cyan-100">{num(s.sum, 2)}</span> · avg {num(s.avg, 2)}
                          </>
                        ) : (
                          `${num(s.distinct)} distinct`
                        )}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            )}
          </table>
          {!view.length && (
            <div className="px-5 py-10 text-center text-[13.5px] text-slate-400">
              {rows.length ? 'No rows match the search and filters.' : 'The query returned no rows from the mock data.'}
              {filtering && (
                <button onClick={clear} className="ml-2 text-cyan-300 underline decoration-cyan-300/30 underline-offset-2 hover:text-cyan-100">
                  Clear them
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-[max(10px,env(safe-area-inset-bottom))] pt-2.5 text-[12.5px] text-slate-400 sm:px-5">
          <span>
            {view.length ? `${num(start + 1)}–${num(start + pageRows.length)} of ${num(view.length)}` : '0 rows'}
            {filtering && view.length !== rows.length && <span className="text-slate-500"> · filtered from {num(rows.length)}</span>}
            <span className="hidden text-slate-600 sm:inline"> · click a row for all of its values</span>
          </span>
          <span className="flex items-center gap-1.5">
            <label className="flex items-center gap-1.5">
              Rows
              <select value={size} onChange={(e) => (setSize(Number(e.target.value)), setPage(0))} className="h-8 rounded-lg border border-white/10 bg-panel-2 px-1.5 text-[12.5px] text-slate-200">
                {SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s || 'All'}
                  </option>
                ))}
              </select>
            </label>
            <button onClick={() => setPage(at - 1)} disabled={at === 0} aria-label="Previous page" className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 text-slate-200 hover:bg-white/5 disabled:opacity-30">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-[52px] text-center font-mono text-[12px]">
              {at + 1} / {pages}
            </span>
            <button onClick={() => setPage(at + 1)} disabled={at >= pages - 1} aria-label="Next page" className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 text-slate-200 hover:bg-white/5 disabled:opacity-30">
              <ChevronRight className="h-4 w-4" />
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

export function ResultDialog() {
  const open = useUi((s) => s.result);
  const setResult = useUi((s) => s.setResult);
  if (!open) return null;
  return <Body result={open.result} sql={open.sql} onClose={() => setResult(null)} />;
}
