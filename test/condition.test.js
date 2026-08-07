const { test } = require('node:test');
const assert = require('node:assert');
const condition = require('../src/engine/nodes/condition');

test('greater_than compares numerically', async () => {
  const { output } = await condition.execute({ params: { left: '250', op: 'greater_than', right: '100' } });
  assert.equal(output.result, true);
});

test('greater_than on non-numeric operands throws (fails the step, does not silently mis-route)', async () => {
  await assert.rejects(
    () => condition.execute({ params: { left: 'abc', op: 'greater_than', right: '100' } }),
    /requires numeric operands/
  );
});

test('equals falls back to string comparison for non-numeric operands', async () => {
  const { output } = await condition.execute({
    params: { left: 'refund_request', op: 'equals', right: 'refund_request' },
  });
  assert.equal(output.result, true);
});

test('contains substring match', async () => {
  const { output } = await condition.execute({ params: { left: 'hello world', op: 'contains', right: 'world' } });
  assert.equal(output.result, true);
});
