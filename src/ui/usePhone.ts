// The phone layout (the AI drawer as a bottom sheet, tables folded by
// default, a lighter scene) follows the window, as it resizes or rotates.

import { useSyncExternalStore } from 'react';

/** Below this width the shell switches to the phone layout. */
export const PHONE_QUERY = '(max-width: 640px)';

const media = (q: string) => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q) : null);

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = media(query);
      m?.addEventListener('change', cb);
      return () => m?.removeEventListener('change', cb);
    },
    () => media(query)?.matches ?? false,
    () => false,
  );
}

export const usePhone = () => useMedia(PHONE_QUERY);
export const useReducedMotion = () => useMedia('(prefers-reduced-motion: reduce)');

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const shortcut = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`);
