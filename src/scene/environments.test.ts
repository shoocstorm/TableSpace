import { describe, expect, it } from 'vitest';
import { DEFAULT_ENVIRONMENT, ENVIRONMENTS, environmentById } from './environments';

const HEX = /^#[0-9a-f]{6}$/i;
/** Perceived brightness of a hex color, 0–1. */
const luma = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};

describe('environments', () => {
  it('have unique ids and names', () => {
    expect(new Set(ENVIRONMENTS.map((e) => e.id)).size).toBe(ENVIRONMENTS.length);
    expect(new Set(ENVIRONMENTS.map((e) => e.name)).size).toBe(ENVIRONMENTS.length);
  });
  it('use full hex colors, which the scene parses', () => {
    for (const e of ENVIRONMENTS) {
      const colors = [e.sky.top, e.sky.horizon, e.sky.bottom, e.fog.color, e.grid.cell, e.grid.section, e.lights.key, e.lights.a, e.lights.b, ...(e.nebula ?? []), ...(e.sun ? [e.sun] : []), ...(e.motes ? [e.motes.color] : [])];
      for (const c of colors) expect(c, `${e.id}: ${c}`).toMatch(HEX);
    }
  });
  it('stay dark behind the tables, whose faces are light text', () => {
    for (const e of ENVIRONMENTS) for (const c of [e.sky.top, e.sky.bottom, e.fog.color]) expect(luma(c), `${e.id}: ${c}`).toBeLessThan(0.2);
  });
  it('fall back to the default for an unknown or missing id', () => {
    expect(environmentById('nope')).toBe(DEFAULT_ENVIRONMENT);
    expect(environmentById(undefined)).toBe(DEFAULT_ENVIRONMENT);
    expect(environmentById('synthwave').name).toBe('Synthwave');
  });
});
