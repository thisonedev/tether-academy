// Minimal SCORM Cloud v2 API client. Auth is HTTP Basic (App ID / Secret
// Key, see .env, gitignored). Endpoints from https://cloud.scorm.com/docs/swagger.json.

const BASE_URL = 'https://cloud.scorm.com/api/v2';

function authHeader(appId, secretKey) {
  return `Basic ${Buffer.from(`${appId}:${secretKey}`).toString('base64')}`;
}

async function apiFetch(appId, secretKey, path, init = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: authHeader(appId, secretKey) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}

export async function uploadAndImportCourse(creds, { courseId, zipBuffer, zipFileName }) {
  const form = new FormData();
  form.append('file', new Blob([zipBuffer], { type: 'application/zip' }), zipFileName);
  const query = new URLSearchParams({ courseId, mayCreateNewVersion: 'true' });
  const result = await apiFetch(creds.appId, creds.secretKey, `/courses/importJobs/upload?${query}`, {
    method: 'POST',
    body: form,
  });
  return result.importJobId ?? result.result ?? result;
}

export async function pollImportJob(creds, importJobId, { intervalMs = 2000, timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await apiFetch(creds.appId, creds.secretKey, `/courses/importJobs/${importJobId}`);
    if (status.status !== 'RUNNING') return status;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Import job ${importJobId} did not finish within ${timeoutMs}ms`);
}

export async function createRegistration(creds, { courseId, registrationId, learner }) {
  return apiFetch(creds.appId, creds.secretKey, '/registrations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ courseId, registrationId, learner }),
  });
}

export async function buildLaunchLink(creds, registrationId, { redirectOnExitUrl = 'blank' } = {}) {
  const result = await apiFetch(creds.appId, creds.secretKey, `/registrations/${registrationId}/launchLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirectOnExitUrl, tracking: true }),
  });
  return result.launchLink;
}

export async function getRegistrationProgress(creds, registrationId) {
  return apiFetch(creds.appId, creds.secretKey, `/registrations/${registrationId}`);
}

export function loadCredsFromEnv() {
  const appId = process.env.SCORM_CLOUD_APP_ID;
  const secretKey = process.env.SCORM_CLOUD_SECRET_KEY;
  if (!appId || !secretKey) {
    throw new Error('SCORM_CLOUD_APP_ID / SCORM_CLOUD_SECRET_KEY not set (see test-lms/.env)');
  }
  return { appId, secretKey };
}
