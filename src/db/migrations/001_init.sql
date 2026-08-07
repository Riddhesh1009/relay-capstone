-- Relay core schema
-- Design notes:
--  * definition/definition_snapshot are JSONB: workflows carry the live definition,
--    runs carry a frozen copy taken at trigger time (DATA_MODEL.md: "Definition Snapshot").
--  * queue_jobs is the durable queue. SELECT ... FOR UPDATE SKIP LOCKED gives us
--    safe concurrent workers for free, and a crashed worker's lock is naturally
--    released (no row update = job stays claimable after lock_expires_at).
--  * All timestamps are UTC (timestamptz).

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

CREATE TABLE IF NOT EXISTS workflows (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  definition    JSONB NOT NULL,
  webhook_secret TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id                  TEXT PRIMARY KEY,
  workflow_id         TEXT NOT NULL REFERENCES workflows(id),
  definition_snapshot JSONB NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','running','waiting_approval','succeeded','failed','cancelled')),
  trigger_type        TEXT NOT NULL,
  input               JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_node_id     TEXT,
  steps_executed      INTEGER NOT NULL DEFAULT 0,
  ai_tokens_used      INTEGER NOT NULL DEFAULT 0,
  error               JSONB,
  cancel_requested    BOOLEAN NOT NULL DEFAULT false,
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runs_workflow_id ON runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS steps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          TEXT NOT NULL REFERENCES runs(id),
  node_id         TEXT NOT NULL,
  node_type       TEXT NOT NULL,
  sequence        INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','succeeded','failed','waiting')),
  attempt         INTEGER NOT NULL DEFAULT 0,
  resolved_input  JSONB,
  output          JSONB,
  tokens_prompt   INTEGER,
  tokens_completion INTEGER,
  idempotency_key TEXT,
  error           JSONB,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  duration_ms     INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (run, node_id, sequence) - sequence lets loops repeat a node id safely.
CREATE INDEX IF NOT EXISTS idx_steps_run_id_sequence ON steps(run_id, sequence);
-- Idempotency keys are {run_id}:{node_id} and must be stable across retries/resumes,
-- but a run can revisit the same node in a loop, so we don't uniq this globally -
-- the mock world's own ledger is the source of truth for exactly-once; this index
-- just makes "did we already succeed this node_id in this run" queries fast.
CREATE INDEX IF NOT EXISTS idx_steps_run_node ON steps(run_id, node_id);

CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  node_id     TEXT NOT NULL,
  step_id     UUID REFERENCES steps(id),
  message     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by  TEXT,
  decided_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_run_id ON approvals(run_id);

-- Durable queue. A run has at most one "live" queue row at a time; the worker
-- claims it with FOR UPDATE SKIP LOCKED so multiple worker processes are safe.
CREATE TABLE IF NOT EXISTS queue_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          TEXT NOT NULL REFERENCES runs(id),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','in_progress','done','cancelled')),
  run_at          TIMESTAMPTZ NOT NULL DEFAULT now(), -- supports `delay` nodes
  locked_by       TEXT,
  locked_at       TIMESTAMPTZ,
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_queue_jobs_claimable ON queue_jobs(status, run_at);

-- Local mirror of side-effect calls, keyed by idempotency key. The mock world
-- keeps its own ledger (source of truth for the duplication_check.py script);
-- this table lets the engine short-circuit a resumed step without a network
-- round trip when we already know the outcome.
CREATE TABLE IF NOT EXISTS side_effect_ledger (
  idempotency_key TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  node_id         TEXT NOT NULL,
  request_hash    TEXT,
  response        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

