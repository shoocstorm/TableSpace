// The AI drawer's conversation. Kept for the session only.

import { create } from 'zustand';
import { isAbort, type ChatMessage } from '../llm/engine';
import { runTurn, type Chooser } from '../agent/run';
import type { Block, ToolCall, ToolName } from '../agent/tools';

export type Message = {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  /** The tool this answer ran, and who chose it. */
  tool?: { name: ToolName; label: string; by: Chooser; done: boolean; ok: boolean };
  blocks: Block[];
  status: 'working' | 'done' | 'stopped' | 'error';
  tokPerSec?: number | null;
};

type ChatState = { messages: Message[]; busy: boolean };

export const useChat = create<ChatState>(() => ({ messages: [], busy: false }));

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
  useChat.setState((s) => ({
    busy: true,
    messages: [...s.messages, { id: nextId++, role: 'user', text: trimmed, blocks: [], status: 'done' }, { id, role: 'assistant', text: '', blocks: [], status: 'working' }],
  }));
  controller = new AbortController();
  try {
    await runTurn({ text: trimmed, direct, history, signal: controller.signal }, (u) => {
      if (u.type === 'tool') patch(id, { tool: { name: u.tool, label: u.label, by: u.by, done: false, ok: true } });
      else if (u.type === 'result') patch(id, (m) => ({ blocks: u.blocks, tool: m.tool && { ...m.tool, done: true, ok: u.ok } }));
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
    controller = null;
    useChat.setState({ busy: false });
  }
}

export const stop = () => controller?.abort();
export const clearChat = () => !useChat.getState().busy && useChat.setState({ messages: [] });
