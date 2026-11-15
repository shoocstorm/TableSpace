import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../llm/engine';
import { useSettings } from '../state/settings';
import { runTurn, type Step, type TurnUpdate } from './run';
import { TOOLS } from './tools';

// The model, scripted: what it would reply to each constrained question, and whether one is loaded at all.
// `scores`: per one-token decision, each option letter with its log-probability; with none queued the readout is empty,
// which is a failed decision, and the model is asked to spell the name out instead (`replies`).
const model = vi.hoisted(() => ({ loaded: false, replies: [] as string[], scores: [] as [string, number][][], said: 'Two foreign keys lack an index.' }));

vi.mock('../llm/engine', () => ({
  hasModel: () => model.loaded,
  isAbort: (e: unknown) => e instanceof Error && e.name === 'AbortError',
  complete: async () => model.replies.shift() ?? '',
  firstToken: async () => {
    const top = (model.scores.shift() ?? []).map(([token, logprob]) => ({ token, logprob }));
    return { sampled: top[0]?.token ?? null, top };
  },
  chat: async function* (_messages: ChatMessage[]) {
    yield { type: 'delta', text: model.said };
    yield { type: 'done', tokens: 6, tokPerSec: 20 };
  },
}));

async function turn(text: string, direct?: Parameters<typeof runTurn>[0]['direct']) {
  const updates: TurnUpdate[] = [];
  await runTurn({ text, direct, history: [], signal: new AbortController().signal }, (u) => updates.push(u));
  const steps: Step[] = [];
  for (const u of updates) if (u.type === 'step') steps[u.index] = u.step;
  const said = updates.filter((u) => u.type === 'text').pop();
  return { steps, updates, text: said?.type === 'text' ? said.text : '' };
}
const outline = (steps: Step[]) => steps.map((s) => `${s.kind}:${s.by}:${s.status}`);

describe('the steps of a turn', () => {
  beforeEach(() => {
    model.loaded = false;
    model.replies = [];
    model.scores = [];
    useSettings.getState().reset();
  });

  it('scripted mode: keywords choose, code runs and answers', async () => {
    const { steps } = await turn('audit the schema');
    expect(outline(steps)).toEqual(['route:keywords:ok', 'tool:code:ok', 'reply:code:ok']);
    expect(steps[0].title).toBe('Matched audit_schema');
    expect(steps[0].note).toMatch(/No model is loaded/);
    expect(steps[1].details?.map((d) => d.label)).toEqual(['Arguments', 'What it found (the facts)']);
  });

  it('a one-click prompt is the user’s own choice', async () => {
    const { steps } = await turn('Full anti-pattern radar', { tool: 'audit_schema', args: { rule: 'all' } });
    expect(outline(steps)).toEqual(['route:you:ok', 'tool:code:ok', 'reply:code:ok']);
  });

  it('scripted mode says so when nothing matches', async () => {
    const { steps } = await turn('hello there');
    expect(outline(steps)).toEqual(['route:keywords:warn', 'reply:code:ok']);
  });

  it('model mode: the model chooses, writes arguments and explains, and each step keeps what was sent and said', async () => {
    model.loaded = true;
    useSettings.getState().set({ fastDecide: false });
    model.replies = ['audit_schema', '{"rule":"missing_fk_index"}', 'answer'];
    const { steps, text } = await turn('is anything wrong with my keys?');
    expect(outline(steps)).toEqual(['route:model:ok', 'args:model:ok', 'tool:code:ok', 'route:model:ok', 'reply:model:ok']);
    expect(steps[3].title).toBe('Enough to answer');
    expect(steps[0].title).toBe('Chose audit_schema');
    expect(steps[0].details?.[1]).toEqual({ label: 'The model replied', text: 'audit_schema' });
    expect(steps[1].details?.[1].text).toBe('{"rule":"missing_fk_index"}');
    expect(text).toBe(model.said);
  });

  it('model mode: a tool that plainly matches wins over the model saying "answer", and the step says who decided', async () => {
    model.loaded = true;
    model.replies = ['answer'];
    const { steps } = await turn('audit the schema');
    expect(outline(steps).slice(0, 2)).toEqual(['route:keywords:warn', 'tool:code:ok']);
  });

  it('model mode: arguments that fail validation are set aside', async () => {
    model.loaded = true;
    model.replies = ['audit_schema', '{"rule":"nope"}'];
    const { steps } = await turn('is anything wrong with my keys?');
    expect(outline(steps).slice(0, 3)).toEqual(['route:model:ok', 'args:model:warn', 'tool:code:ok']);
  });

  it('settings: the model can be kept from choosing and from explaining', async () => {
    model.loaded = true;
    useSettings.getState().set({ modelPicks: false, narrate: false });
    const { steps } = await turn('audit the schema');
    expect(outline(steps)).toEqual(['route:keywords:ok', 'tool:code:ok', 'reply:code:ok']);
    expect(steps[0].note).toMatch(/switched off in Settings/);
    expect(steps[2].note).toMatch(/switched off in Settings/);
  });

  // the letters of a turn's first decision: A is "answer", then the registry's order
  const letter = (tool: string) => 'ABCDEFGHIJKLMNOP'[1 + TOOLS.findIndex((t) => t.name === tool)];
  const sure = (l: string): [string, number][] => [[l, -0.05], ['A', -4], ['B', -4.5]].filter(([x], i) => i === 0 || x !== l) as [string, number][];

  it('one-token decisions: the choice is read from the scores, and the step shows every option', async () => {
    model.loaded = true;
    model.scores = [sure(letter('audit_schema')), sure('A')];
    model.replies = ['{"rule":"all"}'];
    const { steps } = await turn('is anything wrong with my keys?');
    expect(outline(steps)).toEqual(['route:model:ok', 'args:model:ok', 'tool:code:ok', 'route:model:ok', 'reply:model:ok']);
    expect(steps[0].title).toBe('Chose audit_schema');
    expect(steps[0].details?.map((d) => d.label)).toEqual(['Sent to the model', 'How the model scored each option']);
    expect(steps[0].details?.[1].text.split('\n')[0]).toMatch(/%\s+\w\s+audit_schema$/);
  });

  it('one-token decisions: a readout with no option in it falls back to spelling the name out', async () => {
    model.loaded = true;
    model.replies = ['audit_schema', '{"rule":"all"}', 'answer'];
    const { steps } = await turn('is anything wrong with my keys?');
    expect(steps[0].title).toBe('Chose audit_schema');
    expect(steps[0].note).toMatch(/one-token readout failed/);
  });

  it('several steps: the model looks further with tools that read and report, then one answer is written from all of them', async () => {
    model.loaded = true;
    // describe_tables, then (A answer, B relate_tables, C inspect_indexes, D audit_schema) → C, then (A answer, B audit_schema) → A
    model.scores = [sure(letter('describe_tables')), sure('C'), sure('A')];
    model.replies = ['{"tables":["orders"]}', '{"tables":["orders"]}'];
    const { steps, updates } = await turn('walk me through the orders table');
    expect(outline(steps)).toEqual(['route:model:ok', 'args:model:ok', 'tool:code:ok', 'route:model:ok', 'args:model:ok', 'tool:code:ok', 'route:model:ok', 'reply:model:ok']);
    expect(steps[3].title).toBe('Chose inspect_indexes next');
    expect(steps[6].title).toBe('Enough to answer');
    const prompt = steps[7].details?.[0].text ?? '';
    expect(prompt).toContain('Result of describe_tables:');
    expect(prompt).toContain('Result of inspect_indexes:');
    expect(updates.filter((u) => u.type === 'tool').map((u) => u.type === 'tool' && u.tool)).toEqual(['describe_tables', 'inspect_indexes']);
    // the cards of both tools are kept
    const last = updates.filter((u) => u.type === 'result').pop();
    expect(last?.type === 'result' && last.blocks.map((b) => b.kind === 'info' && b.title)).toEqual(['Table details', 'Indexes']);
  });

  it('several steps: a further step the model only leans towards is not taken', async () => {
    model.loaded = true;
    model.scores = [sure(letter('describe_tables')), [['C', -1.0], ['A', -1.1], ['B', -1.2], ['D', -1.3]]];
    model.replies = ['{"tables":["orders"]}'];
    const { steps } = await turn('walk me through the orders table');
    expect(outline(steps)).toEqual(['route:model:ok', 'args:model:ok', 'tool:code:ok', 'route:model:ok', 'reply:model:ok']);
    expect(steps[3].note).toMatch(/leaned towards inspect_indexes/);
  });

  it('several steps: tools that end a turn, the limit in Settings and one-click prompts spend no further decision', async () => {
    model.loaded = true;
    model.scores = [sure(letter('focus_tables'))];
    model.replies = ['{"domain":"none","tables":["orders"],"hops":"1"}'];
    expect(outline((await turn('where is the orders table?')).steps)).toEqual(['route:model:ok', 'args:model:ok', 'tool:code:ok', 'reply:model:ok']);

    useSettings.getState().set({ maxSteps: 1 });
    model.scores = [sure(letter('describe_tables'))];
    model.replies = ['{"tables":["orders"]}'];
    expect(outline((await turn('walk me through the orders table')).steps)).toEqual(['route:model:ok', 'args:model:ok', 'tool:code:ok', 'reply:model:ok']);

    useSettings.getState().reset();
    expect(outline((await turn('Describe orders', { tool: 'describe_tables', args: { tables: ['orders'] } })).steps)).toEqual(['route:you:ok', 'tool:code:ok', 'reply:model:ok']);
  });

  it('a weak first choice loses to a plain keyword match for another tool', async () => {
    model.loaded = true;
    model.scores = [[[letter('seed_data'), -1.0], [letter('audit_schema'), -1.1], ['A', -1.2], ['B', -1.3]]];
    const { steps } = await turn('audit the schema');
    expect(outline(steps).slice(0, 2)).toEqual(['route:keywords:warn', 'tool:code:ok']);
    expect(steps[0].title).toBe('Matched audit_schema');
  });
});
