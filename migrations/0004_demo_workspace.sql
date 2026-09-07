CREATE TABLE IF NOT EXISTS demo_workspace (
  id TEXT PRIMARY KEY CHECK(id = 'default'),
  mode TEXT NOT NULL CHECK(mode IN ('demo', 'live')) DEFAULT 'demo',
  cleanup_prompted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- This ledger makes the supplied sample records removable without touching
-- installation, owner, credential, or customer-created data.
CREATE TABLE IF NOT EXISTS demo_seed_records (
  batch_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  PRIMARY KEY(batch_id, record_type, record_id)
);
