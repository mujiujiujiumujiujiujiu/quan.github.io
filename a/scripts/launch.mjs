import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number.parseInt(process.env.MEME_WAR_PORT ?? '4173', 10) || 4173;
const url = `http://127.0.0.1:${port}/`;

function portIsOpen() {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const close = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => close(true));
    socket.once('error', () => close(false));
    socket.setTimeout(250, () => close(false));
  });
}

async function waitForServer(maxAttempts = 20) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await portIsOpen()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

if (!(await portIsOpen())) {
  const serverPath = path.join(projectRoot, 'scripts', 'server.mjs');
  const server = spawn(process.execPath, [serverPath], {
    cwd: projectRoot,
    detached: true,
    env: { ...process.env, MEME_WAR_PORT: String(port) },
    stdio: 'ignore',
    windowsHide: true,
  });
  server.unref();
}

if (!(await waitForServer())) {
  console.error(`无法启动游戏服务器：${url}`);
  process.exitCode = 1;
} else {
  const browser = spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true });
  browser.unref();
}
