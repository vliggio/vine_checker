#!/usr/bin/env node
/**
 * Rasterises assets/icon.svg into the toolbar PNGs Chrome requires.
 *
 *   node tools/make-icons.js
 *
 * assets/icon.svg is the single source of truth for the mark -- edit that, then
 * re-run this. Rendering goes through headless Chrome rather than an SVG library
 * so there is nothing to install: if you can load this extension, you can build
 * its icons. Set CHROME to override the binary.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SIZES = [16, 32, 48, 128];
const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'assets', 'icon.svg');
const OUT_DIR = path.join(ROOT, 'icons');

const CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);

function findChrome() {
  for (const candidate of CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `No Chrome binary found. Tried:\n  ${CANDIDATES.join('\n  ')}\nSet CHROME=/path/to/chrome and retry.`
  );
}

const chrome = findChrome();
const svgSource = fs.readFileSync(SOURCE, 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vine-icons-'));
fs.mkdirSync(OUT_DIR, { recursive: true });

try {
  for (const size of SIZES) {
    // The SVG markup is inlined rather than linked: a file:// page loading a
    // file:// image needs extra Chrome flags, and inlining sidesteps that entirely.
    // Its viewBox does the scaling, so the intrinsic width/height are overridden.
    const page = path.join(tmp, `icon-${size}.html`);
    fs.writeFileSync(
      page,
      `<!doctype html><meta charset="utf-8">
       <style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
       svg{display:block;width:${size}px;height:${size}px}</style>
       ${svgSource}`
    );

    const out = path.join(OUT_DIR, `icon${size}.png`);
    execFileSync(
      chrome,
      [
        // Deliberately no --user-data-dir: pointing headless Chrome at a fresh
        // profile directory makes it hang on macOS. The default headless profile
        // is fine and does not disturb a running Chrome.
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--default-background-color=00000000',
        `--window-size=${size},${size}`,
        `--screenshot=${out}`,
        new URL('file://' + page).href
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 }
    );

    if (!fs.existsSync(out)) throw new Error(`Chrome produced no output for ${size}px`);
    console.log(`wrote ${path.relative(process.cwd(), out)} (${fs.statSync(out).size} bytes)`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
