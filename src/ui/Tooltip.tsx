// Tooltips that teach: a control's name, the key that does the same thing,
// and a sentence on what it is for. One layer serves the whole app: a
// control opts in by spreading `tip(...)` onto itself, and this component
// listens for the pointer or the keyboard focus arriving on it.
//
// They wait a moment before appearing (and appear at once when moving from
// one control to the next), stay out of the way on touch screens, and can be
// switched off in Settings.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSettings } from '../state/settings';
import { keyCaps, keyOf } from './shortcuts';

type TipProps = { 'data-tip': string; 'data-tip-desc'?: string; 'data-tip-keys'?: string };

/**
 * Marks a control as having a tooltip. `keys` is a shortcut id from ui/shortcuts.ts
 * ('xray'), or a literal key ('Enter') for one that isn't a global shortcut.
 */
export function tip(label: string, desc?: string, keys?: string): TipProps {
  return { 'data-tip': label, 'data-tip-desc': desc, 'data-tip-keys': keys ? keyOf(keys) || keys : undefined };
}

/** Keys drawn as caps: `<Keys keys="mod+K" />`. */
export function Keys({ keys, className = '' }: { keys: string; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-0.5 ${className}`}>
      {keyCaps(keys).map((k, i) => (
        <kbd key={i} className="keycap">
          {k}
        </kbd>
      ))}
    </span>
  );
}

type Shown = { label: string; desc?: string; keys?: string; rect: DOMRect };
type Place = { left: number; top: number; arrow: number; below: boolean };

const DELAY = 380;
/** Moving on within this long shows the next tooltip without the wait. */
const WARM = 400;
const GAP = 10;
const EDGE = 8;

export function TooltipLayer() {
  const enabled = useSettings((s) => s.tooltips);
  const [shown, setShown] = useState<Shown | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!enabled) {
      setShown(null);
      return;
    }
    let target: Element | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hiddenAt = 0;

    const hide = () => {
      clearTimeout(timer);
      if (target) hiddenAt = performance.now();
      target = null;
      setShown(null);
    };
    const show = (el: Element, wait: boolean) => {
      if (el === target) return;
      clearTimeout(timer);
      target = el;
      const open = () => {
        if (target !== el || !el.isConnected) return;
        const d = (el as HTMLElement).dataset;
        setShown({ label: d.tip ?? '', desc: d.tipDesc, keys: d.tipKeys, rect: el.getBoundingClientRect() });
      };
      if (wait && performance.now() - hiddenAt > WARM) timer = setTimeout(open, DELAY);
      else open();
    };
    const find = (t: EventTarget | null) => (t instanceof Element ? t.closest('[data-tip]') : null);

    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = find(e.target);
      if (el) show(el, true);
      else if (target) hide();
    };
    const focus = (e: FocusEvent) => {
      const el = find(e.target);
      // only for focus that came from the keyboard: a click already says what was meant
      if (el && (e.target as Element).matches(':focus-visible')) show(el, false);
    };
    const leave = (e: PointerEvent) => e.relatedTarget === null && hide();

    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', leave);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', leave);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, [enabled]);

  // Placed once its size is known: above the control when there is room, else below; never off the screen.
  useLayoutEffect(() => {
    const el = box.current;
    if (!shown || !el) return setPlace(null);
    const { width, height } = el.getBoundingClientRect();
    const r = shown.rect;
    const below = r.top - height - GAP < EDGE;
    const centre = r.left + r.width / 2;
    const left = Math.max(EDGE, Math.min(window.innerWidth - width - EDGE, centre - width / 2));
    setPlace({ left, top: below ? r.bottom + GAP : r.top - height - GAP, below, arrow: Math.max(12, Math.min(width - 12, centre - left)) });
  }, [shown]);

  if (!shown) return null;
  return (
    <div
      ref={box}
      role="tooltip"
      className={`tooltip ${place ? 'tooltip-in' : ''}`}
      data-below={place?.below || undefined}
      style={{ left: place?.left ?? 0, top: place?.top ?? 0, visibility: place ? 'visible' : 'hidden' }}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12.5px] font-semibold text-slate-50">{shown.label}</span>
        {shown.keys && <Keys keys={shown.keys} />}
      </div>
      {shown.desc && <p className="mt-1 text-[12px] leading-snug text-slate-400">{shown.desc}</p>}
      <span className="tooltip-arrow" style={{ left: place?.arrow ?? 0 }} aria-hidden />
    </div>
  );
}
