-- Persistent, non-production action receipts for the guided sample workspace.
-- Requests are redacted before storage; this table must never contain a token,
-- password, provider secret, or customer-supplied credential.
CREATE TABLE IF NOT EXISTS demo_action_runs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  events_json TEXT NOT NULL,
  effects_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS demo_action_runs_created_idx
  ON demo_action_runs(created_at DESC);
