const tokenInput = document.getElementById('token');
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenInput.value}`,
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error?.message || res.statusText), { body });
  return body;
};

// --- view switching ---
document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`view-${btn.dataset.view}`).classList.add('active');
  });
});

function statusBadge(status) {
  return `<span class="status status-${status}">${status}</span>`;
}

// --- workflows ---
async function loadWorkflows() {
  const { workflows } = await api('/workflows');
  const tbody = document.querySelector('#workflows-table tbody');
  tbody.innerHTML = workflows
    .map(
      (w) => `<tr>
        <td>${w.id}</td>
        <td>${w.name}</td>
        <td>${statusBadge(w.status)}</td>
        <td>
          ${w.status === 'draft' ? `<button data-publish="${w.id}">Publish</button>` : ''}
          <button data-trigger="${w.id}">Trigger</button>
        </td>
      </tr>`
    )
    .join('');

  tbody.querySelectorAll('[data-publish]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        await api(`/workflows/${btn.dataset.publish}/publish`, { method: 'POST' });
        loadWorkflows();
      } catch (e) {
        alert(`Publish failed: ${e.message}\n${JSON.stringify(e.body?.error?.details || [])}`);
      }
    })
  );
  tbody.querySelectorAll('[data-trigger]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const input = prompt('Trigger input JSON (object):', '{}');
      if (input === null) return;
      try {
        const parsed = JSON.parse(input);
        const result = await api(`/workflows/${btn.dataset.trigger}/trigger`, {
          method: 'POST',
          body: JSON.stringify({ input: parsed }),
        });
        alert(`Run started: ${result.run_id}`);
        document.querySelector('nav button[data-view="runs"]').click();
        loadRuns();
      } catch (e) {
        alert(`Trigger failed: ${e.message}`);
      }
    })
  );
}

document.getElementById('refresh-workflows').addEventListener('click', loadWorkflows);

document.getElementById('new-workflow').addEventListener('click', () => {
  document.getElementById('new-workflow-json').value = JSON.stringify(
    {
      id: 'wf_example',
      name: 'Example',
      trigger: { type: 'manual' },
      entry: 'n1',
      limits: { max_steps: 20 },
      nodes: [{ id: 'n1', type: 'notify', params: { channel: 'email', to: 'a@example.com', message: 'hi' }, next: null }],
    },
    null,
    2
  );
  document.getElementById('new-workflow-dialog').showModal();
});
document.getElementById('cancel-new-workflow').addEventListener('click', () =>
  document.getElementById('new-workflow-dialog').close()
);
document.getElementById('submit-new-workflow').addEventListener('click', async () => {
  try {
    const def = JSON.parse(document.getElementById('new-workflow-json').value);
    await api('/workflows', { method: 'POST', body: JSON.stringify(def) });
    document.getElementById('new-workflow-dialog').close();
    loadWorkflows();
  } catch (e) {
    alert(`Create failed: ${e.message}`);
  }
});

// --- runs ---
async function loadRuns() {
  const { runs } = await api('/runs');
  const tbody = document.querySelector('#runs-table tbody');
  tbody.innerHTML = runs
    .map(
      (r) => `<tr>
        <td><a href="#" data-run="${r.id}">${r.id}</a></td>
        <td>${r.workflow_id}</td>
        <td>${statusBadge(r.status)}</td>
        <td>${r.steps_executed}</td>
        <td>${r.started_at ? new Date(r.started_at).toLocaleTimeString() : '-'}</td>
      </tr>`
    )
    .join('');
  tbody.querySelectorAll('[data-run]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      showRunDetail(a.dataset.run);
    })
  );
}

async function showRunDetail(runId) {
  const run = await api(`/runs/${runId}`);
  const el = document.getElementById('run-detail');
  el.innerHTML = `
    <h3>${run.run_id} ${statusBadge(run.status)}</h3>
    <p>Workflow: ${run.workflow_id} · Steps: ${run.steps_executed} · Tokens: ${run.ai_tokens_used}</p>
    ${run.error ? `<pre>${JSON.stringify(run.error, null, 2)}</pre>` : ''}
    <div>${run.steps
      .map(
        (s) => `<div class="step-row">
          <strong>${s.node_id}</strong> (${s.type}) ${statusBadge(s.status)}
          ${s.approval_id ? ` · approval ${s.approval_id} (${s.approval_status})` : ''}
          <pre>in: ${JSON.stringify(s.input)}\nout: ${JSON.stringify(s.output)}${
          s.error ? `\nerror: ${JSON.stringify(s.error)}` : ''
        }</pre>
        </div>`
      )
      .join('')}</div>
  `;
}

document.getElementById('refresh-runs').addEventListener('click', loadRuns);

// --- approvals ---
async function loadApprovals() {
  const approvals = await api('/approvals?status=pending');
  const tbody = document.querySelector('#approvals-table tbody');
  tbody.innerHTML = approvals
    .map(
      (a) => `<tr>
        <td>${a.id}</td>
        <td>${a.run_id}</td>
        <td>${a.message || ''}</td>
        <td>
          <button data-approve="${a.id}">Approve</button>
          <button data-reject="${a.id}">Reject</button>
        </td>
      </tr>`
    )
    .join('');
  tbody.querySelectorAll('[data-approve]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api(`/approvals/${btn.dataset.approve}/approve`, { method: 'POST' });
      loadApprovals();
    })
  );
  tbody.querySelectorAll('[data-reject]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api(`/approvals/${btn.dataset.reject}/reject`, { method: 'POST' });
      loadApprovals();
    })
  );
}

document.getElementById('refresh-approvals').addEventListener('click', loadApprovals);

// initial load
loadWorkflows();
loadRuns();
loadApprovals();
setInterval(() => {
  if (document.getElementById('view-runs').classList.contains('active')) loadRuns();
  if (document.getElementById('view-approvals').classList.contains('active')) loadApprovals();
}, 5000);
