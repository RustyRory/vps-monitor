import Dockerode from 'dockerode';
import { PassThrough } from 'stream';

const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });

async function getContainer(name) {
  const containers = await docker.listContainers({ all: true });
  const found = containers.find((c) => c.Names.includes(`/${name}`));
  if (!found) throw new Error(`Container "${name}" introuvable`);
  return docker.getContainer(found.Id);
}

export async function restartContainer(name) {
  const container = await getContainer(name);
  await container.restart();
}

export async function stopContainer(name) {
  const container = await getContainer(name);
  await container.stop();
}

export async function startContainer(name) {
  const container = await getContainer(name);
  await container.start();
}

export async function removeContainer(name) {
  const container = await getContainer(name);
  await container.remove({ force: false });
}

export async function streamContainerLogs(name, tail, onData, onEnd) {
  const container = await getContainer(name);
  const logStream = await container.logs({ stdout: true, stderr: true, tail, follow: true });

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(logStream, stdout, stderr);

  stdout.on('data', (chunk) => onData(chunk.toString('utf8')));
  stderr.on('data', (chunk) => onData(chunk.toString('utf8')));
  logStream.on('end', onEnd);
  logStream.on('error', onEnd);

  return logStream;
}

export async function getContainers() {
  const containers = await docker.listContainers({ all: true });

  return containers.map((c) => ({
    name: c.Names[0].replace(/^\//, ''),
    status: c.State,
    image: c.Image,
    ports: [...new Set(c.Ports.map((p) =>
      p.PublicPort ? `${p.PublicPort}:${p.PrivatePort}` : `${p.PrivatePort}`
    ))],
    uptime: c.Status,
  }));
}

export async function getContainersByNames(names) {
  const all = await docker.listContainers({ all: true });
  const nameSet = new Set(names);
  return all
    .filter((c) => c.Names.some((n) => nameSet.has(n.replace(/^\//, ''))))
    .map((c) => ({
      name: c.Names[0].replace(/^\//, ''),
      status: c.State,
      image: c.Image,
      ports: [...new Set(c.Ports.map((p) =>
        p.PublicPort ? `${p.PublicPort}:${p.PrivatePort}` : `${p.PrivatePort}`
      ))],
      uptime: c.Status,
    }));
}
