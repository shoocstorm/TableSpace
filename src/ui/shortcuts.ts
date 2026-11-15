// Every keyboard shortcut, as data: the key, what it does, and a sentence
// that teaches it. One listener (useShortcuts, in App) runs them; the
// tooltips and the cheat sheet in Settings read the same list, so a key is
// never described in two places.
//
// A key is written 'mod+K' (⌘ on a Mac, Ctrl elsewhere), 'Shift+A', or a
// single character. Single keys only fire when nothing is being typed, no
// dialog is open, and the user hasn't switched them off.

import { useEffect } from 'react';
import { chipsFor } from '../agent/chips';
import { neighbours } from '../schema/graph';
import { useIntro } from '../scene/intro';
import { send, useChat } from '../state/chat';
import { clearGhosts, focusTables, resetView, selectTable, toggleExpanded, toggleExploded, toggleXray, useScene } from '../state/scene';
import { useSettings } from '../state/settings';
import { useUi } from '../state/ui';
import { isMac } from './usePhone';

export type ShortcutGroup = 'Find your way' | 'Change the view' | 'AI Architect' | 'App';

export type Shortcut = {
  id: string;
  keys: string;
  label: string;
  /** One sentence for the tooltip and the cheat sheet. */
  desc: string;
  group: ShortcutGroup;
  /** Absent for a key another listener handles (listed so the sheet is complete). */
  run?: () => void;
  /** The key does nothing unless this holds (e.g. a table is selected). */
  when?: () => boolean;
  /** Not listed in the cheat sheet (the seven prompt keys share one row). */
  hidden?: boolean;
};

const ui = () => useUi.getState();
const scene = () => useScene.getState();
const hasSelection = () => !!scene().selected;

function runChip(n: number): void {
  const chip = chipsFor(scene().schema)[n - 1];
  if (!chip || useChat.getState().busy) return;
  ui().showDrawer('chat');
  void send(chip.label, chip.call);
}

export const SHORTCUTS: Shortcut[] = [
  { id: 'search', keys: 'mod+K', label: 'Search tables', desc: 'Type part of a table or column name, press Enter, and the camera flies there.', group: 'Find your way', run: () => ui().setPalette(!ui().paletteOpen) },
  { id: 'reset', keys: 'R', label: 'Reset the view', desc: 'Show the whole schema again and drop the focus and any running trace.', group: 'Find your way', run: resetView },
  { id: 'fold', keys: 'F', label: 'Fold or unfold the selected table', desc: 'Show or hide the column list on the selected table in the scene.', group: 'Find your way', when: hasSelection, run: () => toggleExpanded(scene().selected!) },
  {
    id: 'deps',
    keys: 'D',
    label: 'Isolate the selected table’s dependencies',
    desc: 'Light the selected table and every table one relationship away; dim the rest.',
    group: 'Find your way',
    when: hasSelection,
    run: () => focusTables(neighbours(scene().schema, [scene().selected!], 1), `${scene().selected} + neighbours`),
  },
  { id: 'deselect', keys: 'Escape', label: 'Close, or let go of the selection', desc: 'Closes the panel on top. With nothing open, deselects the table.', group: 'Find your way', when: () => hasSelection() && !ui().envOpen && !ui().modelsOpen, run: () => selectTable(null) },

  { id: 'xray', keys: 'X', label: 'X-ray', desc: 'Dim every table that isn’t related to the one you select, so its dependencies stand out.', group: 'Change the view', run: toggleXray },
  { id: 'explode', keys: 'E', label: 'Explode', desc: 'Pull the domains apart so each cluster of tables can be read by itself. Press again to collapse.', group: 'Change the view', run: toggleExploded },
  { id: 'labels', keys: 'L', label: 'Relationship labels', desc: 'Name each relationship on its line: which column references which key.', group: 'Change the view', run: () => ui().toggleLabels() },
  { id: 'ghosts', keys: 'G', label: 'Clear ghost tables', desc: 'Remove the refactor previews the AI Architect floated in the scene.', group: 'Change the view', when: () => scene().ghosts.length > 0, run: clearGhosts },
  { id: 'world', keys: 'W', label: 'World', desc: 'Choose the environment the schema floats in.', group: 'Change the view', run: () => ui().setEnvOpen(!ui().envOpen) },

  { id: 'ask', keys: '/', label: 'Ask the AI Architect', desc: 'Open the conversation and put the cursor in the message box.', group: 'AI Architect', run: () => ui().focusComposer() },
  { id: 'drawer', keys: 'A', label: 'Show or hide the AI Architect', desc: 'The scene takes the space the drawer leaves.', group: 'AI Architect', run: () => ui().setDrawer(!ui().drawerOpen) },
  ...Array.from({ length: 7 }, (_, i): Shortcut => ({ id: `chip${i + 1}`, keys: String(i + 1), label: `Run quick prompt ${i + 1}`, desc: '', group: 'AI Architect', hidden: true, run: () => runChip(i + 1) })),
  { id: 'chips', keys: '1…7', label: 'Run a quick prompt', desc: 'The numbered prompts under the conversation. Each names its tool outright, so nothing is guessed.', group: 'AI Architect' },
  { id: 'profile', keys: 'P', label: 'What the Architect is', desc: 'Its model, where it runs, the exact prompts it is given, what it can see right now, and the rules it follows.', group: 'AI Architect', run: () => ui().showDrawer('profile') },
  { id: 'tools', keys: 'T', label: 'What the Architect can do', desc: 'Every tool it can call, what each leaves in the scene, and how to undo it.', group: 'AI Architect', run: () => ui().showDrawer('tools') },
  { id: 'models', keys: 'M', label: 'Local model', desc: 'Download, load or unload the model that runs in this browser.', group: 'AI Architect', run: () => ui().setModels(!ui().modelsOpen) },
  { id: 'stop', keys: 'Escape', label: 'Stop the answer', desc: 'While the Architect is working and the cursor is in the message box.', group: 'AI Architect' },

  { id: 'import', keys: 'I', label: 'Import your schema', desc: 'Paste SQL DDL (CREATE TABLE …) to see your own database. It stays in this browser.', group: 'App', run: () => ui().setImport(true) },
  { id: 'settings', keys: ',', label: 'Settings', desc: 'Scene, AI Architect and keyboard preferences.', group: 'App', run: () => ui().setSettings(!ui().settingsOpen) },
  { id: 'help', keys: '?', label: 'Keyboard shortcuts', desc: 'This list.', group: 'App', run: () => ui().setSettings(true, 'shortcuts') },
];

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]));
/** The key of a shortcut, for a tooltip: `keyOf('xray')` → 'X'. */
export const keyOf = (id: string): string => BY_ID.get(id)?.keys ?? '';

const NAMES: Record<string, string> = { Escape: 'Esc', Enter: '↵', Shift: '⇧' };
/** A key as the caps to draw: 'mod+K' → ['⌘', 'K'] on a Mac, ['Ctrl', 'K'] elsewhere. */
export const keyCaps = (keys: string): string[] => keys.split('+').map((k) => (k === 'mod' ? (isMac ? '⌘' : 'Ctrl') : (NAMES[k] ?? k)));

function matches(e: KeyboardEvent, keys: string): boolean {
  const parts = keys.split('+');
  const key = parts.pop()!;
  if (parts.includes('mod') !== (e.metaKey || e.ctrlKey) || e.altKey) return false;
  // a letter is matched without its case; a symbol such as ? already says whether Shift is down
  if (/^[a-z]$/i.test(key)) return e.key.toLowerCase() === key.toLowerCase() && e.shiftKey === parts.includes('Shift');
  return e.key === key;
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** The one listener behind every shortcut. It runs before the panels' own Escape handlers, so it can tell what was open. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.isComposing) return;
      // while the title card is up, any key skips it (ui/Intro.tsx)
      if (useIntro.getState().phase !== 'off') return;
      const { paletteOpen, importOpen, result, settingsOpen } = ui();
      const modal = paletteOpen || importOpen || !!result || settingsOpen;
      for (const s of SHORTCUTS) {
        if (!s.run || !matches(e, s.keys)) continue;
        const combo = s.keys.includes('mod+');
        if (!combo && (typing(e.target) || modal || (!useSettings.getState().hotkeys && s.keys !== 'Escape'))) return;
        if (s.when && !s.when()) return;
        if (s.keys !== 'Escape') e.preventDefault();
        s.run();
        return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}
