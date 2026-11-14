// The opening: the schema assembles itself. Tables drop into place parents
// first, each relationship then draws itself from its foreign key to the key
// it references, and the camera sweeps in from far off while a title card
// (ui/Intro.tsx) gives way to the controls. One clock runs all of it, read
// every frame by the tables and the lines; the title card and the controls
// follow its phases. Any key or click skips it, and with reduced motion it
// never plays.

import { create } from 'zustand';
import { touch } from './live';

/**
 * `boot`: the title card covers the scene until the first frame is drawn.
 * `assemble`: the card's backdrop clears and the schema builds behind the title.
 * `reveal`: the title leaves and the controls fade in.
 * `off`: nothing of the intro is left.
 */
export type IntroPhase = 'boot' | 'assemble' | 'reveal' | 'off';

const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export const useIntro = create<{ phase: IntroPhase }>(() => ({ phase: reduced || typeof window === 'undefined' ? 'off' : 'boot' }));

/** Seconds on the intro's clock. */
const T = {
  /** When the first table lands, and how long after it the last one starts. */
  first: 0.45,
  spread: 1.5,
  /** How long a table takes to land, and a line to draw. */
  rise: 0.8,
  line: 0.75,
  /** When the title leaves and the controls come in, and how long that takes. */
  reveal: 3.1,
  fade: 0.9,
  /** With no frame drawn by then (a phone holding the scene still while a model loads), the intro is dropped. */
  giveUp: 2.5,
};

const clock = {
  /** performance.now() at the first frame; -1 until then. */
  start: -1,
  /** True once everything has landed: the scene stops asking. */
  over: reduced,
  /** Each table's place in the build, 0–1. */
  order: new Map<string, number>(),
  timers: [] as ReturnType<typeof setTimeout>[],
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const elapsed = () => (clock.start < 0 ? 0 : (performance.now() - clock.start) / 1000);
const startOf = (table: string) => T.first + (clock.order.get(table) ?? 0) * T.spread;
/** When the scene has finished building. */
const END = T.first + T.spread + T.rise + T.line + 0.1;

const later = (seconds: number, run: () => void) => void clock.timers.push(setTimeout(run, seconds * 1000));
function clearTimers(): void {
  clock.timers.forEach(clearTimeout);
  clock.timers = [];
}

/** Whether the scene is still building. */
export const introPlaying = () => !clock.over;

/** The order tables are built in (parents first). */
export function introOrder(names: string[]): void {
  clock.order = new Map(names.map((n, i) => [n, names.length > 1 ? i / (names.length - 1) : 0]));
}

/** Called every frame by the scene: starts the clock on the first one, and keeps the lines following the tables while they land. */
export function tickIntro(): void {
  if (clock.over) return;
  if (clock.start < 0) {
    clock.start = performance.now();
    if (useIntro.getState().phase === 'boot') {
      clearTimers();
      useIntro.setState({ phase: 'assemble' });
      later(T.reveal, () => useIntro.setState({ phase: 'reveal' }));
      later(T.reveal + T.fade, () => useIntro.setState({ phase: 'off' }));
    }
  }
  touch();
  if (elapsed() > END) clock.over = true;
}

/** Any key or click: everything lands at once and the controls come in. */
export function skipIntro(): void {
  const { phase } = useIntro.getState();
  if (phase === 'off' || phase === 'reveal') return;
  clearTimers();
  clock.start = performance.now() - END * 1000;
  touch(600);
  useIntro.setState({ phase: 'reveal' });
  later(T.fade, () => useIntro.setState({ phase: 'off' }));
}

/** Another database was opened: it builds the same way, without the title card. */
export function replayAssembly(): void {
  if (reduced || useIntro.getState().phase !== 'off') return;
  clock.start = -1;
  clock.over = false;
}

// the title card must never be left up over a scene that isn't drawing
if (useIntro.getState().phase === 'boot') {
  later(T.giveUp, () => {
    if (clock.start >= 0) return;
    clock.over = true;
    useIntro.setState({ phase: 'off' });
  });
}

/** How far a table is into its landing, 0–1. */
export function tableReveal(table: string): number {
  return clock.over ? 1 : clamp01((elapsed() - startOf(table)) / T.rise);
}

/** How much of a relationship's line is drawn, 0–1: it starts once both of its tables have landed. */
export function lineReveal(from: string, to: string): number {
  if (clock.over) return 1;
  const p = clamp01((elapsed() - Math.max(startOf(from), startOf(to)) - T.rise * 0.75) / T.line);
  return p * p * (3 - 2 * p);
}
