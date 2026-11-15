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
import { useSettings } from '../state/settings';
import { choiceGrammar, schemaGrammar, validate, type ObjectSchema } from './grammar';
import { ANSWER, answerMessages, fillArgsMessages, narrateMessages, pickToolMessages, stripThink } from './prompt';
import { route, SCRIPTED_HELP } from './router';
import { TOOLS, toolByName, type Block, type Suggestion, type ToolCall, type ToolName } from './tools';

/** Who chose the tool: the model, the keyword router, or a prompt chip that names it outright. */
export type Chooser = 'model' | 'scripted' | 'chip';

/**
 * One thing the agent did in a turn, as the drawer shows it: what, who decided
 * (the model, the keyword rules, the user's own click, or plain code), how it
 * went, how long it took, and the exact text that went in and came out.
 */
export type Step = {
  kind: 'route' | 'args' | 'tool' | 'ask' | 'reply';
  title: string;
  by: 'model' | 'keywords' | 'you' | 'code';
  status: 'running' | 'ok' | 'warn' | 'fail';
  /** Why it went this way, in a sentence. */
  note?: string;
  ms?: number;
  /** What can be unfolded: prompts, raw model output, arguments, the facts handed over. */
  details?: { label: string; text: string }[];
};

export type TurnUpdate =
  | { type: 'tool'; tool: ToolName; label: string; by: Chooser; args: Record<string, unknown> }
  | { type: 'result'; ok: boolean; blocks: Block[]; next: Suggestion[] }
  | { type: 'text'; text: string }
  | { type: 'step'; index: number; step: Step }
  | { type: 'stats'; tokPerSec: number | null };

export type TurnInput = { text: string; direct?: ToolCall; history: ChatMessage[]; signal: AbortSignal };

/** Starts a step and returns the way to finish it; a step left unfinished shows as running. */
type Begin = (step: Omit<Step, 'status' | 'ms'>) => (patch?: Partial<Step>) => void;

const json = (v: unknown) => JSON.stringify(v, null, 1).replace(/\n\s*/g, ' ');
const sent = (messages: ChatMessage[]) => messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n');
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function chooseTool(text: string, signal: AbortSignal, begin: Begin): Promise<{ call: ToolCall | null; by: Chooser }> {
  const schema = useScene.getState().schema;
  const scripted = route(schema, text);
  const keywordArgs = scripted ? [{ label: 'Arguments from the keyword rules', text: json(scripted.args) }] : undefined;
  if (!hasModel() || !useSettings.getState().modelPicks) {
    begin({
      kind: 'route',
      by: 'keywords',
      title: scripted ? `Matched ${scripted.tool}` : 'No tool matched',
      note: hasModel() ? 'Tool choice by the model is switched off in Settings, so keywords in your request decided.' : 'No model is loaded, so keywords in your request decided. This is pattern matching, not understanding.',
      details: keywordArgs,
    })({ status: scripted ? 'ok' : 'warn' });
    return { call: scripted, by: 'scripted' };
  }

  const prompt = pickToolMessages(schema, TOOLS, text);
  const routed = begin({ kind: 'route', by: 'model', title: 'Choosing a tool', details: [{ label: 'Sent to the model', text: sent(prompt) }] });
  let picked = '';
  try {
    // Measured with Qwen3 0.6B in wllama: an empty <think></think> comes before the constrained text even with thinking off
    picked = stripThink(await complete(prompt, { grammar: choiceGrammar([...TOOLS.map((t) => t.name), ANSWER]), maxTokens: 24, signal })).trim();
  } catch (e) {
    if (isAbort(e)) throw e;
    console.warn('[agent] tool choice failed; using the keyword router', e);
    routed({ status: 'warn', by: 'keywords', title: scripted ? `Matched ${scripted.tool}` : 'No tool matched', note: `The model failed to choose (${why(e)}), so keywords in your request decided.` });
    return { call: scripted, by: 'scripted' };
  }
  const exchange = [{ label: 'Sent to the model', text: sent(prompt) }, { label: 'The model replied', text: picked || '(nothing)' }];
  // Measured: Qwen3 0.6B says "answer" to most questions, even ones that name tables or ask for an action.
  // When the request plainly matches a tool, that match is used, so the scene still responds.
  if (picked === ANSWER) {
    if (scripted) routed({ status: 'warn', by: 'keywords', title: `Matched ${scripted.tool}`, note: 'The model said no tool was needed, but your request plainly matches one, so the keyword match was used.', details: [...exchange, ...keywordArgs!] });
    else routed({ title: 'No tool needed', note: 'The model judged this a general question, to answer in words.', details: exchange });
    return { call: scripted, by: scripted ? 'scripted' : 'model' };
  }
  const tool = toolByName(picked);
  if (!tool) {
    console.warn('[agent] the model named no known tool; using the keyword router', JSON.stringify(picked));
    routed({ status: 'warn', by: 'keywords', title: scripted ? `Matched ${scripted.tool}` : 'No tool matched', note: 'The model named no known tool, so keywords in your request decided.', details: exchange });
    return { call: scripted, by: 'scripted' };
  }
  routed({ title: `Chose ${tool.name}`, note: 'The reply was held to a grammar: it could only be a tool name from the list, or "answer".', details: exchange });

  const spec = tool.schema(schema);
  if (!Object.keys(spec.properties).length) return { call: { tool: tool.name, args: {} }, by: 'model' };
  const argsPrompt = fillArgsMessages(schema, tool, text);
  const filled = begin({ kind: 'args', by: 'model', title: 'Writing the arguments', details: [{ label: 'Sent to the model', text: sent(argsPrompt) }] });
  try {
    const raw = stripThink(await complete(argsPrompt, { grammar: schemaGrammar(spec), maxTokens: 180, signal }));
    const details = [{ label: 'Sent to the model', text: sent(argsPrompt) }, { label: 'The model replied', text: raw }];
    const checked = validate(spec, JSON.parse(raw));
    if (checked.ok) {
      filled({ title: 'Wrote the arguments', note: 'Held to a grammar built from this database (table and domain names are the only strings it could write), then validated again.', details });
      return { call: { tool: tool.name, args: checked.value }, by: 'model' };
    }
    console.warn('[agent] arguments rejected', checked.errors, raw);
    // the model's tool, the router's arguments when it agrees on the tool
    const fallback = scripted?.tool === tool.name ? scripted : { tool: tool.name, args: {} };
    filled({ status: 'warn', title: 'Arguments rejected', note: `The model's arguments failed validation (${checked.errors.join('; ')}), so ${scripted?.tool === tool.name ? 'the keyword rules’ arguments' : 'the tool’s defaults'} were used.`, details: [...details, { label: 'Used instead', text: json(fallback.args) }] });
    return { call: fallback, by: 'model' };
  } catch (e) {
    if (isAbort(e)) throw e;
    console.warn('[agent] tool choice failed; using the keyword router', e);
    filled({ status: 'warn', by: 'keywords', title: scripted ? `Matched ${scripted.tool}` : 'No tool matched', note: `The model's arguments could not be read (${why(e)}), so keywords in your request decided.`, details: keywordArgs });
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
  let count = 0;
  const begin: Begin = (step) => {
    const index = count++;
    const started = performance.now();
    let current: Step = { ...step, status: 'running' };
    onUpdate({ type: 'step', index, step: current });
    return (patch = {}) => {
      current = { ...current, status: 'ok', ...patch, ms: Math.round(performance.now() - started) };
      onUpdate({ type: 'step', index, step: current });
    };
  };

  if (direct) begin({ kind: 'route', by: 'you', title: `You picked ${direct.tool}`, note: 'A one-click prompt names its tool and arguments outright, so nothing was guessed.', details: [{ label: 'Arguments', text: json(direct.args) }] })();
  const { call, by } = direct ? { call: direct, by: 'chip' as Chooser } : await chooseTool(text, signal, begin);

  if (!call) {
    if (!hasModel()) {
      begin({ kind: 'reply', by: 'code', title: 'Showed the scripted-mode help', note: 'With no model loaded there is nothing to answer a free-form question with.' })();
      return onUpdate({ type: 'text', text: SCRIPTED_HELP });
    }
    const messages = answerMessages(schema, history, text);
    const answered = begin({ kind: 'reply', by: 'model', title: 'Answering in words', details: [{ label: 'Sent to the model', text: sent(messages) }] });
    await stream(messages, 320, signal, onUpdate);
    answered({ title: 'Answered in words', note: `Written by the model from the schema summary and the last ${Math.min(4, history.length)} message${Math.min(4, history.length) === 1 ? '' : 's'}. No tool ran, so nothing here was checked by code.` });
    return;
  }

  const tool = toolByName(call.tool)!;
  onUpdate({ type: 'tool', tool: tool.name, label: tool.label, by, args: call.args });
  // a tool may ask the model one narrower question of its own, under a grammar, once it knows more
  const fill = hasModel()
    ? async (spec: ObjectSchema, instructions: string) => {
        const asked = begin({ kind: 'ask', by: 'model', title: 'Asking the model for details', details: [{ label: 'Sent to the model', text: `[system]\n${instructions}\n\n[user]\n${text.slice(0, 1200)}` }] });
        try {
          const raw = stripThink(await complete([{ role: 'system', content: instructions }, { role: 'user', content: text.slice(0, 1200) }], { grammar: schemaGrammar(spec), maxTokens: 320, signal }));
          const checked = validate(spec, JSON.parse(raw));
          if (!checked.ok) console.warn('[agent] a tool question was answered out of shape', checked.errors);
          asked({
            status: checked.ok ? 'ok' : 'warn',
            title: checked.ok ? 'The model described the details' : 'The model’s details were set aside',
            note: checked.ok ? `${tool.name} asked one narrower question. The answer is a proposal: only the parts your own words support are kept.` : `The answer failed validation (${checked.errors.join('; ')}), so only what your request plainly states was used.`,
            details: [{ label: 'Sent to the model', text: `[system]\n${instructions}\n\n[user]\n${text.slice(0, 1200)}` }, { label: 'The model replied', text: raw }],
          });
          return checked.ok ? checked.value : null;
        } catch (e) {
          asked({ status: 'warn', title: 'The model’s details were set aside', note: isAbort(e) ? 'Stopped.' : `The model failed (${why(e)}), so only what your request plainly states was used.` });
          throw e;
        }
      }
    : undefined;
  const ran = begin({ kind: 'tool', by: 'code', title: `Running ${tool.name}`, details: [{ label: 'Arguments', text: json(call.args) }] });
  let result;
  try {
    result = await tool.run(call.args, { schema, userText: direct && !direct.useText ? '' : text, fill });
  } catch (e) {
    ran({ status: 'fail', title: `${tool.name} failed`, note: isAbort(e) ? 'Stopped.' : why(e) });
    throw e;
  }
  ran({
    status: result.ok ? 'ok' : 'warn',
    title: result.ok ? `Ran ${tool.name}` : `${tool.name} found nothing to do`,
    note: result.ok ? tool.leaves : 'Nothing in the scene changed.',
    details: [{ label: 'Arguments', text: json(call.args) }, { label: 'What it found (the facts)', text: result.facts }],
  });
  onUpdate({ type: 'result', ok: result.ok, blocks: result.blocks, next: result.next ?? [] });
  const template = (note: string) => {
    begin({ kind: 'reply', by: 'code', title: 'Showed the tool’s own summary', note })();
    onUpdate({ type: 'text', text: result.text });
  };
  if (signal.aborted) return template('Stopped before an explanation was written.');
  if (!hasModel()) return template('No model is loaded, so the text is a template filled in by the tool.');
  if (!useSettings.getState().narrate) return template('Explanations by the model are switched off in Settings, so the text is a template filled in by the tool.');

  const messages = narrateMessages(schema, text, tool, result.facts);
  const narrated = begin({ kind: 'reply', by: 'model', title: 'Explaining the result', details: [{ label: 'Sent to the model', text: sent(messages) }] });
  try {
    const said = await stream(messages, 260, signal, onUpdate);
    // a model that says nothing still leaves the user with the tool's own summary
    if (!said.trim()) {
      onUpdate({ type: 'text', text: result.text });
      narrated({ status: 'warn', by: 'code', title: 'Showed the tool’s own summary', note: 'The model wrote nothing, so the text is a template filled in by the tool.' });
    } else narrated({ title: 'Explained the result', note: 'Written by the model from the tool’s facts only; it was not shown your database beyond them. Small models can still misstate a fact: the cards below come from code, so trust them over the prose.' });
  } catch (e) {
    if (isAbort(e)) throw e;
    console.warn('[agent] narration failed; showing the tool summary', e);
    onUpdate({ type: 'text', text: result.text });
    narrated({ status: 'warn', by: 'code', title: 'Showed the tool’s own summary', note: `The model failed while explaining (${why(e)}), so the text is a template filled in by the tool.` });
  }
}
