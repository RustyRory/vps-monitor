import {
  getContainers, getMetrics, containerRestart, containerStop, containerStart,
  containerExec, projectRestart,
  getDeployments, triggerDeploy, getDeployLog, openBuildWs, openContainerLogWs,
  getEnv, getEnvExample, saveEnv,
  updateProject, deleteProject,
  getNginx,
} from '../api.js';
import { loadProjects, refreshProjects } from '../store.js';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function relTime(iso) {
  if (!iso) return '—';
  const delta = Date.now() - new Date(iso).getTime();
  const s = Math.floor(delta / 1000);
  if (s < 60)  return `il y a ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `il y a ${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `il y a ${h}h`;
  return `il y a ${Math.floor(h / 24)}j`;
}

function formatBytes(b) {
  if (b === undefined || b === null) return '?';
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// ---- Main entry ----

export function renderProject(el, project, tab, navigate) {
  el.innerHTML = `
    <div class="project-header">
      <div class="project-title-row">
        <span class="project-name">${esc(project.name)}</span>
        <span class="dot ${esc(project.status || 'unknown')}"></span>
        <span class="badge ${esc(project.status || 'unknown')}">${esc(project.status || 'unknown')}</span>
        ${project.gitUrl ? `<a class="project-git-link" href="${esc(project.gitUrl)}" target="_blank" rel="noopener">↗ ${esc(project.gitUrl.replace('https://github.com/', ''))}</a>` : ''}
        ${project.nginxPath ? `<a class="project-git-link" href="${window.location.origin}${esc(project.nginxPath)}" target="_blank" rel="noopener">↗ Ouvrir l'app</a>` : ''}
      </div>
      <div class="project-tabs">
        ${['overview','deployments','variables','settings'].map((t) => `
          <button class="tab-btn${tab === t ? ' active' : ''}" data-tab="${t}">
            ${{ overview: 'Vue d\'ensemble', deployments: 'Déploiements', variables: 'Variables', settings: 'Paramètres' }[t]}
          </button>
        `).join('')}
      </div>
    </div>
    <div id="tab-content" class="tab-content"></div>
  `;

  el.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => navigate(project.id, btn.dataset.tab));
  });

  const content = el.querySelector('#tab-content');

  if (tab === 'overview')     renderOverview(content, project, navigate);
  if (tab === 'deployments')  renderDeployments(content, project, navigate);
  if (tab === 'variables')    renderVariables(content, project);
  if (tab === 'settings')     renderSettings(content, project, navigate);
}

// ================================================================
// OVERVIEW TAB
// ================================================================

function renderOverview(el, project, navigate) {
  el.innerHTML = `
    <div>
      <div class="section-title">Containers</div>
      <div id="containers-section">
        <div class="card" style="color:var(--text-dim);font-size:13px">Chargement…</div>
      </div>
    </div>
    <div>
      <div class="section-title">Nginx</div>
      <div id="nginx-section">
        ${project.nginxPath
          ? `<div class="nginx-row">
               <span class="nginx-path">${esc(project.nginxPath)}</span>
               <span class="nginx-arrow">→</span>
               <span class="nginx-port">:${esc(project.port)}</span>
               <span class="nginx-status"><span class="text-muted" style="font-size:12px;color:var(--text-muted)">Vérification…</span></span>
             </div>`
          : '<div style="color:var(--text-dim);font-size:13px">Pas de route Nginx configurée.</div>'}
      </div>
    </div>
    <div>
      <div class="section-title">Dernier déploiement</div>
      <div id="last-deploy-section">
        ${project.deployments?.length
          ? renderLastDeployCard(project.deployments[0], project.id)
          : '<div style="color:var(--text-dim);font-size:13px">Aucun déploiement.</div>'}
      </div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn" id="btn-redeploy">▶ Redéployer</button>
      <button class="btn" id="btn-full-restart">↺ Full restart</button>
    </div>
    <div id="overview-status" class="status-msg"></div>
  `;

  loadContainers(el, project);

  if (project.nginxPath) checkNginxStatus(el, project);

  el.querySelector('#btn-redeploy').addEventListener('click', async () => {
    const statusEl = el.querySelector('#overview-status');
    try {
      statusEl.textContent = 'Déploiement lancé…';
      statusEl.className = 'status-msg';
      await triggerDeploy(project.id);
      await refreshProjects();
      navigate(project.id, 'deployments');
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = 'status-msg err';
    }
  });

  el.querySelector('#btn-full-restart').addEventListener('click', async () => {
    const statusEl = el.querySelector('#overview-status');
    const btn = el.querySelector('#btn-full-restart');
    btn.disabled = true;
    try {
      statusEl.textContent = 'Restart en cours…';
      statusEl.className = 'status-msg';
      await projectRestart(project.id);
      await refreshProjects();
      statusEl.textContent = 'Redémarré.';
      statusEl.className = 'status-msg ok';
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = 'status-msg err';
    } finally {
      btn.disabled = false;
    }
  });
}

function renderLastDeployCard(dep, projectId) {
  return `
    <div class="card">
      <div class="last-deploy-row">
        <span class="badge ${esc(dep.status)}">${esc(dep.status)}</span>
        <span class="deploy-id">${esc(dep.id)}</span>
        <span style="color:var(--text-dim);font-size:12px">${relTime(dep.timestamp)}</span>
        ${dep.duration ? `<span style="color:var(--text-dim);font-size:12px">${dep.duration}s</span>` : ''}
        ${dep.commit ? `<span class="deploy-commit">${esc(dep.commit)}</span>` : ''}
      </div>
      <div style="margin-top:8px">
        <button class="btn btn-sm" data-log-deploy="${esc(dep.id)}" data-project-id="${esc(projectId)}">Voir les logs</button>
      </div>
    </div>
  `;
}

async function loadContainers(el, project) {
  try {
    const [containers, metrics] = await Promise.all([
      getContainers(project.id),
      getMetrics(project.id).catch(() => []),
    ]);

    const section = el.querySelector('#containers-section');
    if (!containers.length) {
      section.innerHTML = '<div style="color:var(--text-dim);font-size:13px">Aucun container trouvé.</div>';
      return;
    }

    section.innerHTML = containers.map((c) => {
      const m = metrics.find((x) => x.name === c.name);
      const cpuPct = m?.cpu_percent ?? 0;
      const memUsed = m ? formatBytes(m.mem_usage) : '?';
      const memTot  = m ? formatBytes(m.mem_limit) : '?';
      const memPct  = m?.mem_percent ?? 0;
      const barClass = cpuPct > 80 ? 'high' : cpuPct > 50 ? 'med' : '';

      return `
        <div class="card" style="margin-bottom:8px">
          <div class="card-header">
            <div class="card-title">
              <span class="dot ${esc(c.status)}"></span>
              <span>${esc(c.name)}</span>
              <span style="color:var(--text-dim);font-size:12px;font-weight:normal">${esc(c.uptime)}</span>
            </div>
            <span style="font-size:12px;color:var(--text-muted)">${esc(c.image)}</span>
          </div>
          ${m ? `
            <div class="card-meta">
              <span>
                CPU <strong style="color:var(--text)">${cpuPct}%</strong>
                <span class="metric-bar-track"><span class="metric-bar-fill ${barClass}" style="width:${Math.min(cpuPct, 100)}%"></span></span>
              </span>
              <span>
                RAM <strong style="color:var(--text)">${memUsed}</strong> / ${memTot}
                <span class="metric-bar-track"><span class="metric-bar-fill ${memPct > 80 ? 'high' : memPct > 50 ? 'med' : ''}" style="width:${Math.min(memPct, 100)}%"></span></span>
              </span>
              ${c.ports.length ? `<span>Port: ${esc(c.ports.join(', '))}</span>` : ''}
            </div>
          ` : c.ports.length ? `<div class="card-meta"><span>Port: ${esc(c.ports.join(', '))}</span></div>` : ''}
          <div class="card-actions">
            <button class="btn btn-sm" data-action="restart" data-container="${esc(c.name)}" data-project="${esc(project.id)}">Restart</button>
            <button class="btn btn-sm" data-action="${c.status === 'running' ? 'stop' : 'start'}" data-container="${esc(c.name)}" data-project="${esc(project.id)}">
              ${c.status === 'running' ? 'Stop' : 'Start'}
            </button>
            <button class="btn btn-sm" data-action="logs" data-container="${esc(c.name)}">Logs</button>
            <button class="btn btn-sm" data-action="exec" data-container="${esc(c.name)}" data-project="${esc(project.id)}">Exec</button>
          </div>
        </div>
      `;
    }).join('');

    bindContainerActions(el, project);
  } catch (err) {
    const section = el.querySelector('#containers-section');
    section.innerHTML = `<div class="card" style="color:var(--error);font-size:13px">Erreur : ${esc(err.message)}</div>`;
  }
}

async function checkNginxStatus(el, project) {
  try {
    const nginx = await getNginx();
    const app = nginx.apps?.find((a) => a.path === project.nginxPath);
    const statusEl = el.querySelector('.nginx-status');
    if (statusEl) {
      statusEl.innerHTML = app
        ? `<span class="badge running">OK</span>`
        : `<span class="badge failed">Absent</span>`;
    }
  } catch { /* ignore */ }
}

function bindContainerActions(el, project) {
  el.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action    = btn.dataset.action;
      const container = btn.dataset.container;

      if (action === 'logs') {
        openLogsModal(container, 200);
        return;
      }

      if (action === 'exec') {
        openExecModal(project.id, container);
        return;
      }

      btn.disabled = true;
      try {
        if (action === 'restart') await containerRestart(project.id, container);
        if (action === 'stop')    await containerStop(project.id, container);
        if (action === 'start')   await containerStart(project.id, container);
        await loadContainers(el, project);
      } catch (err) {
        alert(`Erreur : ${err.message}`);
      } finally {
        btn.disabled = false;
      }
    });
  });

  // Log link in last-deploy card
  el.querySelectorAll('[data-log-deploy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openLogModal(btn.dataset.projectId || project.id, btn.dataset.logDeploy);
    });
  });
}

// ================================================================
// DEPLOYMENTS TAB
// ================================================================

async function renderDeployments(el, project, _navigate) {
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div>
        <div class="section-title" style="margin:0">Déploiements</div>
        <div style="color:var(--text-dim);font-size:12px;margin-top:2px">Branche : ${esc(project.branch || 'défaut')}</div>
      </div>
      <button class="btn btn-primary" id="btn-deploy">▶ Déployer</button>
    </div>
    <div id="deploy-list-section">
      <div style="color:var(--text-dim);font-size:13px">Chargement…</div>
    </div>
    <div id="build-log-section" class="hidden"></div>
    <div id="deploy-status" class="status-msg"></div>
  `;

  el.querySelector('#btn-deploy').addEventListener('click', () => {
    showDeployForm(el, project);
  });

  loadDeploymentList(el, project);
}

async function loadDeploymentList(el, project) {
  try {
    const deployments = await getDeployments(project.id);
    const section = el.querySelector('#deploy-list-section');

    if (!deployments.length) {
      section.innerHTML = '<div style="color:var(--text-dim);font-size:13px">Aucun déploiement. Clique sur "Déployer" pour commencer.</div>';
      return;
    }

    section.innerHTML = `
      <div class="deploy-list">
        ${deployments.map((dep) => `
          <div class="deploy-item" data-dep-id="${esc(dep.id)}">
            <span class="badge ${esc(dep.status)}">${esc(dep.status)}</span>
            <div class="deploy-item-main">
              <div class="deploy-item-top">
                <span class="deploy-id">${esc(dep.id.slice(0, 16))}</span>
                ${dep.commit ? `<span class="deploy-commit">@ ${esc(dep.commit)}</span>` : ''}
              </div>
              <div class="deploy-item-meta">
                <span>${relTime(dep.timestamp)}</span>
                ${dep.duration ? `<span>${dep.duration}s</span>` : ''}
                <span>${esc(dep.triggeredBy || 'manual')}</span>
              </div>
            </div>
            <button class="btn btn-sm btn-ghost" data-view-log="${esc(dep.id)}">Logs →</button>
          </div>
        `).join('')}
      </div>
    `;

    section.querySelectorAll('[data-view-log]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        showBuildLog(el, project.id, btn.dataset.viewLog);
      });
    });

    section.querySelectorAll('.deploy-item').forEach((item) => {
      item.addEventListener('click', () => {
        showBuildLog(el, project.id, item.dataset.depId);
      });
    });
  } catch (err) {
    el.querySelector('#deploy-list-section').innerHTML =
      `<div class="card" style="color:var(--error);font-size:13px">Erreur : ${esc(err.message)}</div>`;
  }
}

function showDeployForm(el, project) {
  const statusEl = el.querySelector('#deploy-status');
  const deployBtn = el.querySelector('#btn-deploy');

  // Replace button with inline form
  deployBtn.style.display = 'none';

  const formEl = document.createElement('div');
  formEl.className = 'card';
  formEl.style.marginBottom = '0';
  formEl.innerHTML = `
    <div class="settings-form">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Branche</label>
          <input class="form-input" id="dep-branch" placeholder="${esc(project.branch || 'branche par défaut')}" />
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" id="dep-confirm-btn">▶ Lancer le déploiement</button>
        <button class="btn" id="dep-cancel-btn">Annuler</button>
      </div>
    </div>
  `;

  el.querySelector('#deploy-list-section').before(formEl);

  formEl.querySelector('#dep-cancel-btn').addEventListener('click', () => {
    formEl.remove();
    deployBtn.style.display = '';
  });

  formEl.querySelector('#dep-confirm-btn').addEventListener('click', async () => {
    const branch = formEl.querySelector('#dep-branch').value.trim() || null;
    const confirmBtn = formEl.querySelector('#dep-confirm-btn');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Lancement…';
    statusEl.textContent = '';

    try {
      const { deployId } = await triggerDeploy(project.id, { branch });
      formEl.remove();
      deployBtn.style.display = '';
      await refreshProjects();
      // Reload deployment list and show live logs
      await loadDeploymentList(el, project);
      if (deployId) showBuildLog(el, project.id, deployId, null, true);
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = 'status-msg err';
      confirmBtn.disabled = false;
      confirmBtn.textContent = '▶ Lancer le déploiement';
    }
  });
}

async function showBuildLog(el, projectId, deployId, live = false) {
  const logSection = el.querySelector('#build-log-section');
  logSection.classList.remove('hidden');
  logSection.innerHTML = `
    <div class="build-log-container">
      <div class="build-log-header">
        <span class="build-log-title">${esc(deployId)}</span>
        <div style="display:flex;gap:6px;align-items:center">
          <span id="log-status-indicator" style="font-size:11px;color:var(--warning)">
            ${live ? '● Live' : ''}
          </span>
          <button class="btn btn-ghost btn-sm" id="log-copy-btn">Copier</button>
          <button class="btn btn-ghost btn-sm" id="log-close-btn">✕</button>
        </div>
      </div>
      <pre id="build-log-pre" class="build-log-pre">Chargement des logs…</pre>
    </div>
  `;

  logSection.querySelector('#log-close-btn').addEventListener('click', () => {
    logSection.classList.add('hidden');
    logSection.innerHTML = '';
  });

  const logEl = logSection.querySelector('#build-log-pre');
  const indicator = logSection.querySelector('#log-status-indicator');

  logSection.querySelector('#log-copy-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(logEl.textContent).catch(() => {});
  });

  logEl.scrollTop = logEl.scrollHeight;

  // Try to load existing log first
  try {
    const { content, active } = await getDeployLog(projectId, deployId);
    if (content) {
      logEl.textContent = content;
      logEl.scrollTop = logEl.scrollHeight;
    }

    if (active || live) {
      // Stream live via WebSocket
      indicator.textContent = '● Live';
      indicator.style.color = 'var(--warning)';

      let ws;
      try {
        ws = await openBuildWs(deployId,
          (data) => {
            if (logEl.textContent === 'Chargement des logs…') logEl.textContent = '';
            logEl.textContent += data;
            logEl.scrollTop = logEl.scrollHeight;
          },
          async () => {
            indicator.textContent = '✓ Terminé';
            indicator.style.color = 'var(--success)';
            await refreshProjects();
            await loadDeploymentList(el, { id: projectId });
          }
        );
      } catch {
        indicator.textContent = '';
      }

      logSection.querySelector('#log-close-btn').addEventListener('click', () => {
        ws?.close();
      });
    } else {
      indicator.textContent = '';
      if (!content) logEl.textContent = '(log vide)';
    }
  } catch (err) {
    logEl.textContent = `Erreur : ${err.message}`;
  }
}

// ================================================================
// VARIABLES TAB
// ================================================================

async function renderVariables(el, project) {
  el.innerHTML = `
    <div>
      <div class="section-title">.env — ${esc(project.name)}</div>
      <div class="env-editor-container">
        <textarea class="env-textarea" id="env-content" spellcheck="false" placeholder="# Variables d'environnement&#10;KEY=value"></textarea>
      </div>
      <div class="env-actions">
        <button class="btn btn-ghost btn-sm" id="btn-load-example">Charger .env.example</button>
        <div style="display:flex;gap:6px">
          <button class="btn" id="btn-save-env">Enregistrer</button>
          <button class="btn btn-primary" id="btn-save-rebuild">Enregistrer + Rebuild</button>
        </div>
      </div>
      <div id="env-status" class="status-msg"></div>
    </div>
  `;

  // Load existing .env
  try {
    const { content } = await getEnv(project.id);
    el.querySelector('#env-content').value = content;
  } catch { /* empty is fine */ }

  el.querySelector('#btn-load-example').addEventListener('click', async () => {
    try {
      const { content } = await getEnvExample(project.id);
      if (content) el.querySelector('#env-content').value = content;
    } catch (err) {
      showEnvStatus(el, err.message, 'err');
    }
  });

  el.querySelector('#btn-save-env').addEventListener('click', async () => {
    await saveEnvAction(el, project.id, false);
  });

  el.querySelector('#btn-save-rebuild').addEventListener('click', async () => {
    await saveEnvAction(el, project.id, true);
  });
}

async function saveEnvAction(el, projectId, rebuild) {
  const content = el.querySelector('#env-content').value;
  const btn = el.querySelector(rebuild ? '#btn-save-rebuild' : '#btn-save-env');
  btn.disabled = true;

  try {
    await saveEnv(projectId, content, rebuild);
    showEnvStatus(el, rebuild ? 'Enregistré — rebuild en cours.' : 'Enregistré.', 'ok');
  } catch (err) {
    showEnvStatus(el, err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function showEnvStatus(el, msg, type) {
  const statusEl = el.querySelector('#env-status');
  statusEl.textContent = msg;
  statusEl.className = `status-msg ${type}`;
  setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 4000);
}

// ================================================================
// SETTINGS TAB
// ================================================================

function renderSettings(el, project, navigate) {
  el.innerHTML = `
    <div>
      <div class="section-title">Configuration</div>
      <div class="settings-form">
        <div class="form-group">
          <label class="form-label">URL Git</label>
          <input class="form-input" id="s-git" value="${esc(project.gitUrl || '')}" placeholder="https://github.com/…" />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Branche</label>
            <input class="form-input" id="s-branch" value="${esc(project.branch || '')}" placeholder="main (défaut)" />
          </div>
          <div class="form-group">
            <label class="form-label">Port</label>
            <input class="form-input" id="s-port" type="number" value="${esc(project.port || '')}" placeholder="3002" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Chemin Nginx</label>
          <input class="form-input" id="s-nginx" value="${esc(project.nginxPath || '')}" placeholder="/lucky7/" />
        </div>
        <label class="form-check">
          <input type="checkbox" id="s-prefix" ${project.stripPrefix ? 'checked' : ''} />
          Conserver le préfixe (Next.js / basePath)
        </label>
        <button class="btn btn-primary" id="btn-save-settings" style="align-self:flex-start">Enregistrer</button>
        <div id="settings-status" class="status-msg"></div>
      </div>
    </div>
    <div class="danger-zone">
      <div class="danger-zone-title">Zone de danger</div>
      <p>Supprime définitivement le projet, ses containers, ses fichiers et sa config Nginx.</p>
      <button class="btn btn-danger" id="btn-delete-project">Supprimer ${esc(project.name)}</button>
    </div>
  `;

  el.querySelector('#btn-save-settings').addEventListener('click', async () => {
    const gitUrl     = el.querySelector('#s-git').value.trim();
    const branch     = el.querySelector('#s-branch').value.trim() || null;
    const port       = parseInt(el.querySelector('#s-port').value) || null;
    const nginxPath  = el.querySelector('#s-nginx').value.trim() || null;
    const stripPrefix = el.querySelector('#s-prefix').checked;
    const statusEl   = el.querySelector('#settings-status');
    const btn        = el.querySelector('#btn-save-settings');

    btn.disabled = true;
    try {
      await updateProject(project.id, { gitUrl, branch, port, nginxPath, stripPrefix });
      await loadProjects();
      statusEl.textContent = 'Enregistré.';
      statusEl.className = 'status-msg ok';
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = 'status-msg err';
    } finally {
      btn.disabled = false;
    }
  });

  el.querySelector('#btn-delete-project').addEventListener('click', async () => {
    if (!confirm(`Supprimer le projet "${project.name}" ? Cette action est irréversible.`)) return;
    try {
      await deleteProject(project.id);
      await loadProjects();
      navigate(null);
    } catch (err) {
      alert(`Erreur : ${err.message}`);
    }
  });
}

// ================================================================
// MODALS (logs, exec)
// ================================================================

function getModal() {
  return {
    overlay: document.getElementById('modal-overlay'),
    box:     document.getElementById('modal-box'),
  };
}

async function openLogsModal(containerName, tail = 200) {
  const { overlay, box } = getModal();

  overlay.classList.remove('hidden');
  overlay.classList.add('logs-mode');

  box.innerHTML = `
    <div class="modal-header">
      <span class="modal-title">Logs — ${esc(containerName)}</span>
      <div style="display:flex;gap:6px">
        <button class="btn btn-ghost btn-sm" id="log-modal-copy">Copier</button>
        <button class="btn btn-ghost btn-sm" id="log-modal-close">✕</button>
      </div>
    </div>
    <div style="padding:0">
      <pre id="log-modal-pre" class="build-log-pre" style="max-height:60vh">Connexion…</pre>
    </div>
  `;

  const logEl = box.querySelector('#log-modal-pre');
  let ws;

  const close = () => {
    ws?.close();
    overlay.classList.add('hidden');
    overlay.classList.remove('logs-mode');
  };

  box.querySelector('#log-modal-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); }, { once: true });

  box.querySelector('#log-modal-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(logEl.textContent).catch(() => {});
  });

  try {
    ws = await openContainerLogWs(
      containerName, tail,
      (data) => {
        if (logEl.textContent === 'Connexion…') logEl.textContent = '';
        logEl.textContent += data;
        logEl.scrollTop = logEl.scrollHeight;
      },
      () => {
        if (logEl.textContent === 'Connexion…') logEl.textContent = '(Aucun log)';
      }
    );
  } catch (err) {
    logEl.textContent = `Erreur : ${err.message}`;
  }
}

function openExecModal(projectId, containerName) {
  const { overlay, box } = getModal();
  overlay.classList.remove('hidden');

  box.innerHTML = `
    <div class="modal-header">
      <span class="modal-title">Exec — ${esc(containerName)}</span>
      <button class="btn btn-ghost btn-sm" id="exec-close">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-group" style="margin-bottom:10px">
        <label class="form-label">Commande</label>
        <div style="display:flex;gap:8px">
          <input class="form-input" id="exec-cmd-input" placeholder="npm run seed:prod" style="flex:1;font-family:monospace" />
          <button class="btn btn-primary" id="exec-run-btn">Exécuter</button>
        </div>
      </div>
      <pre id="exec-output" class="build-log-pre" style="min-height:80px;max-height:300px">(sortie)</pre>
    </div>
  `;

  const close = () => overlay.classList.add('hidden');
  box.querySelector('#exec-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); }, { once: true });

  const cmdInput = box.querySelector('#exec-cmd-input');
  const outputEl = box.querySelector('#exec-output');
  const runBtn   = box.querySelector('#exec-run-btn');

  const run = async () => {
    const cmd = cmdInput.value.trim();
    if (!cmd) return;
    runBtn.disabled = true;
    outputEl.textContent = 'Exécution…';
    try {
      const { stdout, stderr } = await containerExec(projectId, containerName, cmd);
      outputEl.textContent = [stdout, stderr].filter(Boolean).join('\n') || '(aucune sortie)';
    } catch (err) {
      outputEl.textContent = `Erreur : ${err.message}`;
    } finally {
      runBtn.disabled = false;
    }
  };

  runBtn.addEventListener('click', run);
  cmdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
}

async function openLogModal(projectId, deployId) {
  const { overlay, box } = getModal();
  overlay.classList.remove('hidden');
  overlay.classList.add('logs-mode');

  box.innerHTML = `
    <div class="modal-header">
      <span class="modal-title">Build log — ${esc(deployId.slice(0, 20))}</span>
      <div style="display:flex;gap:6px">
        <button class="btn btn-ghost btn-sm" id="bm-copy">Copier</button>
        <button class="btn btn-ghost btn-sm" id="bm-close">✕</button>
      </div>
    </div>
    <pre id="bm-pre" class="build-log-pre" style="max-height:65vh">Chargement…</pre>
  `;

  const logEl = box.querySelector('#bm-pre');
  const close = () => {
    overlay.classList.add('hidden');
    overlay.classList.remove('logs-mode');
  };

  box.querySelector('#bm-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); }, { once: true });
  box.querySelector('#bm-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(logEl.textContent).catch(() => {});
  });

  try {
    const { content } = await getDeployLog(projectId, deployId);
    logEl.textContent = content || '(log vide)';
    logEl.scrollTop = logEl.scrollHeight;
  } catch (err) {
    logEl.textContent = `Erreur : ${err.message}`;
  }
}
