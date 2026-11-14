import { describe, expect, it } from 'vitest';
import { describeLoadError, detectDevice, fitMessages, loadParams, loadPlan, startLevel } from './device';
import { availableModels, MODELS, recommendedModel } from './models';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15';

describe('device', () => {
  it('tells phones, iPads and computers apart', () => {
    expect(detectDevice({ userAgent: IPHONE })).toEqual({ mobile: true, ios: true });
    expect(detectDevice({ userAgent: MAC, maxTouchPoints: 5 })).toEqual({ mobile: true, ios: true }); // iPadOS
    expect(detectDevice({ userAgent: MAC, maxTouchPoints: 0 })).toEqual({ mobile: false, ios: false });
  });

  it('starts phones on the CPU with a smaller context, and lower after a failure', () => {
    const phone = detectDevice({ userAgent: IPHONE });
    expect(loadPlan(4096, startLevel(phone, undefined))).toEqual({ level: 1, n_ctx: 2048, gpu: false });
    expect(loadPlan(4096, startLevel(phone, 2))).toEqual({ level: 2, n_ctx: 1024, gpu: false });
    expect(loadPlan(4096, startLevel({ mobile: false, ios: false }, undefined))).toEqual({ level: 0, n_ctx: 4096, gpu: true });
  });

  it('asks for less memory on CPU plans and leaves the GPU plan alone', () => {
    expect(loadParams(loadPlan(4096, 0))).toEqual({ n_ctx: 4096, reasoning_format: 'none' });
    expect(loadParams(loadPlan(4096, 1))).toEqual({ n_ctx: 2048, reasoning_format: 'none', n_gpu_layers: 0, cache_type_k: 'q8_0', cache_type_v: 'q8_0', flash_attn: true, n_parallel: 1, n_batch: 256, n_ubatch: 256 });
  });

  it('reads a failed heap growth as a memory failure worth a lighter retry', () => {
    const f = describeLoadError('Aborted(Cannot enlarge memory arrays)', 'Qwen3', loadPlan(4096, 1), { mobile: true, ios: true });
    expect(f.retryLighter).toBe(true);
    expect(f.message).toMatch(/more memory.*this iPhone/);
  });
});

describe('models on a phone', () => {
  it('offers only the phone models, and every model on a computer', () => {
    expect(availableModels(true).map((m) => m.id)).toEqual(['qwen3-0.6b-q4']);
    expect(availableModels(false)).toEqual(MODELS);
    expect(recommendedModel(true).id).toBe('qwen3-0.6b-q4');
    expect(recommendedModel(false).id).toBe('qwen3-0.6b');
  });
  it('pins every model to a commit and a sha256', () => {
    for (const m of MODELS) {
      expect(m.url).toMatch(/^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\/[\w.-]+\.gguf$/);
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // the phone model must be well under the file that reloaded the page on an iPhone
    expect(availableModels(true).every((m) => m.bytes < 450e6)).toBe(true);
  });
});

describe('fitMessages', () => {
  const sys = { role: 'system', content: 'S'.repeat(900) };
  const turn = (n: number, role = 'user') => ({ role, content: `${n}`.repeat(600) });
  const size = (ms: { content: string }[]) => ms.reduce((n, m) => n + m.content.length + 12, 0);

  it('leaves a prompt that fits untouched', () => {
    const ms = [sys, turn(1)];
    expect(fitMessages(ms, 4096, 200)).toEqual(ms);
  });
  it('drops older turns first, keeping the system prompt and the last message', () => {
    const ms = [sys, turn(1), turn(2, 'assistant'), turn(3), turn(4, 'assistant'), turn(5)];
    const out = fitMessages(ms, 1024, 200);
    expect(out[0]).toBe(sys);
    expect(out.at(-1)).toBe(ms.at(-1));
    expect(out.length).toBeLessThan(ms.length);
    expect(size(out)).toBeLessThanOrEqual((1024 - 200 - 48) * 3);
  });
  it('then shortens the longest message', () => {
    const out = fitMessages([sys, { role: 'user', content: 'x'.repeat(9000) }], 1024, 200);
    expect(out[0]).toBe(sys);
    expect(out[1].content.endsWith('…')).toBe(true);
    expect(size(out)).toBeLessThanOrEqual((1024 - 200 - 48) * 3);
  });
});
