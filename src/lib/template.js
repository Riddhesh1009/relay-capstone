/**
 * Resolves {{path.to.value}} placeholders against a context object.
 * Context shape: { trigger: { body: {...} }, steps: { node_id: { output: {...} } } }
 *
 * - A param string that is ENTIRELY one placeholder (e.g. "{{trigger.body.amount_usd}}")
 *   resolves to the underlying value's native type (number stays a number, object stays object).
 * - A param string with a placeholder embedded in other text (e.g. "Hi {{trigger.body.name}}")
 *   is resolved to a string via interpolation.
 * - Objects/arrays are walked recursively.
 * - Unresolvable paths resolve to undefined and are left as an empty string in interpolation,
 *   but throw when the whole-value case can't find the referenced path (fail loud, not silent).
 */

const PLACEHOLDER_RE = /\{\{\s*([\w.]+)\s*\}\}/g;
const WHOLE_PLACEHOLDER_RE = /^\{\{\s*([\w.]+)\s*\}\}$/;

function getPath(obj, dottedPath) {
  return dottedPath.split('.').reduce((acc, key) => {
    if (acc === undefined || acc === null) return undefined;
    return acc[key];
  }, obj);
}

function resolveValue(value, context) {
  if (typeof value === 'string') {
    return resolveString(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, context));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveValue(v, context);
    }
    return out;
  }
  return value;
}

function resolveString(str, context) {
  const wholeMatch = str.match(WHOLE_PLACEHOLDER_RE);
  if (wholeMatch) {
    const resolved = getPath(context, wholeMatch[1]);
    return resolved === undefined ? null : resolved;
  }
  return str.replace(PLACEHOLDER_RE, (_, path) => {
    const resolved = getPath(context, path);
    if (resolved === undefined || resolved === null) return '';
    if (typeof resolved === 'object') return JSON.stringify(resolved);
    return String(resolved);
  });
}

/**
 * Builds the resolution context for a run at the point a given node is about to execute.
 * `stepsById` is a map of node_id -> most recent succeeded step (output, tokens, etc).
 *
 * NOTE: the seed workflow definitions reference prior node output as
 * {{nodes.<node_id>.output.<field>}} (see data/seed_workflows.json,
 * e.g. wf_support_triage's `route` node), so the context key is `nodes`,
 * not `steps`.
 */
function buildContext(run, stepsById) {
  const nodes = {};
  for (const [nodeId, step] of Object.entries(stepsById)) {
    nodes[nodeId] = { output: step.output || {} };
  }
  return {
    trigger: { body: run.input || {} },
    nodes,
  };
}

module.exports = { resolveValue, resolveString, buildContext, getPath };
