// The AI Architect's dossier: two tabs of the drawer that say plainly what
// the agent is and what it can do.
//
// Profile: where it runs and on what model, what leaves this device (nothing),
// what it has put in the scene, the exact prompts it is given, what it can
// see of the database right now, the rules the loop enforces around the
// model, what it cannot do, and a log of what it did this session.
//
// Tools: every function it can call, read from the same registry the agent
// uses (agent/tools.ts), so this list cannot drift from what actually runs.

import { Check, ChevronRight, Copy, Eye, FlaskConical, Play, ScanSearch, Settings2, ShieldCheck, Sparkles, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { chipsFor } from '../agent/chips';
import { ANSWER, answerMessages, decisionState, fillArgsMessages, FIRST_QUESTION, firstOptions, narrateMessages, NEXT_QUESTION, nextOptions, schemaDigest } from '../agent/prompt';
import { decisionMessages } from '../llm/decide';
import { TOOLS, type Tool, type ToolCall, type ToolEffect } from '../agent/tools';
import { MODELS, useEngine } from '../llm/engine';
import { edgesOf } from '../schema/graph';
import type { SchemaDef } from '../schema/types';
import { send, useChat } from '../state/chat';
import { clearBadges, clearFocus, clearGhosts, clearTrace, clearWhatIf, useScene } from '../state/scene';
import { useSettings } from '../state/settings';
import { useUi } from '../state/ui';
import { ByBadge, duration } from './AgentSteps';
import { tip } from './Tooltip';

export const EFFECT: Record<ToolEffect, { label: string; note: string; cls: string; icon: ReactNode }> = {
  view: { label: 'Guide', note: 'moves the camera and the highlight; changes nothing else', cls: 'border-cyan-300/30 bg-cyan-400/10 text-cyan-200', icon: <Eye className="h-3.5 w-3.5" /> },
  analyze: { label: 'Analyze', note: 'reads the schema and reports; what it shows is worked out by code', cls: 'border-violet-300/30 bg-violet-400/10 text-violet-200', icon: <ScanSearch className="h-3.5 w-3.5" /> },
  preview: { label: 'Preview', note: 'adds something pretend to the scene, in memory, until you dismiss it', cls: 'border-teal-300/30 bg-teal-300/10 text-teal-200', icon: <FlaskConical className="h-3.5 w-3.5" /> },
};

/** Rough token count of a prompt (about four characters a token in English). */
const tokens = (text: string) => Math.round(text.length / 4);

function SectionHead({ n, title, sub }: { n: string; title: string; sub: string }) {
  return (
    <div className="mb-2 mt-6 flex items-baseline gap-2 border-b border-white/8 pb-1.5">
      <span className="font-mono text-[10px] text-cyan-300/80">{n}</span>
      <h3 className="font-display text-[13.5px] font-semibold text-slate-100">{title}</h3>
      <span className="min-w-0 truncate text-[11.5px] text-slate-500">{sub}</span>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
      className="flex h-7 shrink-0 items-center gap-1 rounded-lg px-1.5 text-[11.5px] text-slate-400 hover:text-white"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function Directive({ code, title, role, text }: { code: string; title: string; role: string; text: string }) {
  return (
    <details className="group rounded-xl border border-white/8 bg-white/[0.02]">
      <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-2.5 py-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform group-open:rotate-90" />
        <span className="font-mono text-[10.5px] text-violet-300">{code}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-semibold text-slate-100">{title}</span>
          <span className="block text-[11.5px] leading-snug text-slate-500">{role}</span>
        </span>
        <span className="shrink-0 font-mono text-[10.5px] text-slate-500">≈{tokens(text)} tok</span>
      </summary>
      <div className="border-t border-white/8">
        <div className="flex justify-end pr-1 pt-0.5">
          <CopyButton text={text} />
        </div>
        <pre className="thin-scroll max-h-64 overflow-auto whitespace-pre-wrap break-words px-2.5 pb-2.5 font-mono text-[11px] leading-relaxed text-slate-300">{text}</pre>
      </div>
    </details>
  );
}

function Tile({ k, v, sub }: { k: string; v: string; sub: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.02] px-2.5 py-2">
      <div className="label">{k}</div>
      <div className="font-display text-lg font-semibold leading-tight text-slate-50">{v}</div>
      <div className="text-[11px] leading-snug text-slate-500">{sub}</div>
    </div>
  );
}

/** What the agent has put in the scene, each with the way to take it away. */
function InScene() {
  const trace = useScene((s) => s.trace);
  const focusLabel = useScene((s) => s.focusLabel);
  const findings = useScene((s) => s.findings.length);
  const ghosts = useScene((s) => s.ghosts.length);
  const whatIf = useScene((s) => s.whatIf.length);
  const seeded = useScene((s) => Object.keys(s.samples).length);
  const items: { color: string; text: string; clear?: () => void; label?: string }[] = [
    ...(trace ? [{ color: '#67e8f9', text: `A simulated trace · ${trace.label}`, clear: clearTrace, label: 'Stop the trace' }] : []),
    ...(focusLabel && !focusLabel.startsWith('Trace') ? [{ color: '#a78bfa', text: `A focus · ${focusLabel}`, clear: clearFocus, label: 'Clear the focus' }] : []),
    ...(findings ? [{ color: '#fbbf24', text: `${findings} warning badge${findings === 1 ? '' : 's'}`, clear: clearBadges, label: 'Remove the badges' }] : []),
    ...(ghosts ? [{ color: '#5eead4', text: `${ghosts} ghost table${ghosts === 1 ? '' : 's'} (a refactor preview)`, clear: clearGhosts, label: 'Remove the ghosts' }] : []),
    ...(whatIf ? [{ color: '#5eead4', text: `${whatIf} what-if index${whatIf === 1 ? '' : 'es'}`, clear: () => void clearWhatIf(), label: 'Remove the what-if indexes' }] : []),
    ...(seeded ? [{ color: '#34d399', text: `Mock rows in ${seeded} table${seeded === 1 ? '' : 's'} · in memory until you switch database or reload` }] : []),
  ];
  if (!items.length) return <p className="text-[12.5px] leading-snug text-slate-500">Nothing. The scene shows the schema as it is.</p>;
  return (
    <ul className="space-y-1">
      {items.map((it) => (
        <li key={it.text} className="flex min-h-8 items-center gap-2 rounded-lg border border-white/8 bg-white/[0.02] pl-2.5 pr-1 text-[12.5px] text-slate-200">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: it.color }} />
          <span className="min-w-0 flex-1 py-1 leading-snug">{it.text}</span>
          {it.clear && (
            <button onClick={it.clear} aria-label={it.label} {...tip(it.label!)} className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function SessionLog() {
  const messages = useChat((s) => s.messages);
  const rows = useMemo(
    () =>
      messages
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => m.steps.map((s, i) => ({ key: `${m.id}.${i}`, at: m.at, step: s })))
        .reverse()
        .slice(0, 40),
    [messages],
  );
  if (!rows.length) return <p className="text-[12.5px] leading-snug text-slate-500">Nothing yet. Every step the Architect takes is listed here, newest first, with who decided it.</p>;
  return (
    <ol className="space-y-1">
      {rows.map(({ key, at, step }) => (
        <li key={key} className="flex items-center gap-2 text-[12px]">
          <span className="w-10 shrink-0 font-mono text-[10.5px] text-slate-600">{new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <span className={`min-w-0 flex-1 truncate ${step.status === 'ok' ? 'text-slate-300' : 'text-amber-200'}`}>{step.title}</span>
          <ByBadge by={step.by} />
          <span className="w-12 shrink-0 text-right font-mono text-[10.5px] text-slate-600">{step.ms != null ? duration(step.ms) : ''}</span>
        </li>
      ))}
    </ol>
  );
}

const PROTOCOLS = [
  'There is no connection to any database. Everything it shows is worked out from a schema held in this browser, so it cannot change, read or damage your data.',
  'The model only chooses: which tool, and with what arguments. The work itself (the lookups, the audit, the plan, the SQL, the refactor) is done by code, the same way every time.',
  'Its choice is held to a grammar: one letter out of the options offered (or, with that switched off, a tool name from the list). Arguments are held to a grammar built from this database, so a table that doesn’t exist cannot be written, and they are validated again afterwards.',
  'One answer may run several tools, up to the number set in Settings. After the first, it is offered only tools that read and report, and only ones it has not run. Anything that adds to the scene (a what-if index, ghost tables, mock rows) is never chained: it stays your click.',
  'A further step needs most of the model’s weight behind it. A choice it only leans towards is not taken, and the turn answers from what it has.',
  'Names you type win over the model’s guess. If your request names a table, that table is used.',
  'When the model fails, or says no tool is needed for a request that plainly matches one, fixed keyword rules decide instead, and the answer says so.',
  'SQL is never written free-hand by the model. It describes the query as a checked form; code compiles it, reads it back, plans it and runs it on invented rows.',
  'Explanations are written from the tool’s facts only. A small model can still misstate one: the cards under an answer come from code, so trust them over the prose.',
  'Nothing is applied. Indexes are what-ifs, refactors are ghost previews, data is mock. Each can be dismissed.',
];

const LIMITS = [
  'It cannot connect to a database, run a query on real data, or apply a migration. You copy the SQL and decide.',
  'Query plans are simulated from row counts and indexes. They are not EXPLAIN output from a real server.',
  'Query results come from invented rows, to show a query’s shape. They are not your data.',
  'It does not browse the web or call any service. It knows the schema summary below, what its lookup tools read from the schema, and general SQL knowledge baked into the model.',
  'It does not remember: the conversation lives in this tab and is gone on reload. Only free-form answers see earlier messages, and only the last four.',
  'The models are small (0.6–1.7 billion parameters). They misread vague requests. Check the “What I understood” card, or use a one-click prompt.',
  'In scripted mode there is no understanding at all: keywords are matched and answers are templates.',
];

export function ProfileTab() {
  const schema = useScene((s) => s.schema);
  const session = useChat((s) => s.session);
  const status = useEngine((s) => s.status);
  const info = useEngine((s) => s.info);
  const tokPerSec = useEngine((s) => s.tokPerSec);
  const loaded = useEngine((s) => (s.status === 'ready' ? MODELS.find((m) => m.id === s.loadedId) : undefined));
  const modelPicks = useSettings((s) => s.modelPicks);
  const narrate = useSettings((s) => s.narrate);
  const setModels = useUi((s) => s.setModels);
  const setSettings = useUi((s) => s.setSettings);
  const showDrawer = useUi((s) => s.showDrawer);

  const calls = Object.values(session.calls).reduce((n, c) => n + (c ?? 0), 0);
  const count = (e: ToolEffect) => TOOLS.filter((t) => t.effect === e).length;
  const prompts = useMemo(() => {
    const example = TOOLS.find((t) => t.then?.length) ?? TOOLS[0];
    return {
      router: decisionMessages(decisionState(schema, ''), FIRST_QUESTION, firstOptions(TOOLS))[1].content,
      next: decisionMessages(decisionState(schema, '', [{ tool: example.name, args: {}, ok: true, facts: '(what the tool found)' }]), NEXT_QUESTION, nextOptions((example.then ?? []).flatMap((n) => TOOLS.find((t) => t.name === n) ?? [])))[1].content,
      args: fillArgsMessages(schema, example, '')[0].content,
      narrate: narrateMessages(schema, '', example, '')[0].content,
      answer: answerMessages(schema, [], '')[0].content,
      example: example.name,
    };
  }, [schema]);
  const digest = useMemo(() => schemaDigest(schema), [schema]);

  return (
    <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-3.5 pb-6 pt-3.5">
      <section className="flex items-center gap-3">
        <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl border border-cyan-400/25 bg-[radial-gradient(circle_at_30%_25%,rgb(34_211_238/0.28),transparent_70%)]">
          <Sparkles className="h-6 w-6 text-cyan-300" />
        </div>
        <div className="min-w-0">
          <div className="label">Who you are talking to</div>
          <div className="font-display text-xl font-semibold leading-tight text-slate-50">AI Architect</div>
          <p className="text-[12.5px] leading-snug text-slate-400">A small language model inside this page, steering {TOOLS.length} tools written in ordinary code.</p>
        </div>
      </section>

      <div className={`mt-3 rounded-xl border p-2.5 ${loaded ? 'border-emerald-400/30 bg-emerald-400/[0.05]' : 'border-amber-300/25 bg-amber-300/[0.05]'}`}>
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${loaded ? 'bg-emerald-400' : status === 'loading' ? 'animate-pulse bg-amber-400' : 'bg-amber-300'}`} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-100">{loaded ? `Model mode · ${loaded.name}` : status === 'loading' ? 'Loading a model…' : 'Scripted mode · no model'}</span>
          <button onClick={() => setModels(true)} data-models-toggle {...tip('Local model', 'Download, load or unload the model that runs in this browser.', 'models')} className="h-7 shrink-0 rounded-lg border border-white/10 px-2 text-[11.5px] font-medium text-slate-200 hover:bg-white/5">
            {loaded ? 'Change' : 'Load a model'}
          </button>
        </div>
        <p className="mt-1.5 text-[12px] leading-snug text-slate-400">
          {loaded
            ? `${modelPicks ? 'The model reads your request, chooses a tool and writes its arguments' : 'Keyword rules choose the tool (model choice is off in Settings)'}; ${narrate ? 'then it explains the result in its own words' : 'the tool’s own summary is the answer (model explanations are off in Settings)'}.`
            : 'Your request is matched against keyword patterns and answers are templates. Nothing here understands language until a model is loaded. The one-click prompts work fully.'}
        </p>
        {loaded && info && (
          <p className="mt-1.5 font-mono text-[10.5px] leading-relaxed text-slate-500">
            {loaded.family} · {info.backend} · {info.threads} · {info.context} tok context
          </p>
        )}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <Tile k="Tools" v={String(TOOLS.length)} sub={`${count('view')} guide · ${count('analyze')} analyze · ${count('preview')} preview`} />
        <Tile k="Speed" v={tokPerSec ? `${Math.round(tokPerSec)} tok/s` : '—'} sub={tokPerSec ? 'last answer, on this device' : 'no answer written yet'} />
        <Tile k="Requests" v={String(session.turns)} sub="since this page opened" />
        <Tile k="Tool runs" v={String(calls)} sub={calls ? `${session.byModel} by model · ${session.byKeywords} keywords · ${session.byYou} you` : 'who chose each is counted here'} />
      </div>

      <div className="mt-2 flex gap-2.5 rounded-xl border border-white/8 bg-white/[0.02] p-2.5">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
        <div className="text-[12.5px] leading-snug text-slate-300">
          <strong className="font-semibold text-slate-100">Nothing you type leaves this device.</strong> Your messages, the schema and any DDL you import stay in this browser. The only download is the model file itself, once, from Hugging Face, checked against a pinned SHA-256 before it loads. No account, no telemetry.
        </div>
      </div>

      <div className="mt-2 flex gap-2">
        <button onClick={() => showDrawer('tools')} {...tip('What the Architect can do', undefined, 'tools')} className="h-8 flex-1 rounded-lg border border-white/10 text-[12px] font-medium text-slate-200 hover:bg-white/5">
          See its {TOOLS.length} tools
        </button>
        <button onClick={() => setSettings(true, 'agent')} {...tip('AI Architect settings', 'Choose how much the model decides, and what it shows.')} className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 text-[12px] font-medium text-slate-200 hover:bg-white/5">
          <Settings2 className="h-3.5 w-3.5" /> Change its behavior
        </button>
      </div>

      <SectionHead n="01" title="In the scene now" sub="what it has added, and how to remove it" />
      <InScene />

      <SectionHead n="02" title="Rules it works under" sub="enforced by the code around the model" />
      <ol className="space-y-1.5">
        {PROTOCOLS.map((p, i) => (
          <li key={i} className="flex gap-2 text-[12.5px] leading-snug text-slate-300">
            <span className="mt-px w-4 shrink-0 font-mono text-[10.5px] text-cyan-300/80">{i + 1}</span>
            {p}
          </li>
        ))}
      </ol>

      <SectionHead n="03" title="What it cannot do" sub="so you know when not to rely on it" />
      <ul className="space-y-1.5">
        {LIMITS.map((p, i) => (
          <li key={i} className="flex gap-2 text-[12.5px] leading-snug text-slate-300">
            <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-300/80" aria-hidden />
            {p}
          </li>
        ))}
      </ul>

      <SectionHead n="04" title="What it can see" sub={`the summary of ${schema.name} it is given`} />
      <div className="rounded-xl border border-white/8 bg-black/25">
        <div className="flex items-center justify-between pl-2.5 pr-1">
          <span className="label">live · ≈{tokens(digest)} tokens</span>
          <CopyButton text={digest} />
        </div>
        <pre className="thin-scroll max-h-52 overflow-auto whitespace-pre-wrap break-words px-2.5 pb-2.5 font-mono text-[11px] leading-relaxed text-slate-300">{digest}</pre>
      </div>
      <p className="mt-1.5 text-[11.5px] leading-snug text-slate-500">Table names by domain, the foreign keys, junction tables and unrelated tables. It is not given rows. Columns, types, keys and indexes reach it only through a lookup tool (describe_tables, relate_tables, inspect_indexes, find_columns).</p>

      <SectionHead n="05" title="Its instructions" sub="the exact prompts, in the order of a turn" />
      <div className="space-y-1.5">
        <Directive code="Δ1" title="Router" role={`Picks one tool, or “${ANSWER}”: as one letter, read from a single token.`} text={prompts.router} />
        <Directive code="Δ2" title="Argument writer" role={`Writes the chosen tool’s arguments as JSON. Shown for ${prompts.example}; each tool gets its own.`} text={prompts.args} />
        <Directive code="Δ3" title="Next step" role="After a tool has run: stop and answer, or run one more that reads and reports. Shown as it would be after the first tool." text={prompts.next} />
        <Directive code="Δ4" title="Explainer" role="Turns the tool’s facts into the 2–4 sentences you read. After several tools, one answer is written from all their facts." text={prompts.narrate} />
        <Directive code="Δ5" title="Free-form answer" role="Used when no tool fits: a general question about databases." text={prompts.answer} />
      </div>
      <p className="mt-1.5 text-[11.5px] leading-snug text-slate-500">Your request is appended to each as the user message. Unfold the steps under any answer to see the filled-in prompt and the model’s raw reply.</p>

      <SectionHead n="06" title="Session log" sub="every step this session, newest first" />
      <SessionLog />
    </div>
  );
}

// ── Tools ──

/** Stand-ins for the placeholders in a tool's examples, from the active database. */
function exampleWords(schema: SchemaDef): Record<string, string> {
  const rows = (name: string) => schema.tables.find((t) => t.name === name)?.rows ?? 0;
  const edge = edgesOf(schema)
    .filter((e) => e.from !== e.to)
    .sort((a, b) => rows(b.from) - rows(a.from))[0];
  const t = edge?.from ?? schema.tables[0]?.name ?? 'orders';
  return {
    t,
    p: edge?.to ?? t,
    fk: edge?.column ?? 'id',
    d: (schema.domains.find((d) => d.id === schema.tables.find((x) => x.name === t)?.domain) ?? schema.domains[0])?.label.toLowerCase() ?? 'main',
    q: schema.presets[0]?.id.replace(/_/g, ' ') ?? 'checkout',
  };
}

/** A way to run each tool with one click: its prompt chip, or a call that needs no arguments. */
function demoFor(tool: Tool, schema: SchemaDef): { label: string; call: ToolCall } | null {
  const chip = chipsFor(schema).find((c) => c.call.tool === tool.name);
  if (chip) return chip;
  if (tool.name === 'what_if_index') return { label: 'What if every missing index were added?', call: { tool: 'what_if_index', args: { columns: [] } } };
  if (tool.name === 'reset_view') return { label: 'Reset the view', call: { tool: 'reset_view', args: {} } };
  const w = exampleWords(schema);
  if (tool.name === 'describe_tables') return { label: `Describe ${w.t} and ${w.p}`, call: { tool: 'describe_tables', args: { tables: [w.t, w.p] } } };
  if (tool.name === 'relate_tables') return { label: `How do ${w.t} and ${w.p} relate?`, call: { tool: 'relate_tables', args: { tables: [w.t, w.p], depth: '2' } } };
  if (tool.name === 'inspect_indexes') return { label: 'Inspect every index', call: { tool: 'inspect_indexes', args: { tables: [] } } };
  if (tool.name === 'schema_overview') return { label: 'Overview of the schema', call: { tool: 'schema_overview', args: { domain: 'all' } } };
  if (tool.name === 'find_columns') return { label: `Which tables have a ${w.fk} column?`, call: { tool: 'find_columns', args: { columns: [w.fk], kind: 'any' } } };
  return null;
}

function ToolCard({ tool, schema, uses }: { tool: Tool; schema: SchemaDef; uses: number }) {
  const [open, setOpen] = useState(false);
  const busy = useChat((s) => s.busy);
  const showDrawer = useUi((s) => s.showDrawer);
  const spec = useMemo(() => tool.schema(schema), [tool, schema]);
  const words = useMemo(() => exampleWords(schema), [schema]);
  const demo = useMemo(() => demoFor(tool, schema), [tool, schema]);
  const params = Object.entries(spec.properties);
  const e = EFFECT[tool.effect];
  // the description opens with the verbs the model matches on; what follows the colon says what the tool does
  const summary = tool.description.split(': ')[1] ?? tool.description;
  const run = (label: string, call?: ToolCall) => {
    showDrawer('chat');
    void send(label, call);
  };

  return (
    <article className={`rounded-xl border bg-white/[0.02] ${open ? 'border-white/20' : 'border-white/8'}`}>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-start gap-2.5 p-2.5 text-left">
        <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border ${e.cls}`}>{e.icon}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-mono text-[12.5px] font-medium text-slate-100">{tool.name}</span>
            {uses > 0 && <span className="shrink-0 font-mono text-[10.5px] text-emerald-300">×{uses}</span>}
          </span>
          <span className="mt-0.5 block text-[12px] leading-snug text-slate-400">{summary.charAt(0).toUpperCase() + summary.slice(1)}</span>
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className={`inline-flex h-[18px] items-center rounded-full border px-1.5 font-mono text-[10px] uppercase tracking-wider ${e.cls}`}>{e.label}</span>
            <span className="font-mono text-[10.5px] text-slate-500">
              {params.length} argument{params.length === 1 ? '' : 's'}
            </span>
          </span>
        </span>
        <ChevronRight className={`mt-1 h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-white/8 p-2.5">
          <div>
            <div className="label mb-1">What it leaves in the scene</div>
            <p className="text-[12.5px] leading-snug text-slate-300">{tool.leaves}</p>
          </div>
          <div>
            <div className="label mb-1">How the model is told about it</div>
            <p className="rounded-lg bg-black/25 p-2 font-mono text-[11px] leading-relaxed text-slate-300">{tool.description}</p>
          </div>
          <div>
            <div className="label mb-1">Arguments · limited to this database</div>
            {params.length ? (
              <ul className="space-y-2">
                {params.map(([name, p]) => {
                  const values = p.type === 'array' ? p.items.enum : p.enum;
                  return (
                    <li key={name} className="text-[12px] leading-snug">
                      <code className="font-mono text-cyan-200">{name}</code>
                      <span className="ml-1.5 font-mono text-[10.5px] text-slate-500">
                        {p.type === 'array' ? `a list${p.maxItems ? `, up to ${p.maxItems}` : ''}` : 'one value'}
                        {values.length > 0 && ` · ${values.length} allowed value${values.length === 1 ? '' : 's'}`}
                      </span>
                      {p.description && <span className="block text-slate-400">{p.description}</span>}
                      {values.length > 0 && (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {values.slice(0, 10).map((v) => (
                            <span key={v} className="rounded border border-white/8 bg-white/[0.03] px-1 font-mono text-[10.5px] text-slate-300">
                              {v}
                            </span>
                          ))}
                          {values.length > 10 && <span className="font-mono text-[10.5px] text-slate-500">+{values.length - 10} more</span>}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-[12px] text-slate-500">None.</p>
            )}
          </div>
          <div>
            <div className="label mb-1">Ask for it like this</div>
            <div className="flex flex-wrap gap-1.5">
              {tool.examples.map((ex) => {
                const text = ex.replace(/\{(\w+)\}/g, (_, k: string) => words[k] ?? k);
                const runnable = !text.includes('…');
                return runnable ? (
                  <button key={ex} disabled={busy} onClick={() => run(text)} {...tip('Send this request', 'Typed for you into the conversation, so you can watch how it is routed.')} className="rounded-full border border-white/10 px-2.5 py-1 text-left text-[12px] italic text-slate-300 hover:border-cyan-300/50 hover:text-cyan-100 disabled:opacity-40">
                    “{text}”
                  </button>
                ) : (
                  <span key={ex} className="rounded-full border border-white/8 px-2.5 py-1 text-[12px] italic text-slate-400">
                    “{text}”
                  </span>
                );
              })}
            </div>
          </div>
          {demo && (
            <button disabled={busy} onClick={() => run(demo.label, demo.call)} className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/[0.07] text-[12.5px] font-medium text-cyan-100 hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:opacity-40">
              <Play className="h-3.5 w-3.5" /> Run it now · {demo.label}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

export function ToolsTab() {
  const schema = useScene((s) => s.schema);
  const calls = useChat((s) => s.session.calls);
  const [filter, setFilter] = useState<ToolEffect | 'all'>('all');
  const shown = TOOLS.filter((t) => filter === 'all' || t.effect === filter);
  const effects = ['view', 'analyze', 'preview'] as const;

  return (
    <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-3.5 pb-6 pt-3.5">
      <h3 className="font-display text-[15px] font-semibold text-slate-50">Everything it can do</h3>
      <p className="mt-1 text-[12.5px] leading-snug text-slate-400">
        These {TOOLS.length} tools are the Architect’s whole reach. It cannot do anything that is not on this list, and none of them touches a real database.
      </p>
      <dl className="mt-2.5 space-y-1">
        {effects.map((k) => (
          <div key={k} className="flex items-baseline gap-2 text-[12px] leading-snug">
            <dt className={`inline-flex h-[18px] w-[68px] shrink-0 items-center justify-center rounded-full border font-mono text-[10px] uppercase tracking-wider ${EFFECT[k].cls}`}>{EFFECT[k].label}</dt>
            <dd className="text-slate-400">{EFFECT[k].note}</dd>
          </div>
        ))}
      </dl>
      <div role="tablist" aria-label="Filter the tools" className="mt-3 flex gap-1 rounded-xl border border-white/8 bg-black/20 p-1">
        {(['all', ...effects] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={filter === k}
            onClick={() => setFilter(k)}
            className={`h-7 flex-1 rounded-lg text-[12px] font-medium ${filter === k ? 'bg-white/10 text-slate-50' : 'text-slate-400 hover:text-slate-200'}`}
          >
            {k === 'all' ? 'All' : EFFECT[k].label} <span className="font-mono text-[10.5px] text-slate-500">{k === 'all' ? TOOLS.length : TOOLS.filter((t) => t.effect === k).length}</span>
          </button>
        ))}
      </div>
      <div className="mt-2.5 space-y-2">
        {shown.map((t) => (
          <ToolCard key={t.name} tool={t} schema={schema} uses={calls[t.name] ?? 0} />
        ))}
      </div>
    </div>
  );
}
