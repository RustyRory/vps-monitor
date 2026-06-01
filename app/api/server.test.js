import { jest } from '@jest/globals';

process.env.AUTH_USER = 'admin';
process.env.AUTH_PASS = 'testpass';
process.env.SESSION_SECRET = 'test-secret';

const mockProjects = [
  { id: 'lucky7', name: 'lucky7', gitUrl: 'https://github.com/RustyRory/Lucky7.git', status: 'running', deployments: [] },
];

jest.unstable_mockModule('./services/docker.js', () => ({
  getContainers: jest.fn().mockResolvedValue([
    { name: 'lucky7', status: 'running', image: 'img', ports: ['3002'], uptime: 'Up 1 hour' },
  ]),
  getContainersByNames: jest.fn().mockResolvedValue([
    { name: 'lucky7', status: 'running', image: 'img', ports: ['3002'], uptime: 'Up 1 hour' },
  ]),
  restartContainer: jest.fn().mockResolvedValue(),
  stopContainer: jest.fn().mockResolvedValue(),
  startContainer: jest.fn().mockResolvedValue(),
  removeContainer: jest.fn().mockResolvedValue(),
  streamContainerLogs: jest.fn().mockResolvedValue({ destroy: jest.fn() }),
}));

jest.unstable_mockModule('./services/http.js', () => ({
  checkWebsites: jest.fn().mockResolvedValue([
    { name: 'lucky7', url: '/lucky7/', httpCode: 200, status: 'OK' },
  ]),
}));

jest.unstable_mockModule('./services/nginx.js', () => ({
  readConfig: jest.fn().mockResolvedValue(''),
  parseApps: jest.fn().mockReturnValue([]),
  parseConfigMeta: jest.fn().mockReturnValue({ serverName: 'localhost', rootPort: 3020 }),
  writeConfig: jest.fn().mockResolvedValue(),
  testConfig: jest.fn().mockResolvedValue({ ok: true, output: '' }),
  reload: jest.fn().mockResolvedValue(),
  addApp: jest.fn().mockResolvedValue(),
  removeApp: jest.fn().mockResolvedValue(),
}));

jest.unstable_mockModule('./services/deploy.js', () => ({
  getProjects: jest.fn().mockResolvedValue(mockProjects),
  getProject: jest.fn().mockImplementation((id) => {
    const p = mockProjects.find((x) => x.id === id);
    if (!p) throw new Error(`Projet "${id}" introuvable`);
    return Promise.resolve(p);
  }),
  addProject: jest.fn().mockResolvedValue(mockProjects[0]),
  updateProject: jest.fn().mockResolvedValue(mockProjects[0]),
  deleteProject: jest.fn().mockResolvedValue(mockProjects[0]),
  deployProject: jest.fn().mockResolvedValue('d-test-abc'),
  createDeploymentRecord: jest.fn().mockResolvedValue('d-test-abc'),
  runDeployment: jest.fn().mockResolvedValue(),
  deleteProjectFiles: jest.fn().mockResolvedValue(),
  syncProjectStatus: jest.fn().mockResolvedValue('running'),
  readEnvFile: jest.fn().mockResolvedValue('KEY=value'),
  writeEnvFile: jest.fn().mockResolvedValue(),
  readEnvExample: jest.fn().mockResolvedValue('KEY='),
}));

jest.unstable_mockModule('./services/compose.js', () => ({
  getAllServiceNames: jest.fn().mockResolvedValue(['lucky7']),
  composeFullRestart: jest.fn().mockResolvedValue({ services: ['lucky7'], network: 'lucky7-net', connections: [] }),
  ensureInfraInclude: jest.fn().mockResolvedValue(),
  composeUp: jest.fn().mockResolvedValue(),
}));

jest.unstable_mockModule('./services/metrics.js', () => ({
  getProjectMetrics: jest.fn().mockResolvedValue([
    { name: 'lucky7', cpu_percent: 1.2, mem_usage: 50000, mem_limit: 2000000, mem_percent: 2.5 },
  ]),
}));

jest.unstable_mockModule('./services/build.js', () => ({
  readBuildLog: jest.fn().mockResolvedValue('build log content'),
  subscribeBuildSession: jest.fn().mockReturnValue(null),
  isBuildActive: jest.fn().mockReturnValue(false),
}));

const { default: app } = await import('./server.js');
const { default: request } = await import('supertest');

const CREDENTIALS = { username: 'admin', password: 'testpass' };

describe('Auth', () => {
  it('refuse sans session', async () => {
    const res = await request(app).get('/api/status');
    expect(res.statusCode).toBe(401);
  });

  it('refuse avec mauvais identifiants', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'admin', password: 'wrong' });
    expect(res.statusCode).toBe(401);
  });

  it('accepte avec les bons identifiants', async () => {
    const res = await request(app).post('/auth/login').send(CREDENTIALS);
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /api/status', () => {
  let agent;

  beforeEach(async () => {
    agent = request.agent(app);
    await agent.post('/auth/login').send(CREDENTIALS);
  });

  it('répond 200 avec la structure attendue', async () => {
    const res = await agent.get('/api/status');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('containers');
    expect(res.body).toHaveProperty('websites');
    expect(res.body).toHaveProperty('globalStatus');
  });

  it('globalStatus est OK si tous les containers tournent', async () => {
    const res = await agent.get('/api/status');
    expect(res.body.globalStatus).toBe('OK');
  });
});

describe('GET /api/projects', () => {
  let agent;

  beforeEach(async () => {
    agent = request.agent(app);
    await agent.post('/auth/login').send(CREDENTIALS);
  });

  it('retourne la liste des projets', async () => {
    const res = await agent.get('/api/projects');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toHaveProperty('id');
  });

  it('retourne un projet par id', async () => {
    const res = await agent.get('/api/projects/lucky7');
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe('lucky7');
  });

  it('retourne 404 pour un projet inexistant', async () => {
    const res = await agent.get('/api/projects/does-not-exist');
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/projects/:id/deployments', () => {
  let agent;

  beforeEach(async () => {
    agent = request.agent(app);
    await agent.post('/auth/login').send(CREDENTIALS);
  });

  it('retourne la liste des déploiements', async () => {
    const res = await agent.get('/api/projects/lucky7/deployments');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
