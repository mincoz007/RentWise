-- Run in pgAdmin 4 Query Tool after connecting to the RentWise database.
-- The application also creates these tables automatically on first API access.
CREATE TABLE IF NOT EXISTS rentwise_users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  role text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  account jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rentwise_app_data (
  organization_id text NOT NULL,
  collection text NOT NULL,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, collection)
);

CREATE TABLE IF NOT EXISTS rentwise_financial_audit (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  collection text NOT NULL CHECK (collection IN ('payments','expenses')),
  transaction_id text NOT NULL,
  reference text NOT NULL,
  action text NOT NULL CHECK (action IN ('created','updated','reversed','deleted')),
  before_data jsonb,
  after_data jsonb,
  actor_id text NOT NULL,
  actor_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rentwise_financial_audit_org_created_idx
  ON rentwise_financial_audit(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rentwise_attachments (
  id text NOT NULL,
  organization_id text NOT NULL,
  category text NOT NULL CHECK (category IN ('lease', 'receipt', 'maintenance')),
  file_name text NOT NULL,
  mime_type text NOT NULL,
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, category, id)
);
CREATE INDEX IF NOT EXISTS rentwise_attachments_org_idx ON rentwise_attachments(organization_id, category);
