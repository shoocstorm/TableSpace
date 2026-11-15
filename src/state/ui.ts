// Which panels are open, and how the scene is shown. The drawer's state, the environment and the line labels are remembered across visits.

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ResultSet } from '../analysis/execute';
import { PHONE_QUERY } from '../ui/usePhone';

export type DrawerTab = 'chat' | 'profile' | 'tools';
export type SettingsTab = 'general' | 'agent' | 'shortcuts';

type UiState = {
  drawerOpen: boolean;
  paletteOpen: boolean;
  modelsOpen: boolean;
  importOpen: boolean;
  /** The environment picker above the dock. */
  envOpen: boolean;
  /** The settings dialog, and the tab it shows. */
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  /** Which face of the AI drawer is shown: the conversation, what the agent is, or what it can do. */
  drawerTab: DrawerTab;
  /** Counts requests to put the cursor in the drawer's message box. */
  composerFocus: number;
  /** The query result open in the result dialog, with the SQL that produced it. */
  result: { result: ResultSet; sql?: string } | null;
  setDrawer: (open: boolean) => void;
  setPalette: (open: boolean) => void;
  setModels: (open: boolean) => void;
  setImport: (open: boolean) => void;
  setEnvOpen: (open: boolean) => void;
  /** Opens the settings dialog, on `tab` when given; `false` closes it. */
  setSettings: (open: boolean, tab?: SettingsTab) => void;
  /** Opens the AI drawer on a tab. */
  showDrawer: (tab: DrawerTab) => void;
  /** Opens the drawer's conversation with the cursor in the message box. */
  focusComposer: () => void;
  setResult: (result: UiState['result']) => void;
  /** The id of the 3D environment (see scene/environments). */
  env: string;
  setEnv: (env: string) => void;
  /** Whether relationship lines carry their labels. Off unless asked for: the faces and the line ends already say what joins what. */
  labels: boolean;
  toggleLabels: () => void;
};

const startsOnPhone = typeof window !== 'undefined' && !!window.matchMedia?.(PHONE_QUERY).matches;

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      // open on a computer, where there is room beside the scene; closed on a phone, where it covers it
      drawerOpen: !startsOnPhone,
      paletteOpen: false,
      modelsOpen: false,
      importOpen: false,
      envOpen: false,
      settingsOpen: false,
      settingsTab: 'general',
      drawerTab: 'chat',
      composerFocus: 0,
      result: null,
      setDrawer: (drawerOpen) => set({ drawerOpen }),
      setPalette: (paletteOpen) => set({ paletteOpen }),
      setModels: (modelsOpen) => set({ modelsOpen }),
      setImport: (importOpen) => set({ importOpen }),
      setEnvOpen: (envOpen) => set({ envOpen }),
      setSettings: (settingsOpen, tab) => set((s) => ({ settingsOpen, settingsTab: tab ?? s.settingsTab })),
      showDrawer: (drawerTab) => set({ drawerOpen: true, drawerTab }),
      focusComposer: () => set((s) => ({ drawerOpen: true, drawerTab: 'chat', composerFocus: s.composerFocus + 1 })),
      setResult: (result) => set({ result }),
      env: 'space',
      setEnv: (env) => set({ env }),
      labels: false,
      toggleLabels: () => set((s) => ({ labels: !s.labels })),
    }),
    { name: 'tablespace.ui', storage: createJSONStorage(() => localStorage), partialize: (s) => ({ drawerOpen: s.drawerOpen, env: s.env, labels: s.labels }) },
  ),
);
