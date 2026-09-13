import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

export interface RenderJob {
  mediaPath: string;
  outputPath: string;
  specJson: string;
}

export interface RenderServer {
  port: number;
  setJob: (job: RenderJob) => void;
  close: () => Promise<void>;
}

const INDEX_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>grynd batch render</title>
  <style>
    body { background: #111; color: #eee; font: 14px/1.5 monospace; margin: 24px; }
    #status { margin: 12px 0; }
  </style>
</head>
<body>
  <h1>GRYND Batch Renderer</h1>
  <div id="status">loading\u2026</div>
  <script type="module" src="/client.js"></script>
</body>
</html>`;

function serveFileWithRange(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  mime: string
): void {
  const size = fs.statSync(filePath).size;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);

  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Length': size });
    res.end();
    return;
  }

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      let end = match[2] ? parseInt(match[2], 10) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      if (end >= size) end = size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, { 'Content-Length': size });
  fs.createReadStream(filePath).pipe(res);
}

export async function startRenderServer(opts: { clientJsPath: string }): Promise<RenderServer> {
  let job: RenderJob | null = null;

  const server = http.createServer((req, res) => {
    // Cross-origin isolation is required for SharedArrayBuffer (WebCodecs).
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.setHeader('Cache-Control', 'no-store');

    const pathname = url.parse(req.url || '/', true).pathname || '/';

    if (pathname === '/upload' && req.method === 'POST') {
      if (!job) {
        res.writeHead(409, { 'Content-Type': 'text/plain' });
        res.end('no active render job');
        return;
      }
      const activeJob = job;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        fs.mkdirSync(path.dirname(activeJob.outputPath), { recursive: true });
        fs.writeFileSync(activeJob.outputPath, buf);
        console.log(`[server] uploaded ${buf.length} bytes -> ${activeJob.outputPath}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, bytes: buf.length }));
      });
      return;
    }

    if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);
      return;
    }

    if (pathname === '/client.js') {
      const body = fs.readFileSync(opts.clientJsPath);
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(body);
      return;
    }

    if (pathname === '/spec.json') {
      if (!job) {
        res.writeHead(409, { 'Content-Type': 'text/plain' });
        res.end('no active render job');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(job.specJson);
      return;
    }

    if (pathname === '/media/gameplay.mp4') {
      if (!job) {
        res.writeHead(409, { 'Content-Type': 'text/plain' });
        res.end('no active render job');
        return;
      }
      serveFileWithRange(req, res, job.mediaPath, 'video/mp4');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
      } else {
        reject(new Error('failed to bind render server'));
      }
    });
  });

  return {
    port,
    setJob: (next: RenderJob) => {
      job = next;
    },
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}