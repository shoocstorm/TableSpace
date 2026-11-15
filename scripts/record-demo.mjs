// Records the demo video: drives the app through a tour in headless Chrome
// and encodes what was on screen to docs/demo.mp4.
//
//   bun run demo:video                                        start the dev server, record, write docs/demo.mp4
//   node scripts/record-demo.mjs --url http://localhost:5173   record an app that is already running
//   node scripts/record-demo.mjs --width 3840 --height 2160    a 4K video
//   node scripts/record-demo.mjs --scale 1 --fps 30            lighter: capture at 1×, 30 fps
//   node scripts/record-demo.mjs --out docs/demo.mp4 --crf 18 --preset slow
//
// Needs ffmpeg on the PATH and Google Chrome (or CHROME_PATH pointing at a
// Chromium). The page renders at --scale× the video's size (2× by default,
// clamped so the capture stays within 4K) and the frames are minified back
// down with a lanczos filter: supersampled 1080p from a 3840×2160 capture,
// so text and lines stay crisp. Frames come from Chrome's screencast with
// their own timestamps, so the video keeps the app's real pace even where
// frames arrive unevenly.
//
// The script also injects an overlay the tour drives: a pointer with a
// glowing trail and click rings, lower-third captions (window.__demo.caption)
// and keycap flashes for shortcuts (window.__demo.keys). The tour is the
// `tour` function below: edit it to change the video.

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
const FPS = Number(arg('fps', 60));
const CRF = arg('crf', '20');
/** Device pixels per video pixel while capturing. Halves are allowed; the cap keeps the capture within 4K. */
const SCALE = (() => {
  const wanted = Number(arg('scale', 2));
  const fits = Math.floor(Math.sqrt((3840 * 2160) / (WIDTH * HEIGHT)) * 2) / 2;
  return Math.min(wanted, Math.max(1, fits));
})();
const CAPW = Math.round(WIDTH * SCALE);
const CAPH = Math.round(HEIGHT * SCALE);
const PRESET = arg('preset', WIDTH * HEIGHT >= 2560 * 1440 ? 'medium' : 'slow');
/** What the AI drawer takes from the stage when open (index.css --drawer-w). */
const DRAWER = 400;
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

// ── the overlay: pointer, captions, keycaps ──────────────────────────────

// Headless Chrome draws no cursor: the page gets one of its own — an arrow
// with a glowing trail and double click rings — plus the lower-third captions
// and keycap flashes the tour drives through window.__demo.
const OVERLAY = () => {
  const make = () => {
    const pointer = document.createElement('div');
    pointer.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2.5 L4 19 L8.6 14.9 L11.6 21.6 L14.4 20.3 L11.5 13.8 L17.6 13.6 Z" fill="#fff" stroke="#0b1322" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    Object.assign(pointer.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-100px,-100px)', filter: 'drop-shadow(0 2px 8px rgba(0,0,0,.65))' });
    const trail = document.createElement('div');
    Object.assign(trail.style, { position: 'fixed', left: '0', top: '0', width: '28px', height: '28px', borderRadius: '50%', zIndex: '2147483645', pointerEvents: 'none', transform: 'translate(-100px,-100px)', opacity: '0', transition: 'opacity .3s ease', background: 'radial-gradient(circle, rgba(103,232,249,.55), rgba(103,232,249,0) 70%)' });
    document.documentElement.append(trail, pointer);
    let tx = -100;
    let ty = -100;
    let x = -100;
    let y = -100;
    let moved = 0;
    addEventListener('mousemove', (e) => {
      tx = e.clientX;
      ty = e.clientY;
      moved = performance.now();
      pointer.style.transform = `translate(${e.clientX - 5}px,${e.clientY - 3}px)`;
    }, true);
    const follow = () => {
      x += (tx - x) * 0.16;
      y += (ty - y) * 0.16;
      trail.style.transform = `translate(${x - 14}px,${y - 14}px)`;
      trail.style.opacity = performance.now() - moved < 160 ? '1' : '0';
      requestAnimationFrame(follow);
    };
    follow();
    addEventListener('mousedown', (e) => {
      const ring = (size, color, to, ms) => {
        const r = document.createElement('div');
        Object.assign(r.style, { position: 'fixed', left: `${e.clientX - size / 2}px`, top: `${e.clientY - size / 2}px`, width: `${size}px`, height: `${size}px`, borderRadius: '50%', border: `2px solid ${color}`, zIndex: '2147483646', pointerEvents: 'none' });
        document.documentElement.append(r);
        r.animate([{ transform: 'scale(.45)', opacity: 1 }, { transform: `scale(${to})`, opacity: 0 }], { duration: ms, easing: 'cubic-bezier(.2,.7,.3,1)' }).onfinish = () => r.remove();
      };
      ring(46, '#67e8f9', 1.8, 520);
      ring(20, '#a78bfa', 2.4, 420);
    }, true);

    const caption = document.createElement('div');
    Object.assign(caption.style, { position: 'fixed', left: '50%', bottom: '150px', zIndex: '2147483644', pointerEvents: 'none', display: 'none', opacity: '0', transform: 'translateX(-50%) translateY(14px)', transition: 'opacity .38s ease, transform .38s cubic-bezier(.2,.8,.2,1)', textAlign: 'center', width: 'max-content', maxWidth: '80vw', textShadow: '0 2px 18px rgba(2,6,17,.95), 0 0 44px rgba(2,6,17,.8)' });
    caption.innerHTML = '<div id="demo-kicker" style="font:600 12px/1 Space Grotesk,Inter,system-ui,sans-serif;letter-spacing:.3em;text-transform:uppercase;color:#67e8f9;margin-bottom:10px"></div><div id="demo-title" style="font:600 27px/1.25 Space Grotesk,Inter,system-ui,sans-serif;color:#f1f5f9"></div>';
    document.documentElement.append(caption);
    let captionTimer;
    let keysEl;
    window.__demo = {
      caption(kicker, title) {
        caption.querySelector('#demo-kicker').textContent = kicker ?? '';
        caption.querySelector('#demo-title').textContent = title ?? '';
        clearTimeout(captionTimer);
        caption.style.display = 'block';
        requestAnimationFrame(() => {
          caption.style.opacity = '1';
          caption.style.transform = 'translateX(-50%) translateY(0)';
        });
        captionTimer = setTimeout(() => {
          caption.style.opacity = '0';
          caption.style.transform = 'translateX(-50%) translateY(10px)';
          captionTimer = setTimeout(() => (caption.style.display = 'none'), 420);
        }, 3600);
      },
      keys(caps) {
        keysEl?.remove();
        keysEl = document.createElement('div');
        Object.assign(keysEl.style, { position: 'fixed', left: '50%', bottom: '96px', zIndex: '2147483644', pointerEvents: 'none', display: 'flex', gap: '8px', alignItems: 'center' });
        caps.forEach((cap, i) => {
          if (i) {
            const plus = document.createElement('span');
            plus.textContent = '+';
            Object.assign(plus.style, { color: '#94a3b8', font: '600 15px system-ui' });
            keysEl.append(plus);
          }
          const key = document.createElement('div');
          key.textContent = cap;
          Object.assign(key.style, { minWidth: '46px', height: '46px', padding: '0 13px', display: 'grid', placeItems: 'center', font: '600 17px ui-monospace,SFMono-Regular,Menlo,monospace', color: '#e2e8f0', background: 'rgba(9,15,28,.9)', border: '1px solid rgba(148,163,184,.4)', borderRadius: '12px', boxShadow: '0 10px 28px rgba(0,0,0,.55), inset 0 -2px 0 rgba(255,255,255,.07)' });
          keysEl.append(key);
        });
        document.documentElement.append(keysEl);
        keysEl.animate([{ transform: 'translateX(-50%) scale(.72)', opacity: 0 }, { transform: 'translateX(-50%) scale(1)', opacity: 1 }], { duration: 240, easing: 'cubic-bezier(.2,1.5,.35,1)', fill: 'both' });
        const mine = keysEl;
        setTimeout(() => mine.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, fill: 'forwards' }), 1150);
        setTimeout(() => mine.remove(), 1560);
      },
    };
  };
  if (document.documentElement) make();
  else addEventListener('DOMContentLoaded', make);
};

/** The moves a person makes: gliding to things, clicking, dragging, typing. Each waits like a person would. */
function hands(page) {
  let at = { x: WIDTH * 0.42, y: HEIGHT * 0.55 };
  const ease = (t) => t * t * (3 - 2 * t);
  async function glide(x, y, ms = 450) {
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
  async function click(target, { after = 500 } = {}) {
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
  async function type(text, { delay = 24 } = {}) {
    for (const ch of text) {
      await page.keyboard.type(ch);
      await sleep(delay + Math.random() * 12);
    }
  }
  return { glide, click, drag, type };
}

// ── the tour ─────────────────────────────────────────────────────────────

async function tour(page) {
  const { glide, click, drag, type } = hands(page);
  const dock = (name) => page.getByRole('navigation', { name: 'Scene controls' }).getByRole('button', { name, exact: false });
  const step = (text) => console.log(`  ${text}`);
  /** A lower-third caption, and a shortcut pressed with its keys flashed on screen. */
  const say = (kicker, title) => page.evaluate(([k, t]) => window.__demo?.caption(k, t), [kicker, title]);
  const flash = (...caps) => page.evaluate((c) => window.__demo?.keys(c), caps);
  const tap = async (combo, caps, hold = 320) => {
    await flash(...caps);
    await page.keyboard.press(combo);
    await sleep(hold);
  };
  /** Asks the AI architect by typing, the way a visitor would. */
  const ask = async (text, hold) => {
    await click(page.getByLabel('Message the AI architect'), { after: 200 });
    await type(text);
    await sleep(250);
    await page.keyboard.press('Enter');
    await sleep(hold);
  };
  /** The centre of the stage: the drawer takes DRAWER px off the right when it is open. */
  const centre = (open) => ({ x: (WIDTH - (open ? DRAWER : 0)) / 2, y: HEIGHT * 0.54 });

  step('the opening: the schema assembles itself');
  await page.waitForSelector('.intro', { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('.intro', { state: 'detached', timeout: 15000 }).catch(() => {});
  await sleep(700);
  await say('TableSpace', 'Your database, floating in 3D');

  step('orbiting, with the AI architect alongside');
  const o = centre(true);
  await drag(o.x - 260, o.y + 120, o.x + 240, o.y + 90, 1800);
  await sleep(300);

  step('the scene takes the whole screen');
  await click(page.getByRole('button', { name: 'Close the AI drawer' }), { after: 700 });

  step('⌘K search, and a table up close');
  await say('Find', '⌘K finds any table or column');
  await tap('ControlOrMeta+k', ['⌘', 'K'], 420);
  await type('orders', { delay: 60 });
  await sleep(350);
  await page.keyboard.press('Enter');
  await sleep(2100);

  step('the inspector: fold, unfold, and what it depends on');
  await say('Read', 'Columns, keys and indexes — one click');
  await click(page.getByRole('button', { name: 'Fold', exact: true }), { after: 1000 });
  await click(page.getByRole('button', { name: 'Unfold', exact: true }), { after: 1400 });
  await click(page.getByRole('button', { name: 'Isolate dependencies' }), { after: 1800 });

  step('following a foreign key');
  await click(page.getByRole('button', { name: /→\s*users$/ }), { after: 1900 });

  step('X-ray and labels, from the keyboard');
  await say('X-ray', 'See what a table depends on');
  await tap('x', ['X'], 1500);
  await tap('l', ['L'], 1500);
  await tap('l', ['L'], 400);
  await tap('x', ['X'], 400);

  step('the exploded view');
  await say('Explode', 'Domains pull apart to be read');
  await tap('e', ['E'], 2200);
  await tap('e', ['E'], 700);

  step('a domain from the legend, by its colour');
  await tap('r', ['R'], 900);
  await click(page.getByRole('button', { name: /^Catalog/ }), { after: 1700 });
  await tap('r', ['R'], 700);

  step('the AI architect: a query trace');
  await click(page.getByRole('button', { name: 'Open the AI drawer' }), { after: 600 });
  await say('Trace', 'Watch a query move through the schema');
  await ask('Simulate checkout join', 4000);
  await click(page.getByRole('button', { name: 'Stop the query trace' }), { after: 500 });

  step('the audit, run from the health ring');
  await say('Audit', 'Anti-patterns pinned as warnings');
  await click(page.getByRole('button', { name: /Schema health/ }), { after: 2600 });
  await click(page.getByRole('button', { name: /what if every missing index/i }), { after: 2400 });
  await say('What-if', 'Try an index before you build it');
  await click(page.getByRole('button', { name: 'Remove the what-if indexes' }), { after: 400 });
  await click(page.getByRole('button', { name: 'Remove the warning badges' }), { after: 500 });

  step('the AI architect: SQL from words, run on mock rows');
  await ask('Count orders per user', 4600);
  await click(page.getByRole('button', { name: 'Open table' }), { after: 1200 });
  const result = page.getByRole('dialog', { name: 'Query result' });
  await click(result.locator('thead button[title^="Sort by"]').nth(1), { after: 900 });
  await click(page.getByLabel('Search every column'), { after: 200 });
  await type('an', { delay: 80 });
  await sleep(800);
  await click(page.getByRole('button', { name: 'Clear the search' }), { after: 600 });
  await click(result.locator('tbody tr').first(), { after: 1300 });
  await click(page.getByRole('button', { name: 'Close the result' }), { after: 500 });

  step('the model runs in this browser');
  await say('Private by design', 'The model runs in this tab — nothing leaves');
  await click(page.getByRole('button', { name: /^Local model/ }), { after: 1900 });
  await click(page.getByRole('dialog', { name: 'Local models' }).getByRole('button', { name: 'Close' }), { after: 400 });

  step('what the architect is, and what it can do');
  await click(page.getByRole('tab', { name: 'Profile' }), { after: 1800 });
  await click(page.getByRole('tab', { name: 'Tools' }), { after: 1800 });
  await click(page.getByRole('tab', { name: 'Chat' }), { after: 500 });

  step('a refactor, floated as ghost tables');
  await say('Refactor', 'Previews float as ghosts — nothing changes');
  await ask('Normalize bloated tables', 3600);
  await click(dock('Ghosts'), { after: 500 });
  await click(page.getByRole('button', { name: 'Clear the focus' }), { after: 500 });

  step('seeding mock data, then reading it');
  await say('Mock data', 'Invented rows, parents first');
  await ask('Seed mock data', 5200);
  await tap('ControlOrMeta+k', ['⌘', 'K'], 400);
  await type('order_items', { delay: 45 });
  await page.keyboard.press('Enter');
  await sleep(2300);
  await page.keyboard.press('Escape');
  await sleep(400);
  await click(page.getByRole('button', { name: 'Close the AI drawer' }), { after: 600 });

  step('import a schema of your own');
  await say('Bring your own', 'Paste DDL — or drop a .sql file');
  await tap('i', ['I'], 600);
  await click(page.getByRole('button', { name: 'Use the example' }), { after: 1200 });
  await click(page.getByRole('button', { name: 'Open in 3D' }), { after: 2600 });
  const wide = centre(false);
  await drag(wide.x + 180, wide.y + 60, wide.x - 200, wide.y + 90, 1500);
  const switcher = page.getByRole('combobox', { name: 'Database' });
  await glide(WIDTH * 0.16, HEIGHT * 0.06, 500);
  await switcher.selectOption('demo');
  await sleep(2200);

  step('other worlds');
  await say('Worlds', 'Six places to float your schema');
  await tap('w', ['W'], 500);
  for (const world of ['Synthwave', 'Blueprint', 'Nebula', 'Ocean Abyss']) await click(page.getByRole('button', { name: world }), { after: 1300 });
  await click(page.getByRole('button', { name: 'Deep Space' }), { after: 900 });
  await click(page.getByRole('button', { name: 'Close the environment picker' }), { after: 400 });

  step('the shortcuts sheet');
  await tap('Shift+Slash', ['?'], 1700);
  await page.keyboard.press('Escape');
  await sleep(500);

  step('a last look');
  await say('TableSpace', 'See your schema think');
  await tap('r', ['R'], 800);
  await drag(wide.x + 300, wide.y + 120, wide.x - 340, wide.y + 80, 2600);
  await glide(wide.x, HEIGHT + 60, 500);
  await sleep(1400);
}

// ── recording ────────────────────────────────────────────────────────────

/** Saves every frame Chrome paints — at --scale× the video's size — with the time it was painted. */
async function record(page, dir) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const writes = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = join(dir, `${String(frames.length).padStart(6, '0')}.jpg`);
    frames.push({ file, at: metadata?.timestamp ?? frames.at(-1)?.at ?? 0 });
    writes.push(writeFile(file, Buffer.from(data, 'base64')));
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: CAPW, maxHeight: CAPH, everyNthFrame: 1 });
  return async () => {
    await cdp.send('Page.stopScreencast').catch(() => {});
    await Promise.all(writes);
    return frames;
  };
}

/** Frames to an H.264 video, each shown for as long as it was on screen, minified to the output size, fading in and out. */
async function encode(frames, dir, out) {
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, (frames[i + 1]?.at ?? f.at + 1 / FPS) - f.at).toFixed(5)}`).join('\n');
  const listFile = join(dir, 'frames.txt');
  await writeFile(listFile, `ffconcat version 1.0\n${list}\nfile '${frames.at(-1).file}'\n`);
  const seconds = frames.at(-1).at - frames[0].at + 1 / FPS;
  const vf = `fps=${FPS},scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=yuv420p,fade=t=in:st=0:d=0.5,fade=t=out:st=${Math.max(0, seconds - 0.9).toFixed(3)}:d=0.9`;
  await mkdir(dirname(out), { recursive: true });
  const args = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', vf, '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF, '-movflags', '+faststart', out];
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
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: SCALE, colorScheme: 'dark' });
  page.on('pageerror', (e) => console.warn('  · page error:', e.message));
  await page.addInitScript(OVERLAY);
  console.log(`Recording ${app.url} at ${WIDTH}×${HEIGHT} (capture ${CAPW}×${CAPH}, ×${SCALE}, ${FPS} fps)`);
  const stop = await record(page, dir);
  await page.goto(app.url, { waitUntil: 'commit' });
  await tour(page);
  const frames = await stop();
  const seconds = frames.at(-1).at - frames[0].at;
  console.log(`Encoding ${frames.length} frames (${seconds.toFixed(1)} s, ${(frames.length / seconds).toFixed(0)} fps on average) → ${WIDTH}×${HEIGHT}, ${PRESET}/crf ${CRF}`);
  await encode(frames, dir, OUT);
  console.log(`Wrote ${OUT} (${((await stat(OUT)).size / 1e6).toFixed(1)} MB)`);
} finally {
  await browser.close();
  app.stop();
  await rm(dir, { recursive: true, force: true });
}
