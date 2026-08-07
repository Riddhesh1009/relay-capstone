/**
 * condition: compares resolved `left`/`right` per `op`, returns { result: boolean }.
 * The executor (engine/executor.js) uses node.on_true/on_false + this result to
 * pick the next node - this module has no knowledge of graph structure.
 */
function isNumeric(v) {
  return v !== '' && v !== null && v !== undefined && !isNaN(Number(v));
}

async function execute({ params }) {
  const { left, op, right } = params;

  let result;
  const bothNumeric = isNumeric(left) && isNumeric(right);

  switch (op) {
    case 'equals':
      result = bothNumeric ? Number(left) === Number(right) : String(left) === String(right);
      break;
    case 'not_equals':
      result = bothNumeric ? Number(left) !== Number(right) : String(left) !== String(right);
      break;
    case 'greater_than':
      if (!bothNumeric) throw new Error(`greater_than requires numeric operands, got '${left}', '${right}'`);
      result = Number(left) > Number(right);
      break;
    case 'less_than':
      if (!bothNumeric) throw new Error(`less_than requires numeric operands, got '${left}', '${right}'`);
      result = Number(left) < Number(right);
      break;
    case 'contains':
      result = String(left).includes(String(right));
      break;
    default:
      throw new Error(`Unknown condition op '${op}'`);
  }

  return { output: { result } };
}

module.exports = { execute };
