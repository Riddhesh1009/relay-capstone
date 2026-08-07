const { callMockWorld } = require('../../adapters/mockWorldClient');
const config = require('../../config/env');

const PATH_BY_CHANNEL = {
  email: '/email/send',
  chat: '/chat/message',
};

/**
 * notify: side-effect node (side_effect: true in catalog). Always carries
 * the run's idempotency key so a crash-resume replay is absorbed by the
 * mock world's ledger instead of sending the message twice.
 */
async function execute({ params, idempotencyKey, timeoutMs }) {
  const { channel, to, subject, message } = params;
  const path = PATH_BY_CHANNEL[channel];
  if (!path) throw new Error(`Unknown notify channel '${channel}'`);

  // mock_world.py expects different fields per channel:
  //   /email/send   -> { to, subject?, message }
  //   /chat/message -> { channel, message }   (channel = the "to" param, e.g. "#support")
  const body = channel === 'email' ? { to, subject, message } : { channel: to, message };

  const { body: respBody, replayed } = await callMockWorld({
    path,
    body,
    idempotencyKey,
    timeoutMs: timeoutMs || config.defaultTimeoutMs,
  });

  return {
    output: {
      delivered: respBody.delivered ?? true,
      notification_id: respBody.notification_id ?? respBody.id ?? null,
      replayed: !!replayed,
    },
  };
}

module.exports = { execute };
