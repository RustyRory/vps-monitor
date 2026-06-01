import 'dotenv/config';
import { createServer } from 'http';
import express from 'express';
import session from 'express-session';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { getContainers, restartContainer, stopContainer, startContainer, removeContainer, streamContainerLogs } from './services/docker.js';
import { checkWebsites } from './services/http.js';
import { reload as reloadNginx, readConfig, writeConfig, parseApps, parseConfigMeta, addApp, removeApp } from './services/nginx.js';
import { listApps, cloneApp, updateApp, deleteApp, getAppStatus, writeEnvFile, readEnvFile, readEnvExample } from './services/deploy.js';
import { composeUp, composeRebuild, composeFullRestart, getAllServiceNames, ensureInfraInclude } from './services/compose.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT           = process.env.PORT           || 3000;
const BASE_URL       = process.env.BASE_URL       || `http://localhost:${PORT}`;
const AUTH_USER      = process.env.AUTH_USER      || 'admin';
const AUTH_PASS      = process.env.AUTH_PASS      || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me';

const app = express();

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 },
});

app.use(express.json());
app.use(sessionMiddleware);

// --- Routes publiques ---

app.get('/', (req, res) => {
  if (req.session.authenticated) {
    return res.sendFile(join(__dirname, '../public/index.html'));
  }
  res.sendFile(join(__dirname, '../public/home.html'));
});

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (username === AUTH_USER && password === AUTH_PASS) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Identifiants incorrects' });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// Fichiers statiques (style.css, app.js, login.html, home.html…)
// index.html n'est pas accessible directement — servi uniquement via GET /
app.use(express.static(join(__dirname, '../public')));

// --- Middleware auth pour l'API ---

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.status(401).json({ error: 'Non authentifié' });
}

// --- API (protégée) ---

app.get('/api/apps', async (_req, res) => {
  try {
    const content = await readConfig();
    res.json(parseApps(content));
  } catch {
    res.json([]);
  }
});

app.get('/api/status', requireAuth, async (_req, res) => {
  try {
    const content = await readConfig();
    const nginxApps = parseApps(content);
    const [containers, websites] = await Promise.all([
      getContainers(),
      checkWebsites(BASE_URL, nginxApps),
    ]);

    const allRunning = containers.every((c) => c.status === 'running');
    const allUp = websites.every((w) => w.status === 'OK');

    res.json({
      containers,
      websites,
      globalStatus: allRunning && allUp ? 'OK' : 'KO',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/container/exec', requireAuth, async (req, res) => {
  const { name, cmd } = req.body;
  if (!name || !cmd) return res.status(400).json({ error: 'name et cmd requis' });
  try {
    const { execFile: ef } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(ef);
    const { stdout, stderr } = await exec('docker', ['exec', name, 'sh', '-c', cmd]);
    res.json({ ok: true, stdout: stdout.trim(), stderr: stderr.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message, stdout: err.stdout?.trim(), stderr: err.stderr?.trim() });
  }
});

app.post('/api/container/restart', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name requis' });
  try {
    await restartContainer(name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/container/stop', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name requis' });
  try {
    await stopContainer(name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/container/start', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name requis' });
  try {
    await startContainer(name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/container/remove', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name requis' });
  try {
    await removeContainer(name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API Nginx (protégée) ---

app.get('/api/nginx/apps', requireAuth, async (_req, res) => {
  try {
    const content = await readConfig();
    res.json({ apps: parseApps(content), ...parseConfigMeta(content) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/nginx/apps', requireAuth, async (req, res) => {
  const { path, port, stripPrefix = true } = req.body;
  if (!path || !port) return res.status(400).json({ error: 'path et port requis' });
  if (!/^\/[a-zA-Z0-9][a-zA-Z0-9_\-./]*\/$/.test(path)) return res.status(400).json({ error: `Chemin invalide: ${path}` });
  if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: `Port invalide: ${port}` });

  let previous;
  try {
    previous = await readConfig();
    await addApp(path, port, stripPrefix);
    await reloadNginx();
    res.json({ ok: true });
  } catch (err) {
    if (previous) try { await writeConfig(previous); } catch { /* ignore */ }
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/nginx/apps', requireAuth, async (req, res) => {
  const { path } = req.body;
  if (!path) return res.status(400).json({ error: 'path requis' });

  let previous;
  try {
    previous = await readConfig();
    await removeApp(path);
    await reloadNginx();
    res.json({ ok: true });
  } catch (err) {
    if (previous) try { await writeConfig(previous); } catch { /* ignore */ }
    res.status(500).json({ error: err.message });
  }
});

// --- API Data (protégée) ---

const DATA_PATH = join(process.env.VPSCONFIG_PATH || '/var/www/vps-monitor', 'data', 'apps.json');

app.get('/api/data/apps', requireAuth, async (_req, res) => {
  try {
    res.json({ content: await readFile(DATA_PATH, 'utf8') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/data/apps', requireAuth, async (req, res) => {
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'content requis' });
  try {
    JSON.parse(content);
    await writeFile(DATA_PATH, content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(err instanceof SyntaxError ? 400 : 500).json({ error: err.message });
  }
});

// --- API Deploy (protégée) ---

app.get('/api/deploy/apps', requireAuth, async (_req, res) => {
  try {
    res.json(await listApps());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/deploy/status/:app', requireAuth, async (req, res) => {
  try {
    res.json(await getAppStatus(req.params.app));
  } catch (err) {
    res.status(err.message === 'Nom d\'app invalide' ? 400 : 500).json({ error: err.message });
  }
});

app.post('/api/deploy/clone', requireAuth, async (req, res) => {
  const { name, url, nginxPath, port, stripPrefix = true, branch, env } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name et url requis' });
  if (nginxPath && !port) return res.status(400).json({ error: 'port requis si nginxPath fourni' });
  try {
    const parsedPort = port ? parseInt(port, 10) : null;
    const service = await cloneApp(name, url, nginxPath || null, parsedPort, branch || null);
    if (nginxPath && parsedPort) {
      await addApp(nginxPath, parsedPort, stripPrefix);
      await reloadNginx();
    }
    if (env) await writeEnvFile(name, env);
    const allServices = await getAllServiceNames(name).catch(() => [service]);
    res.json({ ok: true, building: true });
    composeRebuild(allServices).catch((err) => console.error(`[clone] build ${name} failed:`, err.message));
  } catch (err) {
    const status = ['Nom d\'app invalide', 'URL invalide'].includes(err.message) ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.get('/api/deploy/apps/:name/env', requireAuth, async (req, res) => {
  try {
    res.json({ content: await readEnvFile(req.params.name) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/deploy/apps/:name/env-example', requireAuth, async (req, res) => {
  try {
    res.json({ content: await readEnvExample(req.params.name) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/deploy/apps/:name/env', requireAuth, async (req, res) => {
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'content requis' });
  try {
    await writeEnvFile(req.params.name, content);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.message === 'Nom d\'app invalide' ? 400 : 500).json({ error: err.message });
  }
});

app.get('/api/diagnostics/networks', requireAuth, async (req, res) => {
  try {
    const { execFile: ef } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(ef);
    const { stdout: lsOut } = await exec('docker', ['network', 'ls', '--format', '{{.Name}}']);
    const names = lsOut.trim().split('\n').filter(Boolean);
    const details = await Promise.all(names.map(async (n) => {
      try {
        const { stdout } = await exec('docker', ['network', 'inspect', n, '--format',
          '{{.Name}}: {{range $k,$v := .Containers}}{{$v.Name}} {{end}}']);
        return stdout.trim();
      } catch { return `${n}: error`; }
    }));
    res.json({ networks: details });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/deploy/apps/:name/full-restart', requireAuth, async (req, res) => {
  const { name } = req.params;
  try {
    const result = await composeFullRestart(name);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/deploy/update', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name requis' });
  try {
    const services = await updateApp(name);
    res.json({ ok: true, building: true });
    composeRebuild(services, true).catch((err) => console.error(`[update] build ${name} failed:`, err.message));
  } catch (err) {
    res.status(err.message === 'Nom d\'app invalide' ? 400 : 500).json({ error: err.message });
  }
});

app.post('/api/webhook/deploy', async (req, res) => {
  const auth = req.headers.authorization;
  const token = process.env.WEBHOOK_SECRET;
  if (!token || !auth || auth !== `Bearer ${token}`) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name requis' });
  try {
    const services = await updateApp(name);
    res.json({ ok: true, building: true });
    composeRebuild(services, true).catch((err) => console.error(`[webhook] build ${name} failed:`, err.message));
  } catch (err) {
    res.status(err.message === 'Nom d\'app invalide' ? 400 : 500).json({ error: err.message });
  }
});

app.delete('/api/deploy/apps', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name requis' });
  try {
    const meta = await deleteApp(name);
    if (meta.nginxPath) {
      await removeApp(meta.nginxPath).catch(() => {});
      await reloadNginx().catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(err.message === 'Nom d\'app invalide' ? 400 : 500).json({ error: err.message });
  }
});

// --- WebSocket : logs en temps réel ---

const wsTokens = new Map();

app.get('/api/ws-token', requireAuth, (_req, res) => {
  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  wsTokens.set(token, Date.now() + 30_000);
  res.json({ token });
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const expiry = token && wsTokens.get(token);

  if (!expiry || Date.now() > expiry) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wsTokens.delete(token);

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const name = url.searchParams.get('name');
  const tail = parseInt(url.searchParams.get('tail') || '200', 10);

  if (!name) {
    ws.close(1008, 'name requis');
    return;
  }

  let logStream = null;

  streamContainerLogs(name, tail,
    (data) => { if (ws.readyState === ws.OPEN) ws.send(data); },
    () => { if (ws.readyState === ws.OPEN) ws.close(); },
  ).then((stream) => {
    logStream = stream;
  }).catch((err) => {
    if (ws.readyState === ws.OPEN) ws.send(`Erreur: ${err.message}`);
    ws.close();
  });

  ws.on('close', () => {
    if (logStream) logStream.destroy();
  });
});

export default app;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureInfraInclude()
    .then(() => composeUp('mongo'))
    .catch((err) => console.error('[infra] startup error:', err.message));

  server.listen(PORT, () => {
    console.log(`vps-monitor listening on ${BASE_URL}`);
  });
}
