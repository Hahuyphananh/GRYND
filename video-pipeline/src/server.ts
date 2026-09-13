import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

export type PocServer = {
  port: number;
  close: () => Promise<void>;
};

const INDEX_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>grynd video pipeline poc</title>
  <style>
    body { background: #111; color: #eee; font: 14px/1.5 monospace; margin: 24px; }
    #status { margin: 12px 0; }
  </style>
</head>
<body>
  <h1>GRYND Diffusion Studio POC</h1>
  <div id="status">loading…</div>
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
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end0 = m[2] ? parseInt(m[2], 10) : size - 1;
      if (start > end0 || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      const end = Math.min(end0, size - 1);
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

export function startServer(opts: {
  videoPath: string;
  clientJsPath: string;
  outputPath: string;
}): Promise<PocServer> {
  fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });

  const server = http.createServer((req, res) => {
    // Cross-origin isolation is required for SharedArrayBuffer (WebCodecs).
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.setHeader('Cache-Control', 'no-store');

    const pathname = url.parse(req.url || '/', true).pathname || '/';

    if (pathname === '/upload' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(opts.outputPath, buf);
        console.log(`[server] uploaded ${buf.length} bytes -> ${opts.outputPath}`);
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

    if (pathname === '/media/gameplay.mp4') {
      serveFileWithRange(req, res, opts.videoPath, 'video/mp4');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve({
          port: address.port,
          close: () => new Promise<void>((res) => server.close(() => res())),
        });
      } else {
        throw new Error('failed to bind server');
      }
    });
  });
}