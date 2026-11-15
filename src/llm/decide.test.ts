import { describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({ top: [] as { token: string; logprob: number; bytes?: number[] }[], fail: null as Error | null, calls: [] as { grammar: string }[] }));
vi.mock('./engine', () => ({
  firstToken: async (_messages: unknown, opts: { grammar: string }) => {
    engine.calls.push(opts);
    if (engine.fail) throw engine.fail;
    return { sampled: engine.top[0]?.token ?? null, top: engine.top };
  },
}));

import { decide, DecisionError, decisionMessages, labelsFor, letterGrammar, optionLogprobs, scoresText, softmax } from './decide';

const options = [
  { id: 'answer', text: 'answer in words' },
  { id: 'audit_schema', text: 'audit the schema' },
  { id: 'trace_query', text: 'trace a query' },
];

describe('the decision prompt', () => {
  it('letters the options and asks for exactly one letter', () => {
    const [system, user] = decisionMessages('the state', 'Which one?', options);
    expect(system.content).toBe('Make the requested decision from the supplied state. Follow the output format exactly.');
    expect(user.content).toBe('State:\nthe state\n\nQuestion:\nWhich one?\n\nAllowed options:\nA. answer in words\nB. audit the schema\nC. trace a query\n\nReply with exactly one option letter from: A, B, C.');
    expect(labelsFor(3)).toEqual(['A', 'B', 'C']);
    expect(letterGrammar(['A', 'B'])).toBe('root ::= "A" | "B"');
  });
});

describe('the readout', () => {
  it('is a softmax over the letters only, whatever else ranks among them', () => {
    const top = [{ token: 'B', logprob: -0.2 }, { token: 'The', logprob: -1 }, { token: 'A', logprob: -2 }, { token: 'C', logprob: -3 }];
    const { values, bounded } = optionLogprobs(top, ['A', 'B', 'C']);
    expect(values).toEqual([-2, -0.2, -3]);
    expect(bounded).toEqual([]);
    const p = softmax(values);
    const z = Math.exp(-2) + Math.exp(-0.2) + Math.exp(-3);
    expect(p[1]).toBeCloseTo(Math.exp(-0.2) / z, 10);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });
  it('finds a letter by its byte or with a leading space', () => {
    expect(optionLogprobs([{ token: '?', logprob: -1, bytes: [66] }, { token: ' A', logprob: -2 }], ['A', 'B']).values).toEqual([-2, -1]);
  });
  it('bounds a letter that is not listed at the lowest listed value, never zero', () => {
    const { values, bounded } = optionLogprobs([{ token: 'A', logprob: -0.1 }, { token: 'x', logprob: -9 }], ['A', 'B']);
    expect(values).toEqual([-0.1, -9]);
    expect(bounded).toEqual([1]);
  });
  it('is no decision when no letter is listed', () => {
    expect(() => optionLogprobs([{ token: 'x', logprob: -1 }], ['A', 'B'])).toThrow(/scored none/);
    expect(() => optionLogprobs([], ['A', 'B'])).toThrow(/scored none/);
  });
});

describe('decide', () => {
  it('returns the best option, a share for every option, and what was sent', async () => {
    engine.fail = null;
    engine.top = [{ token: 'B', logprob: -0.1 }, { token: 'A', logprob: -3 }];
    const d = await decide('state', 'Which?', options);
    expect(d.chosen).toBe('audit_schema');
    expect(d.confidence).toBeGreaterThan(0.9);
    expect(d.bounded).toEqual(['trace_query']);
    expect(d.options.map((o) => o.label)).toEqual(['A', 'B', 'C']);
    expect(engine.calls.at(-1)?.grammar).toBe('root ::= "A" | "B" | "C"');
    expect(scoresText(d).split('\n')[0]).toMatch(/B {2}audit_schema$/);
    expect(scoresText(d)).toMatch(/trace_query {2}\(at most/);
  });
  it('can keep an option in the prompt that cannot win', async () => {
    engine.top = [{ token: 'A', logprob: -0.1 }, { token: 'C', logprob: -2 }, { token: 'B', logprob: -3 }];
    const d = await decide('state', 'Which?', options, undefined, { without: ['answer'] });
    expect(d.chosen).toBe('trace_query');
    expect(d.options.map((o) => o.id)).toEqual(['audit_schema', 'trace_query']);
    expect(d.confidence).toBeCloseTo(Math.exp(-2) / (Math.exp(-2) + Math.exp(-3)), 10);
    expect(engine.calls.at(-1)?.grammar).toBe('root ::= "B" | "C"');
  });
  it('fails as a DecisionError the caller can fall back from', async () => {
    engine.top = [];
    await expect(decide('state', 'Which?', options)).rejects.toBeInstanceOf(DecisionError);
    engine.fail = new Error('worker died');
    await expect(decide('state', 'Which?', options)).rejects.toBeInstanceOf(DecisionError);
    engine.fail = null;
  });
  it('refuses fewer than two options or more than sixteen', async () => {
    await expect(decide('s', 'q', [options[0]])).rejects.toThrow(/2–16/);
  });
});
