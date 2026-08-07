const { callMockWorld } = require('../../adapters/mockWorldClient');
const config = require('../../config/env');

const PATH_BY_ACTION = {
  refund: (orderId) => `/orders/${orderId}/refund`,
  replacement: (orderId) => `/orders/${orderId}/replacement`,
};

/**
 * order_action: SENSITIVE side-effect node. `requires_approval: true` in the
 * catalog. This module does NOT check for an approval record - that gate is
 * enforced one layer up, in engine/executor.js, BEFORE this function is ever
 * called. Keeping the check out-of-band (engine-level, DB-backed) means no
 * amount of prompt injection in trigger data or AI node output can talk the
 * engine into skipping it: the gate isn't a instruction the model can argue
 * with, it's a row that either exists or doesn't.
 */
async function execute({ params, idempotencyKey, timeoutMs }) {
  const { action, order_id: orderId, amount_usd: amountUsd } = params;
  const pathFn = PATH_BY_ACTION[action];
  if (!pathFn) throw new Error(`Unknown order_action action '${action}'`);

  const body = action === 'refund' ? { amount_usd: amountUsd } : {};

  const { body: respBody } = await callMockWorld({
    path: pathFn(orderId),
    body,
    idempotencyKey,
    timeoutMs: timeoutMs || config.defaultTimeoutMs,
  });

  return {
    output: {
      status: respBody.status ?? 'ok',
      reference_id: respBody.reference_id ?? respBody.id ?? null,
    },
  };
}

module.exports = { execute };
