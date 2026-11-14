import { useEffect } from 'react';
import { autoload } from './llm/engine';
import { Viewport } from './scene/Viewport';
import { tablesOfDomain } from './schema/graph';
import { focusTables, useScene } from './state/scene';
import { useUi } from './state/ui';
import { AiDrawer } from './ui/AiDrawer';
import { CommandPalette } from './ui/CommandPalette';
import { Dock } from './ui/Dock';
import { Inspector } from './ui/Inspector';
import { TopBar } from './ui/TopBar';
import { usePhone } from './ui/usePhone';

/** The domains and their colors; a click isolates one. */
function Legend() {
  const schema = useScene((s) => s.schema);
  return (
    <div className="pointer-events-auto absolute bottom-3 left-3 z-10 hidden flex-col gap-0.5 lg:flex">
      <span className="label mb-1 pl-1.5">Domains</span>
      {schema.domains.map((d) => (
        <button
          key={d.id}
          onClick={() => focusTables(tablesOfDomain(schema, d.id), d.label)}
          className="flex h-7 items-center gap-2 rounded-lg px-1.5 text-left text-[12.5px] text-slate-300 hover:bg-white/6 hover:text-white"
        >
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: d.color, boxShadow: `0 0 10px ${d.color}88` }} />
          {d.label}
          <span className="font-mono text-[11px] text-slate-500">{tablesOfDomain(schema, d.id).length}</span>
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const phone = usePhone();
  const drawerOpen = useUi((s) => s.drawerOpen);
  const setPalette = useUi((s) => s.setPalette);
  const selected = useScene((s) => s.selected);

  useEffect(() => {
    // a model used before loads again from the browser's cache; nothing is downloaded unasked
    void autoload();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(!useUi.getState().paletteOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPalette]);

  // The scene keeps to the space the drawer leaves, so what the agent points at is never under it.
  const stage = phone ? { bottom: drawerOpen ? 'var(--sheet-h)' : 0 } : { right: drawerOpen ? 'var(--drawer-w)' : 0 };

  return (
    <div className="fixed inset-0 overflow-hidden bg-void">
      <main className="absolute inset-0" style={stage}>
        <Viewport />
        {selected && !(phone && drawerOpen) && (
          <div className={`pointer-events-none absolute z-20 ${phone ? 'inset-x-2 bottom-[calc(76px+env(safe-area-inset-bottom))]' : 'left-3 top-[62px]'}`}>
            <Inspector compact={phone} />
          </div>
        )}
        {!selected && <Legend />}
        {!(phone && drawerOpen) && <Dock />}
      </main>
      <TopBar />
      <AiDrawer phone={phone} />
      <CommandPalette />
    </div>
  );
}
