import Dockerode from 'dockerode';

const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });

function calcCpuPercent(stats) {
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const sysDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  const cpuCount = stats.cpu_stats.online_cpus || (stats.cpu_stats.cpu_usage.percpu_usage?.length ?? 1);
  if (sysDelta <= 0 || cpuDelta < 0) return 0;
  return (cpuDelta / sysDelta) * cpuCount * 100;
}

export async function getContainerStats(containerName) {
  try {
    const containers = await docker.listContainers({ all: false });
    const found = containers.find((c) => c.Names.includes(`/${containerName}`));
    if (!found) return null;

    const container = docker.getContainer(found.Id);
    const stats = await container.stats({ stream: false });

    const memUsage = stats.memory_stats.usage ?? 0;
    const memLimit = stats.memory_stats.limit ?? 1;
    const memCache = stats.memory_stats.stats?.cache ?? 0;
    const memActual = memUsage - memCache;

    return {
      name: containerName,
      cpu_percent: Math.round(calcCpuPercent(stats) * 10) / 10,
      mem_usage: memActual,
      mem_limit: memLimit,
      mem_percent: Math.round((memActual / memLimit) * 1000) / 10,
    };
  } catch {
    return null;
  }
}

export async function getProjectMetrics(serviceNames) {
  const results = await Promise.all(serviceNames.map(getContainerStats));
  return results.filter(Boolean);
}
