// Centralized API helper — all fetch calls go through here

async function req(method, path, body) {
  const opts = {
    method,
    headers: {},
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('Non authentifié');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---- Projects ----
export const getProjects   = ()         => req('GET',    '/api/projects');
export const getProject    = (id)       => req('GET',    `/api/projects/${id}`);
export const createProject = (data)     => req('POST',   '/api/projects', data);
export const updateProject = (id, data) => req('PUT',    `/api/projects/${id}`, data);
export const deleteProject = (id)       => req('DELETE', `/api/projects/${id}`);

// ---- Deployments ----
export const getDeployments = (id)              => req('GET',  `/api/projects/${id}/deployments`);
export const triggerDeploy  = (id, opts = {})   => req('POST', `/api/projects/${id}/deployments`, opts);
export const getDeployLog   = (id, depId)       => req('GET',  `/api/projects/${id}/deployments/${depId}/log`);

// ---- Containers ----
export const getContainers     = (id)         => req('GET',  `/api/projects/${id}/containers`);
export const getMetrics        = (id)         => req('GET',  `/api/projects/${id}/metrics`);
export const containerRestart  = (id, name)   => req('POST', `/api/projects/${id}/containers/${name}/restart`);
export const containerStop     = (id, name)   => req('POST', `/api/projects/${id}/containers/${name}/stop`);
export const containerStart    = (id, name)   => req('POST', `/api/projects/${id}/containers/${name}/start`);
export const containerExec     = (id, name, cmd) => req('POST', `/api/projects/${id}/containers/${name}/exec`, { cmd });
export const projectRestart    = (id)         => req('POST', `/api/projects/${id}/restart`);

// ---- Environment ----
export const getEnv        = (id)              => req('GET', `/api/projects/${id}/env`);
export const getEnvExample = (id)              => req('GET', `/api/projects/${id}/env/example`);
export const saveEnv       = (id, content, rebuild = false) => req('PUT', `/api/projects/${id}/env`, { content, rebuild });

// ---- Nginx ----
export const getNginx = () => req('GET', '/api/nginx');

// ---- WebSocket token ----
export const getWsToken = () => req('GET', '/api/ws-token');

// ---- Status (global) ----
export const getStatus = () => req('GET', '/api/status');

// ---- Build WebSocket helper ----
export async function openBuildWs(deployId, onData, onClose) {
  const { token } = await getWsToken();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?deployId=${encodeURIComponent(deployId)}&token=${token}`);
  ws.onmessage = (e) => onData(e.data);
  ws.onclose   = onClose;
  ws.onerror   = onClose;
  return ws;
}

// ---- Container log WebSocket helper ----
export async function openContainerLogWs(containerName, tail, onData, onClose) {
  const { token } = await getWsToken();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(
    `${proto}://${location.host}/ws?container=${encodeURIComponent(containerName)}&tail=${tail}&token=${token}`
  );
  ws.onmessage = (e) => onData(e.data);
  ws.onclose   = onClose;
  ws.onerror   = onClose;
  return ws;
}
