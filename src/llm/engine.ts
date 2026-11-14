// The local LLM: wllama (llama.cpp → WebAssembly) running inside the page.
// Nothing is sent to a server; the only network traffic is the model
// download from Hugging Face, once, into the browser's OPFS cache.
//
// Ported from Andai's engine (../Andai/src/llm/engine.ts), which measured
// the things this relies on:
// - Safari lacks the Memory64 the default build needs and wllama's own check
//   is fooled there, so `IsolatedWllama` (wasm.ts) decides by compiling a
//   Memory64 module and switches to the compat build in public/wllama/.
// - wllama only *logs* a worker that died, and its promise never settles, so
//   a warm-up watches the log and has a time limit.
// - iOS closes a tab that grows past its memory limit, with no error: phones
//   load on the CPU with a smaller context (device.ts), and a load in
//   progress is marked so the next launch can say what happened.
// - This build can't turn a JSON Schema into a grammar; a GBNF string works.

import { ModelManager, Wllama, WllamaAbortError, type ChatCompletionParams, type ChatCompletionResponse } from '@wllama/wllama';
import { create } from 'zustand';
import { crashMessage, describeLoadError, detectDevice, isFatalLog, loadPlan, MAX_LEVEL, planText, startLevel, type LoadPlan } from './device';
import { verifyBlobs } from './integrity';
import { MODELS, modelById, type ModelDef } from './models';
import { IsolatedWllama } from './wasm';

const asset = (path: string) => new URL(path, window.location.href).href;

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type EngineInfo = { backend: string; threads: string; context: string; compat: boolean };

export type Caps = { isolated: boolean; sharedArrayBuffer: boolean; opfs: boolean; webgpu: boolean; cores: number };

type Progress = { loaded: number; total: number; speed: number; phase: string };

type EngineState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  loadingId: string | null;
  loadedId: string | null;
  progress: Progress | null;
  error: string | null;
  /** The context the model was loaded with (phones load less than the catalog's n_ctx). */
  nCtx: number | null;
  info: EngineInfo | null;
  /** Downloaded models: url → bytes. */
  cached: Record<string, number>;
  caps: Caps;
  generating: boolean;
  tokPerSec: number | null;
};

export const useEngine = create<EngineState>(() => ({
  status: 'idle',
  loadingId: null,
  loadedId: null,
  progress: null,
  error: null,
  nCtx: null,
  info: null,
  cached: {},
  caps: {
    isolated: typeof window !== 'undefined' && window.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    opfs: typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory,
    webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
    cores: (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 0,
  },
  generating: false,
  tokPerSec: null,
}));

let wllama: Wllama | null = null;
let modelManager: ModelManager | null = null;

function manager(): ModelManager | null {
  if (modelManager) return modelManager;
  try {
    modelManager = new ModelManager();
  } catch (e) {
    console.warn('[engine] model cache unavailable', e);
  }
  return modelManager;
}

/** What llama.cpp's load log says about the GPU; `navigator.gpu` existing says nothing. */
export function gpuFromLog(line: string): { layers: number; total: number } | null {
  const m = /offloaded (\d+)\/(\d+) layers to GPU/.exec(line);
  if (m) return { layers: Number(m[1]), total: Number(m[2]) };
  return /ggml_webgpu: Failed to get an adapter/.test(line) ? { layers: 0, total: 0 } : null;
}

const device = detectDevice(typeof navigator === 'undefined' ? undefined : navigator);
export const isMobileDevice = device.mobile;

const ATTEMPT_KEY = 'tablespace.loadAttempt';
const LEVEL_KEY = 'tablespace.loadLevel';
const LAST_KEY = 'tablespace.lastModel';
const VERIFIED_KEY = 'tablespace.verifiedModels';
type Attempt = { id: string; level: number; at: number };

const readJson = <T,>(key: string, fallback: T): T => {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? 'null') as T) ?? fallback;
  } catch {
    return fallback;
  }
};
const failedLevel = (id: string): number | undefined => readJson<Record<string, number>>(LEVEL_KEY, {})[id];
const setFailedLevel = (id: string, level: number) => localStorage.setItem(LEVEL_KEY, JSON.stringify({ ...readJson<Record<string, number>>(LEVEL_KEY, {}), [id]: level }));

/** How a model will load here next: the device's start, or lighter after a failure. */
export const plannedLoad = (def: { id: string; n_ctx: number }): LoadPlan => loadPlan(def.n_ctx, startLevel(device, failedLevel(def.id)));

/** A load the page didn't survive: says so and makes the next try lighter. Returns the model's id. */
function checkCrashedLoad(): string | null {
  const a = readJson<Attempt | null>(ATTEMPT_KEY, null);
  localStorage.removeItem(ATTEMPT_KEY);
  // only a recent attempt counts: an old marker is from a session the user ended
  if (!a || Date.now() - a.at > 15 * 60_000) return null;
  const def = modelById(a.id);
  const next = a.level < MAX_LEVEL ? loadPlan(def?.n_ctx ?? 4096, a.level + 1) : null;
  setFailedLevel(a.id, Math.min(MAX_LEVEL, a.level + 1));
  useEngine.setState({ status: 'error', error: crashMessage(def?.name ?? a.id, loadPlan(def?.n_ctx ?? 4096, a.level), next, device) });
  return a.id;
}

type NativeWatch = { last: string; fatal?: string; onFatal?: (line: string) => void };

const WARMUP_LIMIT_MS = 180_000;
function withinWarmup<T>(p: Promise<T>, watch: NativeWatch, onStop: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      const stop = (e: Error) => {
        clearTimeout(timer);
        onStop();
        reject(e);
      };
      timer = setTimeout(() => stop(new Error(`timed out warming up${watch.last ? ` (last log: ${watch.last})` : ''}`)), WARMUP_LIMIT_MS);
      // a worker can die before this hook is set; the line is kept for that
      if (watch.fatal) stop(new Error(watch.fatal));
      else watch.onFatal = (line) => stop(new Error(line));
    }),
  ]);
}

function wllamaParams(plan: LoadPlan) {
  return {
    n_ctx: plan.n_ctx,
    // CPU only: wllama then doesn't initialize WebGPU at all
    ...(plan.gpu ? {} : { n_gpu_layers: 0 }),
    // keep <think> blocks in the raw stream; the agent strips them itself
    reasoning_format: 'none' as const,
  };
}

const isEvent = (v: unknown): v is Event => typeof Event !== 'undefined' && v instanceof Event;
const logText = (v: unknown): string => (isEvent(v) ? `worker error: ${(v as ErrorEvent).message || v.type}` : String(v));

function newWllama(onGpu: (gpu: { layers: number; total: number }) => void, native: NativeWatch): Wllama {
  const watch =
    (fn: (...a: unknown[]) => void) =>
    (...a: unknown[]) => {
      const line = a.map(logText).join(' ');
      const gpu = gpuFromLog(line);
      if (gpu) onGpu(gpu);
      native.last = line.replace(/\s+/g, ' ').trim().slice(0, 160);
      // any channel: wllama logs an abort (e.g. a build that can't compile) with console.log
      if (!native.fatal && (a.some(isEvent) || isFatalLog(line))) {
        native.fatal = native.last;
        native.onFatal?.(native.fatal);
      }
      fn(...a);
    };
  const logger = { debug: watch(console.debug), log: watch(console.debug), warn: watch(console.warn), error: watch(console.error) };
  const w = new IsolatedWllama({ default: asset('/wllama/default/wllama.wasm') }, { parallelDownloads: 3, logger });
  w.setCompat({ worker: asset('/wllama/compat/wllama.js'), wasm: asset('/wllama/compat/wllama.wasm') });
  return w;
}

async function warmUp(id: string, model: Awaited<ReturnType<typeof openVerified>>, plan: LoadPlan, onGpu: (g: { layers: number; total: number }) => void): Promise<Wllama> {
  const watch: NativeWatch = { last: '' };
  const w = newWllama(onGpu, watch);
  localStorage.setItem(ATTEMPT_KEY, JSON.stringify({ id, level: plan.level, at: Date.now() } satisfies Attempt));
  try {
    await withinWarmup(w.loadModel(model, wllamaParams(plan)), watch, () => void w.exit().catch(() => {}));
    return w;
  } catch (e) {
    await w.exit().catch(() => {});
    throw e;
  } finally {
    watch.onFatal = undefined;
    localStorage.removeItem(ATTEMPT_KEY);
  }
}

export async function refreshCache(): Promise<void> {
  const cached: Record<string, number> = {};
  try {
    for (const m of (await manager()?.getModels()) ?? []) if (m.size > 0) cached[m.url] = m.size;
  } catch (e) {
    console.warn('[engine] cache listing failed', e);
  }
  useEngine.setState({ cached });
}

// Models already verified, url → sha256, so a cached copy isn't re-hashed on every launch.
const verified = (): Record<string, string> => readJson<Record<string, string>>(VERIFIED_KEY, {});
const setVerified = (url: string, sha256: string | null) => {
  const v = verified();
  if (sha256) v[url] = sha256;
  else delete v[url];
  localStorage.setItem(VERIFIED_KEY, JSON.stringify(v));
};

/** Downloads (or reuses the OPFS copy of) a model and verifies it against its pinned sha256. */
async function openVerified(def: ModelDef, onProgress: (p: Progress) => void) {
  const started = performance.now();
  const mm = manager();
  if (!mm) throw new Error('This browser has no storage for models (OPFS is unavailable, e.g. in a private window).');
  const wasCached = (await mm.getModels()).some((m) => m.url === def.url && m.size > 0);
  const model = await mm.getModelOrDownload(
    { url: def.url },
    {
      progressCallback: ({ loaded, total }: { loaded: number; total: number }) => {
        const secs = (performance.now() - started) / 1000;
        onProgress({ loaded, total: total || def.bytes, speed: secs > 0 ? loaded / secs : 0, phase: 'Downloading' });
      },
    },
  );
  if (!wasCached || verified()[def.url] !== def.sha256) {
    const setDone = (loaded: number) => onProgress({ loaded, total: def.bytes, speed: 0, phase: 'Verifying' });
    setDone(0);
    const verdict = await verifyBlobs(await model.open(), def, setDone);
    if (!verdict.ok) {
      await model.remove();
      setVerified(def.url, null);
      throw new Error(`The downloaded ${def.name} failed its integrity check (${verdict.reason}), so it was removed and not loaded. Try again; if it keeps failing, something is altering the download.`);
    }
    setVerified(def.url, def.sha256);
  }
  onProgress({ loaded: def.bytes, total: def.bytes, speed: 0, phase: 'Warming up' });
  return model;
}

export async function loadModel(id: string): Promise<void> {
  const def = modelById(id);
  if (!def) throw new Error(`unknown model ${id}`);
  const { status, loadedId } = useEngine.getState();
  if (status === 'loading' || loadedId === id) return;
  if (loadedId) await unloadModel();

  useEngine.setState({ status: 'loading', loadingId: id, error: null, progress: { loaded: 0, total: def.bytes, speed: 0, phase: 'Connecting' } });
  let plan: LoadPlan | null = null;
  try {
    const model = await openVerified(def, (progress) => useEngine.setState({ progress }));
    let gpu: { layers: number; total: number } | null = null;
    // phones start lighter; a failure that memory or the GPU caused steps down a level
    let w: Wllama | null = null;
    const first = startLevel(device, failedLevel(id));
    for (let level = first; !w; level++) {
      plan = loadPlan(def.n_ctx, level);
      useEngine.setState({ progress: { loaded: def.bytes, total: def.bytes, speed: 0, phase: level > first ? `Retrying with less memory (${planText(plan)})` : 'Warming up' } });
      try {
        w = await warmUp(id, model, plan, (g) => (gpu = g));
      } catch (e) {
        const failure = describeLoadError(e instanceof Error ? e.message : String(e), def.name, plan, device);
        if (!failure.retryLighter || level >= MAX_LEVEL) throw e;
        console.warn(`[engine] ${def.name} failed at ${planText(plan)}; trying less`, e);
        setFailedLevel(id, level + 1);
      }
    }
    wllama = w;
    useEngine.setState({ status: 'ready', loadingId: null, loadedId: id, progress: null, info: readInfo(w, gpu), nCtx: plan?.n_ctx ?? def.n_ctx });
    localStorage.setItem(LAST_KEY, id);
  } catch (e) {
    console.error('[engine] load failed', e);
    const raw = e instanceof Error ? e.message : String(e);
    useEngine.setState({ status: 'error', loadingId: null, progress: null, error: describeLoadError(raw, def.name, plan, device).message });
  } finally {
    await refreshCache();
  }
}

export async function unloadModel(): Promise<void> {
  const w = wllama;
  wllama = null;
  useEngine.setState({ status: 'idle', loadedId: null, info: null, nCtx: null, tokPerSec: null });
  localStorage.removeItem(LAST_KEY);
  await w?.exit().catch(() => {});
}

/** Deletes a downloaded model from the browser's storage (the UI confirms first). */
export async function evictModel(id: string): Promise<void> {
  const def = modelById(id);
  const mm = manager();
  if (!def || !mm) return;
  if (useEngine.getState().loadedId === id) await unloadModel();
  for (const m of await mm.getModels()) if (m.url === def.url) await m.remove();
  setVerified(def.url, null);
  await refreshCache();
}

function readInfo(w: Wllama, gpu: { layers: number; total: number } | null): EngineInfo {
  const i = w.getLoadedContextInfo();
  return {
    backend: gpu ? (gpu.layers > 0 ? `WebGPU · ${gpu.layers}/${gpu.total} layers` : 'WASM · CPU') : w.isSupportWebGPU() ? 'WebGPU' : 'WASM · CPU',
    threads: w.isMultithread() ? `${w.getNumThreads()} threads` : '1 thread',
    context: `${i.n_ctx}`,
    compat: w.getWorkerResources().compat,
  };
}

export const loadedModel = (): ModelDef | undefined => modelById(useEngine.getState().loadedId);
export const hasModel = (): boolean => !!wllama && useEngine.getState().status === 'ready';
export const isAbort = (e: unknown) => e instanceof WllamaAbortError || (e instanceof Error && e.name === 'AbortError');

/** wllama hands these to llama.cpp's server-side parser, so the llama.cpp-only `grammar` (GBNF) works. */
export type CompletionParams = ChatCompletionParams & { grammar?: string; top_k?: number; top_p?: number };

/** One short, non-streaming completion held to a grammar: tool choice and tool arguments. */
export async function complete(messages: ChatMessage[], opts: { grammar: string; maxTokens: number; signal?: AbortSignal }): Promise<string> {
  const w = wllama;
  const def = loadedModel();
  if (!w || !def) throw new Error('No model loaded.');
  useEngine.setState({ generating: true });
  try {
    const response: ChatCompletionResponse = await w.createChatCompletion({
      messages,
      stream: false,
      grammar: opts.grammar,
      max_tokens: opts.maxTokens,
      temperature: 0,
      abortSignal: opts.signal,
      // a grammar and a <think> block don't mix: thinking stays off for constrained output
      ...(def.thinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    } as CompletionParams & { stream: false });
    return response.choices?.[0]?.message?.content ?? '';
  } finally {
    useEngine.setState({ generating: false });
  }
}

export type StreamEvent = { type: 'delta'; text: string } | { type: 'done'; tokens: number; tokPerSec: number | null };

/** Streams a chat completion. Throws `WllamaAbortError` when `signal` aborts. */
export async function* chat(messages: ChatMessage[], opts: { temperature: number; maxTokens: number; signal: AbortSignal }): AsyncGenerator<StreamEvent> {
  const w = wllama;
  const def = loadedModel();
  if (!w || !def) throw new Error('No model loaded.');
  useEngine.setState({ generating: true });
  let firstAt: number | null = null;
  let tokens = 0;
  try {
    const stream = await w.createChatCompletion({
      messages,
      stream: true,
      abortSignal: opts.signal,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      top_p: 0.95,
      top_k: 40,
      ...(def.thinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    } as CompletionParams & { stream: true });
    for await (const chunk of stream as AsyncIterable<{ choices?: { delta?: { content?: string | null } }[] }>) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (!delta) continue;
      tokens++;
      firstAt ??= performance.now();
      yield { type: 'delta', text: delta };
    }
    // generation speed is timed from the first token: reading the prompt comes first
    const secs = firstAt != null ? (performance.now() - firstAt) / 1000 : 0;
    const tokPerSec = tokens > 1 && secs > 0 ? (tokens - 1) / secs : null;
    if (tokPerSec != null) useEngine.setState({ tokPerSec });
    yield { type: 'done', tokens, tokPerSec };
  } finally {
    useEngine.setState({ generating: false });
  }
}

/** Loads the model used last, if it is still downloaded. Never downloads by itself. */
export async function autoload(): Promise<void> {
  const crashed = checkCrashedLoad();
  await refreshCache();
  const def = modelById(readLast());
  if (def && def.id !== crashed && useEngine.getState().cached[def.url]) await loadModel(def.id);
}

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

export { MODELS };
