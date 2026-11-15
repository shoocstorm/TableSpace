import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../llm/engine';
import { useSettings } from '../state/settings';
import { runTurn, type Step, type TurnUpdate } from './run';

// The model, scripted: what it would reply to each constrained question, and whether one is loaded at all.
const model = vi.hoisted(() => ({ loaded: false, replies: [] as string[], said: 'Two foreign keys lack an index.' }));

vi.mock('../llm/engine', () => ({
  hasModel: () => model.loaded,
  isAbort: (e: unknown) => e instanceof Error && e.name === 'AbortError',
  complete: async () => model.replies.shift() ?? '',
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
  return { steps, text: updates.filter((u) => u.type === 'text').pop()?.text ?? '' };
}
const outline = (steps: Step[]) => steps.map((s) => `${s.kind}:${s.by}:${s.status}`);

describe('the steps of a turn', () => {
  beforeEach(() => {
    model.loaded = false;
    model.replies = [];
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
    model.replies = ['audit_schema', '{"rule":"missing_fk_index"}'];
    const { steps, text } = await turn('is anything wrong with my keys?');
    expect(outline(steps)).toEqual(['route:model:ok', 'args:model:ok', 'tool:code:ok', 'reply:model:ok']);
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
});
