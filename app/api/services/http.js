const TIMEOUT_MS = 5000;

async function checkWebsite(baseUrl, path) {
  const url = `${baseUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    return { name: path.replace(/\//g, ''), url: path, httpCode: res.status, status: res.status < 500 ? 'OK' : 'DOWN' };
  } catch {
    return { name: path.replace(/\//g, ''), url: path, httpCode: null, status: 'DOWN' };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkWebsites(baseUrl, apps) {
  return Promise.all(apps.map(({ path }) => checkWebsite(baseUrl, path)));
}
