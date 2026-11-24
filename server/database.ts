import { Pool, type PoolClient } from "pg";

let pool: Pool | undefined;
let initialized: Promise<void> | undefined;

export function database() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("PostgreSQL is not configured. Set DATABASE_URL in .env and restart RentWise.");
  pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined });
  pool.on("error", (error) => console.error("Unexpected PostgreSQL pool error", error));
  return pool;
}

export async function closeDatabase() {
  const activePool = pool;
  pool = undefined;
  initialized = undefined;
  if (activePool) await activePool.end();
}

export async function ensureDatabase() {
  if (!initialized) initialized = (async () => {
    await database().query(`
      CREATE TABLE IF NOT EXISTS rentwise_users (
        id text PRIMARY KEY,
        email text NOT NULL UNIQUE,
        role text NOT NULL,
        active boolean NOT NULL DEFAULT true,
        account jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS rentwise_sessions (
        token_hash text PRIMARY KEY,
        user_id text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS rentwise_sessions_user_idx ON rentwise_sessions(user_id);
      CREATE INDEX IF NOT EXISTS rentwise_sessions_expiry_idx ON rentwise_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS rentwise_account_tokens (
        token_hash text PRIMARY KEY,
        user_id text NOT NULL REFERENCES rentwise_users(id) ON DELETE CASCADE,
        purpose text NOT NULL CHECK (purpose IN ('verify_email','password_reset')),
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS rentwise_account_tokens_user_purpose_idx ON rentwise_account_tokens(user_id,purpose,expires_at);
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
      CREATE TABLE IF NOT EXISTS rentwise_plan_catalog (
        catalog_id text PRIMARY KEY CHECK (catalog_id = 'default'),
        plans jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS rentwise_tenant_applications (
        id text PRIMARY KEY,
        organization_id text NOT NULL,
        landlord_id text NOT NULL,
        account_id text NOT NULL,
        applicant_name text NOT NULL,
        email text NOT NULL,
        phone text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Assigned')),
        tenant_id text,
        submitted_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (landlord_id, account_id)
      );
      CREATE INDEX IF NOT EXISTS rentwise_tenant_applications_owner_idx ON rentwise_tenant_applications(organization_id, landlord_id, status, submitted_at);
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
      ALTER TABLE rentwise_attachments DROP CONSTRAINT IF EXISTS rentwise_attachments_category_check;
      ALTER TABLE rentwise_attachments ADD CONSTRAINT rentwise_attachments_category_check
        CHECK (category IN ('lease', 'receipt', 'maintenance', 'profile'));
      CREATE INDEX IF NOT EXISTS rentwise_attachments_org_idx ON rentwise_attachments(organization_id, category);
      CREATE TABLE IF NOT EXISTS rentwise_inspection_attachments (
        id text NOT NULL,
        organization_id text NOT NULL,
        file_name text NOT NULL,
        mime_type text NOT NULL,
        content bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (organization_id, id)
      );
      CREATE INDEX IF NOT EXISTS rentwise_inspection_attachments_org_idx ON rentwise_inspection_attachments(organization_id);
      CREATE TABLE IF NOT EXISTS rentwise_reminder_notifications (
        id text PRIMARY KEY,
        organization_id text NOT NULL,
        tenant_id text NOT NULL,
        reminder_date date NOT NULL,
        channel text NOT NULL CHECK (channel IN ('portal', 'whatsapp')),
        status text NOT NULL CHECK (status IN ('queued', 'sending', 'submitted', 'failed', 'not_configured', 'not_opted_in')),
        title text NOT NULL,
        message text NOT NULL,
        provider_message_id text,
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        read_at timestamptz,
        UNIQUE (organization_id, tenant_id, reminder_date, channel)
      );
      CREATE INDEX IF NOT EXISTS rentwise_reminder_notifications_tenant_idx
        ON rentwise_reminder_notifications(organization_id, tenant_id, channel, created_at DESC);
      CREATE TABLE IF NOT EXISTS rentwise_subscription_payments (
        reference text PRIMARY KEY,
        user_id text NOT NULL REFERENCES rentwise_users(id) ON DELETE CASCADE,
        plan_id text NOT NULL CHECK (plan_id IN ('free_starter','basic','professional','business','enterprise','landlord_plus','manager_pro')),
        billing_interval text NOT NULL CHECK (billing_interval IN ('monthly','annually')),
        amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
        currency text NOT NULL DEFAULT 'NGN',
        status text NOT NULL CHECK (status IN ('pending','success','failed')),
        authorization_url text,
        paid_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE rentwise_subscription_payments DROP CONSTRAINT IF EXISTS rentwise_subscription_payments_plan_id_check;
      ALTER TABLE rentwise_subscription_payments ADD CONSTRAINT rentwise_subscription_payments_plan_id_check CHECK (plan_id IN ('free_starter','basic','professional','business','enterprise','landlord_plus','manager_pro'));
      CREATE INDEX IF NOT EXISTS rentwise_subscription_payments_user_idx ON rentwise_subscription_payments(user_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS rentwise_paystack_webhook_events (
        id text PRIMARY KEY,
        event_type text NOT NULL,
        reference text NOT NULL,
        status text NOT NULL CHECK (status IN ('pending','processing','processed','failed')),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        last_error text,
        received_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(event_type,reference)
      );
      CREATE INDEX IF NOT EXISTS rentwise_paystack_webhook_events_queue_idx
        ON rentwise_paystack_webhook_events(status,received_at);
      CREATE TABLE IF NOT EXISTS rentwise_user_subscriptions (
        user_id text PRIMARY KEY REFERENCES rentwise_users(id) ON DELETE CASCADE,
        plan_id text NOT NULL,
        start_date timestamptz NOT NULL,
        duration_days integer NOT NULL CHECK (duration_days > 0),
        expiry_date timestamptz NOT NULL,
        subscription_status text NOT NULL CHECK (subscription_status IN ('active','expired','suspended')),
        last_notified_at timestamptz,
        notification_days integer[] NOT NULL DEFAULT '{}',
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS rentwise_user_subscriptions_status_expiry_idx ON rentwise_user_subscriptions(subscription_status,expiry_date);
      CREATE TABLE IF NOT EXISTS rentwise_subscription_notifications (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES rentwise_users(id) ON DELETE CASCADE,
        plan_id text NOT NULL,
        expiry_date timestamptz NOT NULL,
        days_remaining integer NOT NULL CHECK (days_remaining IN (1,3,7)),
        title text NOT NULL,
        message text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        read_at timestamptz,
        UNIQUE(user_id,expiry_date,days_remaining)
      );
      CREATE INDEX IF NOT EXISTS rentwise_subscription_notifications_user_idx ON rentwise_subscription_notifications(user_id,created_at DESC);
    `);
    await database().query(`
      CREATE TABLE IF NOT EXISTS rentwise_schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE OR REPLACE FUNCTION rentwise_sync_money_kobo() RETURNS trigger AS $$
      DECLARE
        field_maps text[];
        field_map text;
        parts text[];
        item jsonb;
        old_item jsonb;
        normalized jsonb := '[]'::jsonb;
        amount_value numeric;
        kobo_value numeric;
      BEGIN
        IF NEW.collection = 'payments' THEN field_maps := ARRAY['amount:amountKobo'];
        ELSIF NEW.collection = 'expenses' THEN field_maps := ARRAY['amount:amountKobo'];
        ELSIF NEW.collection = 'tenants' THEN field_maps := ARRAY['monthlyRent:monthlyRentKobo'];
        ELSIF NEW.collection = 'leases' THEN field_maps := ARRAY['rentAmount:rentAmountKobo','securityDeposit:securityDepositKobo'];
        ELSIF NEW.collection = 'maintenance' THEN field_maps := ARRAY['quoteAmount:quoteAmountKobo','approvedAmount:approvedAmountKobo','actualCost:actualCostKobo'];
        ELSIF NEW.collection = 'inspections' THEN field_maps := ARRAY['inspectionFee:inspectionFeeKobo','agentFee:agentFeeKobo'];
        ELSIF NEW.collection = 'renewalRequests' THEN field_maps := ARRAY['rentAmount:rentAmountKobo'];
        ELSE RETURN NEW;
        END IF;
        IF jsonb_typeof(NEW.data) <> 'array' THEN RETURN NEW; END IF;
        FOR item IN SELECT value FROM jsonb_array_elements(NEW.data) LOOP
          IF jsonb_typeof(item) = 'object' THEN
            old_item := NULL;
            IF TG_OP = 'UPDATE' THEN
              IF jsonb_typeof(OLD.data) = 'array' AND item ? 'id' THEN
                SELECT value INTO old_item FROM jsonb_array_elements(OLD.data) WHERE value->>'id' = item->>'id' LIMIT 1;
              END IF;
            END IF;
            FOREACH field_map IN ARRAY field_maps LOOP
              parts := string_to_array(field_map, ':');
              IF item ? parts[1] AND item->parts[1] <> 'null'::jsonb THEN
                IF jsonb_typeof(item->parts[1]) = 'number' THEN
                  amount_value := (item->>parts[1])::numeric;
                  kobo_value := amount_value * 100;
                  IF amount_value >= 0 AND kobo_value = trunc(kobo_value) AND kobo_value <= 9007199254740991 THEN
                    item := jsonb_set(item, ARRAY[parts[2]], to_jsonb(kobo_value::bigint), true);
                    CONTINUE;
                  END IF;
                END IF;
                IF old_item IS NOT NULL AND old_item->parts[1] IS NOT DISTINCT FROM item->parts[1] THEN
                  IF old_item ? parts[2] THEN item := jsonb_set(item, ARRAY[parts[2]], old_item->parts[2], true);
                  ELSE item := item - parts[2]; END IF;
                  CONTINUE;
                END IF;
                RAISE EXCEPTION 'Invalid monetary value for %.% (expected non-negative amount with at most two decimal places)', NEW.collection, parts[1] USING ERRCODE = '22023';
              ELSIF item ? parts[2] AND item->parts[2] <> 'null'::jsonb THEN
                IF jsonb_typeof(item->parts[2]) = 'number' THEN
                  kobo_value := (item->>parts[2])::numeric;
                  IF kobo_value >= 0 AND kobo_value = trunc(kobo_value) AND kobo_value <= 9007199254740991 THEN CONTINUE; END IF;
                END IF;
                RAISE EXCEPTION 'Invalid integer-kobo value for %.%', NEW.collection, parts[2] USING ERRCODE = '22023';
              END IF;
            END LOOP;
          END IF;
          normalized := normalized || jsonb_build_array(item);
        END LOOP;
        NEW.data := normalized;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS rentwise_app_data_money_kobo ON rentwise_app_data;
      CREATE TRIGGER rentwise_app_data_money_kobo
        BEFORE INSERT OR UPDATE OF collection,data ON rentwise_app_data
        FOR EACH ROW EXECUTE FUNCTION rentwise_sync_money_kobo();
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM rentwise_schema_migrations WHERE version='financial-kobo-v1') THEN
          UPDATE rentwise_app_data SET data=data WHERE collection IN ('payments','expenses','tenants','leases','maintenance','inspections','renewalRequests');
          INSERT INTO rentwise_schema_migrations(version) VALUES('financial-kobo-v1');
        END IF;
      END;
      $$;
    `);
    await database().query(`
      ALTER TABLE rentwise_app_data ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;
      CREATE TABLE IF NOT EXISTS rentwise_properties (
        organization_id text NOT NULL,
        id text NOT NULL,
        name text NOT NULL DEFAULT '',
        property_type text NOT NULL DEFAULT '',
        address text NOT NULL DEFAULT '',
        position integer NOT NULL DEFAULT 0,
        payload jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(organization_id,id)
      );
      ALTER TABLE rentwise_properties ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS rentwise_properties_type_idx ON rentwise_properties(organization_id,property_type);
      CREATE TABLE IF NOT EXISTS rentwise_tenants (
        organization_id text NOT NULL,
        id text NOT NULL,
        property_id text,
        name text NOT NULL DEFAULT '',
        email text NOT NULL DEFAULT '',
        phone text NOT NULL DEFAULT '',
        position integer NOT NULL DEFAULT 0,
        payload jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(organization_id,id),
        CONSTRAINT rentwise_tenants_property_fk FOREIGN KEY(organization_id,property_id) REFERENCES rentwise_properties(organization_id,id) ON DELETE RESTRICT
      );
      ALTER TABLE rentwise_tenants ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS rentwise_tenants_property_idx ON rentwise_tenants(organization_id,property_id);
      CREATE INDEX IF NOT EXISTS rentwise_tenants_email_idx ON rentwise_tenants(organization_id,lower(email)) WHERE email <> '';
      CREATE TABLE IF NOT EXISTS rentwise_leases (
        organization_id text NOT NULL,
        id text NOT NULL,
        tenant_id text,
        reference text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT '',
        start_date date,
        expiry_date date,
        rent_amount_kobo bigint,
        position integer NOT NULL DEFAULT 0,
        payload jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(organization_id,id),
        CONSTRAINT rentwise_leases_tenant_fk FOREIGN KEY(organization_id,tenant_id) REFERENCES rentwise_tenants(organization_id,id) ON DELETE RESTRICT,
        CHECK (rent_amount_kobo IS NULL OR rent_amount_kobo >= 0)
      );
      ALTER TABLE rentwise_leases ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS rentwise_leases_tenant_idx ON rentwise_leases(organization_id,tenant_id);
      CREATE INDEX IF NOT EXISTS rentwise_leases_expiry_idx ON rentwise_leases(organization_id,expiry_date);
      CREATE UNIQUE INDEX IF NOT EXISTS rentwise_leases_reference_uq ON rentwise_leases(organization_id,reference) WHERE reference<>'';
      CREATE TABLE IF NOT EXISTS rentwise_payments (
        organization_id text NOT NULL,
        id text NOT NULL,
        tenant_id text,
        property_id text,
        reference text NOT NULL DEFAULT '',
        transaction_type text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT '',
        payment_date date,
        amount_kobo bigint,
        position integer NOT NULL DEFAULT 0,
        payload jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(organization_id,id),
        CONSTRAINT rentwise_payments_tenant_fk FOREIGN KEY(organization_id,tenant_id) REFERENCES rentwise_tenants(organization_id,id) ON DELETE RESTRICT,
        CONSTRAINT rentwise_payments_property_fk FOREIGN KEY(organization_id,property_id) REFERENCES rentwise_properties(organization_id,id) ON DELETE RESTRICT,
        CHECK (amount_kobo IS NULL OR amount_kobo >= 0)
      );
      ALTER TABLE rentwise_payments ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS rentwise_payments_property_date_idx ON rentwise_payments(organization_id,property_id,payment_date DESC);
      CREATE INDEX IF NOT EXISTS rentwise_payments_tenant_date_idx ON rentwise_payments(organization_id,tenant_id,payment_date DESC);
      CREATE INDEX IF NOT EXISTS rentwise_payments_status_date_idx ON rentwise_payments(organization_id,status,payment_date DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS rentwise_payments_reference_uq ON rentwise_payments(organization_id,reference) WHERE reference<>'';
      CREATE TABLE IF NOT EXISTS rentwise_expenses (
        organization_id text NOT NULL,
        id text NOT NULL,
        property_id text,
        reference text NOT NULL DEFAULT '',
        category text NOT NULL DEFAULT '',
        expense_date date,
        amount_kobo bigint,
        position integer NOT NULL DEFAULT 0,
        payload jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(organization_id,id),
        CONSTRAINT rentwise_expenses_property_fk FOREIGN KEY(organization_id,property_id) REFERENCES rentwise_properties(organization_id,id) ON DELETE RESTRICT,
        CHECK (amount_kobo IS NULL OR amount_kobo >= 0)
      );
      ALTER TABLE rentwise_expenses ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS rentwise_expenses_property_date_idx ON rentwise_expenses(organization_id,property_id,expense_date DESC);
      CREATE INDEX IF NOT EXISTS rentwise_expenses_category_date_idx ON rentwise_expenses(organization_id,category,expense_date DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS rentwise_expenses_reference_uq ON rentwise_expenses(organization_id,reference) WHERE reference<>'';
      CREATE OR REPLACE FUNCTION rentwise_date_or_null(value text) RETURNS date AS $$
      BEGIN
        IF value IS NULL OR value='' THEN RETURN NULL; END IF;
        RETURN value::date;
      EXCEPTION WHEN OTHERS THEN RETURN NULL;
      END;
      $$ LANGUAGE plpgsql IMMUTABLE;
      CREATE OR REPLACE FUNCTION rentwise_increment_collection_revision() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id || ':' || NEW.collection,0));
        IF TG_OP='UPDATE' THEN NEW.revision := OLD.revision + 1;
        ELSIF NEW.revision IS NULL OR NEW.revision < 1 THEN NEW.revision := 1;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS rentwise_app_data_revision ON rentwise_app_data;
      CREATE TRIGGER rentwise_app_data_revision BEFORE INSERT OR UPDATE ON rentwise_app_data
        FOR EACH ROW EXECUTE FUNCTION rentwise_increment_collection_revision();
      CREATE OR REPLACE FUNCTION rentwise_sync_core_records() RETURNS trigger AS $$
      DECLARE
        item jsonb;
        old_item jsonb;
        related_id text;
        property_ref text;
        record_position integer;
      BEGIN
        IF jsonb_typeof(NEW.data) <> 'array' THEN RETURN NEW; END IF;
        IF NEW.collection='properties' THEN
          DELETE FROM rentwise_properties WHERE organization_id=NEW.organization_id AND NOT (id=ANY(ARRAY(SELECT value->>'id' FROM jsonb_array_elements(NEW.data) WHERE value->>'id' IS NOT NULL)));
          FOR item,record_position IN SELECT value,ord::integer FROM jsonb_array_elements(NEW.data) WITH ORDINALITY AS records(value,ord) ORDER BY ord LOOP
            IF COALESCE(item->>'id','')='' THEN CONTINUE; END IF;
            INSERT INTO rentwise_properties(organization_id,id,name,property_type,address,position,payload,updated_at)
            VALUES(NEW.organization_id,item->>'id',COALESCE(item->>'name',''),COALESCE(item->>'type',item->>'propertyType',''),COALESCE(item->>'address',''),record_position,item,now())
            ON CONFLICT(organization_id,id) DO UPDATE SET name=EXCLUDED.name,property_type=EXCLUDED.property_type,address=EXCLUDED.address,position=EXCLUDED.position,payload=EXCLUDED.payload,updated_at=now();
          END LOOP;
        ELSIF NEW.collection='tenants' THEN
          DELETE FROM rentwise_tenants WHERE organization_id=NEW.organization_id AND NOT (id=ANY(ARRAY(SELECT value->>'id' FROM jsonb_array_elements(NEW.data) WHERE value->>'id' IS NOT NULL)));
          FOR item,record_position IN SELECT value,ord::integer FROM jsonb_array_elements(NEW.data) WITH ORDINALITY AS records(value,ord) ORDER BY ord LOOP
            IF COALESCE(item->>'id','')='' THEN CONTINUE; END IF;
            related_id := NULLIF(item->>'propertyId','');
            old_item := NULL;
            IF TG_OP='UPDATE' THEN
              IF jsonb_typeof(OLD.data)='array' THEN SELECT value INTO old_item FROM jsonb_array_elements(OLD.data) WHERE value->>'id'=item->>'id' LIMIT 1; END IF;
            END IF;
            IF related_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rentwise_properties WHERE organization_id=NEW.organization_id AND id=related_id) THEN
              IF old_item IS NOT NULL AND old_item->>'propertyId'=related_id THEN related_id := NULL;
              ELSE RAISE EXCEPTION 'Tenant % references a property that does not exist in this organization',item->>'id' USING ERRCODE='23503'; END IF;
            END IF;
            INSERT INTO rentwise_tenants(organization_id,id,property_id,name,email,phone,position,payload,updated_at)
            VALUES(NEW.organization_id,item->>'id',related_id,COALESCE(item->>'name',''),lower(COALESCE(item->>'email','')),COALESCE(item->>'phone',''),record_position,item,now())
            ON CONFLICT(organization_id,id) DO UPDATE SET property_id=EXCLUDED.property_id,name=EXCLUDED.name,email=EXCLUDED.email,phone=EXCLUDED.phone,position=EXCLUDED.position,payload=EXCLUDED.payload,updated_at=now();
          END LOOP;
        ELSIF NEW.collection='leases' THEN
          DELETE FROM rentwise_leases WHERE organization_id=NEW.organization_id AND NOT (id=ANY(ARRAY(SELECT value->>'id' FROM jsonb_array_elements(NEW.data) WHERE value->>'id' IS NOT NULL)));
          FOR item,record_position IN SELECT value,ord::integer FROM jsonb_array_elements(NEW.data) WITH ORDINALITY AS records(value,ord) ORDER BY ord LOOP
            IF COALESCE(item->>'id','')='' THEN CONTINUE; END IF;
            related_id := NULLIF(item->>'tenantId','');
            old_item := NULL;
            IF TG_OP='UPDATE' THEN
              IF jsonb_typeof(OLD.data)='array' THEN SELECT value INTO old_item FROM jsonb_array_elements(OLD.data) WHERE value->>'id'=item->>'id' LIMIT 1; END IF;
            END IF;
            IF related_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rentwise_tenants WHERE organization_id=NEW.organization_id AND id=related_id) THEN
              IF old_item IS NOT NULL AND old_item->>'tenantId'=related_id THEN related_id := NULL;
              ELSE RAISE EXCEPTION 'Lease % references a tenant that does not exist in this organization',item->>'id' USING ERRCODE='23503'; END IF;
            END IF;
            INSERT INTO rentwise_leases(organization_id,id,tenant_id,reference,status,start_date,expiry_date,rent_amount_kobo,position,payload,updated_at)
            VALUES(NEW.organization_id,item->>'id',related_id,COALESCE(item->>'reference',''),COALESCE(item->>'status',''),rentwise_date_or_null(item->>'startDate'),rentwise_date_or_null(item->>'expirationDate'),NULLIF(item->>'rentAmountKobo','')::bigint,record_position,item,now())
            ON CONFLICT(organization_id,id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,reference=EXCLUDED.reference,status=EXCLUDED.status,start_date=EXCLUDED.start_date,expiry_date=EXCLUDED.expiry_date,rent_amount_kobo=EXCLUDED.rent_amount_kobo,position=EXCLUDED.position,payload=EXCLUDED.payload,updated_at=now();
          END LOOP;
        ELSIF NEW.collection='payments' THEN
          DELETE FROM rentwise_payments WHERE organization_id=NEW.organization_id AND NOT (id=ANY(ARRAY(SELECT value->>'id' FROM jsonb_array_elements(NEW.data) WHERE value->>'id' IS NOT NULL)));
          FOR item,record_position IN SELECT value,ord::integer FROM jsonb_array_elements(NEW.data) WITH ORDINALITY AS records(value,ord) ORDER BY ord LOOP
            IF COALESCE(item->>'id','')='' THEN CONTINUE; END IF;
            old_item := NULL;
            IF TG_OP='UPDATE' THEN
              IF jsonb_typeof(OLD.data)='array' THEN SELECT value INTO old_item FROM jsonb_array_elements(OLD.data) WHERE value->>'id'=item->>'id' LIMIT 1; END IF;
            END IF;
            related_id := NULLIF(item->>'tenantId','');
            IF related_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rentwise_tenants WHERE organization_id=NEW.organization_id AND id=related_id) THEN
              IF old_item IS NOT NULL AND old_item->>'tenantId'=related_id THEN related_id := NULL;
              ELSE RAISE EXCEPTION 'Payment % references a tenant that does not exist in this organization',item->>'id' USING ERRCODE='23503'; END IF;
            END IF;
            property_ref := NULLIF(item->>'propertyId','');
            IF property_ref IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rentwise_properties WHERE organization_id=NEW.organization_id AND id=property_ref) THEN
              IF old_item IS NOT NULL AND old_item->>'propertyId'=property_ref THEN property_ref := NULL;
              ELSE RAISE EXCEPTION 'Payment % references a property that does not exist in this organization',item->>'id' USING ERRCODE='23503'; END IF;
            END IF;
            INSERT INTO rentwise_payments(organization_id,id,tenant_id,property_id,reference,transaction_type,status,payment_date,amount_kobo,position,payload,updated_at)
            VALUES(NEW.organization_id,item->>'id',related_id,property_ref,COALESCE(item->>'reference',''),COALESCE(item->>'transactionType',''),COALESCE(item->>'status',''),rentwise_date_or_null(item->>'paymentDate'),NULLIF(item->>'amountKobo','')::bigint,record_position,item,now())
            ON CONFLICT(organization_id,id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,property_id=EXCLUDED.property_id,reference=EXCLUDED.reference,transaction_type=EXCLUDED.transaction_type,status=EXCLUDED.status,payment_date=EXCLUDED.payment_date,amount_kobo=EXCLUDED.amount_kobo,position=EXCLUDED.position,payload=EXCLUDED.payload,updated_at=now();
          END LOOP;
        ELSIF NEW.collection='expenses' THEN
          DELETE FROM rentwise_expenses WHERE organization_id=NEW.organization_id AND NOT (id=ANY(ARRAY(SELECT value->>'id' FROM jsonb_array_elements(NEW.data) WHERE value->>'id' IS NOT NULL)));
          FOR item,record_position IN SELECT value,ord::integer FROM jsonb_array_elements(NEW.data) WITH ORDINALITY AS records(value,ord) ORDER BY ord LOOP
            IF COALESCE(item->>'id','')='' THEN CONTINUE; END IF;
            property_ref := NULLIF(item->>'propertyId','');
            old_item := NULL;
            IF TG_OP='UPDATE' THEN
              IF jsonb_typeof(OLD.data)='array' THEN SELECT value INTO old_item FROM jsonb_array_elements(OLD.data) WHERE value->>'id'=item->>'id' LIMIT 1; END IF;
            END IF;
            IF property_ref IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rentwise_properties WHERE organization_id=NEW.organization_id AND id=property_ref) THEN
              IF old_item IS NOT NULL AND old_item->>'propertyId'=property_ref THEN property_ref := NULL;
              ELSE RAISE EXCEPTION 'Expense % references a property that does not exist in this organization',item->>'id' USING ERRCODE='23503'; END IF;
            END IF;
            INSERT INTO rentwise_expenses(organization_id,id,property_id,reference,category,expense_date,amount_kobo,position,payload,updated_at)
            VALUES(NEW.organization_id,item->>'id',property_ref,COALESCE(item->>'reference',''),COALESCE(item->>'category',''),rentwise_date_or_null(item->>'expenseDate'),NULLIF(item->>'amountKobo','')::bigint,record_position,item,now())
            ON CONFLICT(organization_id,id) DO UPDATE SET property_id=EXCLUDED.property_id,reference=EXCLUDED.reference,category=EXCLUDED.category,expense_date=EXCLUDED.expense_date,amount_kobo=EXCLUDED.amount_kobo,position=EXCLUDED.position,payload=EXCLUDED.payload,updated_at=now();
          END LOOP;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS rentwise_app_data_core_sync ON rentwise_app_data;
      CREATE TRIGGER rentwise_app_data_core_sync AFTER INSERT OR UPDATE OF collection,data ON rentwise_app_data
        FOR EACH ROW EXECUTE FUNCTION rentwise_sync_core_records();
      DO $$
      DECLARE row_data record;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM rentwise_schema_migrations WHERE version='core-relational-v1') THEN
          FOR row_data IN SELECT organization_id,collection FROM rentwise_app_data WHERE collection='properties' LOOP
            UPDATE rentwise_app_data SET data=data WHERE organization_id=row_data.organization_id AND collection=row_data.collection;
          END LOOP;
          FOR row_data IN SELECT organization_id,collection FROM rentwise_app_data WHERE collection='tenants' LOOP
            UPDATE rentwise_app_data SET data=data WHERE organization_id=row_data.organization_id AND collection=row_data.collection;
          END LOOP;
          FOR row_data IN SELECT organization_id,collection FROM rentwise_app_data WHERE collection='leases' LOOP
            UPDATE rentwise_app_data SET data=data WHERE organization_id=row_data.organization_id AND collection=row_data.collection;
          END LOOP;
          FOR row_data IN SELECT organization_id,collection FROM rentwise_app_data WHERE collection='payments' LOOP
            UPDATE rentwise_app_data SET data=data WHERE organization_id=row_data.organization_id AND collection=row_data.collection;
          END LOOP;
          FOR row_data IN SELECT organization_id,collection FROM rentwise_app_data WHERE collection='expenses' LOOP
            UPDATE rentwise_app_data SET data=data WHERE organization_id=row_data.organization_id AND collection=row_data.collection;
          END LOOP;
          INSERT INTO rentwise_schema_migrations(version) VALUES('core-relational-v1');
        END IF;
      END;
      $$;
    `);
  })().catch((error) => { initialized = undefined; throw error; });
  return initialized;
}

export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>) {
  await ensureDatabase();
  const client = await database().connect();
  try { await client.query("BEGIN"); const result = await callback(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
