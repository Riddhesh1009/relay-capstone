const fs = require('fs');
const path = require('path');

const CATALOG_PATH = path.join(__dirname, '..', '..', 'data', 'node_catalog.json');
const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));

const nodeTypesByName = new Map(catalog.nodes.map((n) => [n.type, n]));
const triggerTypesByName = new Map(catalog.triggers.map((t) => [t.type, t]));

/**
 * Validates a workflow definition (the seed-file shape: id, name, trigger, entry, limits, nodes[]).
 * Returns an array of human-readable error strings; empty array means valid.
 *
 * Rules enforced (per docs/API_CONTRACT.md "Create and Publish a Workflow"):
 *  - node `type` must be in the catalog
 *  - required params (per catalog) must be present
 *  - `next` / `on_true` / `on_false` must point to an existing node
 *  - `entry` must point to an existing node
 *  - backward jumps (loops) are legal and NOT rejected
 */
function validateDefinition(def) {
  const errors = [];

  if (!def || typeof def !== 'object') {
    return ['Definition must be an object'];
  }
  if (!def.id) errors.push("Missing required field 'id'");
  if (!def.name) errors.push("Missing required field 'name'");
  if (!def.entry) errors.push("Missing required field 'entry'");
  if (!Array.isArray(def.nodes) || def.nodes.length === 0) {
    errors.push("Definition must have a non-empty 'nodes' array");
    return errors; // nothing more we can check
  }

  // Trigger validation
  if (!def.trigger || !def.trigger.type) {
    errors.push("Missing required field 'trigger.type'");
  } else if (!triggerTypesByName.has(def.trigger.type)) {
    errors.push(`Unknown trigger type '${def.trigger.type}'`);
  } else if (def.trigger.type === 'webhook' && !def.trigger.secret) {
    errors.push("Webhook trigger requires 'trigger.secret'");
  }

  const nodeIds = new Set(def.nodes.map((n) => n.id));

  // entry must point to an existing node
  if (def.entry && !nodeIds.has(def.entry)) {
    errors.push(`'entry' points to nonexistent node '${def.entry}'`);
  }

  for (const node of def.nodes) {
    if (!node.id) {
      errors.push(`Node missing 'id': ${JSON.stringify(node)}`);
      continue;
    }
    const catalogEntry = nodeTypesByName.get(node.type);
    if (!catalogEntry) {
      errors.push(`Node '${node.id}' has unknown type '${node.type}'`);
      continue;
    }

    // Required params per catalog
    const params = node.params || {};
    for (const [paramName, paramSpec] of Object.entries(catalogEntry.params || {})) {
      if (paramSpec.required && !(paramName in params)) {
        errors.push(`Node '${node.id}' (${node.type}) missing required param '${paramName}'`);
      }
      if (paramSpec.enum && paramName in params && !isTemplated(params[paramName])) {
        if (!paramSpec.enum.includes(params[paramName])) {
          errors.push(
            `Node '${node.id}' param '${paramName}' must be one of [${paramSpec.enum.join(', ')}], got '${params[paramName]}'`
          );
        }
      }
    }

    // Edge validation: next / on_true / on_false must point to existing nodes.
    // Backward jumps ARE allowed - we only check existence, not direction.
    if (node.type === 'condition') {
      for (const branch of ['on_true', 'on_false']) {
        const target = node[branch];
        if (target !== null && target !== undefined && !nodeIds.has(target)) {
          errors.push(`Node '${node.id}' branch '${branch}' points to nonexistent node '${target}'`);
        }
      }
    } else if ('next' in node && node.next !== null && node.next !== undefined) {
      if (!nodeIds.has(node.next)) {
        errors.push(`Node '${node.id}' 'next' points to nonexistent node '${node.next}'`);
      }
    }
  }

  return errors;
}

function isTemplated(value) {
  return typeof value === 'string' && value.includes('{{');
}

function getCatalogEntry(nodeType) {
  return nodeTypesByName.get(nodeType);
}

module.exports = { validateDefinition, getCatalogEntry, catalog };
