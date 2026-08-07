const { v4: uuidv4 } = require('uuid');
const { getCatalogEntry } = require('../lib/catalogValidator');
const { resolveValue, buildContext } = require('../lib/template');
const { getProvider } = require('../adapters/aiProvider');

const nodeExecutors = {
  http_request: require('./nodes/httpRequest'),
  condition: require('./nodes/condition'),
  delay: require('./nodes/delay'),
  notify: require('./nodes/notify'),
  ai: require('./nodes/ai'),
  approval: require('./nodes/approval'),
  order_action: require('./nodes/orderAction'),
};

const MAX_ATTEMPTS = 3; // transient-failure retries (timeouts, network) per step
const RETRY_BACKOFF_MS = [200, 800]; // between attempts 1->2 and 2->3

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Processes exactly one node for a run, inside a DB transaction so the
 * "persist, then acknowledge" rule holds: nothing about run progress is
 * considered true until this transaction commits.
 *
 * Returns { done: true } if the run reached a terminal/waiting state and the
 * queue job should not be immediately re-run, or { done: false, rescheduleAt }
 * if the worker should requeue the job (immediately, or at a future time for
 * `delay` nodes).
 */
async function processStep(client, run, provider) {
  const definition = run.definition_snapshot;
  const nodeId = run.current_node_id || definition.entry;
  const node = definition.nodes.find((n) => n.id === nodeId);

  if (!node) {
    await failRun(client, run, `Run references nonexistent node '${nodeId}'`);
    return { done: true };
  }

  // --- Step cap: checked BEFORE executing anything, per DATA_MODEL.md ---
  const maxSteps = definition.limits?.max_steps ?? Infinity;
  if (run.steps_executed >= maxSteps) {
    await failRun(client, run, `Run exceeded max_steps cap (${maxSteps})`, 'step_cap_exceeded');
    return { done: true };
  }

  const catalogEntry = getCatalogEntry(node.type);

  // --- Approval gate: engine-level, data-driven, cannot be talked around ---
  if (catalogEntry?.requires_approval) {
    const { rows } = await client.query(
      `SELECT 1 FROM approvals WHERE run_id = $1 AND status = 'approved' LIMIT 1`,
      [run.id]
    );
    if (rows.length === 0) {
      await failRun(
        client,
        run,
        `Node '${node.id}' (${node.type}) requires an approved approval earlier in this run, but none exists`,
        'approval_required'
      );
      return { done: true };
    }
  }

  // --- Build template context from prior succeeded steps in this run ---
  const stepsById = await loadLatestSucceededStepsById(client, run.id);
  const context = buildContext(run, stepsById);
  const resolvedParams = resolveValue(node.params || {}, context);

  const idempotencyKey = catalogEntry?.side_effect ? `${run.id}:${node.id}` : null;
  const sequence = run.steps_executed + 1;

  const stepId = uuidv4();
  const startedAt = new Date();
  await client.query(
    `INSERT INTO steps (id, run_id, node_id, node_type, sequence, status, attempt, resolved_input, idempotency_key, started_at)
     VALUES ($1,$2,$3,$4,$5,'running',1,$6,$7,$8)`,
    [stepId, run.id, node.id, node.type, sequence, JSON.stringify(resolvedParams), idempotencyKey, startedAt]
  );

  const executorFn = nodeExecutors[node.type]?.execute;
  if (!executorFn) {
    await markStepFailed(client, stepId, `No executor registered for node type '${node.type}'`);
    await failRun(client, run, `No executor registered for node type '${node.type}'`);
    return { done: true };
  }

  let result;
  let attempt = 1;
  let lastError;
  while (attempt <= MAX_ATTEMPTS) {
    try {
      result = await executorFn({
        params: resolvedParams,
        idempotencyKey,
        timeoutMs: definition.limits?.timeout_seconds ? definition.limits.timeout_seconds * 1000 : undefined,
        provider,
      });
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BACKOFF_MS[attempt - 1] || 800);
      }
      attempt += 1;
    }
  }

  if (lastError) {
    const durationMs = Date.now() - startedAt.getTime();
    await client.query(
      `UPDATE steps SET status='failed', attempt=$2, error=$3, finished_at=now(), duration_ms=$4 WHERE id=$1`,
      [stepId, attempt - 1, JSON.stringify({ message: lastError.message }), durationMs]
    );
    await client.query(`UPDATE runs SET steps_executed = steps_executed + 1 WHERE id = $1`, [run.id]);
    await failRun(client, run, `Node '${node.id}' (${node.type}) failed: ${lastError.message}`);
    return { done: true };
  }

  const durationMs = Date.now() - startedAt.getTime();
  const tokensPrompt = result.tokensPrompt || 0;
  const tokensCompletion = result.tokensCompletion || 0;

  // --- approval node: pause the run, create the Approval row ---
  if (result.waitingApproval) {
    await client.query(
      `UPDATE steps SET status='waiting', output=$2, finished_at=now(), duration_ms=$3 WHERE id=$1`,
      [stepId, JSON.stringify(result.output || {}), durationMs]
    );
    const approvalId = `apr_${uuidv4().slice(0, 8)}`;
    await client.query(
      `INSERT INTO approvals (id, run_id, node_id, step_id, message, status)
       VALUES ($1,$2,$3,$4,$5,'pending')`,
      [approvalId, run.id, node.id, stepId, result.message || null]
    );
    await client.query(
      `UPDATE runs SET status='waiting_approval', steps_executed = steps_executed + 1,
              current_node_id = $2 WHERE id = $1`,
      [run.id, node.id]
    );
    return { done: true }; // worker stops polling this run until approve/reject re-enqueues it
  }

  await client.query(
    `UPDATE steps SET status='succeeded', output=$2, tokens_prompt=$3, tokens_completion=$4,
            finished_at=now(), duration_ms=$5 WHERE id=$1`,
    [stepId, JSON.stringify(result.output ?? {}), tokensPrompt, tokensCompletion, durationMs]
  );

  // --- figure out the next node ---
  let nextNodeId;
  if (node.type === 'condition') {
    nextNodeId = result.output.result ? node.on_true : node.on_false;
  } else {
    nextNodeId = node.next ?? null;
  }

  const newTokensUsed = tokensPrompt + tokensCompletion;

  if (nextNodeId === null || nextNodeId === undefined) {
    await client.query(
      `UPDATE runs SET status='succeeded', steps_executed = steps_executed + 1,
              ai_tokens_used = ai_tokens_used + $2, current_node_id = NULL, finished_at = now()
       WHERE id = $1`,
      [run.id, newTokensUsed]
    );
    return { done: true };
  }

  await client.query(
    `UPDATE runs SET steps_executed = steps_executed + 1, ai_tokens_used = ai_tokens_used + $2,
            current_node_id = $3, status = 'running' WHERE id = $1`,
    [run.id, newTokensUsed, nextNodeId]
  );

  if (result.rescheduleAt) {
    return { done: false, rescheduleAt: result.rescheduleAt };
  }
  return { done: false, rescheduleAt: new Date() };
}

async function loadLatestSucceededStepsById(client, runId) {
  const { rows } = await client.query(
    `SELECT DISTINCT ON (node_id) node_id, output, tokens_prompt, tokens_completion
     FROM steps
     WHERE run_id = $1 AND status = 'succeeded'
     ORDER BY node_id, sequence DESC`,
    [runId]
  );
  const map = {};
  for (const row of rows) {
    map[row.node_id] = { output: row.output };
  }
  return map;
}

async function markStepFailed(client, stepId, message) {
  await client.query(
    `UPDATE steps SET status='failed', error=$2, finished_at=now() WHERE id=$1`,
    [stepId, JSON.stringify({ message })]
  );
}

async function failRun(client, run, message, reasonCode) {
  await client.query(
    `UPDATE runs SET status='failed', error=$2, finished_at=now() WHERE id=$1`,
    [run.id, JSON.stringify({ message, code: reasonCode || 'node_failed' })]
  );
}

module.exports = { processStep };
