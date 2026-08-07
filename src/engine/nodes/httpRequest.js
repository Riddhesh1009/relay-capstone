const { fetchWithTimeout } = require('../../lib/timeout');
const config = require('../../config/env');

/**
 * http_request: generic outbound call. Non-GET methods are side effects
 * (per node_catalog.json) so they carry the run's Idempotency-Key.
 */
async function execute({ params, idempotencyKey, timeoutMs }) {
  const { method, url, headers = {}, body } = params;

  const finalHeaders = { 'Content-Type': 'application/json', ...headers };
  if (method !== 'GET' && idempotencyKey) {
    finalHeaders['Idempotency-Key'] = idempotencyKey;
  }

  const res = await fetchWithTimeout(
    url,
    {
      method,
      headers: finalHeaders,
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    },
    timeoutMs || config.defaultTimeoutMs,
    `http_request ${method} ${url}`
  );

  const text = await res.text();
  let parsedBody;
  try {
    parsedBody = text ? JSON.parse(text) : {};
  } catch {
    parsedBody = text;
  }

  return { output: { status: res.status, body: parsedBody } };
}

module.exports = { execute };
