import { readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { addInclude, removeInclude, listIncludes, getFirstServiceName, getAllServiceNames, composeDown, composeIsRunning } from './compose.js';
import { rm } from 'fs/promises';

const execFile = promisify(execFileCb);

const REPO_ROOT = process.env.VPSCONFIG_PATH || '/var/www/vps-monitor';
const APPS_ROOT = process.env.APPS_ROOT || '/var/www';

async function readRegistry() {
  const raw = await readFile(join(REPO_ROOT, 'data/apps.json'), 'utf8');
  return JSON.parse(raw);
}

async function writeRegistry(apps) {
  await writeFile(join(REPO_ROOT, 'data/apps.json'), JSON.stringify(apps, null, 2) + '\n', 'utf8');
}

function safeName(name) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Nom d\'app invalide');
  return name;
}

export async function getAppStatus(name) {
  safeName(name);
  const appPath = join(APPS_ROOT, name);

  try {
    await access(appPath);
  } catch {
    return { name, deployed: false, running: false };
  }

  try {
    const service = await getFirstServiceName(name);
    const running = await composeIsRunning(service);
    return { name, deployed: true, running };
  } catch {
    return { name, deployed: true, running: false };
  }
}

export async function listApps() {
  const includes = await listIncludes().catch(() => []);
  const appNames = includes.map(({ name }) => name).filter((n) => n !== 'vps-monitor' && n !== 'infra');

  let registry = [];
  try { registry = await readRegistry(); } catch { /* data/apps.json optionnel */ }

  return Promise.all(appNames.map(async (name) => {
    const status = await getAppStatus(name);
    const meta = registry.find((r) => r.name === name) ?? {};
    return { ...status, url: meta.url ?? null };
  }));
}

export async function cloneApp(name, url, nginxPath, nginxPort, branch) {
  safeName(name);
  if (!/^https?:\/\//.test(url)) throw new Error('URL invalide');

  const appPath = join(APPS_ROOT, name);
  const cloneArgs = branch ? ['clone', '-b', branch, url, appPath] : ['clone', url, appPath];
  await execFile('git', cloneArgs);

  const service = await getFirstServiceName(name);

  const registry = await readRegistry().catch(() => []);
  const entry = { name, url, service };
  if (nginxPath && nginxPort) { entry.nginxPath = nginxPath; entry.port = nginxPort; }
  registry.push(entry);
  await writeRegistry(registry);

  await addInclude(name);
  return service;
}

export async function deleteApp(name) {
  safeName(name);
  const appPath = join(APPS_ROOT, name);

  const services = await getAllServiceNames(name).catch(() => [name]);
  const registry = await readRegistry().catch(() => []);
  const meta = registry.find((r) => r.name === name) ?? {};

  await Promise.all(services.map((s) => composeDown(s)));
  await removeInclude(name);

  const newRegistry = registry.filter((r) => r.name !== name);
  await writeRegistry(newRegistry);

  await rm(appPath, { recursive: true, force: true });

  return meta;
}

export async function updateApp(name) {
  safeName(name);
  const appPath = join(APPS_ROOT, name);
  const safeDir = [`-c`, `safe.directory=${appPath}`];
  await execFile('git', ['-C', appPath, ...safeDir, 'fetch', 'origin']);
  const { stdout } = await execFile('git', ['-C', appPath, ...safeDir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = stdout.trim();
  await execFile('git', ['-C', appPath, ...safeDir, 'reset', '--hard', `origin/${branch}`]);
  return getAllServiceNames(name);
}
