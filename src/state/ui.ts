// Which panels are open. The drawer's state is remembered across visits.

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ResultSet } from '../analysis/execute';
import { PHONE_QUERY } from '../ui/usePhone';

type UiState = {
  drawerOpen: boolean;
  paletteOpen: boolean;
  modelsOpen: boolean;
  importOpen: boolean;
  /** The query result open in the result dialog, with the SQL that produced it. */
  result: { result: ResultSet; sql?: string } | null;
  setDrawer: (open: boolean) => void;
  setPalette: (open: boolean) => void;
  setModels: (open: boolean) => void;
  setImport: (open: boolean) => void;
  setResult: (result: UiState['result']) => void;
  /** The id of the 3D environment (see scene/environments). */
  env: string;
  setEnv: (env: string) => void;
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
      result: null,
      setDrawer: (drawerOpen) => set({ drawerOpen }),
      setPalette: (paletteOpen) => set({ paletteOpen }),
      setModels: (modelsOpen) => set({ modelsOpen }),
      setImport: (importOpen) => set({ importOpen }),
      setResult: (result) => set({ result }),
      env: 'space',
      setEnv: (env) => set({ env }),
    }),
    { name: 'tablespace.ui', storage: createJSONStorage(() => localStorage), partialize: (s) => ({ drawerOpen: s.drawerOpen, env: s.env }) },
  ),
);
