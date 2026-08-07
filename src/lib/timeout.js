/**
 * Races a promise against a timeout so a hung dependency fails the STEP,
 * never hangs the engine loop. Per API_CONTRACT.md: "Timeouts: every call
 * to the mock world or a model provider has a timeout."
 */
async function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetch wrapper that actually aborts the underlying request on timeout
 * (plain Promise.race leaves the socket open). Use this for all outbound
 * HTTP calls (mock world, model provider).
 */
async function fetchWithTimeout(url, options = {}, ms = 8000, label = 'request') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`${label} timed out after ${ms}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { withTimeout, fetchWithTimeout };
