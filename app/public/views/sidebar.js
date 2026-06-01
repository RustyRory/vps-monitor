import { createProject } from '../api.js';
import { loadProjects } from '../store.js';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function statusDot(status) {
  return `<span class="dot ${esc(status || 'unknown')}" title="${esc(status || 'unknown')}"></span>`;
}

export function renderSidebar(el, projects, currentId, navigate) {
  const runningCount = projects.filter((p) => p.status === 'running').length;
  const failedCount  = projects.filter((p) => p.status === 'failed').length;

  el.innerHTML = `
    <div class="sidebar-header">
      <span class="sidebar-logo">vps-monitor</span>
      <span class="sidebar-global">
        <span class="dot ${failedCount > 0 ? 'failed' : 'running'}"></span>
        ${runningCount}/${projects.length}
      </span>
    </div>
    <nav class="sidebar-nav">
      ${projects.length === 0
        ? '<div style="padding:12px 14px;color:var(--text-dim);font-size:12px">Aucun projet</div>'
        : projects.map((p) => `
            <div class="sidebar-project${p.id === currentId ? ' active' : ''}" data-id="${esc(p.id)}">
              ${statusDot(p.status)}
              <span class="sidebar-project-name" title="${esc(p.name)}">${esc(p.name)}</span>
            </div>
          `).join('')}
    </nav>
    <div class="sidebar-footer">
      <button class="btn btn-ghost btn-full" id="sidebar-new-btn" style="justify-content:flex-start;gap:6px;font-size:13px">
        + Nouveau projet
      </button>
      <div style="margin-top:8px">
        <button class="btn btn-ghost btn-full" id="sidebar-logout-btn" style="justify-content:flex-start;font-size:12px;color:var(--text-dim)">
          Déconnexion
        </button>
      </div>
    </div>
  `;

  // Project click
  el.querySelectorAll('.sidebar-project').forEach((item) => {
    item.addEventListener('click', () => navigate(item.dataset.id));
  });

  // New project
  el.querySelector('#sidebar-new-btn').addEventListener('click', () => {
    openNewProjectModal(navigate);
  });

  // Logout
  el.querySelector('#sidebar-logout-btn').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/';
  });
}

// ---- New Project Modal ----

function openNewProjectModal(navigate) {
  const overlay = document.getElementById('modal-overlay');
  const box     = document.getElementById('modal-box');

  box.innerHTML = `
    <div class="modal-header">
      <span class="modal-title">Nouveau projet</span>
      <button class="btn btn-ghost btn-sm" id="modal-close-btn">✕</button>
    </div>
    <div class="modal-body">
      <div class="settings-form">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Identifiant *</label>
            <input class="form-input" id="np-id" placeholder="lucky7" />
            <span style="font-size:11px;color:var(--text-dim)">Alphanumérique + _ -. Utilisé comme nom de dossier.</span>
          </div>
          <div class="form-group">
            <label class="form-label">Nom affiché *</label>
            <input class="form-input" id="np-name" placeholder="Lucky7" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">URL Git *</label>
          <input class="form-input" id="np-url" placeholder="https://github.com/…" />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Branche</label>
            <input class="form-input" id="np-branch" placeholder="main (défaut)" />
          </div>
          <div class="form-group">
            <label class="form-label">Port</label>
            <input class="form-input" id="np-port" type="number" placeholder="3002" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Chemin Nginx</label>
          <input class="form-input" id="np-nginx" placeholder="/lucky7/" />
        </div>
        <label class="form-check">
          <input type="checkbox" id="np-prefix" checked />
          Conserver le préfixe (Next.js / basePath)
        </label>
        <label class="form-check">
          <input type="checkbox" id="np-deploy" checked />
          Lancer le déploiement après création
        </label>
        <div id="np-status" class="status-msg"></div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" id="np-cancel-btn">Annuler</button>
      <button class="btn btn-primary" id="np-submit-btn">Créer</button>
    </div>
  `;

  overlay.classList.remove('hidden');

  const close = () => overlay.classList.add('hidden');

  box.querySelector('#modal-close-btn').addEventListener('click', close);
  box.querySelector('#np-cancel-btn').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); }, { once: true });

  box.querySelector('#np-submit-btn').addEventListener('click', async () => {
    const id       = box.querySelector('#np-id').value.trim();
    const name     = box.querySelector('#np-name').value.trim();
    const gitUrl   = box.querySelector('#np-url').value.trim();
    const branch   = box.querySelector('#np-branch').value.trim() || null;
    const port     = parseInt(box.querySelector('#np-port').value) || null;
    const nginxPath = box.querySelector('#np-nginx').value.trim() || null;
    const stripPrefix = box.querySelector('#np-prefix').checked;
    const doDeploy    = box.querySelector('#np-deploy').checked;
    const statusEl    = box.querySelector('#np-status');
    const submitBtn   = box.querySelector('#np-submit-btn');

    if (!id || !name || !gitUrl) {
      statusEl.textContent = 'Identifiant, nom et URL Git sont requis.';
      statusEl.className = 'status-msg err';
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Création…';
    statusEl.textContent = '';

    try {
      await createProject({ id, name, gitUrl, branch, port, nginxPath, stripPrefix });
      await loadProjects();

      if (doDeploy) {
        const { triggerDeploy } = await import('../api.js');
        await triggerDeploy(id);
        await loadProjects();
      }

      close();
      navigate(id, doDeploy ? 'deployments' : 'overview');
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = 'status-msg err';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Créer';
    }
  });
}
