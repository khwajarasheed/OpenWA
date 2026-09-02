PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS installations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  api_version TEXT NOT NULL DEFAULT 'v1'
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  wa_id TEXT NOT NULL UNIQUE,
  display_name TEXT,
  profile_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  phone_number_id TEXT NOT NULL,
  last_message_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(contact_id, phone_number_id)
);
CREATE INDEX IF NOT EXISTS conversations_phone_activity_idx ON conversations(phone_number_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  meta_message_id TEXT UNIQUE,
  conversation_id TEXT REFERENCES conversations(id),
  phone_number_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
  type TEXT NOT NULL,
  body_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'submitted', 'sent', 'delivered', 'read', 'failed', 'send_unknown')),
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(phone_number_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_phone_status_idx ON messages(phone_number_id, status, created_at);

CREATE TABLE IF NOT EXISTS message_status_events (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  status TEXT NOT NULL,
  meta_timestamp TEXT,
  event_fingerprint TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhook_receipts (
  event_fingerprint TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS outbound_jobs (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  phone_number_id TEXT NOT NULL,
  recipient_wa_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'dispatching', 'submitted', 'failed', 'send_unknown')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS outbound_jobs_due_idx ON outbound_jobs(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS send_attempts (
  id TEXT PRIMARY KEY,
  outbound_job_id TEXT NOT NULL REFERENCES outbound_jobs(id),
  outcome TEXT NOT NULL,
  response_status INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  meta_template_id TEXT UNIQUE,
  name TEXT NOT NULL,
  language TEXT NOT NULL,
  category TEXT,
  status TEXT,
  quality_score TEXT,
  components_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(name, language)
);

CREATE TABLE IF NOT EXISTS api_principals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_digest TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
