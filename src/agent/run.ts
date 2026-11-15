// One turn of the agent: choose a tool, fill its arguments, run it (which
// changes the 3D scene), decide whether another tool is needed and run that
// too, then explain what was found.
//
// A turn can take several steps, so a question that needs two lookups gets
// both. Only tools that read and report are chained (each tool lists the ones
// worth running after it, `then`); anything that adds to the scene stays the
// user's click. Each decision is read from one token (llm/decide.ts) when
// that is switched on, which also scores every option, so a follow-on step
// the model only leans towards is not taken.
//
// With a model loaded, the choice and the arguments are the model's, each
// held to a grammar (a tool name from the list; JSON whose table and domain
// values are enums of the active database) and validated again here. When
// either step fails, the keyword router decides instead, so a turn always
// does something sensible. With no model, the router decides and the tool's
// own summary is the answer.

import { decide, DecisionError, scoresText, type DecisionOption } from '../llm/decide';
import { chat, complete, hasModel, isAbort, type ChatMessage } from '../llm/engine';
import { mentionedColumnNames } from '../schema/insight';
import { useScene } from '../state/scene';
import { useSettings } from '../state/settings';
import { choiceGrammar, schemaGrammar, validate, type ObjectSchema } from './grammar';
import { ANSWER, answerMessages, decisionRequest, decisionState, fillArgsMessages, FIRST_QUESTION, firstOptions, narrateMessages, NEXT_QUESTION, nextOptions, nextToolMessages, pickToolMessages, stripThink, synthesisMessages, type Observation } from './prompt';
import { alsoAsked, route, SCRIPTED_HELP } from './router';
import { mentionedDomain, mentionedTables, TOOLS, toolByName, type Block, type Suggestion, type Tool, type ToolCall, type ToolName, type ToolResult } from './tools';

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

type Detail = { label: string; text: string };

/**
 * Below these shares a one-token decision is not acted on. The shares rank the options; they are not
 * calibrated, so these are gates with a safe fallback, not statements of certainty.
 * FIRST: a first choice this weak loses to a plain keyword match, when there is one for another tool.
 * NEXT: a follow-on step needs most of the weight, or the turn stops and answers.
 */
export const FIRST_MIN = 0.35;
export const NEXT_MIN = 0.5;

type Picked = { id: string; /** The share of the chosen option; null when the name was spelled out instead. */ confidence: number | null; details: Detail[]; /** Why the one-token readout was not used, when it was tried. */ fellBack?: string };

/**
 * One choice among options. Read from one token when that is on (every option scored at once); otherwise,
 * or when the readout fails, the model spells the option's name out under a grammar, as it always could.
 */
async function pick(state: string, request: string, question: string, options: DecisionOption[], named: ChatMessage[], signal: AbortSignal, without: string[] = []): Promise<Picked> {
  let fellBack: string | undefined;
  if (useSettings.getState().fastDecide) {
    try {
      const d = await decide(state, question, options, signal, { without, request });
      return { id: d.chosen, confidence: d.confidence, details: [{ label: 'Sent to the model', text: sent(d.messages) }, { label: 'How the model scored each option', text: scoresText(d) }] };
    } catch (e) {
      if (!(e instanceof DecisionError)) throw e;
      console.warn('[agent] the one-token decision could not be read; asking for the name instead', e);
      fellBack = e.message;
    }
  }
  // Measured with Qwen3 0.6B in wllama: an empty <think></think> comes before the constrained text even with thinking off
  const said = stripThink(await complete(named, { grammar: choiceGrammar(options.map((o) => o.id).filter((id) => !without.includes(id))), maxTokens: 24, signal })).trim();
  return { id: said, confidence: null, details: [{ label: 'Sent to the model', text: sent(named) }, { label: 'The model replied', text: said || '(nothing)' }], fellBack };
}

const share = (p: number) => `${Math.round(p * 100)}%`;
const HOW = {
  scores: 'Read from a single token: the model scored every option at once. The shares rank the options; they are not a calibrated confidence.',
  name: 'The reply was held to a grammar: it could only be a tool name from the list, or "answer".',
};
const how = (p: Picked) => (p.confidence != null ? `${HOW.scores} It gave this one ${share(p.confidence)}.` : `${HOW.name}${p.fellBack ? ` (The one-token readout failed: ${p.fellBack})` : ''}`);

/** The chosen tool's arguments, written by the model under a grammar built from this database and validated again. */
async function writeArgs(tool: Tool, text: string, done: Observation[], scripted: ToolCall | null, signal: AbortSignal, begin: Begin): Promise<{ call: ToolCall | null; by: Chooser }> {
  const schema = useScene.getState().schema;
  const spec = tool.schema(schema);
  if (!Object.keys(spec.properties).length) return { call: { tool: tool.name, args: {} }, by: 'model' };
  const argsPrompt = fillArgsMessages(schema, tool, text, done);
  const filled = begin({ kind: 'args', by: 'model', title: 'Writing the arguments', details: [{ label: 'Sent to the model', text: sent(argsPrompt) }] });
  // the keyword rules' arguments when they agree on the tool; otherwise the tool's defaults (it reads the request itself)
  const fallback = scripted?.tool === tool.name ? scripted : { tool: tool.name, args: {} };
  const instead = scripted?.tool === tool.name ? 'the keyword rules’ arguments' : 'the tool’s defaults';
  try {
    const raw = stripThink(await complete(argsPrompt, { grammar: schemaGrammar(spec), maxTokens: 180, signal }));
    const details = [{ label: 'Sent to the model', text: sent(argsPrompt) }, { label: 'The model replied', text: raw }];
    const checked = validate(spec, JSON.parse(raw));
    if (checked.ok) {
      filled({ title: 'Wrote the arguments', note: 'Held to a grammar built from this database (table and domain names are the only strings it could write), then validated again.', details });
      return { call: { tool: tool.name, args: checked.value }, by: 'model' };
    }
    console.warn('[agent] arguments rejected', checked.errors, raw);
    filled({ status: 'warn', title: 'Arguments rejected', note: `The model's arguments failed validation (${checked.errors.join('; ')}), so ${instead} were used.`, details: [...details, { label: 'Used instead', text: json(fallback.args) }] });
    return { call: fallback, by: 'model' };
  } catch (e) {
    if (isAbort(e)) throw e;
    console.warn('[agent] the arguments could not be read', e);
    // a first step falls back to the keyword match as a whole; a later one keeps the model's tool
    if (!done.length) {
      filled({ status: 'warn', by: 'keywords', title: scripted ? `Matched ${scripted.tool}` : 'No tool matched', note: `The model's arguments could not be read (${why(e)}), so keywords in your request decided.`, details: scripted ? [{ label: 'Arguments from the keyword rules', text: json(scripted.args) }] : undefined });
      return { call: scripted, by: 'scripted' };
    }
    filled({ status: 'warn', title: 'Arguments set aside', note: `The model's arguments could not be read (${why(e)}), so ${instead} were used.`, details: [{ label: 'Used instead', text: json(fallback.args) }] });
    return { call: fallback, by: 'model' };
  }
}

async function chooseTool(text: string, signal: AbortSignal, begin: Begin): Promise<{ call: ToolCall | null; by: Chooser }> {
  const schema = useScene.getState().schema;
  // a request of several parts starts with its first part, not with whichever keyword of the whole ranks highest
  const parts = alsoAsked(schema, text);
  const scripted = parts.length > 1 ? parts[0] : route(schema, text);
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
  const routed = begin({ kind: 'route', by: 'model', title: 'Choosing a tool' });
  let picked: Picked;
  try {
    // "answer" is for a general question that names nothing in this database. Whether the request names a table,
    // a column or a domain is something code can see, so then "answer" cannot win: the best-scoring tool does.
    // Measured with Qwen3 0.6B: it put most of its weight on "answer" for 14 of 27 requests about the schema,
    // and for most of those the right tool was its runner-up.
    const specific = mentionedTables(schema, text).length > 0 || mentionedDomain(schema, text) !== null || mentionedColumnNames(schema, text).length > 0;
    picked = await pick(decisionState(schema), decisionRequest(text), FIRST_QUESTION, firstOptions(TOOLS), prompt, signal, specific ? [ANSWER] : []);
  } catch (e) {
    if (isAbort(e)) throw e;
    console.warn('[agent] tool choice failed; using the keyword router', e);
    routed({ status: 'warn', by: 'keywords', title: scripted ? `Matched ${scripted.tool}` : 'No tool matched', note: `The model failed to choose (${why(e)}), so keywords in your request decided.`, details: keywordArgs });
    return { call: scripted, by: 'scripted' };
  }
  const exchange = picked.details;
  // Measured: Qwen3 0.6B says "answer" to most questions, even ones that name tables or ask for an action.
  // When the request plainly matches a tool, that match is used, so the scene still responds.
  if (picked.id === ANSWER) {
    if (scripted) routed({ status: 'warn', by: 'keywords', title: `Matched ${scripted.tool}`, note: 'The model said no tool was needed, but your request plainly matches one, so the keyword match was used.', details: [...exchange, ...keywordArgs!] });
    else routed({ title: 'No tool needed', note: `The model judged this a general question, to answer in words. ${how(picked)}`, details: exchange });
    return { call: scripted, by: scripted ? 'scripted' : 'model' };
  }
  const tool = toolByName(picked.id);
  if (!tool) {
    console.warn('[agent] the model named no known tool; using the keyword router', JSON.stringify(picked.id));
    routed({ status: 'warn', by: 'keywords', title: scripted ? `Matched ${scripted.tool}` : 'No tool matched', note: 'The model named no known tool, so keywords in your request decided.', details: exchange });
    return { call: scripted, by: 'scripted' };
  }
  // a weak first choice loses to a plain keyword match for another tool
  if (picked.confidence != null && picked.confidence < FIRST_MIN && scripted && scripted.tool !== tool.name) {
    routed({ status: 'warn', by: 'keywords', title: `Matched ${scripted.tool}`, note: `The model leaned towards ${tool.name} with only ${share(picked.confidence)} of the weight, and your request plainly matches ${scripted.tool}, so the keyword match was used.`, details: [...exchange, ...keywordArgs!] });
    return { call: scripted, by: 'scripted' };
  }
  routed({ title: `Chose ${tool.name}`, note: how(picked), details: exchange });
  return writeArgs(tool, text, [], scripted, signal, begin);
}

/** After a tool has run: whether the request needs another one, chosen among the tools worth running after it. */
async function chooseNext(text: string, done: Observation[], signal: AbortSignal, begin: Begin): Promise<ToolCall | null> {
  const schema = useScene.getState().schema;
  const last = done[done.length - 1];
  if (!last.ok) return null;
  const options = (toolByName(last.tool)?.then ?? []).filter((n) => !done.some((d) => d.tool === n)).flatMap((n) => toolByName(n) ?? []);
  // nothing worth running after this tool: the turn ends without spending a decision
  if (!options.length) return null;
  const asked = begin({ kind: 'route', by: 'model', title: 'Deciding whether to look further' });
  let picked: Picked;
  try {
    picked = await pick(decisionState(schema), decisionRequest(text, done), NEXT_QUESTION, nextOptions(options), nextToolMessages(schema, options, text, done), signal);
  } catch (e) {
    if (isAbort(e)) throw e;
    console.warn('[agent] the follow-on decision failed; answering from what was found', e);
    asked({ status: 'warn', by: 'code', title: 'Stopped looking', note: `The model failed to decide (${why(e)}), so the answer is written from what was already found.` });
    return null;
  }
  const tool = options.find((t) => t.name === picked.id);
  if (!tool) {
    asked({ title: 'Enough to answer', note: `The model judged that what was found covers your request. ${how(picked)}`, details: picked.details });
    return null;
  }
  if (picked.confidence != null && picked.confidence < NEXT_MIN) {
    asked({ title: 'Enough to answer', note: `The model leaned towards ${tool.name} with ${share(picked.confidence)} of the weight; a further step needs at least ${share(NEXT_MIN)}, so the turn stopped here.`, details: picked.details });
    return null;
  }
  asked({ title: `Chose ${tool.name} next`, note: `Offered only tools that read and report, and only ones not yet run. ${how(picked)}`, details: picked.details });
  return (await writeArgs(tool, text, done, null, signal, begin)).call;
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
  const first = direct ? { call: direct, by: 'chip' as Chooser } : await chooseTool(text, signal, begin);

  if (!first.call) {
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

  // a one-click prompt is one tool, as clicked. Otherwise the turn may go on: to whatever else the request plainly
  // asks for (matched part by part, by keywords), and then, with a model steering, to what the model judges is missing.
  const steered = !direct && hasModel() && useSettings.getState().modelPicks;
  const maxSteps = direct ? 1 : Math.max(1, useSettings.getState().maxSteps);
  const planned = direct || maxSteps < 2 ? [] : alsoAsked(schema, text);
  const done: (Observation & { result: ToolResult; tool: ToolName })[] = [];
  let blocks: Block[] = [];
  let next: Suggestion[] = [];
  let call: ToolCall | null = first.call;
  let by: Chooser = first.by;
  while (call) {
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
    let result: ToolResult;
    try {
      result = await tool.run(call.args, { schema: useScene.getState().schema, userText: direct && !direct.useText ? '' : text, quiet: done.length > 0, fill });
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
    done.push({ tool: tool.name, args: call.args, ok: result.ok, facts: result.facts, result });
    blocks = [...blocks, ...result.blocks];
    // follow-ups from every step, without the tools this turn already ran
    next = [...next, ...(result.next ?? [])].filter((n, i, all) => all.findIndex((x) => x.label === n.label) === i);
    onUpdate({ type: 'result', ok: result.ok, blocks, next: next.filter((n) => !done.some((d) => d.tool === n.call.tool)).slice(0, 3) });
    if (done.length >= maxSteps || signal.aborted) break;
    const also = planned.find((p) => !done.some((d) => d.tool === p.tool));
    if (also) {
      begin({ kind: 'route', by: 'keywords', title: `Your request also asks for ${also.tool}`, note: 'Your request has several parts. Each was matched by keywords on its own, and this one names a tool that reads and reports, so it runs too.', details: [{ label: 'Arguments from the keyword rules', text: json(also.args) }] })();
      call = also;
      by = 'scripted';
    } else {
      call = steered ? await chooseNext(text, done, signal, begin) : null;
      by = 'model';
    }
  }

  const own = done.map((d) => d.result.text).join('\n\n');
  const template = (note: string) => {
    begin({ kind: 'reply', by: 'code', title: 'Showed the tool’s own summary', note })();
    onUpdate({ type: 'text', text: own });
  };
  if (signal.aborted) return template('Stopped before an explanation was written.');
  if (!hasModel()) return template('No model is loaded, so the text is a template filled in by the tool.');
  if (!useSettings.getState().narrate) return template('Explanations by the model are switched off in Settings, so the text is a template filled in by the tool.');

  const several = done.length > 1;
  const messages = several ? synthesisMessages(schema, text, done) : narrateMessages(schema, text, toolByName(done[0].tool)!, done[0].facts);
  const narrated = begin({ kind: 'reply', by: 'model', title: several ? 'Explaining the results' : 'Explaining the result', details: [{ label: 'Sent to the model', text: sent(messages) }] });
  try {
    const said = await stream(messages, several ? 420 : 260, signal, onUpdate);
    // a model that says nothing still leaves the user with the tool's own summary
    if (!said.trim()) {
      onUpdate({ type: 'text', text: own });
      narrated({ status: 'warn', by: 'code', title: 'Showed the tool’s own summary', note: 'The model wrote nothing, so the text is a template filled in by the tool.' });
    } else narrated({ title: several ? 'Explained the results' : 'Explained the result', note: `Written by the model from the ${several ? `facts of the ${done.length} tools that ran` : 'tool’s facts'} only; it was not shown your database beyond them. Small models can still misstate a fact: the cards below come from code, so trust them over the prose.` });
  } catch (e) {
    if (isAbort(e)) throw e;
    console.warn('[agent] narration failed; showing the tool summary', e);
    onUpdate({ type: 'text', text: own });
    narrated({ status: 'warn', by: 'code', title: 'Showed the tool’s own summary', note: `The model failed while explaining (${why(e)}), so the text is a template filled in by the tool.` });
  }
}
