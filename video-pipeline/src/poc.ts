import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import { chromium } from 'playwright';
import { startServer } from './server.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_VIDEO =
  'C:/Users/client/AppData/Local/CapCut/Videos/grynd-blackjack-2026-09-05-17-43-24.mp4';
const OUTPUT = path.join(ROOT, 'output', 'poc.mp4');
const CLIENT_ENTRY = path.join(ROOT, 'src', 'client', 'render.ts');
const CLIENT_JS = path.join(ROOT, 'dist', 'client.js');

type PageState = {
  error: string | null;
  elapsedMs: number | null;
  bytes: number | null;
  status: string | null;
  crossOriginIsolated: boolean;
};

async function main(): Promise<void> {
  const videoPath = process.env.VIDEO_PATH
    ? path.resolve(process.env.VIDEO_PATH)
    : DEFAULT_VIDEO;
  if (!fs.existsSync(videoPath)) {
    throw new Error(
      `test video not found: ${videoPath} — set VIDEO_PATH to an existing MP4`
    );
  }

  const startedAt = performance.now();

  buildSync({
    entryPoints: [CLIENT_ENTRY],
    outfile: CLIENT_JS,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome126'],
    logLevel: 'warning',
  });
  console.log(`[poc] client bundle: ${CLIENT_JS}`);

  const server = await startServer({ videoPath, clientJsPath: CLIENT_JS, outputPath: OUTPUT });
  console.log(`[poc] server: http://127.0.0.1:${server.port}`);

  try {
    const browser = await chromium.launch({
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    try {
      const page = await browser.newPage();
      let renderStartedMs = 0;
      page.on('console', (msg) => {
        if (msg.type() === 'error') console.log('[page console:error]', msg.text());
      });
      page.on('pageerror', (err) => console.log('[page error]', err.message));
      page.on('requestfinished', (req) => {
        if (req.url().includes('/media/')) renderStartedMs = performance.now();
      });

      await page.goto(`http://127.0.0.1:${server.port}/`, {
        waitUntil: 'load',
        timeout: 60_000,
      });

      await page.waitForFunction(
        () => {
          const w = window as unknown as {
            __pocElapsedMs?: number;
            __pocError?: string;
          };
          return w.__pocElapsedMs !== undefined || w.__pocError !== undefined;
        },
        undefined,
        { timeout: 600_000 }
      );

      const state: PageState = await page.evaluate(() => {
        const w = window as unknown as {
          __pocError?: string;
          __pocElapsedMs?: number;
          __pocBytes?: number;
          __pocStatus?: string;
          crossOriginIsolated: boolean;
        };
        return {
          error: w.__pocError ?? null,
          elapsedMs: w.__pocElapsedMs ?? null,
          bytes: w.__pocBytes ?? null,
          status: w.__pocStatus ?? null,
          crossOriginIsolated: w.crossOriginIsolated,
        };
      });

      console.log('[poc] page state:', JSON.stringify(state, null, 2));

      if (state.error) {
        throw new Error(`render failed in browser: ${state.error}`);
      }
      if (!fs.existsSync(OUTPUT)) {
        throw new Error(`output file missing: ${OUTPUT}`);
      }

      const bytes = fs.statSync(OUTPUT).size;
      const wallSeconds = ((performance.now() - renderStartedMs) / 1000).toFixed(1);
      console.log(`[poc] output: ${OUTPUT}`);
      console.log(`[poc] size: ${bytes} bytes`);
      console.log(`[poc] in-browser render time: ${(state.elapsedMs! / 1000).toFixed(1)}s`);
      console.log(`[poc] wall time after media fetch: ${wallSeconds}s`);
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }

  console.log(`[poc] total run: ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});