// The control dock under the scene: camera reset, X-ray, exploded view,
// line labels, clearing the agent's ghost previews, the environment picker, and table search. Above it, a strip
// names whatever the agent has put in the scene, each with a way to dismiss it.

import { Check, Expand, Ghost, Mountain, RotateCcw, ScanEye, Search, Shrink, Tag, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { ENVIRONMENTS } from '../scene/environments';
import { clearBadges, clearFocus, clearGhosts, clearTrace, clearWhatIf, resetView, toggleExploded, toggleXray, useScene } from '../state/scene';
import { useUi } from '../state/ui';
import { shortcut } from './usePhone';

function DockButton({ label, hint, active, disabled, onClick, children }: { label: string; hint?: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={label}
      title={hint ? `${label} (${hint})` : label}
      className={`group flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-xl px-2.5 transition-colors disabled:cursor-not-allowed disabled:opacity-35 sm:min-w-[68px] ${
        active ? 'bg-cyan-400/15 text-cyan-300' : 'text-slate-300 hover:bg-white/6 hover:text-white'
      }`}
    >
      {children}
      <span className="hidden font-mono text-[9.5px] uppercase tracking-wider text-current opacity-70 sm:block">{label}</span>
    </button>
  );
}

function Pill({ color, children, onDismiss, label }: { color: string; children: ReactNode; onDismiss: () => void; label: string }) {
  return (
    <span className="glass rise flex h-8 max-w-full items-center gap-2 rounded-full pl-3 pr-1 text-[12px] font-medium text-slate-200">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="truncate">{children}</span>
      <button onClick={onDismiss} aria-label={label} className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-white/10 hover:text-white">
        <X className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}

/** The worlds to choose from, as tiles painted like them. */
function EnvironmentPicker({ onClose }: { onClose: () => void }) {
  const env = useUi((s) => s.env);
  const setEnv = useUi((s) => s.setEnv);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <>
      <div className="pointer-events-auto fixed inset-0 z-0" onPointerDown={onClose} />
      <div role="dialog" aria-label="Choose an environment" className="glass rise !bg-panel pointer-events-auto relative z-10 w-[min(440px,calc(100vw-16px))] rounded-2xl p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="label">Environment</span>
          <button onClick={onClose} aria-label="Close the environment picker" className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {ENVIRONMENTS.map((e) => {
            const on = e.id === env;
            return (
              <button key={e.id} onClick={() => setEnv(e.id)} aria-pressed={on} title={e.blurb} className={`group overflow-hidden rounded-xl border text-left transition-colors ${on ? 'border-cyan-300/80' : 'border-white/10 hover:border-white/30'}`}>
                <span className="relative block h-14" style={{ background: e.swatch }}>
                  {on && (
                    <span className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-cyan-300 text-slate-950">
                      <Check className="h-3.5 w-3.5" strokeWidth={3} />
                    </span>
                  )}
                </span>
                <span className="block px-2 py-1.5">
                  <span className="block text-[12.5px] font-semibold text-slate-100">{e.name}</span>
                  <span className="block truncate text-[11px] text-slate-400">{e.blurb}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

export function Dock() {
  const [picking, setPicking] = useState(false);
  const xray = useScene((s) => s.xray);
  const exploded = useScene((s) => s.exploded);
  const ghosts = useScene((s) => s.ghosts.length);
  const findings = useScene((s) => s.findings.length);
  const trace = useScene((s) => s.trace);
  const focusLabel = useScene((s) => s.focusLabel);
  const seeding = useScene((s) => s.seeding);
  const selected = useScene((s) => s.selected);
  const whatIf = useScene((s) => s.whatIf.length);
  const setPalette = useUi((s) => s.setPalette);
  const labels = useUi((s) => s.labels);
  const toggleLabels = useUi((s) => s.toggleLabels);
  const xrayIdle = xray && !focusLabel && !selected;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-2 px-2 pb-[max(10px,env(safe-area-inset-bottom))]">
      <div className="flex max-w-full flex-wrap justify-center gap-1.5 [&>*]:pointer-events-auto">
        {seeding && (
          <span className="glass flex h-8 items-center gap-2 rounded-full px-3 text-[12px] font-medium text-slate-200">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            Seeding {seeding.current ?? '…'} · {seeding.done + 1}/{seeding.order.length}
          </span>
        )}
        {trace && (
          <Pill color="#67e8f9" onDismiss={clearTrace} label="Stop the query trace">
            Simulated trace · {trace.label}
          </Pill>
        )}
        {focusLabel && !focusLabel.startsWith('Trace') && (
          <Pill color="#a78bfa" onDismiss={clearFocus} label="Clear the focus">
            Focus · {focusLabel}
          </Pill>
        )}
        {findings > 0 && (
          <Pill color="#fbbf24" onDismiss={clearBadges} label="Remove the warning badges">
            {findings} warning{findings === 1 ? '' : 's'}
          </Pill>
        )}
        {whatIf > 0 && (
          <Pill color="#5eead4" onDismiss={clearWhatIf} label="Remove the what-if indexes">
            {whatIf} what-if index{whatIf === 1 ? '' : 'es'}
          </Pill>
        )}
        {xrayIdle && <span className="glass flex h-8 items-center rounded-full px-3 text-[12px] text-slate-300">X-ray is on — select a table to isolate what it depends on</span>}
      </div>

      {picking && <EnvironmentPicker onClose={() => setPicking(false)} />}

      <nav aria-label="Scene controls" className="glass pointer-events-auto flex items-center gap-0.5 rounded-2xl p-1">
        <DockButton label="Reset" hint="show the whole schema" onClick={resetView}>
          <RotateCcw className="h-[18px] w-[18px]" />
        </DockButton>
        <DockButton label="X-ray" hint="dim unrelated tables" active={xray} onClick={toggleXray}>
          <ScanEye className="h-[18px] w-[18px]" />
        </DockButton>
        <DockButton label={exploded ? 'Collapse' : 'Explode'} hint="pull the domains apart" active={exploded} onClick={toggleExploded}>
          {exploded ? <Shrink className="h-[18px] w-[18px]" /> : <Expand className="h-[18px] w-[18px]" />}
        </DockButton>
        <DockButton label="Labels" hint="name each relationship on its line" active={labels} onClick={toggleLabels}>
          <Tag className="h-[18px] w-[18px]" />
        </DockButton>
        <DockButton label={ghosts ? `Ghosts ${ghosts}` : 'Ghosts'} hint="clear the AI's ghost previews" disabled={!ghosts} onClick={clearGhosts}>
          <Ghost className="h-[18px] w-[18px]" />
        </DockButton>
        <DockButton label="World" hint="choose the environment" active={picking} onClick={() => setPicking((v) => !v)}>
          <Mountain className="h-[18px] w-[18px]" />
        </DockButton>
        <span className="mx-1 h-7 w-px bg-white/10" />
        <DockButton label="Search" hint={shortcut('K')} onClick={() => setPalette(true)}>
          <Search className="h-[18px] w-[18px]" />
        </DockButton>
      </nav>
    </div>
  );
}
