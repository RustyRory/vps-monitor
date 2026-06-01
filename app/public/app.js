const REFRESH_INTERVAL = 5000;

async function fetchStatus() {
  const res = await fetch('/api/status');
  if (res.status === 401) {
    window.location.href = '/login.html';
    return null;
  }
  return res.json();
}

async function removeContainer(name) {
  if (!confirm(`Supprimer le container "${name}" ? Cette action est irréversible.`)) return;
  await fetch('/api/container/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  await refresh();
}

async function containerAction(action, name) {
  const btn = document.querySelector(`[data-name="${name}"][data-action="${action}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '...';
  }

  await fetch(`/api/container/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });

  await refresh();
}

let activeLogSocket = null;

async function showLogs(name) {
  if (activeLogSocket) {
    activeLogSocket.close();
    activeLogSocket = null;
  }

  const modal = document.getElementById('logs-modal');
  const title = document.getElementById('logs-title');
  const content = document.getElementById('logs-content');
  title.textContent = `Logs — ${name}`;
  content.textContent = 'Connexion…';
  modal.classList.remove('hidden');

  const tokenRes = await fetch('/api/ws-token');
  if (!tokenRes.ok) {
    content.textContent = 'Erreur: impossible d\'obtenir un token';
    return;
  }
  const { token } = await tokenRes.json();

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/logs?name=${encodeURIComponent(name)}&tail=200&token=${token}`);
  activeLogSocket = ws;
  content.textContent = '';

  ws.onmessage = (e) => {
    content.textContent += e.data;
    content.scrollTop = content.scrollHeight;
  };

  ws.onerror = () => {
    content.textContent += '\n[Erreur WebSocket]';
  };

  ws.onclose = () => {
    content.textContent += '\n[Flux terminé]';
  };
}

async function copyLogs() {
  const content = document.getElementById('logs-content').textContent;
  const btn = document.getElementById('copy-logs-btn');
  try {
    await navigator.clipboard.writeText(content);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = content;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  btn.textContent = 'Copié !';
  setTimeout(() => { btn.textContent = 'Copier'; }, 2000);
}

function closeLogs() {
  if (activeLogSocket) {
    activeLogSocket.close();
    activeLogSocket = null;
  }
  document.getElementById('logs-modal').classList.add('hidden');
}

async function logout() {
  await fetch('/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
}

// --- Tabs ---

function showTab(id) {
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  document.getElementById(`tab-${id}`).classList.remove('hidden');
  document.querySelector(`.tab-btn[onclick="showTab('${id}')"]`).classList.add('active');
  if (id === 'configs') { loadAppsJson(); loadConfigs(); }
  if (id === 'deploy') loadDeploy();
}

// --- apps.json ---

async function loadAppsJson() {
  const res = await fetch('/api/data/apps');
  if (res.status === 401) { window.location.href = '/login.html'; return; }
  const { content } = await res.json();
  document.getElementById('apps-json-editor').value = content;
}

async function saveAppsJson() {
  const content = document.getElementById('apps-json-editor').value;
  const statusEl = document.getElementById('apps-json-status');
  statusEl.textContent = 'Sauvegarde…';
  const res = await fetch('/api/data/apps', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  const data = await res.json();
  statusEl.textContent = res.ok ? '✅ Sauvegardé' : `❌ ${data.error}`;
}

// --- Nginx ---

let nginxApps = [];

async function loadConfigs() {
  const res = await fetch('/api/nginx/apps');
  if (res.status === 401) { window.location.href = '/login.html'; return; }
  const { apps, serverName } = await res.json();
  nginxApps = apps;
  document.getElementById('nginx-server-info').textContent = `Serveur : ${serverName}`;
  renderNginxApps();
}

function renderNginxApps() {
  const el = document.getElementById('nginx-apps');
  if (!nginxApps.length) {
    el.innerHTML = '<div class="file-empty">Aucune application configurée</div>';
    return;
  }
  el.innerHTML = nginxApps.map((a) => `
    <div class="card">
      <div class="card-header">
        <span class="card-name">${a.path}</span>
        <button class="card-delete" onclick="nginxRemoveApp('${a.path}', this)">✕</button>
      </div>
      <div class="card-meta">
        <div>Port : <strong>${a.port}</strong></div>
        <div>→ http://127.0.0.1:${a.port}/</div>
      </div>
    </div>
  `).join('');
}

async function nginxRemoveApp(path, btn) {
  btn.disabled = true;
  btn.textContent = '…';
  const statusEl = document.getElementById('nginx-status');
  const res = await fetch('/api/nginx/apps', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const data = await res.json();
  if (res.ok) {
    statusEl.textContent = '';
    await loadConfigs();
  } else {
    statusEl.textContent = `❌ ${data.output || data.error}`;
    btn.disabled = false;
    btn.textContent = '✕';
  }
}

async function nginxAddApp() {
  const path = document.getElementById('nginx-add-path').value.trim();
  const port = parseInt(document.getElementById('nginx-add-port').value, 10);
  const stripPrefix = !document.getElementById('nginx-add-keep-prefix').checked;
  const statusEl = document.getElementById('nginx-status');

  if (!path.startsWith('/') || !path.endsWith('/')) {
    statusEl.textContent = '❌ Le chemin doit commencer et finir par /';
    return;
  }
  if (!port || port < 1 || port > 65535) {
    statusEl.textContent = '❌ Port invalide';
    return;
  }

  statusEl.textContent = 'Ajout en cours…';
  const res = await fetch('/api/nginx/apps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, port, stripPrefix }),
  });
  const data = await res.json();
  if (res.ok) {
    document.getElementById('nginx-add-path').value = '';
    document.getElementById('nginx-add-port').value = '';
    statusEl.textContent = '✅ App ajoutée';
    await loadConfigs();
  } else {
    statusEl.textContent = `❌ ${data.output || data.error}`;
  }
}

// --- Deploy ---

async function loadDeploy() {
  const res = await fetch('/api/deploy/apps');
  if (res.status === 401) { window.location.href = '/login.html'; return; }
  renderDeployApps(await res.json());
}

function renderDeployApps(apps) {
  const el = document.getElementById('deploy-apps');
  if (!apps.length) {
    el.innerHTML = '<div class="file-empty">Aucune app définie dans apps/</div>';
    return;
  }
  el.innerHTML = apps.map((a) => `
    <div class="card">
      <div class="card-header">
        <span class="card-name">${a.name}</span>
        <span class="deploy-badge ${a.deployed ? (a.running ? 'running' : 'stopped') : 'absent'}">
          ${a.deployed ? (a.running ? 'running' : 'stopped') : 'absent'}
        </span>
        ${a.deployed ? `<button class="card-delete" onclick="deleteDeployApp('${a.name}', this)">✕</button>` : ''}
      </div>
      <div class="card-actions">
        ${a.deployed
          ? `<button onclick="updateDeployApp('${a.name}', this)">Mettre à jour</button>
             <button onclick="fullRestartApp('${a.name}', this)" title="Redémarre tous les containers (backend, frontend, BDD…) sur le même réseau">Redémarrage complet</button>
             <button onclick="openExecModal('${a.name}')">Exec</button>
             <button onclick="openEnvModal('${a.name}')">Éditer .env</button>`
          : `<button onclick="promptClone('${a.name}')">Déployer</button>`
        }
      </div>
    </div>
  `).join('');
}

async function deleteDeployApp(name, btn) {
  if (!confirm(`Supprimer "${name}" ? Cette action est irréversible (container arrêté, dossier supprimé).`)) return;
  btn.disabled = true;
  btn.textContent = '…';
  const res = await fetch('/api/deploy/apps', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (res.ok) {
    setTimeout(() => loadDeploy(), 500);
  } else {
    const data = await res.json();
    alert(`❌ ${data.error}`);
    btn.disabled = false;
    btn.textContent = '✕';
  }
}

async function updateDeployApp(name, btn) {
  btn.disabled = true;
  btn.textContent = '…';
  const res = await fetch('/api/deploy/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  btn.textContent = res.ok ? '✅' : '❌';
  setTimeout(() => loadDeploy(), 1500);
}

function openExecModal(appName) {
  document.getElementById('exec-modal-title').textContent = `Exec — ${appName}`;
  document.getElementById('exec-container').value = `${appName}-backend`;
  document.getElementById('exec-cmd').value = 'npm run seed:prod';
  document.getElementById('exec-output').textContent = '';
  document.getElementById('exec-modal').classList.remove('hidden');
}

function closeExecModal() {
  document.getElementById('exec-modal').classList.add('hidden');
}

async function runExec() {
  const name = document.getElementById('exec-container').value.trim();
  const cmd = document.getElementById('exec-cmd').value.trim();
  const out = document.getElementById('exec-output');
  if (!name || !cmd) return;
  out.textContent = '…';
  const res = await fetch('/api/container/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, cmd }),
  });
  const data = await res.json().catch(() => ({}));
  out.textContent = [data.stdout, data.stderr, data.error].filter(Boolean).join('\n') || '(aucun output)';
}

async function fullRestartApp(name, btn) {
  if (!confirm(`Redémarrer tous les containers de "${name}" ? (BDD incluse — quelques secondes d'interruption)`)) return;
  btn.disabled = true;
  btn.textContent = '…';
  const res = await fetch(`/api/deploy/apps/${encodeURIComponent(name)}/full-restart`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    const info = data.connections ? `\n${data.connections.join('\n')}` : '';
    alert(`✅ Redémarrage complet de "${name}" terminé.\nRéseau : ${data.network || '?'}${info}`);
  } else {
    alert(`❌ Erreur : ${data.error || 'inconnue'}`);
  }
  btn.disabled = false;
  btn.textContent = 'Redémarrage complet';
  loadDeploy();
}

function toggleEnvSection() {
  const show = document.getElementById('clone-has-env').checked;
  document.getElementById('clone-env-section').classList.toggle('hidden', !show);
}

async function loadCloneEnvExample() {
  const name = document.getElementById('clone-name').value.trim();
  if (!name) { alert('Renseigne le nom de l\'app d\'abord'); return; }
  const res = await fetch(`/api/deploy/apps/${encodeURIComponent(name)}/env-example`);
  if (!res.ok) return;
  const { content } = await res.json();
  if (content) document.getElementById('clone-env-content').value = content;
}

function promptClone(name) {
  document.getElementById('clone-name').value = name;
  document.getElementById('clone-url').focus();
  document.getElementById('clone-url').scrollIntoView({ behavior: 'smooth' });
}

async function cloneNewApp() {
  const name = document.getElementById('clone-name').value.trim();
  const url = document.getElementById('clone-url').value.trim();
  const branch = document.getElementById('clone-branch').value.trim() || null;
  const nginxPath = document.getElementById('clone-nginx-path').value.trim() || null;
  const port = document.getElementById('clone-nginx-port').value.trim() || null;
  const stripPrefix = !document.getElementById('clone-keep-prefix').checked;
  const statusEl = document.getElementById('clone-status');

  if (!name || !url) { statusEl.textContent = '❌ Nom et URL requis'; return; }
  if (nginxPath && !port) { statusEl.textContent = '❌ Port requis si chemin nginx renseigné'; return; }

  const hasEnv = document.getElementById('clone-has-env').checked;
  const env = hasEnv ? document.getElementById('clone-env-content').value.trim() : null;

  statusEl.textContent = `Déploiement de ${name}…`;
  const res = await fetch('/api/deploy/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, url, branch, nginxPath, port: port ? parseInt(port, 10) : undefined, stripPrefix, env }),
  });
  const data = await res.json();
  statusEl.textContent = res.ok ? `✅ ${name} déployé` : `❌ ${data.error}`;
  if (res.ok) {
    document.getElementById('clone-name').value = '';
    document.getElementById('clone-url').value = '';
    document.getElementById('clone-branch').value = '';
    document.getElementById('clone-nginx-path').value = '';
    document.getElementById('clone-nginx-port').value = '';
    document.getElementById('clone-has-env').checked = false;
    document.getElementById('clone-env-content').value = '';
    document.getElementById('clone-env-section').classList.add('hidden');
    loadDeploy();
  }
}

function renderContainers(containers) {
  const el = document.getElementById('containers');
  el.innerHTML = containers.map((c) => {
    const isRunning = c.status === 'running';
    return `
      <div class="card">
        <div class="card-header">
          <span class="card-name">${c.name}</span>
          <span class="dot ${c.status}" title="${c.status}"></span>
        </div>
        <div class="card-meta">
          <div>${c.image}</div>
          <div>${c.uptime}</div>
          <div>${c.ports.join(', ') || '—'}</div>
        </div>
        <div class="card-actions">
          ${isRunning ? `
            <button data-name="${c.name}" data-action="restart" onclick="containerAction('restart', '${c.name}')">Restart</button>
            <button data-name="${c.name}" data-action="stop" onclick="containerAction('stop', '${c.name}')">Stop</button>
          ` : `
            <button data-name="${c.name}" data-action="start" onclick="containerAction('start', '${c.name}')">Start</button>
            <button onclick="removeContainer('${c.name}')" style="color:var(--red,#e53e3e)">Supprimer</button>
          `}
          <button onclick="showLogs('${c.name}')">Logs</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderWebsites(websites) {
  const el = document.getElementById('websites');
  el.innerHTML = websites.map((w) => `
    <div class="card">
      <div class="card-header">
        <span class="card-name">${w.name}</span>
        <span class="dot ${w.status === 'OK' ? 'running' : 'exited'}" title="${w.status}"></span>
      </div>
      <div class="card-meta">
        <div>${w.url}</div>
        <div>HTTP ${w.httpCode ?? 'timeout'}</div>
      </div>
      <div class="card-actions">
        <a class="card-link" href="${w.url}" target="_blank" rel="noopener">Ouvrir →</a>
      </div>
    </div>
  `).join('');
}

function renderGlobalStatus(status) {
  const el = document.getElementById('global-status');
  el.textContent = status;
  el.className = `badge ${status.toLowerCase()}`;
}

function renderSummary(containers, websites) {
  const all = [
    ...containers.map((c) => c.status === 'running'),
    ...websites.map((w) => w.status === 'OK'),
  ];
  const ok = all.filter(Boolean).length;
  const ko = all.length - ok;
  const el = document.getElementById('summary');
  el.innerHTML = `<span class="ok-count">${ok} OK</span> / <span class="ko-count">${ko} KO</span>`;
}

// --- Env modal ---

let envModalApp = null;

async function openEnvModal(name) {
  envModalApp = name;
  document.getElementById('env-modal-title').textContent = `.env — ${name}`;
  document.getElementById('env-modal-status').textContent = '';
  document.getElementById('env-modal-content').value = 'Chargement…';
  document.getElementById('env-modal').classList.remove('hidden');
  const res = await fetch(`/api/deploy/apps/${encodeURIComponent(name)}/env`);
  const { content } = await res.json();
  document.getElementById('env-modal-content').value = content || '';
}

async function loadEnvExample() {
  if (!envModalApp) return;
  const res = await fetch(`/api/deploy/apps/${encodeURIComponent(envModalApp)}/env-example`);
  if (!res.ok) return;
  const { content } = await res.json();
  if (content) document.getElementById('env-modal-content').value = content;
}

async function saveEnv(rebuild) {
  const content = document.getElementById('env-modal-content').value;
  const statusEl = document.getElementById('env-modal-status');
  statusEl.textContent = 'Sauvegarde…';
  const res = await fetch(`/api/deploy/apps/${encodeURIComponent(envModalApp)}/env`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const data = await res.json();
    statusEl.textContent = `❌ ${data.error}`;
    return;
  }
  if (rebuild) {
    statusEl.textContent = 'Reconstruction…';
    await fetch('/api/deploy/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: envModalApp }),
    });
    statusEl.textContent = '✅ Sauvegardé — build en cours';
    setTimeout(() => closeEnvModal(), 1500);
  } else {
    statusEl.textContent = '✅ Sauvegardé';
  }
}

function closeEnvModal() {
  document.getElementById('env-modal').classList.add('hidden');
  envModalApp = null;
}

async function refresh() {
  try {
    const data = await fetchStatus();
    if (!data) return;
    renderGlobalStatus(data.globalStatus);
    renderSummary(data.containers, data.websites);
    renderContainers(data.containers);
    renderWebsites(data.websites);
  } catch {
    renderGlobalStatus('KO');
  }
}

refresh();
setInterval(refresh, REFRESH_INTERVAL);
