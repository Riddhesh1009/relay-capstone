const { test } = require('node:test');
const assert = require('node:assert');
const { resolveValue, buildContext } = require('../src/lib/template');

test('resolves a whole-string placeholder to native type', () => {
  const ctx = { trigger: { body: { amount_usd: 250 } } };
  assert.equal(resolveValue('{{trigger.body.amount_usd}}', ctx), 250);
});

test('interpolates a placeholder embedded in text as a string', () => {
  const ctx = { trigger: { body: { name: 'Maya' } } };
  assert.equal(resolveValue('Hello {{trigger.body.name}}!', ctx), 'Hello Maya!');
});

test('resolves nested object params recursively', () => {
  const ctx = { trigger: { body: { order_id: 'ord_1' } } };
  const resolved = resolveValue({ body: { order_id: '{{trigger.body.order_id}}' } }, ctx);
  assert.deepEqual(resolved, { body: { order_id: 'ord_1' } });
});

test('resolves {{nodes.X.output.Y}} - the shape seed workflows actually use', () => {
  const run = { input: {} };
  const stepsById = { classify: { output: { category: 'refund_request' } } };
  const ctx = buildContext(run, stepsById);
  assert.equal(resolveValue('{{nodes.classify.output.category}}', ctx), 'refund_request');
});

test('unresolvable path in whole-value case resolves to null, not a crash', () => {
  const ctx = { trigger: { body: {} } };
  assert.equal(resolveValue('{{trigger.body.missing}}', ctx), null);
});
