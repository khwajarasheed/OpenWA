export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  INBOUND_QUEUE: Queue<QueueJob>;
  OUTBOUND_QUEUE: Queue<QueueJob>;
  MAINTENANCE_QUEUE: Queue<QueueJob>;
  PHONE_DISPATCHER: DurableObjectNamespace;
  META_ACCESS_TOKEN: string;
  META_APP_SECRET: string;
  WEBHOOK_VERIFY_TOKEN: string;
  BOOTSTRAP_ADMIN_TOKEN: string;
  META_GRAPH_VERSION: string;
  PHONE_NUMBER_IDS: string;
  WABA_ID: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
  CF_ACCESS_AUD: string;
  CF_ACCESS_TEAM_DOMAIN: string;
}

export type QueueJob =
  | { type: 'inbound_webhook'; fingerprint: string; payload?: unknown; r2Key?: string }
  | { type: 'outbound_dispatch'; jobId: string; phoneNumberId: string }
  | { type: 'template_sync' };

export interface Principal {
  id: string;
  name: string;
  scopes: string[];
}
