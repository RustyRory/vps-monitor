import { readFile, writeFile, access, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

const APPS_ROOT = process.env.APPS_ROOT || '/var/www';
const MAIN_COMPOSE = join(APPS_ROOT, 'docker-compose.yml');

export async function findComposePath(name) {
  const deployPath = join(APPS_ROOT, name, 'deployment', 'docker-compose.yml');
  try {
    await access(deployPath);
    return `${name}/deployment/docker-compose.yml`;
  } catch {
    return `${name}/docker-compose.yml`;
  }
}

async function readMainCompose() {
  try {
    return await readFile(MAIN_COMPOSE, 'utf8');
  } catch {
    return 'include:\n';
  }
}

export async function addInclude(name) {
  const relPath = await findComposePath(name);
  const content = await readMainCompose();

  if (content.includes(relPath)) return;

  const lines = content.split('\n');
  let lastIncludeIdx = -1;
  let inInclude = false;

  for (let i = 0; i < lines.length; i++) {
    if (/^include:/.test(lines[i])) { inInclude = true; lastIncludeIdx = i; }
    else if (inInclude && /^\s+- /.test(lines[i])) { lastIncludeIdx = i; }
    else if (inInclude && lines[i].trim() && !/^\s/.test(lines[i])) { break; }
  }

  if (lastIncludeIdx >= 0) {
    lines.splice(lastIncludeIdx + 1, 0, `  - ${relPath}`);
  } else {
    lines.unshift('include:', `  - ${relPath}`, '');
  }

  await writeFile(MAIN_COMPOSE, lines.join('\n'), 'utf8');
}

export async function removeInclude(name) {
  let content;
  try { content = await readFile(MAIN_COMPOSE, 'utf8'); } catch { return; }
  const lines = content.split('\n').filter((l) => !new RegExp(`^\\s+- ${name}/`).test(l));
  await writeFile(MAIN_COMPOSE, lines.join('\n'), 'utf8');
}

export async function getFirstServiceName(name) {
  const relPath = await findComposePath(name);
  try {
    const content = await readFile(join(APPS_ROOT, relPath), 'utf8');
    const match = content.match(/^services:\s*\n\s+([a-zA-Z0-9_-]+):/m);
    return match?.[1] ?? name;
  } catch {
    return name;
  }
}

export async function getAllServiceNames(name) {
  const relPath = await findComposePath(name);
  try {
    const content = await readFile(join(APPS_ROOT, relPath), 'utf8');
    const servicesBlock = content.match(/^services:\s*\n([\s\S]*?)(?=^\S|(?![\s\S]))/m)?.[1] ?? '';
    const matches = [...servicesBlock.matchAll(/^ {2}([a-zA-Z0-9_-]+):/gm)];
    return matches.map((m) => m[1]);
  } catch {
    return [name];
  }
}

async function hasImages(serviceNames) {
  const checks = await Promise.all(
    serviceNames.map(async (name) => {
      try {
        const { stdout } = await execFile('docker', ['compose', '-f', MAIN_COMPOSE, 'images', '-q', name], { cwd: APPS_ROOT });
        return stdout.trim().length > 0;
      } catch {
        return false;
      }
    }),
  );
  return checks.every(Boolean);
}

export async function composeUp(serviceName) {
  const args = ['compose', '-f', MAIN_COMPOSE, 'up', '-d'];
  if (serviceName) args.push(serviceName);
  await execFile('docker', args, { cwd: APPS_ROOT });
}

export async function composeRebuild(serviceNames, forceBuild = false) {
  const names = Array.isArray(serviceNames) ? serviceNames : [serviceNames];
  const build = forceBuild || !(await hasImages(names));
  // Arrêt + suppression via compose (containers gérés par ce projet)
  await execFile('docker', ['compose', '-f', MAIN_COMPOSE, 'rm', '-sf', ...names], { cwd: APPS_ROOT }).catch(() => {});
  // Suppression forcée des containers orphelins du même nom (ancien projet compose)
  await Promise.all(names.map((n) => execFile('docker', ['rm', '-f', n]).catch(() => {})));
  const args = ['compose', '-f', MAIN_COMPOSE, 'up', '-d'];
  if (build) args.push('--build');
  args.push(...names);
  await execFile('docker', args, { cwd: APPS_ROOT });
}

export async function composeRebuildStreaming(serviceNames, forceBuild = false, onOutput = null) {
  const { spawn } = await import('child_process');
  const names = Array.isArray(serviceNames) ? serviceNames : [serviceNames];
  const build = forceBuild || !(await hasImages(names));

  const emit = (text) => { if (onOutput) onOutput(text); };

  emit(`[vps] Arrêt des containers existants...\n`);
  await execFile('docker', ['compose', '-f', MAIN_COMPOSE, 'rm', '-sf', ...names], { cwd: APPS_ROOT }).catch(() => {});
  await Promise.all(names.map((n) => execFile('docker', ['rm', '-f', n]).catch(() => {})));

  const args = ['compose', '-f', MAIN_COMPOSE, 'up', '-d'];
  if (build) args.push('--build');
  args.push(...names);

  emit(`[vps] docker ${args.join(' ')}\n`);

  await new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd: APPS_ROOT });
    child.stdout.on('data', (chunk) => emit(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => emit(chunk.toString('utf8')));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker compose exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

async function freePortsFromCompose(appName) {
  const relPath = await findComposePath(appName);
  try {
    const content = await readFile(join(APPS_ROOT, relPath), 'utf8');
    const ports = [...content.matchAll(/127\.0\.0\.1:(\d+):/g)].map((m) => m[1]);
    for (const port of ports) {
      const { stdout } = await execFile('docker', ['ps', '-a', '-q', '--filter', `publish=${port}`], {}).catch(() => ({ stdout: '' }));
      const ids = stdout.trim().split('\n').filter(Boolean);
      await Promise.all(ids.map((id) => execFile('docker', ['rm', '-f', id]).catch(() => {})));
    }
  } catch { /* ignore */ }
}

export async function composeFullRestart(appName) {
  const allServices = await getAllServiceNames(appName);
  console.log(`[full-restart] ${appName}: services = [${allServices.join(', ')}]`);

  // Suppression de tous les containers de l'app
  await execFile('docker', ['compose', '-f', MAIN_COMPOSE, 'rm', '-sf', ...allServices], { cwd: APPS_ROOT }).catch(() => {});
  await Promise.all(allServices.map((n) => execFile('docker', ['rm', '-f', n]).catch(() => {})));

  // Libération forcée des ports utilisés par l'app (au cas où un container orphelin les tient)
  await freePortsFromCompose(appName);

  // Suppression puis recréation d'un réseau dédié propre
  const networkName = `${appName}-net`;
  await execFile('docker', ['network', 'rm', networkName], {}).catch(() => {});
  await execFile('docker', ['network', 'create', networkName], {});

  // Démarrage de tous les containers
  await execFile('docker', ['compose', '-f', MAIN_COMPOSE, 'up', '-d', ...allServices], { cwd: APPS_ROOT });

  // Attente que les containers soient créés (3s)
  await new Promise((r) => setTimeout(r, 3000));

  // Connexion forcée de TOUS les containers au réseau partagé
  const connectResults = await Promise.all(
    allServices.map(async (n) => {
      try {
        await execFile('docker', ['network', 'connect', networkName, n]);
        return `${n}: connecté`;
      } catch (e) {
        return `${n}: ${e.message.includes('already') ? 'déjà connecté' : e.message.split('\n')[0]}`;
      }
    })
  );

  console.log(`[full-restart] réseau ${networkName}:`, connectResults);
  return { services: allServices, network: networkName, connections: connectResults };
}

const INFRA_COMPOSE_CONTENT = `services:
  mongo:
    image: mongo:7
    restart: unless-stopped
    volumes:
      - mongo_data:/data/db

volumes:
  mongo_data:
`;

export async function ensureInfraInclude() {
  const INFRA_REL = 'infra/docker-compose.yml';
  const infraFile = join(APPS_ROOT, INFRA_REL);

  try {
    await access(infraFile);
  } catch {
    await mkdir(dirname(infraFile), { recursive: true });
    await writeFile(infraFile, INFRA_COMPOSE_CONTENT, 'utf8');
  }

  const content = await readMainCompose();
  if (content.includes(INFRA_REL)) return;

  const lines = content.split('\n');
  const includeIdx = lines.findIndex((l) => /^include:/.test(l));

  if (includeIdx >= 0) {
    lines.splice(includeIdx + 1, 0, `  - ${INFRA_REL}`);
  } else {
    lines.unshift('include:', `  - ${INFRA_REL}`, '');
  }

  await writeFile(MAIN_COMPOSE, lines.join('\n'), 'utf8');
}

export async function listIncludes() {
  const content = await readMainCompose();
  return [...content.matchAll(/^\s+- (.+docker-compose\.yml)/gm)]
    .map((m) => m[1].trim())
    .map((path) => ({ name: path.split('/')[0], path }));
}

export async function composeDown(serviceName) {
  try {
    await execFile('docker', ['compose', '-f', MAIN_COMPOSE, 'stop', serviceName], { cwd: APPS_ROOT });
    await execFile('docker', ['compose', '-f', MAIN_COMPOSE, 'rm', '-f', serviceName], { cwd: APPS_ROOT });
  } catch { /* ignore if already stopped/absent */ }
}

export async function composeIsRunning(serviceName) {
  try {
    const { stdout } = await execFile('docker', ['compose', '-f', MAIN_COMPOSE, 'ps', '--quiet', serviceName], { cwd: APPS_ROOT });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
