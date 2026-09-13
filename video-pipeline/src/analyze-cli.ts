import * as path from 'node:path';
import { analyzeVideo } from './analysis/pipeline.js';

interface CliArgs {
  video: string;
  fps: number;
  format: 'jpg' | 'png';
  locale: string;
  keepFrames: boolean;
  analysisDir?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { video: '', fps: 2, format: 'jpg', locale: 'fr-CA', keepFrames: false };
  let i = 0;
const usage = (): never => {
    console.error(
      'usage: npx tsx src/analyze-cli.ts <video> [--fps 2] [--format jpg|png] [--locale fr-CA] [--keep-frames] [--out <dir>]'
    );
    console.error('  (npm run analyze -- <video> also works for default options; npm 11 swallows --flags)');
    process.exit(2);
  };
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = [a, argv[i + 1]];
      switch (k) {
        case '--fps':
          args.fps = Number(v);
          if (!Number.isFinite(args.fps) || args.fps <= 0) return usage();
          i += 2;
          break;
        case '--format':
          if (v !== 'jpg' && v !== 'png') return usage();
          args.format = v;
          i += 2;
          break;
        case '--locale':
          args.locale = v;
          i += 2;
          break;
        case '--keep-frames':
          args.keepFrames = true;
          i += 1;
          break;
        case '--out':
          args.analysisDir = v;
          i += 2;
          break;
        default:
          return usage();
      }
    } else {
      args.video = a;
      i += 1;
    }
  }
  if (!args.video) return usage();
  if (!path.isAbsolute(args.video)) args.video = path.resolve(args.video);
  return args;
}

const BAR = '-'.repeat(60);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { analysis, jsonPath, tookMs } = await analyzeVideo(args.video, {
    fps: args.fps,
    format: args.format,
    locale: args.locale,
    keepFrames: args.keepFrames,
    analysisDir: args.analysisDir,
  });

  const g = analysis.game ?? 'unknown';
  const moments = analysis.importantMoments;

  const topText =
    moments.length > 0
      ? moments
          .slice(0, 5)
          .map((m) => `    ${m.score.toFixed(3)}  ${m.importance.padEnd(9)} ${m.timestamp.toFixed(2)}s  ${m.eventType}  (${m.confidence.toFixed(2)})`)
          .join('\n')
      : '    (none)';

  const evSummary =
    analysis.events.length > 0
      ? analysis.events
          .slice(0, 8)
          .map((e) => `    ${e.timestamp.toFixed(2)}s  ${e.importance.padEnd(9)} ${e.type.padEnd(28)} c=${e.confidence.toFixed(2)}`)
          .join('\n')
      : '    (no events detected)';

  console.log(BAR);
  console.log('GRYND gameplay analysis');
  console.log(BAR);
  console.log(`source        : ${analysis.source}`);
  console.log(`duration      : ${analysis.duration.toFixed(2)}s  ${analysis.width}x${analysis.height}@${Math.round(analysis.fps)}fps`);
  console.log(`game          : ${g}  (confidence ${analysis.gameConfidence.toFixed(2)})`);
  console.log(
    `sampling      : ${analysis.sampling.frameCount} frames @ ${analysis.sampling.fps}fps (${analysis.sampling.format}, reused=${analysis.sampling.reused})`
  );
  console.log(`ocr           : ${analysis.ocr.engine ?? 'none'} locale=${analysis.ocr.locale ?? '-'} words=${analysis.ocr.wordCount}`);
  console.log(`observations  : ${analysis.observations.length}`);
  console.log(`events        : ${analysis.events.length}`);
  console.log('\nTop important moments:');
  console.log(topText);
  console.log('\nFirst events:');
  console.log(evSummary);
  if (analysis.warnings.length) {
    console.log('\nWarnings:');
    for (const w of analysis.warnings) console.log(`  ! ${w}`);
  }
  if (analysis.errors.length) {
    console.log('\nErrors:');
    for (const e of analysis.errors) console.log(`  x ${e}`);
  }
  console.log(BAR);
  console.log(`wrote         : ${jsonPath}`);
  console.log(`analysis time : ${(tookMs / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
process.exit(1);
});
