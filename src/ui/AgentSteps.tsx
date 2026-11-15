// How an answer was reached, step by step: which tool, who chose it (the
// model, the keyword rules, or the user's own click), what code ran, what
// the model was sent and what it wrote back. Folded to one line under each
// answer; unfolded, every step can show its exact inputs and outputs.

import { Check, ChevronRight, Code2, Cpu, LoaderCircle, MousePointerClick, Regex, TriangleAlert, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { Step } from '../agent/run';
import type { Message } from '../state/chat';
import { useSettings } from '../state/settings';
import { tip } from './Tooltip';

export const BY: Record<Step['by'], { label: string; cls: string; icon: ReactNode; meaning: string }> = {
  model: { label: 'model', cls: 'border-violet-300/30 bg-violet-400/10 text-violet-200', icon: <Cpu className="h-3 w-3" />, meaning: 'Decided or written by the language model running on this device. It can be wrong.' },
  keywords: { label: 'keywords', cls: 'border-amber-300/30 bg-amber-300/10 text-amber-200', icon: <Regex className="h-3 w-3" />, meaning: 'Decided by fixed keyword rules: words in your request were matched against patterns. No understanding involved.' },
  you: { label: 'you', cls: 'border-cyan-300/30 bg-cyan-400/10 text-cyan-200', icon: <MousePointerClick className="h-3 w-3" />, meaning: 'You chose this outright with a one-click prompt, so nothing was guessed.' },
  code: { label: 'code', cls: 'border-white/12 bg-white/[0.04] text-slate-300', icon: <Code2 className="h-3 w-3" />, meaning: 'Done by ordinary code: the same input always gives the same result.' },
};

export function ByBadge({ by }: { by: Step['by'] }) {
  const b = BY[by];
  return (
    <span {...tip(`Decided by: ${b.label}`, b.meaning)} className={`inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border px-1.5 font-mono text-[10px] uppercase tracking-wider ${b.cls}`}>
      {b.icon}
      {b.label}
    </span>
  );
}

export const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function StatusIcon({ status }: { status: Step['status'] }) {
  if (status === 'running') return <LoaderCircle className="h-3.5 w-3.5 animate-spin text-cyan-300" aria-label="running" />;
  if (status === 'ok') return <Check className="h-3.5 w-3.5 text-emerald-300" aria-label="done" />;
  if (status === 'warn') return <TriangleAlert className="h-3.5 w-3.5 text-amber-300" aria-label="fell back" />;
  return <X className="h-3.5 w-3.5 text-rose-300" aria-label="failed" />;
}

function StepRow({ step, n }: { step: Step; n: number }) {
  return (
    <li className="relative pl-6">
      <span className="absolute left-0 top-0.5 grid h-[18px] w-[18px] place-items-center rounded-full bg-panel-2 ring-1 ring-white/10">
        <StatusIcon status={step.status} />
      </span>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-[10px] text-slate-600">{n}</span>
        <span className="text-[12.5px] font-medium text-slate-100">{step.title}</span>
        <ByBadge by={step.by} />
        {step.ms != null && <span className="ml-auto font-mono text-[10.5px] text-slate-500">{duration(step.ms)}</span>}
      </div>
      {step.note && <p className="mt-0.5 text-[12px] leading-snug text-slate-400">{step.note}</p>}
      {step.details?.map((d) => (
        <details key={d.label} className="group mt-1">
          <summary className="flex cursor-pointer select-none list-none items-center gap-1 text-[11.5px] text-slate-500 hover:text-slate-300 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
            {d.label}
          </summary>
          <pre className="thin-scroll mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/8 bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-slate-300">{d.text}</pre>
        </details>
      ))}
    </li>
  );
}

/** The trace of one answer. While the agent works, the line names the step it is on. */
export function StepsView({ m }: { m: Message }) {
  const [open, setOpen] = useState(() => useSettings.getState().stepsOpen);
  const { steps } = m;
  if (!steps.length) return null;
  const working = m.status === 'working';
  const running = steps.find((s) => s.status === 'running');
  const worst = steps.some((s) => s.status === 'fail') ? 'fail' : steps.some((s) => s.status === 'warn') ? 'warn' : 'ok';
  // the step that decided what this answer is: the choice of tool, or of answering in words
  const route = steps.find((s) => s.kind === 'route') ?? steps[0];
  const headline = working ? `${running?.title ?? 'Working'}…` : (m.trail?.join(' → ') ?? m.tool?.name ?? route.title);

  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.02]">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        {...tip(open ? 'Hide the steps' : 'How this answer was reached', 'Each step shows who decided it — the model, keyword rules, you, or plain code — and the exact text that went in and came out.')}
        className="flex min-h-8 w-full items-center gap-2 px-2 py-1 text-left"
      >
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`} />
        <StatusIcon status={working ? 'running' : worst} />
        <span className={`min-w-0 truncate text-[12px] ${m.tool && !working ? 'font-mono text-slate-200' : 'text-slate-200'}`}>{headline}</span>
        {!working && <ByBadge by={route.by} />}
        <span className="ml-auto shrink-0 font-mono text-[10.5px] text-slate-500">
          {steps.length} step{steps.length === 1 ? '' : 's'}
          {!working && m.ms != null && ` · ${duration(m.ms)}`}
        </span>
      </button>
      {open && (
        <ol className="relative space-y-2.5 border-t border-white/8 px-2.5 py-2.5 before:absolute before:bottom-4 before:left-[19px] before:top-4 before:w-px before:bg-white/8">
          {steps.map((s, i) => (
            <StepRow key={i} step={s} n={i + 1} />
          ))}
        </ol>
      )}
    </div>
  );
}
