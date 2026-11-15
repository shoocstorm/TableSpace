// What the user chose in Settings, remembered across visits: how the
// keyboard and the tooltips behave, and how much the loaded model is allowed
// to decide in a turn of the AI Architect (agent/run.ts reads these).

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type Settings = {
  /** Single-key shortcuts (X, R, /…). Combinations with ⌘/Ctrl always work. */
  hotkeys: boolean;
  /** The explanatory tooltips on controls. */
  tooltips: boolean;
  /** With a model loaded: the model chooses the tool and writes its arguments. Off: keywords decide. */
  modelPicks: boolean;
  /**
   * With a model loaded: each choice is read from one token, which scores every option at once (llm/decide.ts).
   * Off: the model spells the tool's name out under a grammar, as it did before.
   */
  fastDecide: boolean;
  /** With a model loaded: how many tools one answer may run. After the first, only tools that read and report. 1 keeps a turn to one tool. */
  maxSteps: number;
  /** With a model loaded: the model explains each result. Off: the tool's own summary is shown, at once. */
  narrate: boolean;
  /** Each answer's steps start unfolded. */
  stepsOpen: boolean;
  /** One-click follow-ups under an answer. */
  followUps: boolean;
  /** Load the model used last when the app opens (from the browser's storage; never a download). */
  autoload: boolean;
};

export const DEFAULT_SETTINGS: Settings = { hotkeys: true, tooltips: true, modelPicks: true, fastDecide: true, maxSteps: 3, narrate: true, stepsOpen: false, followUps: true, autoload: true };

// Where there is no usable localStorage (a locked-down browser, the test runner), the choices last for the visit.
const held = new Map<string, string>();
const memory = { getItem: (k: string) => held.get(k) ?? null, setItem: (k: string, v: string) => void held.set(k, v), removeItem: (k: string) => void held.delete(k) };
const usable = () => {
  try {
    return typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function';
  } catch {
    return false; // some private windows throw on the access itself
  }
};

type SettingsState = Settings & { set: (patch: Partial<Settings>) => void; reset: () => void };

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      set: (patch) => set(patch),
      reset: () => set(DEFAULT_SETTINGS),
    }),
    {
      name: 'tablespace.settings',
      storage: createJSONStorage(() => (usable() ? localStorage : memory)),
      partialize: ({ set: _set, reset: _reset, ...values }) => values,
    },
  ),
);
