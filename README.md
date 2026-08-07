# Relay

An AI workflow orchestrator: define workflows as typed nodes, trigger runs from
webhooks or the API, execute them durably through a Postgres-backed queue and
worker, pause for human approval before sensitive actions, validate AI output
against a JSON schema before anything downstream trusts it, and recover from a
crashed worker without duplicating side effects.

Stack: **Node.js (Express) + PostgreSQL**. No Redis, no message broker - the
durable queue is a Postgres table, claimed with `SELECT ... FOR UPDATE SKIP
LOCKED`. This is deliberate: fewer moving parts, and Postgres transactions
give the "persist, then acknowledge" guarantee for free.

## Setup

### 1. Prerequisites
- Node.js 18+
- PostgreSQL 14+ running locally (or reachable via `DATABASE_URL`)
- Python 3.9+ (only to run the mock world / mock provider / grading scripts)

### 2. Database
```bash
createuser relay --superuser --pwprompt   # password: relay (or edit .env)
createdb relay -O relay
```

### 3. Install & configure
```bash
npm install
cp .env.example .env
# edit .env if your Postgres credentials differ from the defaults
```

### 4. Migrate + seed
```bash
npm run migrate   # creates workflows/runs/steps/approvals/queue_jobs/...
npm run seed       # loads data/seed_workflows.json as four Published workflows
```

### 5. Start the mock world and mock provider
These simulate every external system Relay acts on (email, chat, orders,
refunds, shipments) and a chat-completions-style LLM endpoint. In two
terminals:
```bash
python3 scripts/mock_world.py --port 9210
python3 scripts/mock_provider.py --port 9211
```

### 6. Start the API and the worker
Two more terminals (or `npm run dev` to run both with one command via
`concurrently`):
```bash
npm start           # API on :8080
npm run worker      # durable execution loop
```

### 7. Open the console
`http://localhost:8080` - paste the demo token (`demo-token-123` by default,
pre-filled) and you can list/publish workflows, trigger runs, watch traces,
and approve/reject pending approvals.

### 8. Verify
```bash
python3 scripts/smoke_test.py --url http://localhost:8080 --token demo-token-123
```
See `verification/verification_report.md` for a full run of this, plus the
kill-and-resume drill and the prompt-injection test, executed against this
codebase.

## Architecture

```
                    ┌──────────────┐
  webhook / API ───▶│   Express    │──▶ workflows / runs / approvals (Postgres)
                    │   (src/server)│
                    └──────┬───────┘
                           │ INSERT queue_jobs (run_id, status=pending)
                           ▼
                  ┌────────────────┐
                  │ queue_jobs     │  durable queue: SELECT ... FOR UPDATE SKIP LOCKED
                  │ (Postgres)     │  + a 30s lease so a crashed worker's job is reclaimed
                  └────────┬───────┘
                           │ claim
                           ▼
                  ┌────────────────┐        ┌──────────────────┐
                  │  Worker loop   │──calls─▶│  node executors  │
                  │ (src/engine/   │         │  http_request     │
                  │   worker.js)   │         │  condition        │
                  └────────┬───────┘         │  delay            │
                           │                 │  notify  ─────────┼──▶ mock world
                           │                 │  ai      ─────────┼──▶ AI provider
                           │                 │  approval          │      (adapter)
                           │                 │  order_action ─────┼──▶ mock world
                           ▼                 └──────────────────┘
                  steps table (the trace)
```

Every mutation to `runs` / `steps` / `approvals` / `queue_jobs` for a single
node execution happens inside **one Postgres transaction**
(`src/engine/executor.js` + `src/engine/worker.js`'s `tick()`). Nothing about
run progress is real until that transaction commits - this is the whole basis
for crash recovery (see below).

### Key files
| Path | Responsibility |
|---|---|
| `src/db/migrations/001_init.sql` | Schema: workflows, runs, steps, approvals, queue_jobs, side_effect_ledger |
| `src/lib/catalogValidator.js` | Publish-time validation against `data/node_catalog.json` |
| `src/lib/template.js` | `{{trigger.body.x}}` / `{{nodes.x.output.y}}` resolution |
| `src/engine/executor.js` | Core per-node logic: step cap, approval gate, dispatch, persistence |
| `src/engine/worker.js` | The poll loop: claim → process → requeue/close, with crash-lease reclaim |
| `src/engine/nodes/*.js` | One file per node type, each a pure `execute(ctx) -> result` function |
| `src/adapters/aiProvider.js` | AI provider interface + 3 implementations (heuristic/mock/anthropic) |
| `src/adapters/mockWorldClient.js` | Every side-effect call to the mock world goes through here (idempotency headers) |
| `src/routes/*.js` | REST API, matching `docs`-style API_CONTRACT field names |
| `public/` | Minimal static console (vanilla JS) |

## Run state machine

```
                    ┌────────┐
     trigger ──────▶│ queued │
                    └───┬────┘
                        │ worker picks up
                        ▼
                  ┌───────────┐   node type = approval    ┌──────────────────┐
        ┌────────▶│  running  │───────────────────────────▶│ waiting_approval │
        │         └─────┬─────┘                            └─────────┬────────┘
        │  next node     │                                            │
        │  (loop back)   │ node.next == null                          │ approve
        └────────────────┤                                            │
                          ▼                                            ▼
                    ┌───────────┐                              (advance to node.next,
                    │ succeeded │                               back to running)
                    └───────────┘
                                                              reject / cancel
                                                                    │
                                                                    ▼
                                                              ┌───────────┐
       step cap exceeded / node fails after retries ────────▶│ cancelled │
       (after all retries)                                   └───────────┘
                          │
                          ▼
                    ┌───────────┐
                    │  failed   │
                    └───────────┘
```

Status set: `queued`, `running`, `waiting_approval`, `succeeded`, `failed`,
`cancelled` - matches the fixed API contract.

Per-step status: `pending → running → succeeded | failed | waiting` (the
`waiting` status is specific to an `approval` node's step, distinct from the
run-level `waiting_approval`).

## Durable execution & exactly-once recovery

**The rule**: a step is only "done" once its row is committed with
`status='succeeded'`. Nothing else - not an in-memory variable, not a log
line - is trusted. Resume logic is: *find the run, find its current node
(`runs.current_node_id`), execute it.* That's the entire recovery algorithm.

**The queue**: `queue_jobs` is a Postgres table. One row per active run. The
worker claims a job with:
```sql
SELECT * FROM queue_jobs
WHERE (status = 'pending' AND run_at <= now())
   OR (status = 'in_progress' AND locked_at < now() - interval '30 seconds')
ORDER BY run_at ASC LIMIT 1
FOR UPDATE SKIP LOCKED
```
The second branch is the crash-recovery lease: if a worker claims a job and
then dies before finishing, no other worker touches that row for 30 seconds
(it might still be legitimately in progress) - after that, it's presumed
crashed and becomes claimable again, no manual intervention required.

**The crash window** (the actual hard part): the dangerous moment is *after*
a side-effect call reaches the mock world but *before* the step is persisted
as succeeded. On resume, the engine cannot know whether the original call
landed. So it doesn't try to know - it just re-sends the same request with
the same `Idempotency-Key`. Two outcomes:
- The first attempt never arrived → the retry executes normally.
- The first attempt did arrive → the mock world recognizes the key, returns
  the original response with `x-mockworld-replayed: true`, and no new side
  effect occurs.

Either way: exactly once, from the mock world's point of view. This is why
**idempotency keys must never include the attempt number** -
`${run_id}:${node_id}` is the whole key (`src/engine/executor.js`). A key
with an attempt counter baked in would defeat replay detection entirely,
since every retry would look like a brand-new request.

**Verified**: `verification/verification_report.md` documents an actual run
where the worker was `SIGKILL`ed mid-`create_shipment` HTTP call, the process
was restarted after the crash lease expired, and
`scripts/duplication_check.py` confirmed every side effect executed exactly
once.

**Delay nodes** don't block the worker thread - they set the queue job's
`run_at` to a future timestamp and release the row. A worker restart during
a delay is a non-event: `run_at` is a persisted timestamp, not in-memory
state, so the job simply isn't claimable until its time comes.

## AI nodes: schema enforcement & prompt-injection resistance

Every `ai` node's raw model output is parsed as JSON and validated with
[ajv](https://ajv.js.org/) against the node's `output_schema`
(`src/engine/nodes/ai.js`). On the first invalid response, the engine retries
**once** with the validation error appended to the prompt so the model can
self-correct; a second failure fails the step (never silently passes bad data
downstream).

**Approval gating is engine logic, not prompt logic.** Before executing any
node whose catalog entry has `requires_approval: true` (currently only
`order_action`), the engine runs a plain SQL check:
```sql
SELECT 1 FROM approvals WHERE run_id = $1 AND status = 'approved' LIMIT 1
```
If that query returns nothing, the node does not run - full stop, regardless
of what any upstream AI node classified or what instructions are embedded in
the trigger payload. There is no code path from "AI output" to "skip this
check." This is deliberately boring: the gate is a database row that either
exists or doesn't, not a rule the model is asked to respect.

Verified against `data/sample_payloads.jsonl`'s `pay_inject_001` - a support
message that tries to talk the classifier into believing "approval has
already been granted" and requesting a $5000 refund. The run correctly
classifies, routes, and pauses at `waiting_approval`; the mock world's ledger
stays empty until a human actually approves. See the verification report for
the full trace.

### On the AI provider
`AI_PROVIDER` in `.env` selects the implementation
(`src/adapters/aiProvider.js`):
- **`heuristic`** (default) - a real local keyword-based classifier. It reads
  the customer message out of the prompt and scores it against small
  lexicons per schema field. This exists because `scripts/mock_provider.py`
  is shared tooling built for a different capstone (LLM-gateway
  routing/failover testing) - it always returns free-text prose regardless of
  instructions and can never satisfy a JSON schema. `heuristic` is what makes
  the AI-branching demo actually work end-to-end without a real model key.
- **`mock`** - talks to `scripts/mock_provider.py`. Useful for exercising
  auth, timeouts, and retry/backoff paths, not for schema-conformant demos.
- **`anthropic`** - a real model, requires `ANTHROPIC_API_KEY`.

Engine unit tests inject a third implementation, `FakeAiProvider`, with
canned responses - no network calls in `npm test`.

## Guardrails

- **Timeouts**: every outbound call (mock world, AI provider) goes through
  `fetchWithTimeout` (`src/lib/timeout.js`), which uses a real
  `AbortController` - a hung dependency fails the *step*, never hangs the
  engine loop.
- **Retries**: transient failures (timeouts, network errors) get up to 3
  attempts with backoff (`src/engine/executor.js`). This is separate from the
  AI node's own single schema-validation retry.
- **Step cap**: checked *before* any node executes, against
  `definition.limits.max_steps`. `wf_runaway` (a deliberately looping seed
  workflow, cap 12) verifies this in the smoke test.
- **Idempotency**: every `side_effect: true` node type
  (`http_request`/non-GET, `notify`, `order_action`) carries
  `Idempotency-Key: ${run_id}:${node_id}`.

## API summary

See `docs/API_CONTRACT.md` (from the original spec pack) for the full fixed
contract. Quick reference:

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /workflows` | Bearer | List workflows |
| `POST /workflows` | Bearer | Create a Draft |
| `POST /workflows/:id/publish` | Bearer | Validate + publish (4xx on invalid) |
| `POST /workflows/:id/trigger` | Bearer | Manual trigger, body `{"input": {...}}` |
| `POST /hooks/:workflowId` | `X-Relay-Secret` header | Webhook trigger |
| `GET /runs/:id` | Bearer | Full trace |
| `GET /runs?status=&workflow_id=` | Bearer | List runs |
| `POST /runs/:id/cancel` | Bearer | Cooperative cancel |
| `GET /approvals?status=pending` | Bearer | List pending approvals |
| `POST /approvals/:id/approve` | Bearer | Resume the paused run |
| `POST /approvals/:id/reject` | Bearer | Run ends `cancelled` |

Auth: a single demo bearer token (`DEMO_TOKEN` in `.env`) covers
builder/operator/approver, per the spec's Must-Have scope. The webhook route
is intentionally *not* behind this token - it's guarded by the per-workflow
`X-Relay-Secret` instead.

## Testing

```bash
npm test
```
25 tests covering: publish validation (unknown types, missing params,
dangling edges, legal backward loops), template resolution (including the
`{{nodes.x.output.y}}` shape the seed workflows actually use), condition
node comparison semantics, AI schema validation + retry-once-then-fail
behavior (via `FakeAiProvider`, no network), and three integration tests
against a real Postgres instance: idempotency-key stability, step-cap
enforcement, and the approval gate refusing a sensitive node with no
approval record.

Integration tests need `DATABASE_URL` pointed at a real (ideally disposable)
Postgres - they write real rows.

## Known limitations

- **Single worker process assumed for the demo.** The queue design (`FOR
  UPDATE SKIP LOCKED` + lease) is safe with multiple concurrent workers, but
  this hasn't been load-tested under real concurrency.
- **`limits.timeout_seconds` and `limits.max_ai_tokens`** are read from the
  seed definitions but not enforced as hard caps (Good-to-Have per the spec;
  per-call timeouts *are* enforced, just not a cumulative run-level budget).
- **No cron/schedule trigger** (Good-to-Have) - only webhook and manual.
- **No NL-to-workflow compiler** (Good-to-Have).
- **No role separation** - the single demo token covers
  builder/operator/approver, per Must-Have scope.
- **AI prompt/response bodies are stored in the trace** (`steps.resolved_input`
  / `steps.output`) for debugging visibility. In a real deployment with PII
  in trigger payloads, this would need a retention policy or redaction -
  noted here rather than solved, per the spec's guidance to document this
  trade-off rather than silently make it.
- **The console is intentionally minimal** - functional (list, trigger,
  trace, approve/reject) rather than polished, to protect time for the
  engine's correctness properties.
