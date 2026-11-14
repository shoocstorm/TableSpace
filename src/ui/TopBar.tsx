// The bar across the top: which database is shown, the local engine's
// status, the model selector, and the AI drawer's toggle.

import { ChevronDown, Cpu, Database, Download, LoaderCircle, Sparkles, Trash2, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { evictModel, isMobileDevice, loadModel, MODELS, plannedLoad, unloadModel, useEngine } from '../llm/engine';
import { planText } from '../llm/device';
import { BUILT_IN, useRegistry } from '../schema/registry';
import { setSchema, useScene } from '../state/scene';
import { useUi } from '../state/ui';

const mb = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`);

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 64 64" className="h-7 w-7 shrink-0" aria-hidden>
        <rect width="64" height="64" rx="14" fill="#0b1322" stroke="#1e2c46" />
        <rect x="14" y="14" width="36" height="9" rx="2.5" fill="#22d3ee" />
        <rect x="14" y="27.5" width="36" height="9" rx="2.5" fill="#22d3ee" opacity=".55" />
        <rect x="14" y="41" width="36" height="9" rx="2.5" fill="#a78bfa" opacity=".8" />
      </svg>
      <span className="font-display hidden text-[17px] font-semibold tracking-tight text-slate-100 sm:block">TableSpace</span>
    </div>
  );
}

const IMPORT = '__import__';

function SchemaSwitcher() {
  const id = useScene((s) => s.schema.id);
  const engine = useScene((s) => s.schema.engine);
  const imported = useRegistry((s) => s.imported);
  const setImport = useUi((s) => s.setImport);
  return (
    <label className="glass relative flex h-10 min-w-0 items-center gap-2 rounded-xl pl-3 pr-2">
      <Database className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden />
      <span className="sr-only">Database</span>
      <select value={id} onChange={(e) => (e.target.value === IMPORT ? setImport(true) : setSchema(e.target.value))} className="min-w-0 cursor-pointer appearance-none truncate bg-transparent pr-6 text-sm font-semibold text-slate-100 outline-none" title={engine}>
        {BUILT_IN.map((s) => (
          <option key={s.id} value={s.id} className="bg-slate-900">
            {s.name}
          </option>
        ))}
        {imported.map((s) => (
          <option key={s.id} value={s.id} className="bg-slate-900">
            {s.name} · imported
          </option>
        ))}
        <option value={IMPORT} className="bg-slate-900">
          ＋ Import your schema…
        </option>
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 h-4 w-4 text-slate-500" aria-hidden />
    </label>
  );
}

/** The engine's state in a few words, and the dot's color. */
function useEngineSummary() {
  const status = useEngine((s) => s.status);
  const loaded = useEngine((s) => MODELS.find((m) => m.id === s.loadedId));
  const progress = useEngine((s) => s.progress);
  const info = useEngine((s) => s.info);
  const tokPerSec = useEngine((s) => s.tokPerSec);
  if (status === 'loading') {
    const pct = progress && progress.total ? Math.round((progress.loaded / progress.total) * 100) : 0;
    return { dot: 'bg-amber-400 animate-pulse', text: `${progress?.phase ?? 'Loading'} ${progress?.phase === 'Warming up' ? '' : `${pct}%`}`, short: `${pct}%` };
  }
  if (status === 'ready' && loaded) {
    return { dot: 'bg-emerald-400', text: `${loaded.name} · ${info?.backend.split(' · ')[0] ?? 'ready'}${tokPerSec ? ` · ${tokPerSec.toFixed(0)} tok/s` : ''}`, short: loaded.name.replace('Qwen3 ', '') };
  }
  if (status === 'error') return { dot: 'bg-rose-500', text: 'Model failed to load', short: 'Error' };
  return { dot: 'bg-slate-500', text: 'No model · scripted mode', short: 'No model' };
}

function ModelMenu({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as Element).closest?.('[data-models-toggle]')) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  const { caps } = engine;
  return (
    <div ref={ref} role="dialog" aria-label="Local models" className="glass rise absolute right-2 top-[calc(100%+8px)] z-40 !bg-panel w-[min(420px,calc(100vw-16px))] rounded-2xl p-4 sm:right-3">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-display text-base font-semibold text-slate-100">Local model</h2>
        <button onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-slate-100">
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="mb-3 text-[13px] leading-relaxed text-slate-400">
        Runs entirely in this browser with wllama (llama.cpp in WebAssembly). A model downloads once from Hugging Face and is kept on this device; nothing you type leaves it.
      </p>

      <div className="space-y-2">
        {MODELS.map((m) => {
          const cached = !!engine.cached[m.url];
          const loading = engine.loadingId === m.id;
          const loaded = engine.loadedId === m.id;
          const pct = loading && engine.progress?.total ? (engine.progress.loaded / engine.progress.total) * 100 : 0;
          return (
            <div key={m.id} className={`rounded-xl border p-3 ${loaded ? 'border-emerald-400/40 bg-emerald-400/5' : 'border-white/8 bg-white/[0.02]'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                    {m.name}
                    {loaded && <span className="label !text-emerald-300">loaded</span>}
                    {!loaded && cached && <span className="label !text-cyan-300">downloaded</span>}
                  </div>
                  <div className="font-mono text-[11px] text-slate-500">
                    {m.family} · {m.size}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {cached && !loading && (
                    <button
                      onClick={() => window.confirm(`Delete the downloaded ${m.name} (${m.size}) from this browser?`) && void evictModel(m.id)}
                      aria-label={`Delete ${m.name}`}
                      title="Delete the download"
                      className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 hover:bg-white/5 hover:text-rose-300"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                  {loaded ? (
                    <button onClick={() => void unloadModel()} className="h-9 rounded-lg border border-white/10 px-3 text-[13px] font-semibold text-slate-200 hover:bg-white/5">
                      Unload
                    </button>
                  ) : (
                    <button
                      disabled={engine.status === 'loading'}
                      onClick={() => void loadModel(m.id)}
                      className="flex h-9 items-center gap-1.5 rounded-lg bg-cyan-400 px-3 text-[13px] font-semibold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : cached ? <Cpu className="h-4 w-4" /> : <Download className="h-4 w-4" />}
                      {loading ? 'Loading' : cached ? 'Load' : 'Download'}
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-1.5 text-[12.5px] leading-snug text-slate-400">{m.note}</p>
              {isMobileDevice && !loaded && <p className="mt-1 text-[12px] text-slate-500">On this device: {planText(plannedLoad(m))}.</p>}
              {loading && engine.progress && (
                <div className="mt-2.5">
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
                    <div className="h-full rounded-full bg-cyan-400 transition-[width] duration-200" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-1 flex justify-between font-mono text-[11px] text-slate-400">
                    <span>{engine.progress.phase}…</span>
                    <span>
                      {mb(engine.progress.loaded)} / {mb(engine.progress.total)}
                      {engine.progress.speed > 0 && ` · ${(engine.progress.speed / 1e6).toFixed(1)} MB/s`}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {engine.error && (
        <p role="alert" className="mt-3 flex gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-[13px] leading-snug text-rose-200">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {engine.error}
        </p>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-white/8 pt-3 font-mono text-[11px] text-slate-500">
        {engine.info && (
          <>
            <dt>backend</dt>
            <dd className="text-right text-slate-300">{engine.info.backend}</dd>
            <dt>threads · context</dt>
            <dd className="text-right text-slate-300">
              {engine.info.threads} · {engine.info.context} tok{engine.info.compat ? ' · compat build' : ''}
            </dd>
          </>
        )}
        <dt>cross-origin isolated</dt>
        <dd className={`text-right ${caps.isolated ? 'text-emerald-300' : 'text-amber-300'}`}>{caps.isolated ? 'yes · multi-threaded' : 'no · single thread'}</dd>
        <dt>WebGPU · cores</dt>
        <dd className="text-right text-slate-300">
          {caps.webgpu ? 'available' : 'none'} · {caps.cores || '?'}
        </dd>
      </dl>
      {!caps.opfs && <p className="mt-2 text-[12px] text-amber-300">This browser has no persistent storage here (a private window?), so models can't be kept.</p>}
    </div>
  );
}

export function TopBar() {
  const { drawerOpen, setDrawer, modelsOpen, setModels } = useUi();
  const summary = useEngineSummary();
  const error = useEngine((s) => s.status === 'error');

  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-40 flex items-center gap-2 px-2 pt-[max(8px,env(safe-area-inset-top))] sm:gap-3 sm:px-3">
      <div className="pointer-events-auto glass flex h-10 items-center rounded-xl px-2.5">
        <Logo />
      </div>
      <div className="pointer-events-auto min-w-0">
        <SchemaSwitcher />
      </div>
      <div className="flex-1" />
      <button
        data-models-toggle
        onClick={() => setModels(!modelsOpen)}
        aria-expanded={modelsOpen}
        aria-label={`Local model: ${summary.text}`}
        className={`pointer-events-auto glass flex h-10 min-w-0 items-center gap-2 rounded-xl px-3 text-[13px] font-medium text-slate-200 hover:text-white ${error ? '!border-rose-400/40' : ''}`}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${summary.dot}`} />
        <span className="hidden truncate md:block">{summary.text}</span>
        <span className="truncate md:hidden">{summary.short}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" />
      </button>
      <button
        onClick={() => setDrawer(!drawerOpen)}
        aria-pressed={drawerOpen}
        aria-label={drawerOpen ? 'Close the AI drawer' : 'Open the AI drawer'}
        className={`pointer-events-auto flex h-10 items-center gap-2 rounded-xl px-3 text-[13px] font-semibold transition-colors ${drawerOpen ? 'glass text-cyan-300' : 'bg-cyan-400 text-slate-950 hover:bg-cyan-300'}`}
      >
        <Sparkles className="h-4 w-4" />
        <span className="hidden sm:block">AI Architect</span>
      </button>
      {modelsOpen && (
        <div className="pointer-events-auto">
          <ModelMenu onClose={() => setModels(false)} />
        </div>
      )}
    </header>
  );
}
