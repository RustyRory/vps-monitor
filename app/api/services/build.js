import { createWriteStream } from 'fs';
import { readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { EventEmitter } from 'events';

const REPO_ROOT = process.env.VPSCONFIG_PATH || '/var/www/vps-monitor';
const LOGS_DIR = join(REPO_ROOT, 'data', 'logs');

// Active build sessions: deployId → { emitter, fileStream }
const activeSessions = new Map();

export function getBuildLogPath(projectId, deployId) {
  return join(LOGS_DIR, `${projectId}-${deployId}.log`);
}

export async function startBuildSession(projectId, deployId) {
  await mkdir(LOGS_DIR, { recursive: true });
  const logPath = getBuildLogPath(projectId, deployId);
  const fileStream = createWriteStream(logPath, { flags: 'a' });
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);

  const session = {
    emitter,
    fileStream,
    write(text) {
      fileStream.write(text);
      emitter.emit('data', text);
    },
    end() {
      fileStream.end();
      emitter.emit('end');
      activeSessions.delete(deployId);
    },
  };

  activeSessions.set(deployId, session);
  return session;
}

// Returns an unsubscribe function, or null if session is not active (build already ended).
export function subscribeBuildSession(deployId, onData, onEnd) {
  const session = activeSessions.get(deployId);
  if (!session) return null;

  session.emitter.on('data', onData);
  session.emitter.once('end', onEnd);

  return () => {
    session.emitter.off('data', onData);
    session.emitter.off('end', onEnd);
  };
}

export function isBuildActive(deployId) {
  return activeSessions.has(deployId);
}

export async function readBuildLog(projectId, deployId) {
  const logPath = getBuildLogPath(projectId, deployId);
  try {
    return await readFile(logPath, 'utf8');
  } catch {
    return '';
  }
}
