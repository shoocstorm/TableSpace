// The worlds the diagram can float in. Each is data: a sky gradient, fog, a
// floor grid, lights and a few optional extras the backdrop knows how to
// draw. Adding one here adds it to the picker. All of them stay dark, because
// the tables' faces are light text on glass.

export type Environment = {
  id: string;
  name: string;
  blurb: string;
  /** The sky dome, from straight up to the horizon to straight down. */
  sky: { top: string; horizon: string; bottom: string };
  fog: { color: string; near: number; far: number };
  grid: { cell: string; section: string };
  lights: { ambient: number; key: string; a: string; b: string };
  /** Whether the sky has stars. */
  stars: boolean;
  /** Two cloud colors painted into the sky. */
  nebula?: [string, string];
  /** A striped sun on the horizon. */
  sun?: string;
  /** Motes drifting through the scene. */
  motes?: { color: string; size: number; speed: number };
  /** Multiplies the glow. */
  bloom: number;
  /** CSS for the picker's preview tile. */
  swatch: string;
};

export const ENVIRONMENTS: Environment[] = [
  {
    id: 'space',
    name: 'Deep Space',
    blurb: 'Quiet stars over a blue grid',
    sky: { top: '#02040a', horizon: '#0b1830', bottom: '#04070d' },
    fog: { color: '#070d19', near: 95, far: 280 },
    grid: { cell: '#12233d', section: '#1d4268' },
    lights: { ambient: 0.7, key: '#ffffff', a: '#38bdf8', b: '#a78bfa' },
    stars: true,
    bloom: 1,
    swatch: 'radial-gradient(circle at 70% 20%, #1d4268 0, transparent 45%), linear-gradient(180deg, #02040a, #0b1830 60%, #04070d)',
  },
  {
    id: 'nebula',
    name: 'Nebula',
    blurb: 'Violet and cyan gas clouds',
    sky: { top: '#07031a', horizon: '#1b0d3f', bottom: '#05030f' },
    fog: { color: '#0d0724', near: 100, far: 300 },
    grid: { cell: '#1d1547', section: '#4a32a0' },
    lights: { ambient: 0.75, key: '#e9d5ff', a: '#22d3ee', b: '#c026d3' },
    stars: true,
    nebula: ['#7c3aed', '#0891b2'],
    motes: { color: '#c4b5fd', size: 4, speed: 0.25 },
    bloom: 1.1,
    swatch: 'radial-gradient(circle at 25% 30%, #7c3aed 0, transparent 50%), radial-gradient(circle at 80% 60%, #0891b2 0, transparent 45%), linear-gradient(180deg, #07031a, #1b0d3f)',
  },
  {
    id: 'synthwave',
    name: 'Synthwave',
    blurb: 'Neon grid and a setting sun',
    sky: { top: '#0b0221', horizon: '#6d1470', bottom: '#0a0118' },
    fog: { color: '#1c0633', near: 90, far: 300 },
    grid: { cell: '#5b1a8a', section: '#ff2bd6' },
    lights: { ambient: 0.75, key: '#ffd6f5', a: '#ff2bd6', b: '#22d3ee' },
    stars: true,
    sun: '#ff9a3d',
    bloom: 1.25,
    swatch: 'radial-gradient(circle at 50% 78%, #ff9a3d 0 18%, transparent 19%), linear-gradient(180deg, #0b0221, #6d1470 72%, #ff2bd6 74%, #0a0118 76%)',
  },
  {
    id: 'blueprint',
    name: 'Blueprint',
    blurb: 'Drafting-table blue, crisp lines',
    sky: { top: '#061b40', horizon: '#0d3576', bottom: '#051630' },
    fog: { color: '#0a2a5e', near: 110, far: 320 },
    grid: { cell: '#2a5fae', section: '#8fbcff' },
    lights: { ambient: 0.95, key: '#ffffff', a: '#93c5fd', b: '#e0f2fe' },
    stars: false,
    bloom: 0.55,
    swatch: 'linear-gradient(0deg, transparent 47%, #8fbcff55 48% 52%, transparent 53%), linear-gradient(90deg, transparent 47%, #8fbcff55 48% 52%, transparent 53%), linear-gradient(180deg, #061b40, #0d3576)',
  },
  {
    id: 'abyss',
    name: 'Ocean Abyss',
    blurb: 'Deep water with drifting plankton',
    sky: { top: '#03323c', horizon: '#04262f', bottom: '#01080c' },
    fog: { color: '#031c23', near: 60, far: 210 },
    grid: { cell: '#0b3a40', section: '#16808a' },
    lights: { ambient: 0.7, key: '#bff6ff', a: '#2dd4bf', b: '#0ea5e9' },
    stars: false,
    motes: { color: '#5eead4', size: 7, speed: 0.35 },
    bloom: 1.05,
    swatch: 'radial-gradient(circle at 50% 0%, #0f6b7a 0, transparent 60%), linear-gradient(180deg, #03323c, #01080c)',
  },
  {
    id: 'terminal',
    name: 'Terminal',
    blurb: 'Green phosphor on black',
    sky: { top: '#000201', horizon: '#03200f', bottom: '#000000' },
    fog: { color: '#010a05', near: 90, far: 260 },
    grid: { cell: '#0a3d1c', section: '#22c55e' },
    lights: { ambient: 0.65, key: '#d1fadf', a: '#22c55e', b: '#a3e635' },
    stars: false,
    motes: { color: '#4ade80', size: 4, speed: 0.6 },
    bloom: 1.15,
    swatch: 'repeating-linear-gradient(0deg, #22c55e33 0 1px, transparent 1px 6px), linear-gradient(180deg, #000201, #03200f)',
  },
];

export const DEFAULT_ENVIRONMENT = ENVIRONMENTS[0];
export const environmentById = (id: string | undefined): Environment => ENVIRONMENTS.find((e) => e.id === id) ?? DEFAULT_ENVIRONMENT;
