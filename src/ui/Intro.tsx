// The title card of the opening (scene/intro.ts runs the clock). It covers
// the scene until the first frame is drawn, then its backdrop clears and the
// logo docks where the top bar's logo is while the schema builds itself
// behind it; a status line counts what is being assembled. It leaves as the
// controls fade in. Any key or click skips it.

import { useEffect } from 'react';
import { skipIntro, useIntro } from '../scene/intro';
import { useScene } from '../state/scene';

const NAME = 'TableSpace';

export function Intro() {
  const phase = useIntro((s) => s.phase);
  const schema = useScene((s) => s.schema);
  const relationships = useScene((s) => s.edges.length);

  useEffect(() => {
    if (phase === 'off') return;
    window.addEventListener('keydown', skipIntro);
    return () => window.removeEventListener('keydown', skipIntro);
  }, [phase]);

  if (phase === 'off') return null;
  return (
    <div className="intro" data-phase={phase} onPointerDown={skipIntro}>
      <div className="intro-backdrop" />
      <div className="intro-lockup">
        <svg viewBox="0 0 64 64" className="intro-mark" aria-hidden>
          <rect width="64" height="64" rx="14" fill="#0b1322" stroke="#1e2c46" />
          <rect x="14" y="14" width="36" height="9" rx="2.5" fill="#22d3ee" />
          <rect x="14" y="27.5" width="36" height="9" rx="2.5" fill="#22d3ee" opacity=".55" />
          <rect x="14" y="41" width="36" height="9" rx="2.5" fill="#a78bfa" opacity=".8" />
        </svg>
        <span className="intro-name font-display" aria-label={NAME}>
          {[...NAME].map((ch, i) => (
            <span key={i} aria-hidden style={{ animationDelay: `${180 + i * 38}ms` }}>
              {ch}
            </span>
          ))}
        </span>
      </div>
      <div className="intro-status" role="status">
        <span className="intro-line">
          Assembling <b>{schema.name}</b> · {schema.tables.length} tables · {relationships} relationships
        </span>
        <span className="intro-bar">
          <i />
        </span>
        <span className="intro-skip">press any key to skip</span>
      </div>
    </div>
  );
}
