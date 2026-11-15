// Choice-based decisions, ported from Andai (../Andai/src/llm/decide.ts and
// docs/decider.md; the technique is SemIf's). The model never writes the
// decision. It gets a state, a question and lettered options, and one forward
// pass is read out as the next-token log-probabilities of the option letters;
// a softmax over just those letters gives a probability per option. That is
// one token instead of a spelled-out tool name, always a valid choice, and a
// score for every option rather than only the winner.
//
// Andai's other backend, the Laya decision checkpoint, is not ported: it runs
// on MLX through Rust on Apple Silicon and has no browser build. This is the
// regular-model path, on the chat model already loaded in the page.
//
// What Andai measured on this stack (wllama 3.6.1, Qwen3 0.6B) and this file
// relies on: the logprobs are the raw next-token distribution, before
// sampling, so every letter shows up in `top_logprobs` when the prompt asks
// for a letter; a GBNF grammar keeps the sampled token a letter;
// `post_sampling_probs` makes wllama return no `top_logprobs`, and a logit
// bias doesn't change the reported values, so neither is used. A letter
// missing from the list scored at most the lowest listed value: it is bounded
// there and flagged, never read as zero. The probabilities are an uncalibrated
// ranking signal, not a confidence in the statistical sense.

import { firstToken, type ChatMessage, type TokenScore } from './engine';

export const LETTERS = 'ABCDEFGHIJKLMNOP';
export const MAX_OPTIONS = LETTERS.length;

export type DecisionOption = { id: string; text: string };

export type Decision = {
  options: { id: string; label: string; text: string; probability: number; logprob: number }[];
  /** The option with the highest probability. */
  chosen: string;
  /** Probability of `chosen`: a ranking signal to gate on, not a calibrated confidence. */
  confidence: number;
  /** Options that weren't in the readout and were scored at its lowest logprob (an upper bound). */
  bounded: string[];
  ms: number;
  /** The call as sent and the raw readout, for the steps under an answer. */
  messages: ChatMessage[];
  sampled: string | null;
  top: TokenScore[];
};

/** A decision that was sent but couldn't be read out; carries the call for the trace. */
export class DecisionError extends Error {
  constructor(
    message: string,
    readonly messages: ChatMessage[],
    readonly top: TokenScore[],
  ) {
    super(message);
    this.name = 'DecisionError';
  }
}

export const labelsFor = (n: number) => LETTERS.slice(0, n).split('');

/**
 * Andai's decision prompt, with what changes from turn to turn moved last: the
 * state (what never changes while a database is open), the question, the
 * lettered options, and only then `request` (the user's request and what the
 * turn has found so far). llama.cpp reuses the part of a prompt it has
 * already read, so the long unchanging part is read once.
 *
 * Measured with Qwen3 0.6B on CPU (wllama 3.6.1, 30 requests), first tool right
 * and median time per first decision:
 * - request inside the state, before the options (Andai's order): 21/30, 5.4 s;
 *   every turn re-read the ~1,000 tokens of question and options;
 * - request last (this): 23/30, 0.40 s;
 * - question and options first, then the whole state: 13/30.
 */
export function decisionMessages(state: string, question: string, options: DecisionOption[], request = ''): ChatMessage[] {
  const labels = labelsFor(options.length);
  const block = options.map((o, i) => `${labels[i]}. ${o.text}`).join('\n');
  return [
    { role: 'system', content: 'Make the requested decision from the supplied state. Follow the output format exactly.' },
    { role: 'user', content: `State:\n${state}\n\nQuestion:\n${question}\n\nAllowed options:\n${block}\n\n${request ? `${request}\n\n` : ''}Reply with exactly one option letter from: ${labels.join(', ')}.` },
  ];
}

export function softmax(values: number[]): number[] {
  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp(v - max));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / total);
}

/**
 * The log-probability of each label among the first generated token's top
 * candidates. A label that isn't listed gets the lowest listed value and is
 * reported in `bounded`. Throws when no label is listed: that is no decision.
 */
export function optionLogprobs(top: TokenScore[], labels: string[]): { values: number[]; bounded: number[] } {
  const found = labels.map((label) => {
    const code = label.charCodeAt(0);
    // a tokenizer may attach the space before the letter
    const e = top.find((t) => t.token === label || t.token.trim() === label || (t.bytes?.length === 1 && t.bytes[0] === code));
    return Number(e?.logprob);
  });
  if (!found.some(Number.isFinite)) throw new Error(`The model scored none of the options (${labels.join(', ')}).`);
  const floor = Math.min(...top.map((t) => t.logprob).filter(Number.isFinite));
  const bounded = found.flatMap((v, i) => (Number.isFinite(v) ? [] : [i]));
  return { values: found.map((v) => (Number.isFinite(v) ? v : floor)), bounded };
}

export const letterGrammar = (labels: string[]) => `root ::= ${labels.map((l) => `"${l}"`).join(' | ')}`;

/**
 * Scores `options` for `question` given `state` and `opts.request`, in one forward pass of the loaded model.
 * `opts.without`: options that stay in the prompt but cannot win:
 * the shares are taken over the others only. Used when code already knows an option is wrong.
 */
export async function decide(state: string, question: string, options: DecisionOption[], signal?: AbortSignal, opts: { without?: string[]; request?: string } = {}): Promise<Decision> {
  if (options.length < 2 || options.length > MAX_OPTIONS) throw new Error(`A decision needs 2–${MAX_OPTIONS} options, got ${options.length}.`);
  const started = performance.now();
  const labels = labelsFor(options.length);
  const messages = decisionMessages(state, question, options, opts.request);
  const open = options.map((o, i) => ({ o, label: labels[i] })).filter(({ o }) => !opts.without?.includes(o.id));
  if (!open.length) throw new Error('A decision needs at least one option that can win.');
  let read: Awaited<ReturnType<typeof firstToken>>;
  try {
    read = await firstToken(messages, { grammar: letterGrammar(open.map((x) => x.label)), signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new DecisionError(e instanceof Error ? e.message : String(e), messages, []);
  }
  let readout: ReturnType<typeof optionLogprobs>;
  try {
    readout = optionLogprobs(read.top, open.map((x) => x.label));
  } catch (e) {
    throw new DecisionError(e instanceof Error ? e.message : String(e), messages, read.top);
  }
  const probs = softmax(readout.values);
  const scored = open.map(({ o, label }, i) => ({ id: o.id, label, text: o.text, probability: probs[i], logprob: readout.values[i] }));
  const best = scored.reduce((a, b) => (b.probability > a.probability ? b : a));
  return { options: scored, chosen: best.id, confidence: best.probability, bounded: readout.bounded.map((i) => open[i].o.id), ms: Math.round(performance.now() - started), messages, sampled: read.sampled, top: read.top };
}

/** Every option with its share, best first: what a step shows of a decision. */
export const scoresText = (d: Pick<Decision, 'options' | 'bounded'>): string =>
  [...d.options]
    .sort((a, b) => b.probability - a.probability)
    .map((o) => `${(o.probability * 100).toFixed(1).padStart(5)}%  ${o.label}  ${o.id}${d.bounded.includes(o.id) ? '  (at most: not in the readout)' : ''}`)
    .join('\n');
