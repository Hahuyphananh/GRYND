import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface OcrWordBox {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrLineData {
  text: string;
  words: OcrWordBox[];
}

export interface OcrFrameResult {
  image: string;
  text: string;
  lines: OcrLineData[];
  error?: string;
}

export interface WindowsOcrOutput {
  engine: string;
  locale: string;
  count: number;
  results: OcrFrameResult[];
  error?: string;
}

interface WindowsOcrResult {
  engine: string;
  locale: string;
  count: number;
  results: Array<{
    image: string;
    text?: string;
    lines?: Array<{ text: string; words: OcrWordBox[] }>;
    error?: string;
  }>;
  error?: string;
}

export const OCR_SCRIPT = path.join(projectRoot(), 'scripts', 'ocr-win.ps1');

function projectRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..');
}

/**
 * Run the locally installed Windows OCR engine (Windows.Media.Ocr) over the
 * frames in `framesDir` via a PowerShell WinRT bridge. No external OCR engine
 * or network API is used. The bridge writes its JSON to a temp file (UTF-8)
 * because PowerShell 5.1 encodes console output in the OEM codepage, which
 * would corrupt non-ASCII text when re-read as UTF-8.
 */
export async function runWindowsOcr(
  framesDir: string,
  opts: { pattern?: string; locale?: string; timeoutMs?: number } = {}
): Promise<WindowsOcrOutput> {
  const pattern = opts.pattern ?? 'frame-*.jpg';
  const locale = opts.locale ?? 'fr-CA';
  const timeoutMs = opts.timeoutMs ?? 900_000;
  const outFile = path.join(os.tmpdir(), `grynd-ocr-${process.pid}-${Date.now()}.json`);

  try {
    await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', OCR_SCRIPT,
        '-InputDir', framesDir,
        '-Pattern', pattern,
        '-Locale', locale,
        '-OutFile', outFile,
      ],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }
    );

    const raw = fs.readFileSync(outFile, 'utf8');
    return parseResult(raw);
  } catch (e) {
    return {
      engine: 'windows-ocr',
      locale: '',
      count: 0,
      results: [],
      error: `Windows OCR invocation failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    try {
      fs.rmSync(outFile, { force: true });
    } catch {
      // best effort
    }
  }
}

function parseResult(raw: string): WindowsOcrOutput {
  const cleaned = raw.replace(/^\uFEFF/, '');
  try {
    const parsed = JSON.parse(cleaned) as WindowsOcrResult;
    if (parsed.error) return { engine: 'windows-ocr', locale: '', count: 0, results: [], error: parsed.error };
    return {
      engine: parsed.engine ?? 'windows-ocr',
      locale: parsed.locale ?? '',
      count: parsed.count ?? 0,
      results: (parsed.results ?? []).map((r) => ({
        image: r.image,
        text: r.text ?? '',
        lines: r.lines ?? [],
        error: r.error,
      })),
    };
  } catch (parseErr) {
    return {
      engine: 'windows-ocr',
      locale: '',
      count: 0,
      results: [],
      error: `unparsable OCR output: ${cleaned.slice(0, 300)}`,
    };
  }
}