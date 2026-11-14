// One turn of the agent: choose a tool, fill its arguments, run it (which
// changes the 3D scene), then explain the result.
//
// With a model loaded, the choice and the arguments are the model's, each
// held to a grammar (a tool name from the list; JSON whose table and domain
// values are enums of the active database) and validated again here. When
// either step fails, the keyword router decides instead, so a turn always
// does something sensible. With no model, the router decides and the tool's
// own summary is the answer.

import { chat, complete, hasModel, isAbort, type ChatMessage } from '../llm/engine';
import { useScene } from '../state/scene';
import { choiceGrammar, schemaGrammar, validate, type ObjectSchema } from './grammar';
import { ANSWER, answerMessages, fillArgsMessages, narrateMessages, pickToolMessages, stripThink } from './prompt';
import { route, SCRIPTED_HELP } from './router';
import { TOOLS, toolByName, type Block, type Suggestion, type ToolCall, type ToolName } from './tools';

/** Who chose the tool: the model, the keyword router, or a prompt chip that names it outright. */
export type Chooser = 'model' | 'scripted' | 'chip';

export type TurnUpdate =
  | { type: 'tool'; tool: ToolName; label: string; by: Chooser; args: Record<string, unknown> }
  | { type: 'result'; ok: boolean; blocks: Block[]; next: Suggestion[] }
  | { type: 'text'; text: string }
  | { type: 'stats'; tokPerSec: number | null };

export type TurnInput = { text: string; direct?: ToolCall; history: ChatMessage[]; signal: AbortSignal };

async function chooseTool(text: string, signal: AbortSignal): Promise<{ call: ToolCall | null; by: Chooser }> {
  const schema = useScene.getState().schema;
  const scripted = route(schema, text);
  if (!hasModel()) return { call: scripted, by: 'scripted' };
  try {
    // Measured with Qwen3 0.6B in wllama: an empty <think></think> comes before the constrained text even with thinking off
    const picked = stripThink(await complete(pickToolMessages(schema, TOOLS, text), { grammar: choiceGrammar([...TOOLS.map((t) => t.name), ANSWER]), maxTokens: 24, signal })).trim();
    // Measured: Qwen3 0.6B says "answer" to most questions, even ones that name tables or ask for an action.
    // When the request plainly matches a tool, that match is used, so the scene still responds.
    if (picked === ANSWER) return { call: scripted, by: scripted ? 'scripted' : 'model' };
    const tool = toolByName(picked);
    if (!tool) {
      console.warn('[agent] the model named no known tool; using the keyword router', JSON.stringify(picked));
      return { call: scripted, by: 'scripted' };
    }
    const spec = tool.schema(schema);
    if (!Object.keys(spec.properties).length) return { call: { tool: tool.name, args: {} }, by: 'model' };
    const raw = stripThink(await complete(fillArgsMessages(schema, tool, text), { grammar: schemaGrammar(spec), maxTokens: 180, signal }));
    const checked = validate(spec, JSON.parse(raw));
    if (checked.ok) return { call: { tool: tool.name, args: checked.value }, by: 'model' };
    console.warn('[agent] arguments rejected', checked.errors, raw);
    // the model's tool, the router's arguments when it agrees on the tool
    return { call: scripted?.tool === tool.name ? scripted : { tool: tool.name, args: {} }, by: 'model' };
  } catch (e) {
    if (isAbort(e)) throw e;
    console.warn('[agent] tool choice failed; using the keyword router', e);
    return { call: scripted, by: 'scripted' };
  }
}

async function stream(messages: ChatMessage[], maxTokens: number, signal: AbortSignal, onUpdate: (u: TurnUpdate) => void): Promise<string> {
  let raw = '';
  for await (const ev of chat(messages, { temperature: 0.4, maxTokens, signal })) {
    if (ev.type === 'delta') {
      raw += ev.text;
      onUpdate({ type: 'text', text: stripThink(raw) });
    } else onUpdate({ type: 'stats', tokPerSec: ev.tokPerSec });
  }
  return stripThink(raw);
}

export async function runTurn(input: TurnInput, onUpdate: (u: TurnUpdate) => void): Promise<void> {
  const { text, direct, history, signal } = input;
  const schema = useScene.getState().schema;
  const { call, by } = direct ? { call: direct, by: 'chip' as Chooser } : await chooseTool(text, signal);

  if (!call) {
    if (!hasModel()) return onUpdate({ type: 'text', text: SCRIPTED_HELP });
    await stream(answerMessages(schema, history, text), 320, signal, onUpdate);
    return;
  }

  const tool = toolByName(call.tool)!;
  onUpdate({ type: 'tool', tool: tool.name, label: tool.label, by, args: call.args });
  // a tool may ask the model one narrower question of its own, under a grammar, once it knows more
  const fill = hasModel()
    ? async (spec: ObjectSchema, instructions: string) => {
        const raw = stripThink(await complete([{ role: 'system', content: instructions }, { role: 'user', content: text.slice(0, 1200) }], { grammar: schemaGrammar(spec), maxTokens: 320, signal }));
        const checked = validate(spec, JSON.parse(raw));
        if (!checked.ok) console.warn('[agent] a tool question was answered out of shape', checked.errors);
        return checked.ok ? checked.value : null;
      }
    : undefined;
  const result = await tool.run(call.args, { schema, userText: direct && !direct.useText ? '' : text, fill });
  onUpdate({ type: 'result', ok: result.ok, blocks: result.blocks, next: result.next ?? [] });
  if (signal.aborted) return onUpdate({ type: 'text', text: result.text });

  if (!hasModel()) return onUpdate({ type: 'text', text: result.text });
  try {
    const said = await stream(narrateMessages(schema, text, tool, result.facts), 260, signal, onUpdate);
    // a model that says nothing still leaves the user with the tool's own summary
    if (!said.trim()) onUpdate({ type: 'text', text: result.text });
  } catch (e) {
    if (isAbort(e)) throw e;
    console.warn('[agent] narration failed; showing the tool summary', e);
    onUpdate({ type: 'text', text: result.text });
  }
}
