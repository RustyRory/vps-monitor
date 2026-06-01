import { readFile, writeFile } from 'fs/promises';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

const NGINX_CONFIG = process.env.NGINX_CONFIG || '/etc/nginx/sites-available/vps';

export async function testConfig() {
  try {
    const { stdout, stderr } = await execFile('/usr/sbin/nginx', ['-t']);
    return { ok: true, output: stdout + stderr };
  } catch (err) {
    const output = (err.stdout ?? '') + (err.stderr ?? '');
    // getpwnam/getgrnam failures are container env issues (missing host users), not config errors
    const hasRealError = output.split('\n').some(
      (l) => l.includes('[emerg]') && !l.includes('getpwnam') && !l.includes('getgrnam'),
    );
    return { ok: !hasRealError, output };
  }
}

export async function reload() {
  const { stdout } = await execFile('sh', ['-c',
    "for f in /proc/[0-9]*/cmdline; do grep -qa 'nginx: master' \"$f\" && basename \"${f%/cmdline}\" && break; done",
  ]);
  const pid = stdout.trim();
  if (!pid) throw new Error('nginx master process introuvable');
  await execFile('kill', ['-HUP', pid]);
}

export async function readConfig() {
  return readFile(NGINX_CONFIG, 'utf8');
}

export async function writeConfig(content) {
  await writeFile(NGINX_CONFIG, content, 'utf8');
}

export function parseApps(content) {
  const apps = [];
  const blockRegex = /location\s+(\/[^\s{]+)\s*\{([^}]+)\}/g;
  for (const match of content.matchAll(blockRegex)) {
    const path = match[1].trim();
    if (path === '/') continue;
    const portMatch = match[2].match(/proxy_pass\s+http:\/\/127\.0\.0\.1:(\d+)/);
    if (portMatch) apps.push({ path, port: parseInt(portMatch[1], 10) });
  }
  return apps;
}

export function parseConfigMeta(content) {
  const serverName = content.match(/server_name\s+([^;]+);/)?.[1].trim() ?? '127.0.0.1';
  const rootBlock = content.match(/location\s+\/\s*\{([^}]+)\}/)?.[1] ?? '';
  const rootPort = parseInt(
    rootBlock.match(/proxy_pass\s+http:\/\/127\.0\.0\.1:(\d+)/)?.[1] ?? '3020',
    10,
  );
  return { serverName, rootPort };
}

export async function addApp(path, port, stripPrefix = true) {
  const content = await readConfig();
  const proxyTarget = stripPrefix
    ? `http://127.0.0.1:${port}/`
    : `http://127.0.0.1:${port}`;
  const block = `
    location ${path} {
        proxy_pass ${proxyTarget};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }`;
  await writeConfig(content.trimEnd().replace(/\n\}$/, `\n${block}\n}`) + '\n');
}

export async function removeApp(path) {
  const content = await readConfig();
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRegex = new RegExp(`\\n[ \\t]*location\\s+${escaped}\\s*\\{[\\s\\S]*?\\}`, 'g');
  await writeConfig(content.replace(blockRegex, ''));
}
