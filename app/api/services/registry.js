import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';

const REPO_ROOT = process.env.VPSCONFIG_PATH || '/var/www/vps-monitor';
const REGISTRY_PATH = join(REPO_ROOT, 'data', 'apps.json');
const MAX_DEPLOYMENTS = 10;

async function read() {
  const raw = await readFile(REGISTRY_PATH, 'utf8');
  return JSON.parse(raw);
}

async function write(projects) {
  await writeFile(REGISTRY_PATH, JSON.stringify(projects, null, 2) + '\n', 'utf8');
}

export async function getProjects() {
  return read();
}

export async function getProject(id) {
  const projects = await read();
  const project = projects.find((p) => p.id === id);
  if (!project) throw new Error(`Projet "${id}" introuvable`);
  return project;
}

export async function addProject(config) {
  const { id, name, gitUrl, branch = null, nginxPath = null, port = null, stripPrefix = true } = config;
  if (!id || !name || !gitUrl) throw new Error('id, name et gitUrl requis');

  const projects = await read();
  if (projects.find((p) => p.id === id)) throw new Error(`Projet "${id}" existe déjà`);

  const project = {
    id,
    name,
    gitUrl,
    branch,
    nginxPath,
    port,
    stripPrefix,
    status: 'unknown',
    lastDeployAt: null,
    deployments: [],
  };

  projects.push(project);
  await write(projects);
  return project;
}

export async function updateProject(id, updates) {
  const projects = await read();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`Projet "${id}" introuvable`);

  const allowed = ['name', 'gitUrl', 'branch', 'nginxPath', 'port', 'stripPrefix'];
  for (const key of allowed) {
    if (updates[key] !== undefined) projects[idx][key] = updates[key];
  }

  await write(projects);
  return projects[idx];
}

export async function deleteProject(id) {
  const projects = await read();
  const project = projects.find((p) => p.id === id);
  if (!project) throw new Error(`Projet "${id}" introuvable`);
  await write(projects.filter((p) => p.id !== id));
  return project;
}

export async function setProjectStatus(id, status) {
  const projects = await read();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) return;
  projects[idx].status = status;
  await write(projects);
}

export function generateDeployId() {
  return `d-${Date.now()}-${randomBytes(3).toString('hex')}`;
}

export async function addDeployment(id, deployment) {
  const projects = await read();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`Projet "${id}" introuvable`);

  projects[idx].deployments.unshift(deployment);
  if (projects[idx].deployments.length > MAX_DEPLOYMENTS) {
    projects[idx].deployments = projects[idx].deployments.slice(0, MAX_DEPLOYMENTS);
  }
  projects[idx].lastDeployAt = deployment.timestamp;

  await write(projects);
}

export async function updateDeployment(id, deployId, updates) {
  const projects = await read();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) return;

  const depIdx = projects[idx].deployments.findIndex((d) => d.id === deployId);
  if (depIdx === -1) return;

  Object.assign(projects[idx].deployments[depIdx], updates);
  await write(projects);
}
