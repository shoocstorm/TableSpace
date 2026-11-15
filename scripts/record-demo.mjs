// Records the demo video: drives the app through a tour in headless Chrome
// and encodes what was on screen to docs/demo.mp4.
//
//   bun run demo:video                       start the dev server, record, write docs/demo.mp4
//   node scripts/record-demo.mjs --url http://localhost:5173    record an app that is already running
//   node scripts/record-demo.mjs --out docs/demo.mp4 --width 1920 --height 1080 --fps 60 --crf 21
//
// Needs ffmpeg on the PATH and Google Chrome (or CHROME_PATH pointing at a
// Chromium). Frames come from Chrome's screencast with their own timestamps,
// so the video keeps the app's real pace even where frames arrive unevenly.
// The tour is the `tour` function below: edit it to change the video.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const WIDTH = Number(arg('width', 1920));
const HEIGHT = Number(arg('height', 1080));
const OUT = resolve(root, arg('out', 'docs/demo.mp4'));
/** Frames per second of the video, and its quality (ffmpeg's CRF: lower is better and larger). */
const FPS = Number(arg('fps', 30));
const CRF = arg('crf', '30');
const PORT = 5187;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the app ──────────────────────────────────────────────────────────────

/** The dev server, unless --url names an app that is already running. */
async function serve() {
  const given = arg('url');
  if (given) return { url: given, stop: () => {} };
  const child = spawn('bun', ['--bun', 'vite', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
  const url = `http://localhost:${PORT}/`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`the dev server stopped (is port ${PORT} taken?)`);
    if (await fetch(url).then((r) => r.ok, () => false)) return { url, stop: () => child.kill() };
    await sleep(200);
  }
  child.kill();
  throw new Error('the dev server did not start');
}

// ── the pointer ──────────────────────────────────────────────────────────

// Headless Chrome draws no cursor: the page gets one of its own, and a ring where it clicks.
const POINTER = () => {
  const make = () => {
    const dot = document.createElement('div');
    dot.id = 'demo-pointer';
    dot.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2.5 L4 19 L8.6 14.9 L11.6 21.6 L14.4 20.3 L11.5 13.8 L17.6 13.6 Z" fill="#fff" stroke="#0b1322" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    Object.assign(dot.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-100px,-100px)', filter: 'drop-shadow(0 2px 6px rgba(0,0,0,.6))' });
    document.documentElement.append(dot);
    addEventListener('mousemove', (e) => (dot.style.transform = `translate(${e.clientX - 4}px,${e.clientY - 2}px)`), true);
    addEventListener(
      'mousedown',
      (e) => {
        const ring = document.createElement('div');
        Object.assign(ring.style, { position: 'fixed', left: `${e.clientX - 16}px`, top: `${e.clientY - 16}px`, width: '32px', height: '32px', borderRadius: '50%', border: '2px solid #67e8f9', zIndex: '2147483646', pointerEvents: 'none' });
        document.documentElement.append(ring);
        ring.animate([{ transform: 'scale(.4)', opacity: 1 }, { transform: 'scale(1.7)', opacity: 0 }], { duration: 480, easing: 'ease-out' }).onfinish = () => ring.remove();
      },
      true,
    );
  };
  if (document.documentElement) make();
  else addEventListener('DOMContentLoaded', make);
};

/** The moves a person makes: gliding to things, clicking, dragging, typing. Each waits like a person would. */
function hands(page) {
  let at = { x: WIDTH * 0.42, y: HEIGHT * 0.55 };
  const ease = (t) => t * t * (3 - 2 * t);
  async function glide(x, y, ms = 650) {
    const from = at;
    const steps = Math.max(2, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
      const k = ease(i / steps);
      await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
      await sleep(ms / steps);
    }
    at = { x, y };
  }
  /** Clicks what `target` finds (a locator); says so and carries on when it isn't there. */
  async function click(target, { after = 700 } = {}) {
    const box = await target.first().boundingBox({ timeout: 4000 }).catch(() => null);
    if (!box) return void console.warn(`  · skipped a click: ${target} is not on screen`);
    await glide(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(140);
    await page.mouse.down();
    await sleep(70);
    await page.mouse.up();
    await sleep(after);
  }
  /** Drags across the scene, to orbit it. */
  async function drag(x0, y0, x1, y1, ms) {
    await glide(x0, y0, 500);
    await page.mouse.down();
    await glide(x1, y1, ms);
    await page.mouse.up();
  }
  async function type(text, { delay = 42 } = {}) {
    for (const ch of text) {
      await page.keyboard.type(ch);
      await sleep(delay + Math.random() * 30);
    }
  }
  return { glide, click, drag, type };
}

// ── the tour ─────────────────────────────────────────────────────────────

async function tour(page) {
  const { glide, click, drag, type } = hands(page);
  const dock = (name) => page.getByRole('navigation', { name: 'Scene controls' }).getByRole('button', { name, exact: false });
  const step = (text) => console.log(`  ${text}`);
  /** Asks the AI architect by typing, the way a visitor would. */
  const ask = async (text, hold) => {
    await click(page.getByLabel('Message the AI architect'), { after: 250 });
    await type(text);
    await sleep(300);
    await page.keyboard.press('Enter');
    await sleep(hold);
  };
  const scene = { x: (WIDTH - 400) / 2, y: HEIGHT * 0.56 };

  step('the opening: the schema assembles itself');
  await page.waitForSelector('.intro', { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('.intro', { state: 'detached', timeout: 15000 }).catch(() => {});
  await sleep(1200);

  step('orbiting');
  await drag(scene.x - 260, scene.y + 120, scene.x + 240, scene.y + 90, 2600);
  await sleep(700);

  step('search, and a table up close');
  await click(dock('Search'), { after: 500 });
  await type('orders', { delay: 80 });
  await sleep(500);
  await page.keyboard.press('Enter');
  await glide(scene.x + 330, scene.y + 200, 800);
  await sleep(2800);

  step('following a foreign key');
  await click(page.getByRole('button', { name: /→\s*users$/ }), { after: 2800 });

  step('X-ray, and labels on the lines');
  await click(dock('X-ray'), { after: 2200 });
  await click(dock('Labels'), { after: 2200 });
  await click(dock('Labels'), { after: 500 });
  await click(dock('X-ray'), { after: 400 });

  step('the exploded view');
  await click(dock('Reset'), { after: 1500 });
  await click(dock('Explode'), { after: 2600 });
  await click(dock('Collapse'), { after: 1400 });

  step('the AI architect: a query trace');
  await ask('Simulate checkout join', 5500);
  await click(page.getByRole('button', { name: 'Stop the query trace' }), { after: 600 });

  step('the AI architect: an audit');
  await ask('Full anti-pattern radar', 3400);

  step('the AI architect: a refactor, as ghost tables');
  await ask('Normalize bloated tables', 4000);
  await click(dock('Ghosts'), { after: 300 });
  await click(page.getByRole('button', { name: 'Remove the warning badges' }), { after: 300 });
  await click(page.getByRole('button', { name: 'Clear the focus' }), { after: 300 });

  step('the AI architect: seeding mock data');
  await click(dock('Reset'), { after: 1200 });
  await ask('Seed mock data', 6000);

  step('other worlds');
  await click(dock('World'), { after: 700 });
  for (const world of ['Synthwave', 'Nebula', 'Ocean Abyss']) await click(page.getByRole('button', { name: world }), { after: 1400 });
  await click(page.getByRole('button', { name: 'Close the environment picker' }), { after: 400 });

  step('a last look');
  await click(dock('Reset'), { after: 800 });
  await drag(scene.x + 280, scene.y + 150, scene.x - 320, scene.y + 110, 3200);
  await glide(scene.x, HEIGHT + 40, 600);
  await sleep(1200);
}

// ── recording ────────────────────────────────────────────────────────────

/** Saves every frame Chrome paints, with the time it was painted. */
async function record(page, dir) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const writes = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = join(dir, `${String(frames.length).padStart(6, '0')}.jpg`);
    frames.push({ file, at: metadata.timestamp });
    writes.push(writeFile(file, Buffer.from(data, 'base64')));
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 93, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });
  return async () => {
    await cdp.send('Page.stopScreencast').catch(() => {});
    await Promise.all(writes);
    return frames;
  };
}

/** Frames to an H.264 video, each shown for as long as it was on screen. */
async function encode(frames, dir, out) {
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, (frames[i + 1]?.at ?? f.at + 1 / 30) - f.at).toFixed(5)}`).join('\n');
  const listFile = join(dir, 'frames.txt');
  await writeFile(listFile, `ffconcat version 1.0\n${list}\nfile '${frames.at(-1).file}'\n`);
  await mkdir(dirname(out), { recursive: true });
  const args = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', `fps=${FPS},scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', CRF, '-movflags', '+faststart', out];
  await new Promise((done, fail) => {
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    ff.on('error', () => fail(new Error('ffmpeg is not installed (brew install ffmpeg)')));
    ff.on('exit', (code) => (code === 0 ? done() : fail(new Error(`ffmpeg exited with ${code}`))));
  });
}

async function launch() {
  const options = { headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars'] };
  if (process.env.CHROME_PATH) return chromium.launch({ ...options, executablePath: process.env.CHROME_PATH });
  return chromium.launch({ ...options, channel: 'chrome' }).catch(() => chromium.launch(options));
}

const app = await serve();
const dir = await mkdtemp(join(tmpdir(), 'tablespace-demo-'));
const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1, colorScheme: 'dark' });
  page.on('pageerror', (e) => console.warn('  · page error:', e.message));
  await page.addInitScript(POINTER);
  console.log(`Recording ${app.url} at ${WIDTH}×${HEIGHT}`);
  const stop = await record(page, dir);
  await page.goto(app.url, { waitUntil: 'commit' });
  await tour(page);
  const frames = await stop();
  const seconds = frames.at(-1).at - frames[0].at;
  console.log(`Encoding ${frames.length} frames (${seconds.toFixed(1)} s, ${(frames.length / seconds).toFixed(0)} fps on average)`);
  await encode(frames, dir, OUT);
  console.log(`Wrote ${OUT} (${((await stat(OUT)).size / 1e6).toFixed(1)} MB)`);
} finally {
  await browser.close();
  app.stop();
  await rm(dir, { recursive: true, force: true });
}
