import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.MEME_WAR_PORT || 4173);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (request, response) => {
  try {
    const requested = decodeURIComponent((request.url || '/').split('?')[0]);
    const candidate = normalize(join(root, requested === '/' ? 'index.html' : requested));
    const safeRelative = relative(root, candidate);
    if (safeRelative.startsWith('..') || safeRelative.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    const file = await readFile(candidate);
    response.writeHead(200, { 'Content-Type': types[extname(candidate)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(file);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`梗战争模拟器: http://127.0.0.1:${port}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
