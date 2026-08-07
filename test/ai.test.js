const { test } = require('node:test');
const assert = require('node:assert');
const aiNode = require('../src/engine/nodes/ai');
const { FakeAiProvider } = require('../src/adapters/aiProvider');

const schema = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: ['refund_request', 'complaint', 'question'] },
    priority: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['category', 'priority'],
  additionalProperties: false,
};

test('accepts valid JSON on the first attempt', async () => {
  const provider = new FakeAiProvider([JSON.stringify({ category: 'complaint', priority: 'low' })]);
  const { output, tokensPrompt } = await aiNode.execute({
    params: { prompt: 'classify this', output_schema: schema },
    provider,
  });
  assert.deepEqual(output, { category: 'complaint', priority: 'low' });
  assert.equal(provider.calls.length, 1);
});

test('retries once on invalid output, then succeeds', async () => {
  const provider = new FakeAiProvider([
    'not json at all',
    JSON.stringify({ category: 'question', priority: 'medium' }),
  ]);
  const { output } = await aiNode.execute({
    params: { prompt: 'classify this', output_schema: schema },
    provider,
  });
  assert.deepEqual(output, { category: 'question', priority: 'medium' });
  assert.equal(provider.calls.length, 2);
  // the retry prompt must include the validation error so the model can self-correct
  assert.match(provider.calls[1], /previous response was invalid/i);
});

test('fails the step after retry still produces invalid output', async () => {
  const provider = new FakeAiProvider(['nope', 'still nope']);
  await assert.rejects(
    () => aiNode.execute({ params: { prompt: 'classify this', output_schema: schema }, provider }),
    /failed schema validation after retry/
  );
  assert.equal(provider.calls.length, 2); // exactly one retry, not unbounded
});

test('rejects output missing a required field', async () => {
  const provider = new FakeAiProvider([
    JSON.stringify({ category: 'complaint' }), // missing priority
    JSON.stringify({ category: 'complaint' }), // still missing after "retry"
  ]);
  await assert.rejects(
    () => aiNode.execute({ params: { prompt: 'classify this', output_schema: schema }, provider }),
    /failed schema validation/
  );
});

test('rejects output with an enum value outside the schema', async () => {
  const provider = new FakeAiProvider([
    JSON.stringify({ category: 'sabotage', priority: 'high' }),
    JSON.stringify({ category: 'sabotage', priority: 'high' }),
  ]);
  await assert.rejects(
    () => aiNode.execute({ params: { prompt: 'classify this', output_schema: schema }, provider }),
    /failed schema validation/
  );
});

test('strips markdown code fences if the model wraps its JSON', async () => {
  const provider = new FakeAiProvider(['```json\n' + JSON.stringify({ category: 'question', priority: 'low' }) + '\n```']);
  const { output } = await aiNode.execute({
    params: { prompt: 'classify this', output_schema: schema },
    provider,
  });
  assert.deepEqual(output, { category: 'question', priority: 'low' });
});
