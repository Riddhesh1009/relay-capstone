const config = require('../config/env');
const { fetchWithTimeout } = require('../lib/timeout');

/**
 * All side-effect calls to the mock world go through here so the
 * Idempotency-Key header is never forgotten. Per API_CONTRACT.md:
 * key = `${run_id}:${node_id}` - stable across retries and resumes,
 * NEVER includes the attempt number.
 */
async function callMockWorld({ method = 'POST', path, body, idempotencyKey, timeoutMs }) {
  const headers = { 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const res = await fetchWithTimeout(
    `${config.mockWorldUrl}${path}`,
    {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    timeoutMs || config.defaultTimeoutMs,
    `mock world ${path}`
  );

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(`Mock world ${path} returned ${res.status}: ${text}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return { status: res.status, body: json, replayed: res.headers.get('x-mockworld-replayed') === 'true' };
}

module.exports = { callMockWorld };
