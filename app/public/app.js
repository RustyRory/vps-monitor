import { getState, loadProjects, refreshProjects, subscribe } from './store.js';
import { renderSidebar } from './views/sidebar.js';
import { renderProject } from './views/project.js';

// ---- Router ----

function getRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  if (!hash) return { projectId: null, tab: 'overview' };
  const parts = hash.split('/');
  // projects/:id or projects/:id/:tab
  if (parts[0] === 'projects' && parts[1]) {
    return { projectId: parts[1], tab: parts[2] || 'overview' };
  }
  return { projectId: null, tab: 'overview' };
}

export function navigate(projectId, tab = 'overview') {
  const frag = projectId
    ? `#/projects/${projectId}${tab !== 'overview' ? '/' + tab : ''}`
    : '#/';
  history.pushState(null, '', frag);
  render();
}

// ---- Render ----

function render() {
  const { projects, loading, error } = getState();
  const { projectId, tab } = getRoute();
  const sidebar = document.getElementById('sidebar');
  const main    = document.getElementById('main');

  renderSidebar(sidebar, projects, projectId, navigate);

  if (loading) {
    main.innerHTML = '<div class="loading-state">Chargement…</div>';
    return;
  }

  if (error) {
    main.innerHTML = `<div class="error-state">Erreur : ${error}</div>`;
    return;
  }

  if (!projectId) {
    if (projects.length > 0) {
      navigate(projects[0].id);
      return;
    }
    main.innerHTML = '<div class="empty-state">Aucun projet — crée le premier depuis la barre latérale.</div>';
    return;
  }

  const project = projects.find((p) => p.id === projectId);
  if (!project) {
    main.innerHTML = '<div class="error-state">Projet introuvable</div>';
    return;
  }

  renderProject(main, project, tab, navigate);
}

// ---- Bootstrap ----

window.addEventListener('hashchange', render);

(async () => {
  await loadProjects();

  subscribe(render);
  render();

  // Navigate to first project if no route defined
  const { projectId } = getRoute();
  if (!projectId) {
    const { projects } = getState();
    if (projects.length > 0) navigate(projects[0].id);
  }

  // Poll every 5 seconds to refresh status
  setInterval(refreshProjects, 5000);
})();
