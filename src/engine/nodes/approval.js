/**
 * approval: doesn't call anything external. Just tells the executor
 * "pause here" - the executor creates the Approval row and flips the
 * run to waiting_approval. Resolution (approve/reject) happens via the
 * /approvals/:id/approve|reject routes, which re-enqueue the run.
 */
async function execute({ params }) {
  return { output: {}, waitingApproval: true, message: params.message };
}

module.exports = { execute };
