/* =============================================================================
 * render.mjs  —  Deterministic frame capture + H.264 encode for the Vert demo.
 *
 *   Playwright (Chromium)  drives  window.seek(t)  at 60 fps across 0 → 45 s,
 *   screenshots every frame, and pipes the PNG stream straight into the
 *   ffmpeg binary shipped with `imageio-ffmpeg` (libx264, yuv420p, CRF 18).
 *
 *   Output:  vert-ar-reconciliation-demo.mp4   (1920×1080, 60 fps, H.264)
 *
 *   Usage:   node render.mjs [path/to/vert-demo.html] [out.mp4]
 * ========================================================================== */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* -------- config -------- */
const FPS        = 60;
const DURATION   = 45;                         // seconds
const WIDTH      = 1920;
const HEIGHT     = 1080;
const CRF        = 18;                          // visually lossless-ish, small file
const HTML       = resolve(process.argv[2] || resolve(__dirname, '../..', 'vert-demo.html'));
const OUT        = resolve(process.argv[3] || resolve(__dirname, 'vert-ar-reconciliation-demo.mp4'));
const CHROME     = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const TOTAL      = process.env.TEST_FRAMES ? +process.env.TEST_FRAMES
                                           : Math.round(DURATION * FPS);  // 2700 frames

/* -------- resolve the imageio-ffmpeg binary -------- */
function ffmpegExe(){
  const envp = process.env.IMAGEIO_FFMPEG_EXE;
  if (envp && existsSync(envp)) return envp;
  try {
    const p = execSync('python3 -c "import imageio_ffmpeg,sys; sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())"',
                       { encoding: 'utf8' }).trim();
    if (p && existsSync(p)) return p;
  } catch {}
  const fallback = '/usr/local/lib/python3.11/dist-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v7.0.2';
  if (existsSync(fallback)) return fallback;
  throw new Error('Could not locate an imageio-ffmpeg binary. `pip install imageio-ffmpeg`.');
}

if (!existsSync(HTML)) { console.error('HTML not found:', HTML); process.exit(1); }

const FFMPEG = ffmpegExe();
console.log('· html    :', HTML);
console.log('· output  :', OUT);
console.log('· ffmpeg  :', FFMPEG);
console.log('· frames  :', TOTAL, `(${DURATION}s @ ${FPS}fps)`);

/* -------- launch ffmpeg (reads a raw PNG stream on stdin) -------- */
const ff = spawn(FFMPEG, [
  '-y',
  '-f', 'image2pipe',
  '-vcodec', 'mjpeg',
  '-framerate', String(FPS),
  '-i', '-',
  '-vf', 'format=yuv420p',
  '-c:v', 'libx264',
  '-preset', 'medium',
  '-crf', String(CRF),
  '-profile:v', 'high',
  '-level', '4.2',
  '-x264-params', 'keyint=120:min-keyint=60',
  '-movflags', '+faststart',
  OUT,
], { stdio: ['pipe', 'inherit', 'inherit'] });

const ffDone = new Promise((res, rej) => {
  ff.on('close', code => code === 0 ? res() : rej(new Error('ffmpeg exited with code ' + code)));
  ff.on('error', rej);
});

/* backpressure-aware write */
function writeFrame(buf){
  return new Promise((res, rej) => {
    if (ff.stdin.write(buf)) res();
    else ff.stdin.once('drain', res);
    ff.stdin.once('error', rej);
  });
}

/* -------- launch chromium -------- */
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--force-color-profile=srgb', '--hide-scrollbars',
         '--disable-lcd-text', '--font-render-hinting=none'],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
await page.goto('file://' + HTML);
await page.waitForFunction('window.__ready===true', { timeout: 15000 });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);   // settle embedded font + first paint

/* -------- capture loop -------- */
const t0 = Date.now();
for (let f = 0; f < TOTAL; f++){
  const t = f / FPS;
  await page.evaluate(tt => window.seek(tt), t);
  const buf = await page.screenshot({ type: 'jpeg', quality: 100, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
  await writeFrame(buf);
  if (f % 60 === 0 || f === TOTAL - 1){
    const pct = ((f + 1) / TOTAL * 100).toFixed(1);
    const el  = (Date.now() - t0) / 1000;
    const eta = el / (f + 1) * (TOTAL - f - 1);
    process.stdout.write(`\r  frame ${f + 1}/${TOTAL}  ${pct}%  ·  ${el.toFixed(0)}s elapsed  ·  ~${eta.toFixed(0)}s left   `);
  }
}
process.stdout.write('\n');

await browser.close();
ff.stdin.end();
await ffDone;
console.log('✓ wrote', OUT);
