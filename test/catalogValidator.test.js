const { test } = require('node:test');
const assert = require('node:assert');
const { validateDefinition } = require('../src/lib/catalogValidator');

function baseDef(overrides = {}) {
  return {
    id: 'wf_test',
    name: 'Test',
    trigger: { type: 'manual' },
    entry: 'n1',
    limits: { max_steps: 10 },
    nodes: [{ id: 'n1', type: 'notify', params: { channel: 'chat', to: '#x', message: 'hi' }, next: null }],
    ...overrides,
  };
}

test('accepts a valid minimal definition', () => {
  const errors = validateDefinition(baseDef());
  assert.deepEqual(errors, []);
});

test('rejects unknown node type', () => {
  const def = baseDef({ nodes: [{ id: 'n1', type: 'teleport', params: {}, next: null }] });
  const errors = validateDefinition(def);
  assert.ok(errors.some((e) => e.includes("unknown type 'teleport'")));
});

test('rejects missing required param', () => {
  const def = baseDef({ nodes: [{ id: 'n1', type: 'notify', params: { channel: 'chat' }, next: null }] });
  const errors = validateDefinition(def);
  assert.ok(errors.some((e) => e.includes("missing required param 'to'") || e.includes("missing required param 'message'")));
});

test('rejects next pointing to nonexistent node', () => {
  const def = baseDef({
    nodes: [{ id: 'n1', type: 'notify', params: { channel: 'chat', to: '#x', message: 'hi' }, next: 'ghost' }],
  });
  const errors = validateDefinition(def);
  assert.ok(errors.some((e) => e.includes("points to nonexistent node 'ghost'")));
});

test('rejects on_true/on_false pointing to nonexistent nodes', () => {
  const def = baseDef({
    entry: 'c1',
    nodes: [
      { id: 'c1', type: 'condition', params: { left: '1', op: 'equals', right: '1' }, on_true: 'missing', on_false: null },
    ],
  });
  const errors = validateDefinition(def);
  assert.ok(errors.some((e) => e.includes("branch 'on_true' points to nonexistent node 'missing'")));
});

test('rejects entry pointing to nonexistent node', () => {
  const def = baseDef({ entry: 'ghost' });
  const errors = validateDefinition(def);
  assert.ok(errors.some((e) => e.includes("'entry' points to nonexistent node 'ghost'")));
});

test('allows backward jumps (loops)', () => {
  const def = baseDef({
    entry: 'a',
    nodes: [
      { id: 'a', type: 'notify', params: { channel: 'chat', to: '#x', message: 'hi' }, next: 'b' },
      { id: 'b', type: 'notify', params: { channel: 'chat', to: '#x', message: 'hi' }, next: 'a' }, // loop back
    ],
  });
  const errors = validateDefinition(def);
  assert.deepEqual(errors, []);
});
