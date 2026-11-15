// Settings: how the scene looks, how much the AI Architect's model is
// allowed to decide, and the keyboard. Every switch says what it changes;
// the Shortcuts tab is the cheat sheet (ui/shortcuts.ts is its source).

import { Keyboard, Settings2, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { TOOLS } from '../agent/tools';
import { MODELS, useEngine } from '../llm/engine';
import { ENVIRONMENTS } from '../scene/environments';
import { useRegistry } from '../schema/registry';
import { DEFAULT_SETTINGS, useSettings, type Settings } from '../state/settings';
import { useUi, type SettingsTab } from '../state/ui';
import { SHORTCUTS, type ShortcutGroup } from './shortcuts';
import { Keys } from './Tooltip';
import { usePhone } from './usePhone';

const TABS: { id: SettingsTab; label: string; icon: ReactNode }[] = [
  { id: 'general', label: 'General', icon: <SlidersHorizontal className="h-4 w-4" /> },
  { id: 'agent', label: 'AI Architect', icon: <Sparkles className="h-4 w-4" /> },
  { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard className="h-4 w-4" /> },
];

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-5 last:mb-0">
      <h3 className="label mb-1.5">{title}</h3>
      <div className="divide-y divide-white/6 rounded-xl border border-white/8 bg-white/[0.02]">{children}</div>
    </section>
  );
}

function Row({ title, desc, children, muted }: { title: string; desc: ReactNode; children: ReactNode; muted?: boolean }) {
  return (
    <label className="flex cursor-pointer items-center gap-4 px-3 py-2.5">
      <span className={`min-w-0 flex-1 ${muted ? 'opacity-60' : ''}`}>
        <span className="block text-[13.5px] font-medium text-slate-100">{title}</span>
        <span className="block text-[12.5px] leading-snug text-slate-400">{desc}</span>
      </span>
      {children}
    </label>
  );
}

/** The settings that are switches. */
type Flag = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

function Toggle({ k, title, desc, muted }: { k: Flag; title: string; desc: ReactNode; muted?: boolean }) {
  const on = useSettings((s) => s[k]);
  const set = useSettings((s) => s.set);
  return (
    <Row title={title} desc={desc} muted={muted}>
      <input type="checkbox" role="switch" className="switch" checked={on} onChange={(e) => set({ [k]: e.target.checked })} />
    </Row>
  );
}

function General() {
  const env = useUi((s) => s.env);
  const setEnv = useUi((s) => s.setEnv);
  const labels = useUi((s) => s.labels);
  const toggleLabels = useUi((s) => s.toggleLabels);
  const imported = useRegistry((s) => s.imported.length);
  const setImport = useUi((s) => s.setImport);
  const setSettings = useUi((s) => s.setSettings);
  const reset = useSettings((s) => s.reset);
  const changed = useSettings((s) => (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).some((k) => s[k] !== DEFAULT_SETTINGS[k]));
  return (
    <>
      <Group title="Scene">
        <Row title="World" desc="The environment the schema floats in.">
          <select value={env} onChange={(e) => setEnv(e.target.value)} className="h-9 cursor-pointer rounded-lg border border-white/10 bg-panel-2 px-2 text-[13px] text-slate-100">
            {ENVIRONMENTS.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Relationship labels" desc="Name each relationship on its line: which column references which key.">
          <input type="checkbox" role="switch" className="switch" checked={labels} onChange={toggleLabels} />
        </Row>
      </Group>
      <Group title="Help">
        <Toggle k="tooltips" title="Tooltips" desc="Hover or tab to a control to see what it does and the key for it." />
      </Group>
      <Group title="On this device">
        <Row title="Imported schemas" desc={imported ? `${imported} kept in this browser’s storage. Remove one from the import dialog.` : 'None yet. A schema you import is kept in this browser only.'}>
          <button
            onClick={() => {
              setSettings(false);
              setImport(true);
            }}
            className="h-9 shrink-0 rounded-lg border border-white/10 px-3 text-[13px] font-medium text-slate-200 hover:bg-white/5"
          >
            Open import
          </button>
        </Row>
        <Row title="Restore the defaults" desc="Puts every switch in Settings back as it came. The scene, your schemas and downloaded models are left alone.">
          <button onClick={reset} disabled={!changed} className="h-9 shrink-0 rounded-lg border border-white/10 px-3 text-[13px] font-medium text-slate-200 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-35">
            Restore
          </button>
        </Row>
      </Group>
    </>
  );
}

function Agent() {
  const loaded = useEngine((s) => (s.status === 'ready' ? MODELS.find((m) => m.id === s.loadedId) : undefined));
  const loading = useEngine((s) => s.status === 'loading');
  const setModels = useUi((s) => s.setModels);
  const setSettings = useUi((s) => s.setSettings);
  const showDrawer = useUi((s) => s.showDrawer);
  const leave = (then: () => void) => () => {
    setSettings(false);
    then();
  };
  const needsModel = loaded ? '' : ' Applies once a model is loaded.';
  const modelPicks = useSettings((s) => s.modelPicks);
  const maxSteps = useSettings((s) => s.maxSteps);
  const set = useSettings((s) => s.set);
  return (
    <>
      <Group title="Model">
        <Row
          title={loaded ? `${loaded.name} is loaded` : loading ? 'A model is loading…' : 'No model: scripted mode'}
          desc={loaded ? 'It runs inside this page. Nothing you type is sent anywhere.' : 'Requests are matched by keyword and answers are templates. A model downloads once and then runs inside this page.'}
        >
          <button onClick={leave(() => setModels(true))} data-models-toggle className="h-9 shrink-0 rounded-lg border border-white/10 px-3 text-[13px] font-medium text-slate-200 hover:bg-white/5">
            {loaded ? 'Change' : 'Choose a model'}
          </button>
        </Row>
        <Toggle k="autoload" title="Load it again when the app opens" desc="Uses the copy already in this browser’s storage. Never downloads by itself." />
      </Group>
      <Group title="How much the model decides">
        <Toggle
          k="modelPicks"
          muted={!loaded}
          title="The model chooses the tool"
          desc={`On: the model reads your request, picks one of the ${TOOLS.length} tools and writes its arguments. Off: fixed keyword rules pick, which is instant and predictable but understands nothing.${needsModel}`}
        />
        <Toggle
          k="fastDecide"
          muted={!loaded || !modelPicks}
          title="Read each choice from one token"
          desc={`On: the model is shown the options as letters and its choice is read from a single token, which also scores every option, so a choice it only leans towards can be set aside. Off: it spells the tool’s name out, which takes a few tokens more and gives no scores.${needsModel}`}
        />
        <Row muted={!loaded || !modelPicks} title="Tools per answer" desc={`How far one answer may go. After the first tool, the model may run more that read and report (table details, relationships, indexes, the audit) and then answers from all of them. Each extra step is one more decision. 1 keeps every answer to one tool.${needsModel}`}>
          <select value={maxSteps} onChange={(e) => set({ maxSteps: Number(e.target.value) })} aria-label="Tools per answer" className="h-9 cursor-pointer rounded-lg border border-white/10 bg-panel-2 px-2 text-[13px] text-slate-100">
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n === 1 ? '1 · one tool' : `up to ${n}`}
              </option>
            ))}
          </select>
        </Row>
        <Toggle k="narrate" muted={!loaded} title="The model explains results" desc={`On: the model writes a few sentences from the tool’s facts. Off: the tool’s own summary is shown at once, with no wait and nothing a model could misstate.${needsModel}`} />
      </Group>
      <Group title="What it shows">
        <Toggle k="stepsOpen" title="Unfold the steps of each answer" desc="Every answer lists how it was reached: who chose the tool, what ran, what the model was sent and wrote back. Off keeps that to one line you can open." />
        <Toggle k="followUps" title="Suggest follow-ups" desc="One-click next steps under an answer, such as trying the index a slow scan needs." />
      </Group>
      <div className="flex gap-2">
        <button onClick={leave(() => showDrawer('profile'))} className="h-9 flex-1 rounded-lg border border-white/10 text-[13px] font-medium text-slate-200 hover:bg-white/5">
          What the Architect is
        </button>
        <button onClick={leave(() => showDrawer('tools'))} className="h-9 flex-1 rounded-lg border border-white/10 text-[13px] font-medium text-slate-200 hover:bg-white/5">
          What it can do
        </button>
      </div>
    </>
  );
}

const GROUPS: ShortcutGroup[] = ['Find your way', 'Change the view', 'AI Architect', 'App'];

function Shortcuts() {
  const hotkeys = useSettings((s) => s.hotkeys);
  return (
    <>
      <Group title="Keyboard">
        <Toggle k="hotkeys" title="Single-key shortcuts" desc="Keys such as X, R and / act when you aren’t typing in a field. Off leaves only the combinations and Esc." />
      </Group>
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
        {GROUPS.map((g) => (
          <section key={g}>
            <h3 className="label mb-1.5">{g}</h3>
            <ul className="space-y-0.5">
              {SHORTCUTS.filter((s) => s.group === g && !s.hidden).map((s) => {
                const off = !hotkeys && !s.keys.includes('mod+') && s.keys !== 'Escape';
                return (
                  <li key={s.id} className={`flex items-start gap-3 rounded-lg px-1.5 py-1.5 ${off ? 'opacity-40' : ''}`}>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-slate-100">{s.label}</span>
                      <span className="block text-[12px] leading-snug text-slate-500">{s.desc}</span>
                    </span>
                    <Keys keys={s.keys} className="mt-0.5" />
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      <p className="mt-4 text-[12px] leading-snug text-slate-500">In the scene: drag to orbit, scroll or pinch to zoom, right-drag to pan, click a table to select it.</p>
    </>
  );
}

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const chosen = useUi((s) => s.settingsTab);
  const setSettings = useUi((s) => s.setSettings);
  // a phone has no keyboard to teach
  const phone = usePhone();
  const tab = phone && chosen === 'shortcuts' ? 'general' : chosen;

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setSettings(false);
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, setSettings]);

  if (!open) return null;
  return (
    <div className="absolute inset-0 z-50 flex items-end justify-center bg-black/55 sm:items-center sm:p-4" onPointerDown={(e) => e.target === e.currentTarget && setSettings(false)}>
      <div role="dialog" aria-label="Settings" aria-modal className="glass rise !bg-panel flex h-[min(88dvh,640px)] w-full max-w-[720px] flex-col overflow-hidden rounded-t-3xl sm:rounded-2xl">
        <header className="flex shrink-0 items-center gap-2 border-b border-white/8 px-4 py-2.5">
          <Settings2 className="h-4 w-4 text-cyan-300" aria-hidden />
          <h2 className="font-display text-[15px] font-semibold text-slate-50">Settings</h2>
          <div className="flex-1" />
          <span className="hidden sm:block">
            <Keys keys="Escape" />
          </span>
          <button onClick={() => setSettings(false)} aria-label="Close settings" className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav role="tablist" aria-label="Settings sections" className="flex shrink-0 gap-1 border-b border-white/8 p-2 sm:w-[168px] sm:flex-col sm:border-b-0 sm:border-r">
            {TABS.filter((t) => !phone || t.id !== 'shortcuts').map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setSettings(true, t.id)}
                className={`flex h-9 flex-1 items-center justify-center gap-2 rounded-lg px-2.5 text-[13px] font-medium sm:flex-none sm:justify-start ${tab === t.id ? 'bg-cyan-400/12 text-cyan-200' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`}
              >
                {t.icon}
                <span className="truncate">{t.label}</span>
              </button>
            ))}
          </nav>
          <div role="tabpanel" className="thin-scroll min-h-0 flex-1 overflow-y-auto p-4">
            {tab === 'general' ? <General /> : tab === 'agent' ? <Agent /> : <Shortcuts />}
          </div>
        </div>
      </div>
    </div>
  );
}
