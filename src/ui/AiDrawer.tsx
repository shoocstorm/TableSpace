// The AI drawer: a chat with the local data architect. On a computer it is
// a panel on the right; on a phone a sheet over the lower part of the screen,
// so the scene it controls stays visible above it.

import { ArrowUp, Check, Copy, CornerDownRight, LoaderCircle, Maximize2, MessageSquare, Play, ShieldCheck, Sparkles, Square, Trash2, TriangleAlert, UserRound, Wrench, X } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RULE_LABEL } from '../analysis/audit';
import type { PlanStep } from '../analysis/plan';
import { chipsFor } from '../agent/chips';
import { TOOLS, type Block } from '../agent/tools';
import { MODELS, useEngine } from '../llm/engine';
import { formatRows } from '../schema/graph';
import { scanColor } from '../scene/QueryPulses';
import { SEVERITY_COLOR } from '../scene/WarningBadges';
import { clearChat, send, stop, useChat, type Message } from '../state/chat';
import { ghostPositions } from '../scene/Ghosts';
import { focusTables, positionsOf, selectTable, startTrace, useScene } from '../state/scene';
import { useSettings } from '../state/settings';
import { useUi, type DrawerTab } from '../state/ui';
import { ProfileTab, ToolsTab } from './AgentDossier';
import { StepsView } from './AgentSteps';
import { Keys, tip } from './Tooltip';

/** Bold, inline code and line breaks: all the formatting answers use. Rendered as elements, never as HTML. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((para, i) => (
        <p key={i} className="whitespace-pre-wrap">
          {para.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g).map((part, j) => {
            if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={j} className="font-semibold text-slate-50">{part.slice(2, -2)}</strong>;
            if (/^`[^`]+`$/.test(part)) return <code key={j} className="rounded bg-white/8 px-1 py-0.5 font-mono text-[0.88em] text-cyan-200">{part.slice(1, -1)}</code>;
            if (/^\*[^*\n]+\*$/.test(part)) return <em key={j} className="text-slate-100">{part.slice(1, -1)}</em>;
            return <Fragment key={j}>{part}</Fragment>;
          })}
        </p>
      ))}
    </>
  );
}

function SqlBlock({ title, sql }: { title: string; sql: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(sql).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="overflow-hidden rounded-xl border border-white/8 bg-black/30">
      <div className="flex items-center justify-between border-b border-white/8 pl-3 pr-1">
        <span className="label">{title}</span>
        <button onClick={copy} className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[11.5px] text-slate-400 hover:text-white">
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="thin-scroll max-h-64 overflow-auto p-3 font-mono text-[11.5px] leading-relaxed text-slate-300">{sql}</pre>
    </div>
  );
}

function TableChip({ name, suffix }: { name: string; suffix?: string }) {
  return (
    <button onClick={() => selectTable(name, { fly: true, expand: true })} className="rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[11.5px] text-slate-200 hover:border-cyan-400/50 hover:text-cyan-200">
      {name}
      {suffix && <span className="ml-1 text-slate-500">{suffix}</span>}
    </button>
  );
}

function BlockView({ block }: { block: Block }) {
  const setResult = useUi((s) => s.setResult);
  const activeSql = useScene((s) => s.trace?.sql);
  const traceStep = useScene((s) => s.traceStep);
  switch (block.kind) {
    case 'sql':
      return <SqlBlock title={block.title} sql={block.sql} />;
    case 'checks':
      return (
        <div className="rounded-xl border border-white/8 bg-white/[0.02] p-2.5">
          <div className="label mb-1">What I understood</div>
          <p className="mb-2.5 text-[13px] leading-snug text-slate-200">{block.understood}</p>
          <div className="label mb-1">Checked</div>
          <ul className="space-y-1">
            {block.checks.map((c, i) => (
              <li key={i} className="flex gap-2 text-[12.5px] leading-snug">
                {c.ok ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" aria-label="verified" /> : <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" aria-label="check this" />}
                <span className={c.ok ? 'text-slate-400' : 'text-amber-100'}>{c.text}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    case 'result': {
      const { columns, rows, total, scanned } = block.result;
      const shown = rows.slice(0, 8);
      const open = () => setResult({ result: block.result, sql: block.sql });
      return (
        <div className="overflow-hidden rounded-xl border border-white/8 bg-white/[0.02]">
          <div className="flex items-center justify-between gap-2 pl-2.5 pr-1 pt-1">
            <span className="label">Result · mock data</span>
            <span className="flex min-w-0 items-center gap-1 font-mono text-[11px] text-slate-500">
              <span className="truncate">
                {total.toLocaleString('en-US')} row{total === 1 ? '' : 's'} · {scanned.toLocaleString('en-US')} read
              </span>
              {rows.length > 0 && (
                <button onClick={open} {...tip('Open as a table', 'Sort, filter, hide columns and export the rows.')} className="ml-1 flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-cyan-400/30 bg-cyan-400/[0.07] px-2 font-sans text-[12px] font-medium text-cyan-100 hover:border-cyan-300/60 hover:bg-cyan-400/15">
                  <Maximize2 className="h-3.5 w-3.5" /> Open table
                </button>
              )}
            </span>
          </div>
          {rows.length ? (
            <div className="thin-scroll mt-1 cursor-pointer overflow-x-auto" onClick={open}>
              <table className="w-max min-w-full font-mono text-[11.5px]">
                <thead>
                  <tr className="border-y border-white/8 bg-white/[0.03] text-left text-slate-400">
                    {columns.map((c, i) => (
                      <th key={i} className="px-2.5 py-1.5 font-medium">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r, i) => (
                    <tr key={i} className="border-b border-white/5 text-slate-200 last:border-0">
                      {r.map((v, j) => (
                        <td key={j} className={`max-w-[190px] truncate px-2.5 py-1 ${typeof v === 'number' ? 'text-right text-cyan-100' : ''}`}>
                          {v === null ? <span className="text-slate-600">null</span> : typeof v === 'number' ? v.toLocaleString('en-US') : String(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="px-2.5 py-2 text-[12.5px] text-slate-400">No rows match in the mock data.</p>
          )}
          <p className="border-t border-white/8 px-2.5 py-1.5 text-[11.5px] leading-snug text-slate-500">
            {rows.length > shown.length && (
              <button onClick={open} className="mr-1 text-cyan-300 underline decoration-cyan-300/30 underline-offset-2 hover:text-cyan-100">
                First {shown.length} of {rows.length} — see all
              </button>
            )}
            Run in the browser on invented rows, to show the query's shape — not your data.
          </p>
        </div>
      );
    }
    case 'whatif': {
      const sum = (steps: PlanStep[]) => steps.reduce((n, s) => n + s.rowsRead, 0);
      return (
        <div className="rounded-xl border border-teal-300/25 bg-teal-300/[0.04] p-2.5">
          <div className="label mb-1.5 !text-teal-300">What-if · nothing changed in the database</div>
          {block.before && block.after ? (
            <div className="grid grid-cols-2 gap-2">
              {([['Before', block.before], ['With the index', block.after]] as const).map(([title, steps]) => (
                <div key={title} className="rounded-lg bg-black/25 p-2">
                  <div className="label">{title}</div>
                  <div className="font-display text-lg font-semibold text-slate-50">~{formatRows(sum(steps))}</div>
                  <div className="text-[11.5px] text-slate-400">rows read</div>
                  <div className="mt-1.5 flex gap-1">
                    {steps.map((s, i) => (
                      <span key={i} {...tip(s.table, s.note)} className="h-1.5 flex-1 rounded-full" style={{ background: scanColor(s) }} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[12.5px] leading-snug text-slate-300">Trace a query to see what the index changes in its plan.</p>
          )}
          {block.resolved > 0 && (
            <p className="mt-2 text-[12.5px] text-slate-300">
              {block.resolved} audit finding{block.resolved === 1 ? '' : 's'} would be resolved.
            </p>
          )}
          <pre className="thin-scroll mt-2 overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[11.5px] leading-relaxed text-slate-300">{block.sql}</pre>
        </div>
      );
    }
    case 'tables':
      return (
        <div className="flex flex-wrap gap-1.5">
          {block.tables.map((t) => (
            <TableChip key={t} name={t} />
          ))}
        </div>
      );
    case 'findings':
      return (
        <ul className="space-y-1.5">
          {block.findings.map((f, i) => (
            <li key={i}>
              <button onClick={() => selectTable(f.table, { fly: true, expand: true })} className="flex w-full gap-2.5 rounded-xl border border-white/8 bg-white/[0.02] p-2.5 text-left hover:border-white/20">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" style={{ color: SEVERITY_COLOR[f.severity] }} aria-label={f.severity} />
                <span className="min-w-0">
                  <span className="block font-mono text-[12px] text-slate-100">
                    {f.table}
                    {f.column && <span className="text-slate-400">.{f.column}</span>}
                    <span className="label ml-2" style={{ color: SEVERITY_COLOR[f.severity] }}>
                      {RULE_LABEL[f.rule]}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-[12.5px] leading-snug text-slate-400">{f.detail}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      );
    case 'plan': {
      const live = activeSql === block.sql;
      return (
        <div className="rounded-xl border border-white/8 bg-white/[0.02] p-2.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="label">Simulated plan · {block.steps.length} steps</span>
            {!live && (
              <button onClick={() => startTrace({ label: block.label, sql: block.sql, steps: block.steps })} {...tip('Replay the trace', 'Animate this plan across the tables again.')} className="flex h-7 items-center gap-1 rounded-lg border border-white/10 px-2 text-[11.5px] text-slate-300 hover:text-white">
                <Play className="h-3 w-3" /> Replay
              </button>
            )}
          </div>
          <ol className="space-y-1">
            {block.steps.map((s, i) => (
              <li key={i} className={`flex items-start gap-2 rounded-lg px-1.5 py-1 transition-colors ${live && traceStep === i ? 'bg-white/8' : ''}`}>
                <span className="mt-[5px] h-2 w-2 shrink-0 rounded-full" style={{ background: scanColor(s), boxShadow: live && traceStep === i ? `0 0 10px ${scanColor(s)}` : undefined }} />
                <span className="min-w-0 text-[12.5px] leading-snug">
                  <span className="font-mono text-slate-100">{s.table}</span>{' '}
                  <span className="font-mono text-[11px]" style={{ color: scanColor(s) }}>
                    {s.scan === 'index' ? 'index scan' : s.slow ? 'SEQ SCAN · slow' : 'seq scan'}
                  </span>
                  <span className="block text-slate-400">
                    {s.note} · ~{formatRows(s.rowsRead)} rows
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <details className="mt-2">
            <summary className="label cursor-pointer select-none py-1 hover:text-slate-300">Query</summary>
            <pre className="thin-scroll mt-1 overflow-auto rounded-lg bg-black/30 p-2.5 font-mono text-[11.5px] leading-relaxed text-slate-300">{block.sql}</pre>
          </details>
        </div>
      );
    }
    case 'ghosts':
      return (
        <div className="rounded-xl border border-teal-300/25 bg-teal-300/[0.04] p-2.5">
          <div className="label mb-1.5 !text-teal-300">
            Ghost preview · {block.table}: {block.before} → {block.after} columns
          </div>
          <ul className="space-y-1.5">
            {block.ghosts.map((g) => (
              <li key={g.name} className="text-[12.5px] leading-snug">
                <span className="font-mono text-teal-200">{g.name}</span> <span className="text-slate-500">· {g.columns.length} columns</span>
                <span className="block text-slate-400">{g.reason}</span>
              </li>
            ))}
          </ul>
          <button onClick={() => focusTables([block.table], `Refactor · ${block.table}`, [...ghostPositions(block.ghosts, positionsOf(useScene.getState())).values()])} className="mt-2 text-[12px] text-teal-300 underline decoration-teal-300/30 underline-offset-2 hover:text-teal-100">
            Fly to the preview
          </button>
        </div>
      );
    case 'seed':
      return (
        <div className="rounded-xl border border-white/8 bg-white/[0.02] p-2.5">
          <div className="label mb-1.5">Insert order · parents first · mock data</div>
          <div className="flex flex-wrap items-center gap-1">
            {block.order.map((t, i) => (
              <Fragment key={t}>
                {i > 0 && <span className="text-slate-600">→</span>}
                <TableChip name={t} suffix={`+${block.counts[t]}`} />
              </Fragment>
            ))}
          </div>
        </div>
      );
  }
}

function MessageView({ m, last, busy }: { m: Message; last: boolean; busy: boolean }) {
  const followUps = useSettings((s) => s.followUps);
  if (m.role === 'user') {
    return (
      <div className="rise flex justify-end">
        <div className="max-w-[86%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-cyan-400/15 px-3.5 py-2 text-[14px] leading-relaxed text-slate-100">{m.text}</div>
      </div>
    );
  }
  const working = m.status === 'working';
  return (
    <div className="rise space-y-2">
      <StepsView m={m} />
      {(m.text || working) && (
        <div className={`space-y-2 text-[14px] leading-relaxed ${m.status === 'error' ? 'text-rose-200' : 'text-slate-300'}`}>
          {m.text ? <Rich text={m.text} /> : !m.steps.length && <span className="text-slate-500">Thinking…</span>}
          {working && m.text && <span className="blink inline-block h-3.5 w-1.5 translate-y-0.5 bg-cyan-300" aria-hidden />}
        </div>
      )}
      {m.blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
      {last && !busy && followUps && m.next && m.next.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {m.next.map((n) => (
            <button key={n.label} onClick={() => void send(n.label, n.call)} {...tip('A suggested next step', 'Runs this tool directly. Switch these off in Settings.')} className="flex min-h-8 items-center gap-1.5 rounded-full border border-violet-300/30 bg-violet-400/[0.08] px-3 py-1 text-left text-[12.5px] font-medium text-violet-100 hover:border-violet-200/60 hover:bg-violet-400/15">
              <CornerDownRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {n.label}
            </button>
          ))}
        </div>
      )}
      {m.status === 'stopped' && <div className="label">stopped</div>}
      {m.status === 'done' && m.tokPerSec != null && <div className="label">written by the model · {m.tokPerSec.toFixed(0)} tok/s · on this device</div>}
    </div>
  );
}

function Empty({ scripted, children }: { scripted: boolean; children: ReactNode }) {
  const showDrawer = useUi((s) => s.showDrawer);
  return (
    <div className="px-1 pt-2">
      <div className="mb-3 grid h-11 w-11 place-items-center rounded-2xl border border-cyan-400/25 bg-cyan-400/10">
        <Sparkles className="h-5 w-5 text-cyan-300" />
      </div>
      <h3 className="font-display text-lg font-semibold text-slate-50">Ask about this database</h3>
      <p className="mt-1 text-[13.5px] leading-relaxed text-slate-400">
        The architect acts on the 3D scene: it flies the camera, traces queries along the relationship lines, pins warnings on tables and previews refactors as ghost tables.
      </p>
      <p className="mt-2 text-[12.5px] leading-relaxed text-slate-500">
        It works through {TOOLS.length} tools and cannot touch a real database. See{' '}
        <button onClick={() => showDrawer('profile')} className="text-cyan-300 underline decoration-cyan-300/30 underline-offset-2 hover:text-cyan-100">
          what it is
        </button>{' '}
        and{' '}
        <button onClick={() => showDrawer('tools')} className="text-cyan-300 underline decoration-cyan-300/30 underline-offset-2 hover:text-cyan-100">
          what it can do
        </button>
        .
      </p>
      {scripted && (
        <p className="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/[0.06] p-3 text-[12.5px] leading-snug text-amber-100/90">
          <strong className="font-semibold">Scripted mode.</strong> No model is loaded, so requests are matched by keyword and answers are templates. The prompts below work fully. For free-form questions, load a model from the top bar.
        </p>
      )}
      <div className="mt-4">{children}</div>
    </div>
  );
}

const TABS: { id: DrawerTab; label: string; icon: ReactNode; desc: string; keys?: string }[] = [
  { id: 'chat', label: 'Chat', icon: <MessageSquare className="h-3.5 w-3.5" />, desc: 'Ask, and watch each answer’s steps.', keys: 'ask' },
  { id: 'profile', label: 'Profile', icon: <UserRound className="h-3.5 w-3.5" />, desc: 'What the Architect is: its model, its exact instructions, what it can see, and the rules it follows.', keys: 'profile' },
  { id: 'tools', label: 'Tools', icon: <Wrench className="h-3.5 w-3.5" />, desc: 'Everything it can do, what each tool leaves in the scene, and how to undo it.', keys: 'tools' },
];

/** What the agent is doing this moment, and the standing fact that it runs here. */
function StatusLine() {
  const busy = useChat((s) => s.busy);
  const running = useChat((s) => (s.busy ? s.messages[s.messages.length - 1]?.steps.find((x) => x.status === 'running') : undefined));
  const loading = useEngine((s) => s.status === 'loading');
  const loaded = useEngine((s) => (s.status === 'ready' ? MODELS.find((m) => m.id === s.loadedId) : undefined));
  const showDrawer = useUi((s) => s.showDrawer);
  const text = busy ? `${running?.title ?? 'Working'}…` : loading ? 'Loading the model…' : loaded ? `Idle · ${loaded.name} runs on this device` : 'Idle · scripted mode: keywords, no model';
  return (
    <button
      onClick={() => showDrawer('profile')}
      {...tip('What the Architect is doing', 'It only acts when you ask. Nothing you type leaves this device. Click for its full profile.', 'profile')}
      className="flex w-full items-center gap-1.5 px-1 text-left font-mono text-[10.5px] text-slate-500 hover:text-slate-300"
    >
      {busy ? <LoaderCircle className="h-3 w-3 shrink-0 animate-spin text-cyan-300" /> : <span className={`mx-[3px] h-1.5 w-1.5 shrink-0 rounded-full ${loaded ? 'bg-emerald-400' : 'bg-amber-300'}`} />}
      <span className="min-w-0 flex-1 truncate" aria-live="polite">
        {text}
      </span>
      <ShieldCheck className="h-3 w-3 shrink-0 text-emerald-300/80" aria-hidden />
      <span className="shrink-0">private</span>
    </button>
  );
}

export function AiDrawer({ phone }: { phone: boolean }) {
  const open = useUi((s) => s.drawerOpen);
  const tab = useUi((s) => s.drawerTab);
  const showDrawer = useUi((s) => s.showDrawer);
  const focusNonce = useUi((s) => s.composerFocus);
  const setDrawer = useUi((s) => s.setDrawer);
  const setModels = useUi((s) => s.setModels);
  const messages = useChat((s) => s.messages);
  const busy = useChat((s) => s.busy);
  const schema = useScene((s) => s.schema);
  const loaded = useEngine((s) => (s.status === 'ready' ? MODELS.find((m) => m.id === s.loadedId) : undefined));
  const hotkeys = useSettings((s) => s.hotkeys);
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const chips = useMemo(() => chipsFor(schema), [schema]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, tab]);

  // the / key (and anything else that asks for the message box)
  useEffect(() => {
    if (focusNonce) composer.current?.focus();
  }, [focusNonce]);

  if (!open) return null;
  const submit = () => {
    if (busy || !draft.trim()) return;
    void send(draft);
    setDraft('');
  };
  const chipRow = (wrap: boolean) => (
    <div className={wrap ? 'flex flex-wrap gap-2' : 'no-scrollbar -mx-3 flex gap-2 overflow-x-auto px-3'}>
      {chips.map((c, i) => (
        <button
          key={c.label}
          disabled={busy}
          onClick={() => void send(c.label, c.call)}
          {...tip(c.label, `Runs ${c.call.tool} directly: a one-click prompt names its tool, so nothing is guessed.`, hotkeys && !phone ? String(i + 1) : undefined)}
          className="h-9 shrink-0 rounded-full border border-cyan-400/25 bg-cyan-400/[0.07] px-3.5 text-[12.5px] font-medium text-cyan-100 hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:opacity-40"
        >
          {c.label}
        </button>
      ))}
    </div>
  );

  return (
    <section
      aria-label="AI Architect"
      className={`glass absolute z-30 flex flex-col overflow-hidden ${
        phone ? 'inset-x-0 bottom-0 h-(--sheet-h) rounded-t-3xl !border-x-0 !border-b-0' : 'bottom-3 right-3 top-[62px] w-[calc(var(--drawer-w)-12px)] rounded-2xl'
      }`}
    >
      {phone && <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-white/15" aria-hidden />}
      <header className="flex shrink-0 items-center gap-2 px-3.5 pb-1.5 pt-2.5">
        <Sparkles className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden />
        <h2 className="font-display shrink-0 whitespace-nowrap text-[15px] font-semibold text-slate-50">AI Architect</h2>
        <button
          onClick={() => setModels(true)}
          data-models-toggle
          {...tip(loaded ? `Running ${loaded.name}` : 'Scripted mode', loaded ? 'A language model running inside this page chooses tools and explains results. Click to change it.' : 'No model is loaded: requests are matched by keyword and answers are templates. Click to load a model.', 'models')}
          className={`label ml-1 truncate rounded-full border px-2 py-0.5 ${loaded ? 'border-emerald-400/30 !text-emerald-300' : 'border-amber-300/30 !text-amber-200'}`}
        >
          {loaded ? loaded.name : 'scripted · no model'}
        </button>
        <div className="flex-1" />
        {messages.length > 0 && tab === 'chat' && (
          <button onClick={clearChat} disabled={busy} aria-label="Clear the conversation" {...tip('Clear the conversation', 'Removes the messages. What is in the scene stays; the session counts in Profile stay.')} className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white disabled:opacity-30">
            <Trash2 className="h-4 w-4" />
          </button>
        )}
        <button onClick={() => setDrawer(false)} aria-label="Close the AI drawer" {...tip('Hide the AI Architect', 'The scene takes the space.', 'drawer')} className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </header>

      <div role="tablist" aria-label="AI Architect views" className="flex shrink-0 gap-1 border-b border-white/8 px-3 pb-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => showDrawer(t.id)}
            {...tip(t.label, t.desc, t.keys)}
            className={`flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-[12.5px] font-medium transition-colors ${tab === t.id ? 'bg-cyan-400/12 text-cyan-200' : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'}`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'profile' ? (
        <ProfileTab />
      ) : tab === 'tools' ? (
        <ToolsTab />
      ) : (
        <>
          <div ref={scroller} className="thin-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-3.5 py-3.5" aria-live="polite">
            {messages.length === 0 ? <Empty scripted={!loaded}>{chipRow(true)}</Empty> : messages.map((m, i) => <MessageView key={m.id} m={m} last={i === messages.length - 1} busy={busy} />)}
          </div>

          <footer className="shrink-0 space-y-2 border-t border-white/8 px-3 pb-[max(10px,env(safe-area-inset-bottom))] pt-2.5">
            {messages.length > 0 && chipRow(false)}
            <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-black/25 p-1.5 pl-3 transition-colors focus-within:bg-black/45">
              <textarea
                ref={composer}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submit();
                  } else if (e.key === 'Escape') {
                    // first Esc stops a running answer; otherwise it hands the keyboard back to the scene's shortcuts
                    if (busy) stop();
                    else e.currentTarget.blur();
                  }
                }}
                rows={1}
                placeholder={loaded ? 'Ask for a query, or paste one to trace' : 'Try “audit the schema”, or ask for a query'}
                aria-label="Message the AI architect"
                className="max-h-32 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-snug text-slate-100 !outline-none placeholder:text-slate-500 [field-sizing:content]"
              />
              {!draft && !busy && hotkeys && !phone && <Keys keys="/" className="mb-2 opacity-60" />}
              {busy ? (
                <button onClick={stop} aria-label="Stop" {...tip('Stop', 'Stops the Architect where it is. What a tool already put in the scene stays.', 'Escape')} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/10 text-slate-100 hover:bg-white/15">
                  <Square className="h-3.5 w-3.5 fill-current" />
                </button>
              ) : (
                <button onClick={submit} disabled={!draft.trim()} aria-label="Send" {...tip('Send', 'Shift+Enter starts a new line.', 'Enter')} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-cyan-400 text-slate-950 hover:bg-cyan-300 disabled:opacity-30">
                  <ArrowUp className="h-4 w-4" />
                </button>
              )}
            </div>
            <StatusLine />
          </footer>
        </>
      )}
    </section>
  );
}
