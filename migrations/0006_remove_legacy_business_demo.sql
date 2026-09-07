-- OpenWA is a developer CPaaS, not a customer-support or commerce suite.
-- Remove the legacy guided-business-demo ledger and its action receipts.
DROP TABLE IF EXISTS demo_action_runs;
DROP TABLE IF EXISTS demo_seed_records;
DROP TABLE IF EXISTS demo_workspace;
