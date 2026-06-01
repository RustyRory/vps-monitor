import { readFile, writeFile, access, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { execFile as execFileCb, spawn } from 'child_process';
import { promisify } from 'util';
import {
  addInclude, removeInclude, getAllServiceNames, findComposePath,
  composeDown, composeIsRunning, composeRebuildStreaming,
} from './compose.js';
import {
  getProjects, getProject, addProject, deleteProject,
  setProjectStatus, addDeployment, updateDeployment, generateDeployId,
} from './registry.js';
import { startBuildSession } from './build.js';

const execFile = promisify(execFileCb);

const APPS_ROOT = process.env.APPS_ROOT || '/var/www';

function safeName(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Identifiant invalide');
  return id;
}

async function envFilePath(name) {
  const relPath = await findComposePath(name);
  return join(APPS_ROOT, dirname(relPath), '.env');
}

async function envExamplePath(name) {
  const relPath = await findComposePath(name);
  return join(APPS_ROOT, dirname(relPath), '.env.example');
}

export async function readEnvFile(name) {
  safeName(name);
  try { return await readFile(await envFilePath(name), 'utf8'); } catch { return ''; }
}

export async function writeEnvFile(name, content) {
  safeName(name);
  await writeFile(await envFilePath(name), content, 'utf8');
}

export async function readEnvExample(name) {
  safeName(name);
  try { return await readFile(await envExamplePath(name), 'utf8'); } catch { return ''; }
}

async function getCurrentCommit(appPath) {
  try {
    const { stdout } = await execFile('git', ['-C', appPath, 'rev-parse', '--short', 'HEAD']);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function httpHealthcheck(url, timeoutMs = 30000, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status < 500) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

export async function deployProject(projectId, options = {}) {
  const { env = null, branch = null } = options;
  safeName(projectId);

  const project = await getProject(projectId);
  const appPath = join(APPS_ROOT, projectId);
  const deployId = generateDeployId();
  const timestamp = new Date().toISOString();

  const deployment = {
    id: deployId,
    timestamp,
    commit: null,
    status: 'pending',
    logFile: `${projectId}-${deployId}.log`,
    duration: null,
    triggeredBy: options.triggeredBy || 'manual',
  };

  await addDeployment(projectId, deployment);
  await setProjectStatus(projectId, 'building');

  const buildSession = await startBuildSession(projectId, deployId);
  const startTime = Date.now();

  const log = (text) => buildSession.write(text);

  try {
    // --- Git clone or update ---
    let isNewClone = false;
    try {
      await access(appPath);
    } catch {
      isNewClone = true;
    }

    if (isNewClone) {
      log(`[vps] Clonage de ${project.gitUrl}...\n`);
      const cloneArgs = ['clone'];
      const targetBranch = branch || project.branch;
      if (targetBranch) cloneArgs.push('-b', targetBranch);
      cloneArgs.push(project.gitUrl, appPath);

      await new Promise((resolve, reject) => {
        const child = spawn('git', cloneArgs);
        child.stdout.on('data', (chunk) => log(chunk.toString('utf8')));
        child.stderr.on('data', (chunk) => log(chunk.toString('utf8')));
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`git clone exited ${code}`)));
        child.on('error', reject);
      });

      await addInclude(projectId);
    } else {
      log(`[vps] Mise à jour depuis ${project.gitUrl}...\n`);
      const safeDir = [`-c`, `safe.directory=${appPath}`];
      await new Promise((resolve, reject) => {
        const child = spawn('git', ['-C', appPath, ...safeDir, 'fetch', 'origin']);
        child.stdout.on('data', (chunk) => log(chunk.toString('utf8')));
        child.stderr.on('data', (chunk) => log(chunk.toString('utf8')));
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`git fetch exited ${code}`)));
        child.on('error', reject);
      });

      const { stdout: branchOut } = await execFile('git', ['-C', appPath, ...safeDir, 'rev-parse', '--abbrev-ref', 'HEAD']);
      const currentBranch = (branch || project.branch || branchOut.trim());

      await new Promise((resolve, reject) => {
        const child = spawn('git', ['-C', appPath, ...safeDir, 'reset', '--hard', `origin/${currentBranch}`]);
        child.stdout.on('data', (chunk) => log(chunk.toString('utf8')));
        child.stderr.on('data', (chunk) => log(chunk.toString('utf8')));
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`git reset exited ${code}`)));
        child.on('error', reject);
      });
    }

    // --- Write .env if provided ---
    if (env !== null) {
      log(`[vps] Écriture du fichier .env...\n`);
      await writeEnvFile(projectId, env);
    }

    // --- Get commit hash ---
    const commit = await getCurrentCommit(appPath);
    await updateDeployment(projectId, deployId, { commit, status: 'building' });

    // --- Build & start containers ---
    log(`[vps] Démarrage du build...\n`);
    const services = await getAllServiceNames(projectId).catch(() => [projectId]);

    await composeRebuildStreaming(services, isNewClone, log);

    // --- Healthcheck ---
    log(`[vps] Healthcheck...\n`);
    let healthy = true;
    if (project.nginxPath && project.port) {
      const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
      const healthUrl = `${BASE_URL}${project.nginxPath}`;
      healthy = await httpHealthcheck(healthUrl);
      log(healthy ? `[vps] Application opérationnelle.\n` : `[vps] Healthcheck timeout — l'app ne répond pas.\n`);
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    const finalStatus = healthy ? 'success' : 'failed';

    await updateDeployment(projectId, deployId, { status: finalStatus, duration });
    await setProjectStatus(projectId, healthy ? 'running' : 'failed');

    log(`[vps] Déploiement ${finalStatus} (${duration}s)\n`);
  } catch (err) {
    const duration = Math.round((Date.now() - startTime) / 1000);
    log(`[vps] ERREUR: ${err.message}\n`);
    await updateDeployment(projectId, deployId, { status: 'failed', duration });
    await setProjectStatus(projectId, 'failed');
  } finally {
    buildSession.end();
  }
}

export async function deleteProjectFiles(projectId) {
  safeName(projectId);
  const appPath = join(APPS_ROOT, projectId);

  const services = await getAllServiceNames(projectId).catch(() => [projectId]);
  await Promise.all(services.map((s) => composeDown(s)));
  await removeInclude(projectId);
  await rm(appPath, { recursive: true, force: true });
}

// --- Sync running status for a project from Docker ---
export async function syncProjectStatus(projectId) {
  try {
    const appPath = join(APPS_ROOT, projectId);
    await access(appPath);
    const services = await getAllServiceNames(projectId).catch(() => [projectId]);
    const checks = await Promise.all(services.map((s) => composeIsRunning(s)));
    const running = checks.some(Boolean);
    await setProjectStatus(projectId, running ? 'running' : 'stopped');
    return running ? 'running' : 'stopped';
  } catch {
    await setProjectStatus(projectId, 'unknown');
    return 'unknown';
  }
}

export { getProjects, getProject, addProject, deleteProject };
