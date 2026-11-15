import { useEffect, useMemo } from 'react';
import { useSettings } from './state/settings';
import { autoload } from './llm/engine';
import { useIntro } from './scene/intro';
import { Viewport } from './scene/Viewport';
import { audit } from './analysis/audit';
import { send } from './state/chat';
import { tablesOfDomain } from './schema/graph';
import { focusTables, useScene } from './state/scene';
import type { SchemaDef } from './schema/types';
import { useUi } from './state/ui';
import { AiDrawer } from './ui/AiDrawer';
import { CommandPalette } from './ui/CommandPalette';
import { Dock } from './ui/Dock';
import { ImportDialog } from './ui/ImportDialog';
import { Inspector } from './ui/Inspector';
import { Intro } from './ui/Intro';
import { ResultDialog } from './ui/ResultDialog';
import { SettingsDialog } from './ui/SettingsDialog';
import { useShortcuts } from './ui/shortcuts';
import { tip, TooltipLayer } from './ui/Tooltip';
import { TopBar } from './ui/TopBar';
import { usePhone } from './ui/usePhone';

/** 100 for a schema the audit finds nothing in; each finding takes points off by severity. */
export function healthOf(schema: SchemaDef): { score: number; issues: number } {
  const findings = audit(schema);
  const cost = { critical: 12, warning: 6, info: 2 };
  return { score: Math.max(0, 100 - findings.reduce((n, f) => n + cost[f.severity], 0)), issues: findings.length };
}

/** The schema's health at a glance; a click runs the audit. It moves when what-if indexes are tried. */
function Health() {
  const schema = useScene((s) => s.schema);
  const whatIf = useScene((s) => s.whatIf.length);
  const setDrawer = useUi((s) => s.setDrawer);
  const { score, issues } = useMemo(() => healthOf(schema), [schema]);
  const color = score >= 85 ? '#34d399' : score >= 60 ? '#fbbf24' : '#ff5c5c';
  return (
    <button
      onClick={() => {
        setDrawer(true);
        void send('Full anti-pattern radar', { tool: 'audit_schema', args: { rule: 'all' } });
      }}
      {...tip('Schema health', '100 means the audit finds nothing; each finding takes points off by severity. Click to run the full audit with the AI Architect.')}
      className="glass mb-2 flex items-center gap-2.5 rounded-xl py-1.5 pl-2 pr-3 text-left hover:border-white/25"
    >
      <span className="grid h-9 w-9 place-items-center rounded-full font-mono text-[12px] font-semibold" style={{ color, background: `conic-gradient(${color} ${score * 3.6}deg, #1e2c46 0)` }}>
        <span className="grid h-7 w-7 place-items-center rounded-full bg-panel">{score}</span>
      </span>
      <span>
        <span className="block text-[12.5px] font-semibold text-slate-100">Schema health</span>
        <span className="block text-[11.5px] text-slate-400">
          {issues ? `${issues} finding${issues === 1 ? '' : 's'}` : 'nothing to flag'}
          {whatIf > 0 && ` · with ${whatIf} what-if`}
        </span>
      </span>
    </button>
  );
}

/** The domains and their colors; a click isolates one. */
function Legend() {
  const schema = useScene((s) => s.schema);
  return (
    <div className="pointer-events-auto absolute bottom-3 left-3 z-10 hidden flex-col gap-0.5 lg:flex">
      <Health />
      <span className="label mb-1 pl-1.5">Domains</span>
      {schema.domains.map((d) => (
        <button
          key={d.id}
          onClick={() => focusTables(tablesOfDomain(schema, d.id), d.label)}
          {...tip(`Isolate ${d.label}`, 'Light this domain’s tables and dim the rest. Reset brings everything back.')}
          className="flex h-7 items-center gap-2 rounded-lg px-1.5 text-left text-[12.5px] text-slate-300 hover:bg-white/6 hover:text-white"
        >
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: d.color, boxShadow: `0 0 10px ${d.color}88` }} />
          {d.label}
          <span className="font-mono text-[11px] text-slate-500">{tablesOfDomain(schema, d.id).length}</span>
        </button>
      ))}
      <span className="label mb-1 mt-2 pl-1.5">Relationships</span>
      <span className="flex items-center gap-2 pl-1.5 text-[12px] text-slate-400">
        <svg width="46" height="10" viewBox="0 0 46 10" aria-hidden>
          <rect x="1" y="1.5" width="3" height="7" rx="1" fill="#67e8f9" />
          <path d="M4 5 H35" stroke="#94a3b8" strokeWidth="1.6" />
          <path d="M33 1.5 L42 5 L33 8.5 Z" fill="#e2e8f0" />
          <rect x="42" y="1.5" width="3" height="7" rx="1" fill="#fbbf24" />
        </svg>
        foreign key → the key it references
      </span>
    </div>
  );
}

export default function App() {
  const phone = usePhone();
  const drawerOpen = useUi((s) => s.drawerOpen);
  const selected = useScene((s) => s.selected);
  const intro = useIntro((s) => s.phase);

  useEffect(() => {
    // a model used before loads again from the browser's cache; nothing is downloaded unasked
    void autoload(useSettings.getState().autoload);
  }, []);

  useShortcuts();

  // The scene keeps to the space the drawer leaves, so what the agent points at is never under it.
  const stage = phone ? { bottom: drawerOpen ? 'var(--sheet-h)' : 0 } : { right: drawerOpen ? 'var(--drawer-w)' : 0 };

  return (
    <div className="fixed inset-0 overflow-hidden bg-void" data-intro={intro === 'off' ? undefined : intro}>
      <main className="absolute inset-0" style={stage}>
        <Viewport />
        {selected && !(phone && drawerOpen) && (
          <div className={`pointer-events-none absolute z-20 ${phone ? 'inset-x-2 bottom-[calc(76px+env(safe-area-inset-bottom))]' : 'left-3 top-[62px]'}`}>
            <Inspector compact={phone} />
          </div>
        )}
        {!selected && <Legend />}
        {!(phone && drawerOpen) && <Dock />}
      </main>
      <TopBar />
      <AiDrawer phone={phone} />
      <CommandPalette />
      <ImportDialog />
      <ResultDialog />
      <SettingsDialog />
      <TooltipLayer />
      <Intro />
    </div>
  );
}
