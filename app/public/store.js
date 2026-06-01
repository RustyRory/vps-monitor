import { getProjects } from './api.js';

let state = {
  projects: [],
  loading: true,
  error: null,
};

const listeners = new Set();

export function getState() {
  return state;
}

function setState(updates) {
  state = { ...state, ...updates };
  listeners.forEach((fn) => fn(state));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function loadProjects() {
  try {
    const projects = await getProjects();
    setState({ projects, loading: false, error: null });
  } catch (err) {
    setState({ loading: false, error: err.message });
  }
}

export async function refreshProjects() {
  try {
    const projects = await getProjects();
    setState({ projects });
  } catch {
    // Ignore polling errors silently
  }
}
