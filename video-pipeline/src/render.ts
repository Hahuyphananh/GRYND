import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import { Browser, Page, chromium } from 'playwright';
import { RenderJob, RenderServer, startRenderServer } from './render-server.js';

const CLIENT_ENTRY = path.resolve(import.meta.dirname, 'render-client.ts');
export const CLIENT_JS = path.resolve(import.meta.dirname, '..', 'dist', 'render-client.js');

export interface RenderResult {
  outputPath: string;
  bytes: number;
  skipped: boolean;
  elapsedMs: number;
  browserError: string | null;
}

interface PageState {
  error: string | null;
  elapsedMs: number | null;
  bytes: number | null;
  done: boolean;
  status: string | null;
  crossOriginIsolated: boolean;
}

export function buildRenderClient(): string {
  buildSync({
    entryPoints: [CLIENT_ENTRY],
    outfile: CLIENT_JS,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome126'],
    logLevel: 'warning',
  });
  return CLIENT_JS;
}

/**
 * Reusable renderer: one headless Chromium + one local render server are
 * shared across a whole batch to avoid unnecessary browser/server launches.
 */
export class RenderRunner {
  private readonly server: RenderServer;
  private readonly browser: Browser;

  private constructor(server: RenderServer, browser: Browser) {
    this.server = server;
    this.browser = browser;
  }

  static async start(): Promise<RenderRunner> {
    buildRenderClient();
    const server = await startRenderServer({ clientJsPath: CLIENT_JS });
    const browser = await chromium.launch({
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    return new RenderRunner(server, browser);
  }

  get port(): number {
    return this.server.port;
  }

  async render(job: RenderJob): Promise<RenderResult> {
    fs.mkdirSync(path.dirname(job.outputPath), { recursive: true });
    if (fs.existsSync(job.outputPath)) {
      fs.rmSync(job.outputPath, { force: true });
    }
    this.server.setJob(job);

    const page: Page = await this.browser.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log('[page console:error]', msg.text());
    });
    page.on('pageerror', (err) => console.log('[page error]', err.message));

    try {
      await page.goto(`http://127.0.0.1:${this.server.port}/`, {
        waitUntil: 'load',
        timeout: 60_000,
      });

      await page.waitForFunction(
        () => {
          const w = window as unknown as { __render?: { done?: boolean; error?: string } };
          return Boolean(w.__render && (w.__render.done === true || w.__render.error));
        },
        undefined,
        { timeout: 1_200_000 }
      );

      const state: PageState = await page.evaluate(() => {
        const w = window as unknown as {
          __render?: {
            error?: string;
            elapsedMs?: number;
            bytes?: number;
            done?: boolean;
            status?: string;
          };
          crossOriginIsolated: boolean;
        };
        const r = w.__render ?? {};
        return {
          error: r.error ?? null,
          elapsedMs: r.elapsedMs ?? null,
          bytes: r.bytes ?? null,
          done: r.done === true,
          status: r.status ?? null,
          crossOriginIsolated: w.crossOriginIsolated,
        };
      });

      if (!state.crossOriginIsolated) {
        console.warn('[render] page is NOT cross-origin isolated — WebCodecs may fail');
      }
      if (state.error) {
        return {
          outputPath: job.outputPath,
          bytes: 0,
          skipped: false,
          elapsedMs: 0,
          browserError: state.error,
        };
      }
      if (!fs.existsSync(job.outputPath)) {
        return {
          outputPath: job.outputPath,
          bytes: 0,
          skipped: false,
          elapsedMs: 0,
          browserError: `browser reported success but output file is missing: ${job.outputPath}`,
        };
      }
      return {
        outputPath: job.outputPath,
        bytes: fs.statSync(job.outputPath).size,
        skipped: false,
        elapsedMs: state.elapsedMs ?? 0,
        browserError: null,
      };
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    await this.browser.close();
    await this.server.close();
  }
}

/** One-shot convenience used for a single render. */
export async function renderOneJob(job: RenderJob): Promise<RenderResult> {
  const runner = await RenderRunner.start();
  try {
    return await runner.render(job);
  } finally {
    await runner.close();
  }
}