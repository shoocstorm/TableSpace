// The AI drawer's conversation. Kept for the session only.

import { create } from 'zustand';
import { isAbort, type ChatMessage } from '../llm/engine';
import { runTurn, type Chooser, type Step } from '../agent/run';
import type { Block, Suggestion, ToolCall, ToolName } from '../agent/tools';

export type Message = {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  /** The tool this answer ran, and who chose it. */
  tool?: { name: ToolName; label: string; by: Chooser; done: boolean; ok: boolean };
  blocks: Block[];
  /** What the agent did to get here, in order (agent/run.ts). */
  steps: Step[];
  /** When the turn started and how long it took. */
  at: number;
  ms?: number;
  /** One-click follow-ups the tool suggested. */
  next?: Suggestion[];
  status: 'working' | 'done' | 'stopped' | 'error';
  tokPerSec?: number | null;
};

/** Counts since the page opened; clearing the conversation keeps them. */
export type Session = { turns: number; calls: Partial<Record<ToolName, number>>; byModel: number; byKeywords: number; byYou: number };

type ChatState = { messages: Message[]; busy: boolean; session: Session };

export const useChat = create<ChatState>(() => ({ messages: [], busy: false, session: { turns: 0, calls: {}, byModel: 0, byKeywords: 0, byYou: 0 } }));

const CHOSEN: Record<Chooser, 'byModel' | 'byKeywords' | 'byYou'> = { model: 'byModel', scripted: 'byKeywords', chip: 'byYou' };

let nextId = 1;
let controller: AbortController | null = null;

const patch = (id: number, p: Partial<Message> | ((m: Message) => Partial<Message>)) =>
  useChat.setState((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...(typeof p === 'function' ? p(m) : p) } : m)) }));

/** Sends a request. A prompt chip passes `direct`: the tool it stands for, so it never depends on a guess. */
export async function send(text: string, direct?: ToolCall): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || useChat.getState().busy) return;
  const history: ChatMessage[] = useChat
    .getState()
    .messages.filter((m) => m.status === 'done' && m.text)
    .map((m) => ({ role: m.role, content: m.text.slice(0, 600) }));
  const id = nextId++;
  const at = Date.now();
  useChat.setState((s) => ({
    busy: true,
    session: { ...s.session, turns: s.session.turns + 1 },
    messages: [...s.messages, { id: nextId++, role: 'user', text: trimmed, blocks: [], steps: [], at, status: 'done' }, { id, role: 'assistant', text: '', blocks: [], steps: [], at, status: 'working' }],
  }));
  controller = new AbortController();
  try {
    await runTurn({ text: trimmed, direct, history, signal: controller.signal }, (u) => {
      if (u.type === 'tool') {
        patch(id, { tool: { name: u.tool, label: u.label, by: u.by, done: false, ok: true } });
        useChat.setState((s) => ({ session: { ...s.session, calls: { ...s.session.calls, [u.tool]: (s.session.calls[u.tool] ?? 0) + 1 }, [CHOSEN[u.by]]: s.session[CHOSEN[u.by]] + 1 } }));
      } else if (u.type === 'step') patch(id, (m) => ({ steps: Object.assign([...m.steps], { [u.index]: u.step }) }));
      else if (u.type === 'result') patch(id, (m) => ({ blocks: u.blocks, next: u.next, tool: m.tool && { ...m.tool, done: true, ok: u.ok } }));
      else if (u.type === 'text') patch(id, { text: u.text });
      else patch(id, { tokPerSec: u.tokPerSec });
    });
    patch(id, { status: 'done' });
  } catch (e) {
    if (isAbort(e)) patch(id, { status: 'stopped' });
    else {
      console.error('[chat] turn failed', e);
      patch(id, (m) => ({ status: 'error', text: m.text || `Something went wrong: ${e instanceof Error ? e.message : String(e)}` }));
    }
  } finally {
    // a step cut short by Stop or an error must not keep spinning
    patch(id, (m) => ({ ms: Date.now() - at, steps: m.steps.map((x) => (x.status === 'running' ? { ...x, status: 'warn' as const, note: m.status === 'stopped' ? 'Stopped before it finished.' : 'Did not finish.' } : x)) }));
    controller = null;
    useChat.setState({ busy: false });
  }
}

export const stop = () => controller?.abort();
export const clearChat = () => !useChat.getState().busy && useChat.setState({ messages: [] });
