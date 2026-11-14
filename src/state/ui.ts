// Which panels are open. The drawer's state is remembered across visits.

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { PHONE_QUERY } from '../ui/usePhone';

type UiState = {
  drawerOpen: boolean;
  paletteOpen: boolean;
  modelsOpen: boolean;
  setDrawer: (open: boolean) => void;
  setPalette: (open: boolean) => void;
  setModels: (open: boolean) => void;
};

const startsOnPhone = typeof window !== 'undefined' && !!window.matchMedia?.(PHONE_QUERY).matches;

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      // open on a computer, where there is room beside the scene; closed on a phone, where it covers it
      drawerOpen: !startsOnPhone,
      paletteOpen: false,
      modelsOpen: false,
      setDrawer: (drawerOpen) => set({ drawerOpen }),
      setPalette: (paletteOpen) => set({ paletteOpen }),
      setModels: (modelsOpen) => set({ modelsOpen }),
    }),
    { name: 'tablespace.ui', storage: createJSONStorage(() => localStorage), partialize: (s) => ({ drawerOpen: s.drawerOpen }) },
  ),
);
