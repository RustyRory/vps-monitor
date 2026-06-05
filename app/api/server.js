import 'dotenv/config';
import { createServer } from 'http';
import express from 'express';
import session from 'express-session';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  getContainers, getContainersByNames,
  restartContainer, stopContainer, startContainer, removeContainer,
  streamContainerLogs,
} from './services/docker.js';
import { checkWebsites } from './services/http.js';
import {
  reload as reloadNginx, readConfig, writeConfig,
  parseApps, parseConfigMeta, addApp, removeApp,
} from './services/nginx.js';
import {
  getProjects, getProject, addProject, updateProject, deleteProject,
  createDeploymentRecord, runDeployment,
  deleteProjectFiles, syncProjectStatus,
  readEnvFile, writeEnvFile, readEnvExample,
} from './services/deploy.js';
import { getAllServiceNames, composeFullRestart, ensureInfraInclude, composeUp } from './services/compose.js';
import { getProjectMetrics } from './services/metrics.js';
import { readBuildLog, subscribeBuildSession, isBuildActive } from './services/build.js';

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

// --- Auth ---

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, '../public', req.session.authenticated ? 'index.html' : 'home.html'));
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

app.use(express.static(join(__dirname, '../public')));

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.status(401).json({ error: 'Non authentifié' });
}

// --- Public: apps list for home.html ---

app.get('/api/apps', async (_req, res) => {
  try {
    const content = await readConfig();
    res.json(parseApps(content));
  } catch {
    res.json([]);
  }
});

// --- Global monitoring status ---

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
    res.json({ containers, websites, globalStatus: allRunning && allUp ? 'OK' : 'KO' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Projects ---

app.get('/api/projects', requireAuth, async (_req, res) => {
  try {
    const projects = await getProjects();
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects', requireAuth, async (req, res) => {
  const { id, name, gitUrl, branch, nginxPath, port, stripPrefix = true, extraRoutes = [] } = req.body;
  if (!id || !name || !gitUrl) return res.status(400).json({ error: 'id, name et gitUrl requis' });
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ error: 'id invalide (alphanumérique, _ -)' });
  if (!/^https?:\/\//.test(gitUrl)) return res.status(400).json({ error: 'gitUrl invalide' });
  try {
    const project = await addProject({ id, name, gitUrl, branch: branch || null, nginxPath: nginxPath || null, port: port ? parseInt(port, 10) : null, stripPrefix, extraRoutes });
    res.status(201).json(project);
  } catch (err) {
    res.status(err.message.includes('existe déjà') ? 409 : 500).json({ error: err.message });
  }
});

app.get('/api/projects/:id', requireAuth, async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    res.json(project);
  } catch (err) {
    res.status(err.message.includes('introuvable') ? 404 : 500).json({ error: err.message });
  }
});

app.put('/api/projects/:id', requireAuth, async (req, res) => {
  try {
    const project = await updateProject(req.params.id, req.body);
    res.json(project);
  } catch (err) {
    res.status(err.message.includes('introuvable') ? 404 : 500).json({ error: err.message });
  }
});

app.delete('/api/projects/:id', requireAuth, async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    await deleteProjectFiles(req.params.id);
    const allPaths = [
      project.nginxPath,
      ...((project.extraRoutes || []).map((r) => r.nginxPath)),
    ].filter(Boolean);
    if (allPaths.length) {
      await Promise.all(allPaths.map((p) => removeApp(p).catch(() => {})));
      await reloadNginx().catch(() => {});
    }
    await deleteProject(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.message.includes('introuvable') ? 404 : 500).json({ error: err.message });
  }
});

// --- Project containers ---

app.get('/api/projects/:id/containers', requireAuth, async (req, res) => {
  try {
    const services = await getAllServiceNames(req.params.id).catch(() => [req.params.id]);
    const containers = await getContainersByNames(services);
    res.json(containers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:id/containers/:name/restart', requireAuth, async (req, res) => {
  try {
    await restartContainer(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:id/containers/:name/stop', requireAuth, async (req, res) => {
  try {
    await stopContainer(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:id/containers/:name/start', requireAuth, async (req, res) => {
  try {
    await startContainer(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:id/containers/:name/exec', requireAuth, async (req, res) => {
  const { cmd } = req.body;
  if (!cmd) return res.status(400).json({ error: 'cmd requis' });
  try {
    const { execFile: ef } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(ef);
    const { stdout, stderr } = await exec('docker', ['exec', req.params.name, 'sh', '-c', cmd]);
    res.json({ ok: true, stdout: stdout.trim(), stderr: stderr.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message, stdout: err.stdout?.trim(), stderr: err.stderr?.trim() });
  }
});

app.get('/api/projects/:id/metrics', requireAuth, async (req, res) => {
  try {
    const services = await getAllServiceNames(req.params.id).catch(() => [req.params.id]);
    const metrics = await getProjectMetrics(services);
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:id/restart', requireAuth, async (req, res) => {
  try {
    const result = await composeFullRestart(req.params.id);
    await syncProjectStatus(req.params.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Deployments ---

app.get('/api/projects/:id/deployments', requireAuth, async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    res.json(project.deployments);
  } catch (err) {
    res.status(err.message.includes('introuvable') ? 404 : 500).json({ error: err.message });
  }
});

async function ensureNginxRoutes(project) {
  const allRoutes = [
    project.nginxPath && project.port ? { nginxPath: project.nginxPath, port: project.port, stripPrefix: project.stripPrefix } : null,
    ...(project.extraRoutes || []),
  ].filter(Boolean);
  if (!allRoutes.length) return;
  const config = await readConfig().catch(() => '');
  let changed = false;
  for (const route of allRoutes) {
    if (!config.includes(route.nginxPath)) {
      await addApp(route.nginxPath, route.port, route.stripPrefix ?? true).catch(() => {});
      changed = true;
    }
  }
  if (changed) await reloadNginx().catch(() => {});
}

app.post('/api/projects/:id/deployments', requireAuth, async (req, res) => {
  const { env, branch } = req.body;
  try {
    const project = await getProject(req.params.id);
    await ensureNginxRoutes(project);
    const opts = { env, branch, triggeredBy: 'manual' };
    const deployId = await createDeploymentRecord(req.params.id, opts);
    res.json({ ok: true, deployId, building: true });
    runDeployment(req.params.id, deployId, opts)
      .catch((err) => console.error(`[deploy] ${req.params.id}:`, err.message));
  } catch (err) {
    res.status(err.message.includes('introuvable') ? 404 : 500).json({ error: err.message });
  }
});

app.get('/api/projects/:id/deployments/:depId/log', requireAuth, async (req, res) => {
  try {
    const { id, depId } = req.params;
    const content = await readBuildLog(id, depId);
    res.json({ content, active: isBuildActive(depId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Environment ---

app.get('/api/projects/:id/env', requireAuth, async (req, res) => {
  try {
    res.json({ content: await readEnvFile(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/projects/:id/env', requireAuth, async (req, res) => {
  const { content, rebuild = false } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'content requis' });
  try {
    await writeEnvFile(req.params.id, content);
    let deployId = null;
    if (rebuild) {
      const opts = { triggeredBy: 'env-update' };
      deployId = await createDeploymentRecord(req.params.id, opts);
      runDeployment(req.params.id, deployId, opts)
        .catch((err) => console.error(`[env-rebuild] ${req.params.id}:`, err.message));
    }
    res.json({ ok: true, building: rebuild, deployId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/projects/:id/env/example', requireAuth, async (req, res) => {
  try {
    res.json({ content: await readEnvExample(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Nginx ---

app.get('/api/nginx', requireAuth, async (_req, res) => {
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
    if (previous) await writeConfig(previous).catch(() => {});
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
    if (previous) await writeConfig(previous).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/nginx/reload', requireAuth, async (_req, res) => {
  try {
    await reloadNginx();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Container actions (global, legacy-compatible) ---

app.post('/api/container/restart', requireAuth, async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'name requis' });
  try { await restartContainer(req.body.name); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/container/stop', requireAuth, async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'name requis' });
  try { await stopContainer(req.body.name); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/container/start', requireAuth, async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'name requis' });
  try { await startContainer(req.body.name); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/webhook/deploy', async (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  const auth = req.headers['authorization'];
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name requis' });
  try {
    const project = await getProject(name);
    await ensureNginxRoutes(project).catch(() => {});
    const deployId = await createDeploymentRecord(name, { triggeredBy: 'webhook' });
    res.json({ ok: true, deployId });
    runDeployment(name, deployId, { triggeredBy: 'webhook' })
      .catch((err) => console.error(`[webhook] ${name}:`, err.message));
  } catch (err) {
    res.status(err.message.includes('introuvable') ? 404 : 500).json({ error: err.message });
  }
});

app.post('/api/container/remove', requireAuth, async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'name requis' });
  try { await removeContainer(req.body.name); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
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

// --- Webhook ---

app.post('/api/webhook/:id', async (req, res) => {
  const auth = req.headers.authorization;
  const token = process.env.WEBHOOK_SECRET;
  if (!token || !auth || auth !== `Bearer ${token}`) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  try {
    await getProject(req.params.id);
    const opts = { triggeredBy: 'webhook' };
    const deployId = await createDeploymentRecord(req.params.id, opts);
    res.json({ ok: true, deployId, building: true });
    runDeployment(req.params.id, deployId, opts)
      .catch((err) => console.error(`[webhook] ${req.params.id}:`, err.message));
  } catch (err) {
    res.status(err.message.includes('introuvable') ? 404 : 500).json({ error: err.message });
  }
});

// --- WebSocket tokens ---

const wsTokens = new Map();

app.get('/api/ws-token', requireAuth, (_req, res) => {
  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  wsTokens.set(token, Date.now() + 30_000);
  res.json({ token });
});

// --- HTTP + WebSocket server ---

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
  const container = url.searchParams.get('container');
  const deployId = url.searchParams.get('deployId');
  const projectId = url.searchParams.get('projectId');

  if (deployId) {
    // Stream build logs
    const send = (data) => { if (ws.readyState === ws.OPEN) ws.send(data); };
    const close = () => { if (ws.readyState === ws.OPEN) ws.close(); };

    const unsubscribe = subscribeBuildSession(deployId, send, close);

    if (!unsubscribe) {
      // Build already completed — send the full log from file then close
      readBuildLog(projectId || '', deployId).then((content) => {
        if (content) send(content);
        close();
      });
      return;
    }

    ws.on('close', unsubscribe);
    return;
  }

  if (container) {
    // Stream container logs
    const tail = parseInt(url.searchParams.get('tail') || '200', 10);
    let logStream = null;

    streamContainerLogs(
      container, tail,
      (data) => { if (ws.readyState === ws.OPEN) ws.send(data); },
      () => { if (ws.readyState === ws.OPEN) ws.close(); },
    ).then((stream) => {
      logStream = stream;
    }).catch((err) => {
      if (ws.readyState === ws.OPEN) ws.send(`Erreur: ${err.message}`);
      ws.close();
    });

    ws.on('close', () => { if (logStream) logStream.destroy(); });
    return;
  }

  ws.close(1008, 'container ou deployId requis');
});

export default app;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureInfraInclude()
    .then(() => composeUp('mongo'))
    .catch((err) => console.error('[infra] startup error:', err.message));

  server.listen(PORT, () => {
    console.log(`vps-monitor v2 listening on ${BASE_URL}`);
  });
}
