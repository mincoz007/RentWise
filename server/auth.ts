import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PoolClient } from "pg";
import type { Plugin } from "vite";
import { database, ensureDatabase, withTransaction } from "./database.ts";
import { normalizePlanId, subscriptionPlans, type StoredPlanId, type SubscriptionInterval, type SubscriptionPlanConfig, type PlanLimitKey } from "../src/plan-catalog.ts";

export const roleIds = ["super_admin", "platform_admin", "landlord_owner", "property_manager", "estate_agent", "resident_tenant"] as const;
export type RoleId = (typeof roleIds)[number];

type SubscriptionPlanId = StoredPlanId;
type Account = {
  id: string;
  name: string;
  email: string;
  role: RoleId;
  subscriptionPlan?: SubscriptionPlanId;
  subscriptionInterval?: SubscriptionInterval;
  subscriptionStartAt?: string;
  subscriptionDurationDays?: number;
  subscriptionExpiresAt?: string;
  subscriptionStatus?: "active" | "expired" | "suspended";
  subscriptionLastNotifiedAt?: string;
  subscriptionRemainingDays?: number | null;
  tenantId?: string;
  organizationId?: string;
  landlordId?: string;
  landlordCode?: string;
  emailVerified?: boolean;
  active: boolean;
  salt: string;
  passwordHash: string;
  createdAt: string;
};

type UserStore = { users: Account[] };
type PublicAccount = Omit<Account, "salt" | "passwordHash">;
type GoogleFlow = { mode: "login" | "signup"; role?: "landlord_owner" | "resident_tenant" | "estate_agent"; landlordCode?: string; expiresAt: number };

const userFile = resolve(process.cwd(), "data", "rentwise-users.json");
const googleFlows = new Map<string, GoogleFlow>();
const loginAttempts = new Map<string, { count: number; startedAt: number }>();
const accountFlowAttempts = new Map<string, { count: number; startedAt: number }>();
const sessionLifetimeSeconds = 5 * 60;
let mutationQueue: Promise<void> = Promise.resolve();
const dataCollections = new Set(["properties", "tenants", "reminderMessages", "payments", "expenses", "leases", "bankTransferDetails", "maintenance", "maintenanceVendors", "inspections", "renewalRequests"]);
const writableCollections: Record<RoleId, Set<string>> = {
  super_admin: dataCollections,
  platform_admin: new Set(),
  landlord_owner: dataCollections,
  property_manager: dataCollections,
  estate_agent: new Set(["inspections", "expenses"]),
  resident_tenant: new Set(["payments", "maintenance", "renewalRequests"]),
};
const readableCollections: Record<RoleId, Set<string>> = {
  super_admin: dataCollections,
  platform_admin: dataCollections,
  landlord_owner: dataCollections,
  property_manager: dataCollections,
  estate_agent: new Set(["properties", "tenants", "payments", "expenses", "inspections"]),
  resident_tenant: new Set(["properties", "tenants", "reminderMessages", "payments", "leases", "maintenance", "bankTransferDetails", "renewalRequests"]),
};

function tenantScope(account: Account, collection: string, data: unknown, tenantId: string) {
  if (account.role !== "resident_tenant" || !tenantId || !Array.isArray(data)) return data;
  if (collection === "tenants") return data.filter((item) => item && item.id === tenantId);
  if (collection === "properties") return data;
  if (collection === "maintenance") return data.filter((item) => item && item.tenantId === tenantId).map((item) => {
    const { vendorId: _vendorId, quoteAmount: _quoteAmount, approvalStatus: _approvalStatus, approvedAmount: _approvedAmount, actualCost: _actualCost, workOrderDueDate: _workOrderDueDate, workOrderNotes: _workOrderNotes, ...residentRequest } = item as Record<string, unknown>;
    return residentRequest;
  });
  return data.filter((item) => item && item.tenantId === tenantId);
}

async function residentLeaseTenantIds(account: Account, organizationId: string) {
  const tenantIds = new Set<string>(account.tenantId ? [account.tenantId] : []);
  const email = account.email.trim().toLowerCase();
  if (!email) return tenantIds;
  const rows = await database().query<{ data: Array<{ id?: unknown; email?: unknown }> }>(
    "SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='tenants'",
    [organizationId],
  );
  const tenants = Array.isArray(rows.rows[0]?.data) ? rows.rows[0].data : [];
  for (const tenant of tenants) {
    if (typeof tenant.id === "string" && typeof tenant.email === "string" && tenant.email.trim().toLowerCase() === email) tenantIds.add(tenant.id);
  }
  return tenantIds;
}

function publicAccount(account: Account): PublicAccount {
  const { salt: _salt, passwordHash: _passwordHash, ...safeAccount } = account;
  const expiry = safeAccount.subscriptionExpiresAt ? Date.parse(safeAccount.subscriptionExpiresAt) : Number.NaN;
  const status = safeAccount.subscriptionStatus === "suspended" ? "suspended" : Number.isFinite(expiry) && expiry <= Date.now() ? "expired" : safeAccount.subscriptionPlan === "free_starter" ? "active" : safeAccount.subscriptionStatus;
  return { ...safeAccount, subscriptionStatus: status, subscriptionRemainingDays: Number.isFinite(expiry) ? Math.max(0, Math.ceil((expiry - Date.now()) / 86_400_000)) : null };
}

async function accountWithOrganizationPlan(account: Account): Promise<Account> {
  if (account.role === "super_admin" || account.role === "platform_admin") return account;
  const accountHasCurrentPlan = account.subscriptionPlan && account.subscriptionExpiresAt && Number.isFinite(Date.parse(account.subscriptionExpiresAt)) && Date.parse(account.subscriptionExpiresAt) > Date.now() && account.subscriptionStatus !== "suspended";
  if ((accountHasCurrentPlan && account.role !== "property_manager" && !(account.role === "estate_agent" && account.organizationId)) || account.role === "landlord_owner" || (account.role === "estate_agent" && !account.organizationId)) return account;
  const organizationId = await resolveOrganization(account);
  const store = await readStore();
  const owner = store.users.find((user) => user.role === "landlord_owner" && (user.organizationId ?? "rentwise-default") === organizationId && user.active);
  if (!owner) return account;
  return { ...account, landlordCode: owner.landlordCode, subscriptionPlan: owner.subscriptionPlan, subscriptionInterval: owner.subscriptionInterval, subscriptionStartAt: owner.subscriptionStartAt, subscriptionDurationDays: owner.subscriptionDurationDays, subscriptionExpiresAt: owner.subscriptionExpiresAt, subscriptionStatus: owner.subscriptionStatus, subscriptionLastNotifiedAt: owner.subscriptionLastNotifiedAt };
}

function normalizeSubscriptionAccount(account: Account, now = Date.now()) {
  if (!account.subscriptionPlan || account.subscriptionPlan === "free_starter") {
    delete account.subscriptionStartAt; delete account.subscriptionDurationDays; delete account.subscriptionExpiresAt; delete account.subscriptionStatus; delete account.subscriptionLastNotifiedAt;
    return account;
  }
  const durationDays = Number.isInteger(account.subscriptionDurationDays) && Number(account.subscriptionDurationDays) > 0 ? Number(account.subscriptionDurationDays) : getSubscriptionDuration(account);
  const expiryAt = account.subscriptionExpiresAt && Number.isFinite(Date.parse(account.subscriptionExpiresAt)) ? account.subscriptionExpiresAt : subscriptionExpiry(new Date(now).toISOString(), durationDays);
  const startAt = account.subscriptionStartAt && Number.isFinite(Date.parse(account.subscriptionStartAt)) ? account.subscriptionStartAt : new Date(Date.parse(expiryAt) - durationDays * 86_400_000).toISOString();
  account.subscriptionStartAt = startAt;
  account.subscriptionDurationDays = durationDays;
  account.subscriptionExpiresAt = expiryAt;
  account.subscriptionStatus = account.subscriptionStatus === "suspended" ? "suspended" : Date.parse(expiryAt) <= now ? "expired" : "active";
  return account;
}

async function hasActivePlan(account: Account) {
  if (account.role === "super_admin" || account.role === "platform_admin") return true;
  const withPlan = normalizeSubscriptionAccount(await accountWithOrganizationPlan(account));
  const planId = normalizePlanId(withPlan.subscriptionPlan);
  if (!planId || account.role === "estate_agent" && planId === "free_starter") return false;
  if (planId === "free_starter") return true;
  return Boolean(withPlan.subscriptionExpiresAt && Number.isFinite(Date.parse(withPlan.subscriptionExpiresAt)) && Date.parse(withPlan.subscriptionExpiresAt) > Date.now() && withPlan.subscriptionStatus !== "suspended");
}

function subscriptionExpiry(startAt: string, durationDays: number) {
  return new Date(Date.parse(startAt) + durationDays * 86_400_000).toISOString();
}

function getSubscriptionDuration(account: Pick<Account, "subscriptionDurationDays" | "subscriptionInterval">) {
  return account.subscriptionDurationDays ?? (account.subscriptionInterval === "annually" ? 365 : 30);
}

async function syncSubscriptionRow(client: PoolClient, account: Account) {
  normalizeSubscriptionAccount(account);
  if (!account.subscriptionPlan || account.subscriptionPlan === "free_starter") {
    await client.query("DELETE FROM rentwise_user_subscriptions WHERE user_id=$1", [account.id]);
    return;
  }
  await client.query(`INSERT INTO rentwise_user_subscriptions(user_id,plan_id,start_date,duration_days,expiry_date,subscription_status,last_notified_at)
    VALUES($1,$2,$3::timestamptz,$4,$5::timestamptz,$6,$7::timestamptz)
    ON CONFLICT(user_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,start_date=EXCLUDED.start_date,duration_days=EXCLUDED.duration_days,expiry_date=EXCLUDED.expiry_date,subscription_status=EXCLUDED.subscription_status,last_notified_at=EXCLUDED.last_notified_at,updated_at=now()`,
  [account.id, normalizePlanId(account.subscriptionPlan) ?? account.subscriptionPlan, account.subscriptionStartAt, account.subscriptionDurationDays, account.subscriptionExpiresAt, account.subscriptionStatus, account.subscriptionLastNotifiedAt ?? null]);
}

async function readStore(): Promise<UserStore> {
  await ensureDatabase();
  const query = await database().query<{ account: Account }>("SELECT account FROM rentwise_users ORDER BY created_at");
  if (query.rows.length) return { users: query.rows.map((row) => row.account.role === "resident_tenant" || row.account.role === "estate_agent" && !row.account.organizationId ? row.account : ({ organizationId: "rentwise-default", ...row.account })) };
  // One-time import keeps existing Super Admin credentials usable after PostgreSQL is configured.
  try {
    const contents = await readFile(userFile, "utf8");
    const store = JSON.parse(contents) as UserStore;
    if (Array.isArray(store.users) && store.users.length) await withTransaction(async (client) => {
      const current = await client.query("SELECT 1 FROM rentwise_users LIMIT 1");
      if (!current.rowCount) for (const user of store.users) {
        if (user.role !== "resident_tenant" && !(user.role === "estate_agent" && !user.organizationId)) user.organizationId ??= "rentwise-default";
        await client.query("INSERT INTO rentwise_users(id,email,role,active,account,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (id) DO NOTHING", [user.id, user.email, user.role, user.active, JSON.stringify(user), user.createdAt]);
      }
    });
    return Array.isArray(store.users) ? store : { users: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { users: [] };
    throw error;
  }
}

async function updateStore<T>(update: (store: UserStore, client: PoolClient) => T | Promise<T>): Promise<T> {
  const operation = mutationQueue.then(async () => withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(7193001)");
    const query = await client.query<{ account: Account }>("SELECT account FROM rentwise_users FOR UPDATE");
    const store: UserStore = { users: query.rows.map((row) => row.account) };
    const result = await update(store, client);
    const activeIds = new Set(store.users.map((user) => user.id));
    await client.query("DELETE FROM rentwise_users WHERE NOT (id = ANY($1::text[]))", [store.users.length ? [...activeIds] : ["__no-users__"]]);
    for (const user of store.users) {
      await syncSubscriptionRow(client, user);
      await client.query("INSERT INTO rentwise_users(id,email,role,active,account,created_at,updated_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,now()) ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email,role=EXCLUDED.role,active=EXCLUDED.active,account=EXCLUDED.account,updated_at=now()", [user.id, user.email, user.role, user.active, JSON.stringify(user), user.createdAt]);
    }
    return result;
  }));
  mutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function savePendingTenantApplication(client: PoolClient, organizationId: string, landlord: Account, account: Account, phone?: unknown) {
  const normalizedPhone = typeof phone === "string" ? phone.replace(/\D/g, "").slice(0, 11) : "";
  await client.query(
    `INSERT INTO rentwise_tenant_applications(id,organization_id,landlord_id,account_id,applicant_name,email,phone)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(landlord_id,account_id) DO UPDATE SET applicant_name=EXCLUDED.applicant_name,email=EXCLUDED.email,phone=EXCLUDED.phone
     WHERE rentwise_tenant_applications.status='Pending'`,
    [randomUUID(), organizationId, landlord.id, account.id, account.name, account.email, normalizedPhone],
  );
}

function makeLandlordCode(users: Account[]) {
  let code = "";
  do { code = `RW-${randomBytes(4).toString("hex").toUpperCase()}`; }
  while (users.some((user) => user.role === "landlord_owner" && user.landlordCode === code));
  return code;
}

async function ensureLandlordCodes() {
  const store = await readStore();
  if (!store.users.some((user) => user.role === "landlord_owner" && !user.landlordCode)) return;
  await updateStore((current) => {
    for (const user of current.users) if (user.role === "landlord_owner" && !user.landlordCode) user.landlordCode = makeLandlordCode(current.users);
  });
}

function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeLandlordCode(value: unknown) {
  return typeof value === "string" ? value.trim().toUpperCase().replace(/[\s-]/g, "") : "";
}

function landlordMatchesCode(users: Account[], value: unknown) {
  const code = normalizeLandlordCode(value);
  if (!code) return undefined;
  return users.find((user) => user.role === "landlord_owner" && user.landlordCode && normalizeLandlordCode(user.landlordCode) === code);
}

async function findTenantRecordByIdentity(organizationId: string, email: string, phone?: unknown) {
  const rows = await database().query<{ data: Array<{ id: string; email?: string; phone?: string }> }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='tenants'", [organizationId]);
  const tenants = rows.rows[0]?.data ?? [];
  const emailMatches = tenants.filter((tenant) => email && normalizeEmail(tenant.email) === email);
  const digits = typeof phone === "string" ? phone.replace(/\D/g, "") : "";
  const phoneMatches = digits.length >= 7 ? tenants.filter((tenant) => typeof tenant.phone === "string" && tenant.phone.replace(/\D/g, "") === digits) : [];
  if (emailMatches.length === 1) {
    const emailMatch = emailMatches[0];
    if (digits && typeof emailMatch.phone === "string" && emailMatch.phone.replace(/\D/g, "") !== digits) return undefined;
    if (phoneMatches.length === 1 && phoneMatches[0].id !== emailMatch.id) return undefined;
    return emailMatch.id;
  }
  if (emailMatches.length > 1) {
    const intersection = emailMatches.filter((tenant) => phoneMatches.some((match) => match.id === tenant.id));
    return intersection.length === 1 ? intersection[0].id : undefined;
  }
  return phoneMatches.length === 1 ? phoneMatches[0].id : undefined;
}

async function findTenantOrganization(tenantId: string) {
  if (!tenantId) return undefined;
  const rows = await database().query<{ organization_id: string; data: Array<{ id: string }> }>("SELECT organization_id,data FROM rentwise_app_data WHERE collection='tenants'");
  return rows.rows.find((row) => row.data?.some((tenant) => tenant.id === tenantId))?.organization_id;
}

function validateAccountInput(body: Record<string, unknown>, requirePasswordConfirmation = false) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  if (name.length < 2 || name.length > 100) throw new Error("Enter a name between 2 and 100 characters.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
  if (password.length < 12 || password.length > 200) throw new Error("Use a password between 12 and 200 characters.");
  if (requirePasswordConfirmation && (typeof body.confirmPassword !== "string" || body.confirmPassword !== password)) throw Object.assign(new Error("Password and confirmation do not match."), { status: 400 });
  return { name, email, password };
}

function makeAccount(input: { name: string; email: string; password: string; role: RoleId; tenantId?: string }): Account {
  const salt = randomBytes(16).toString("hex");
  const passwordHash = scryptSync(input.password, salt, 64).toString("hex");
  return {
    id: randomUUID(),
    name: input.name,
    email: input.email,
    role: input.role,
    tenantId: input.role === "resident_tenant" ? input.tenantId : undefined,
    organizationId: input.role === "landlord_owner" ? randomUUID() : undefined,
    active: true,
    emailVerified: true,
    salt,
    passwordHash,
    createdAt: new Date().toISOString(),
  };
}

async function resolveOrganization(account: Account) {
  if (account.organizationId) return account.organizationId;
  if (account.role === "estate_agent") return `estate-agent-${account.id}`;
  if (account.role === "resident_tenant" && account.tenantId) {
    await ensureDatabase();
    const organizations = await database().query<{ organization_id: string; data: Array<{ id: string }> }>("SELECT organization_id,data FROM rentwise_app_data WHERE collection='tenants'");
    const match = organizations.rows.find((row) => Array.isArray(row.data) && row.data.some((tenant) => tenant.id === account.tenantId));
    if (match) return match.organization_id;
  }
  return "rentwise-default";
}

function passwordMatches(password: string, account: Account) {
  const candidate = scryptSync(password, account.salt, 64);
  const stored = Buffer.from(account.passwordHash, "hex");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

function getCookie(request: IncomingMessage, cookieName: string) {
  const cookie = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(cookieName + "="));
  return cookie ? decodeURIComponent(cookie.slice(cookieName.length + 1)) : "";
}

function setSessionCookie(response: ServerResponse, request: IncomingMessage, token: string) {
  const secure = process.env.NODE_ENV === "production" || Boolean((request.socket as IncomingMessage["socket"] & { encrypted?: boolean }).encrypted);
  response.setHeader("Set-Cookie", `rentwise_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
}

function clearSessionCookie(response: ServerResponse, request: IncomingMessage) {
  const secure = process.env.NODE_ENV === "production" || Boolean((request.socket as IncomingMessage["socket"] & { encrypted?: boolean }).encrypted);
  response.setHeader("Set-Cookie", `rentwise_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`);
}

function send(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

async function requireCollectionRevision(client: PoolClient, organizationId: string, collection: string, expectedRevision: unknown) {
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) {
    throw Object.assign(new Error("This workspace needs to refresh its saved data version before saving. Reload the page and retry."), { status: 428 });
  }
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${organizationId}:${collection}`]);
  const current = await client.query<{ revision: string }>("SELECT revision::text FROM rentwise_app_data WHERE organization_id=$1 AND collection=$2 FOR UPDATE", [organizationId, collection]);
  const actualRevision = current.rows[0] ? Number(current.rows[0].revision) : 0;
  if (Number(expectedRevision) !== actualRevision) {
    throw Object.assign(new Error("This record set changed after you opened it. Reload the workspace to get the latest data, then reapply your change."), { status: 409 });
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16 * 1024 * 1024) throw new Error("Request is too large (maximum 16 MB).");
    chunks.push(buffer);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid request body.");
  return body as Record<string, unknown>;
}

let configuredSubscriptionPlans: SubscriptionPlanConfig[] = subscriptionPlans.map((plan) => ({ ...plan, limits: { ...plan.limits }, features: { ...plan.features }, bullets: [...plan.bullets] }));
let planCatalogLoad: Promise<void> | undefined;

function applyPlanCatalogEdits(input: unknown, current: SubscriptionPlanConfig[]): SubscriptionPlanConfig[] {
  if (!Array.isArray(input) || input.length !== current.length) throw Object.assign(new Error("Submit all five RentWise plans together."), { status: 400 });
  const updated = current.map((plan) => {
    const item = input.find((candidate) => candidate && typeof candidate === "object" && (candidate as Record<string, unknown>).id === plan.id) as Record<string, unknown> | undefined;
    if (!item || !item.limits || typeof item.limits !== "object" || Array.isArray(item.limits)) throw Object.assign(new Error(`Plan settings are missing for ${plan.name}.`), { status: 400 });
    const validPrice = (value: unknown, label: string) => {
      if (value === null) return null;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) throw Object.assign(new Error(`${label} must be a whole Naira amount between 0 and 1,000,000,000, or blank for custom pricing.`), { status: 400 });
      if (plan.id !== "free_starter" && value === 0) throw Object.assign(new Error(`${label} must be greater than zero for a paid plan. Use blank for custom pricing.`), { status: 400 });
      return value;
    };
    const limits = { ...(item.limits as Record<string, unknown>) };
    const limitKeys: PlanLimitKey[] = ["properties", "units", "tenants", "staff", "storageMb", "monthlyNotifications"];
    const cleanLimits = {} as Record<PlanLimitKey, number | null>;
    for (const key of limitKeys) {
      const value = limits[key];
      if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000)) throw Object.assign(new Error(`${plan.name}: ${key} must be a whole number of 0 or more, or blank for unlimited.`), { status: 400 });
      cleanLimits[key] = value as number | null;
    }
    return { ...plan, monthlyPrice: validPrice(item.monthlyPrice, `${plan.name} monthly price`), annualPrice: validPrice(item.annualPrice, `${plan.name} annual price`), limits: cleanLimits };
  });
  const freeStarter = updated.find((plan) => plan.id === "free_starter");
  if (freeStarter && (freeStarter.monthlyPrice === 0) !== (freeStarter.annualPrice === 0)) throw Object.assign(new Error("Free Starter must be priced at ₦0 for both terms or priced for both terms."), { status: 400 });
  return updated;
}

async function loadPlanCatalog() {
  if (!planCatalogLoad) planCatalogLoad = (async () => {
    await ensureDatabase();
    const saved = await database().query<{ plans: unknown }>("SELECT plans FROM rentwise_plan_catalog WHERE catalog_id='default'");
    if (!saved.rowCount) {
      await database().query("INSERT INTO rentwise_plan_catalog(catalog_id,plans) VALUES('default',$1::jsonb) ON CONFLICT DO NOTHING", [JSON.stringify(configuredSubscriptionPlans)]);
      return;
    }
    configuredSubscriptionPlans = applyPlanCatalogEdits(saved.rows[0].plans, configuredSubscriptionPlans);
  })().catch((error) => { planCatalogLoad = undefined; throw error; });
  await planCatalogLoad;
}

function getConfiguredPlan(planId: StoredPlanId | string | undefined) {
  const normalized = normalizePlanId(planId);
  return configuredSubscriptionPlans.find((plan) => plan.id === normalized);
}

function effectivePlan(account: Account) { return getConfiguredPlan(account.subscriptionPlan); }

function accountCountsAsStaff(account: Account, organizationId: string) {
  return (account.organizationId ?? "rentwise-default") === organizationId && account.active && ["property_manager", "estate_agent"].includes(account.role);
}

function paystackSecret() { return process.env.PAYSTACK_SECRET_KEY?.trim(); }

function constantTimeHexMatch(expectedHex: string, suppliedHex: string) {
  if (!/^[0-9a-f]{128}$/i.test(suppliedHex)) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const supplied = Buffer.from(suppliedHex, "hex");
  return supplied.length === expected.length && timingSafeEqual(expected, supplied);
}

function verifyPaystackWebhookSignature(rawBody: Buffer, headers: IncomingMessage["headers"]) {
  const currentHeader = headers["paystack-signature"];
  if (typeof currentHeader === "string") {
    const fields = currentHeader.split(",").map((field) => field.trim());
    const timestamps = fields.filter((field) => field.startsWith("t=")).map((field) => field.slice(2));
    const timestamp = timestamps.length === 1 && /^\d+$/.test(timestamps[0]) ? Number(timestamps[0]) : Number.NaN;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const signedValues = fields.filter((field) => field.startsWith("v1=")).map((field) => field.slice(3).split(":").at(-1) ?? "");
    const webhookSecrets = (process.env.PAYSTACK_WEBHOOK_SECRET ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    if (Number.isFinite(timestamp) && Math.abs(nowSeconds - timestamp) <= 300 && signedValues.length && webhookSecrets.length) {
      for (const signingSecret of webhookSecrets) {
        const expected = createHmac("sha512", signingSecret).update(`${timestamp}.`).update(rawBody).digest("hex");
        if (signedValues.some((signature) => constantTimeHexMatch(expected, signature))) return true;
      }
    }
  }
  const legacyHeader = headers["x-paystack-signature"];
  const legacySecret = paystackSecret();
  if (typeof legacyHeader !== "string" || !legacySecret || !/^[0-9a-f]{128}$/i.test(legacyHeader)) return false;
  const expectedLegacy = createHmac("sha512", legacySecret).update(rawBody).digest("hex");
  return constantTimeHexMatch(expectedLegacy, legacyHeader);
}

async function verifyPaystackSubscription(reference: string) {
  const secret = paystackSecret();
  if (!secret) throw Object.assign(new Error("Subscription payments are not configured. Add PAYSTACK_SECRET_KEY to the server .env and restart RentWise."), { status: 503 });
  const payment = await database().query<{ user_id: string; plan_id: SubscriptionPlanId; billing_interval: SubscriptionInterval; amount_kobo: string; status: string }>(
    "SELECT user_id,plan_id,billing_interval,amount_kobo,status FROM rentwise_subscription_payments WHERE reference=$1",
    [reference],
  );
  const saved = payment.rows[0];
  if (!saved) throw Object.assign(new Error("Subscription payment reference was not found."), { status: 404 });
  if (saved.status === "success") return { ok: true, alreadyProcessed: true };
  const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15_000) });
  const result = await response.json().catch(() => ({})) as { status?: boolean; message?: string; data?: { status?: string; reference?: string; amount?: number; currency?: string; paid_at?: string | null } };
  const verified = result.data;
  if (response.status === 429 || response.status >= 500) throw Object.assign(new Error("Paystack verification is temporarily unavailable. The event will be retried."), { status: 503 });
  if (!response.ok || !result.status || !verified || verified.status !== "success" || verified.reference !== reference || verified.amount !== Number(saved.amount_kobo) || verified.currency !== "NGN") {
    await database().query("UPDATE rentwise_subscription_payments SET status=CASE WHEN status='success' THEN status ELSE 'failed' END,updated_at=now() WHERE reference=$1", [reference]);
    throw Object.assign(new Error(result.message || "Paystack could not verify this subscription payment. No plan was activated."), { status: 402 });
  }
  await withTransaction(async (client) => {
    const paymentNow = await client.query<{ status: string; user_id: string; plan_id: SubscriptionPlanId; billing_interval: SubscriptionInterval }>("SELECT status,user_id,plan_id,billing_interval FROM rentwise_subscription_payments WHERE reference=$1 FOR UPDATE", [reference]);
    const current = paymentNow.rows[0];
    if (!current) throw Object.assign(new Error("Subscription payment reference was not found."), { status: 404 });
    if (current.status === "success") return;
    const userResult = await client.query<{ account: Account }>("SELECT account FROM rentwise_users WHERE id=$1 FOR UPDATE", [current.user_id]);
    const account = userResult.rows[0]?.account;
    if (!account || !account.active || account.role !== "landlord_owner" && !(account.role === "estate_agent" && !account.organizationId)) throw Object.assign(new Error("This subscription account is unavailable. Contact RentWise support."), { status: 409 });
    const now = Date.now();
    const oldExpiry = account.subscriptionPlan === current.plan_id && account.subscriptionExpiresAt ? Date.parse(account.subscriptionExpiresAt) : Number.NaN;
    const start = new Date(Number.isFinite(oldExpiry) && oldExpiry > now ? oldExpiry : now);
    const durationDays = current.billing_interval === "annually" ? 365 : 30;
    account.subscriptionPlan = current.plan_id;
    account.subscriptionInterval = current.billing_interval;
    account.subscriptionStartAt = start.toISOString();
    account.subscriptionDurationDays = durationDays;
    account.subscriptionExpiresAt = subscriptionExpiry(account.subscriptionStartAt, durationDays);
    account.subscriptionStatus = "active";
    delete account.subscriptionLastNotifiedAt;
    await client.query("DELETE FROM rentwise_subscription_notifications WHERE user_id=$1", [account.id]);
    await syncSubscriptionRow(client, account);
    await client.query("UPDATE rentwise_users SET account=$2::jsonb,updated_at=now() WHERE id=$1", [account.id, JSON.stringify(account)]);
    await client.query("UPDATE rentwise_subscription_payments SET status='success',paid_at=COALESCE($2::timestamptz,now()),updated_at=now() WHERE reference=$1", [reference, verified.paid_at ?? null]);
  });
  return { ok: true, alreadyProcessed: false };
}

let paystackWebhookQueueRunning = false;

async function processPaystackWebhookQueue() {
  if (paystackWebhookQueueRunning) return;
  paystackWebhookQueueRunning = true;
  try {
    await ensureDatabase();
    await database().query("UPDATE rentwise_paystack_webhook_events SET status='pending',updated_at=now() WHERE status='processing' AND updated_at < now()-interval '5 minutes'");
    const claimed = await withTransaction(async (client) => {
      const pending = await client.query<{ id: string; reference: string; attempts: number }>(
        "SELECT id,reference,attempts FROM rentwise_paystack_webhook_events WHERE status='pending' AND attempts < 10 ORDER BY received_at LIMIT 20 FOR UPDATE SKIP LOCKED",
      );
      for (const event of pending.rows) {
        await client.query("UPDATE rentwise_paystack_webhook_events SET status='processing',attempts=attempts+1,updated_at=now() WHERE id=$1", [event.id]);
      }
      return pending.rows.map((event) => ({ ...event, attempts: event.attempts + 1 }));
    });
    for (const event of claimed) {
      try {
        await verifyPaystackSubscription(event.reference);
        await database().query("UPDATE rentwise_paystack_webhook_events SET status='processed',last_error=NULL,updated_at=now() WHERE id=$1", [event.id]);
      } catch (error) {
        const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : 500;
        const retry = (status === 429 || status >= 500) && event.attempts < 10;
        const detail = error instanceof Error ? error.message.slice(0, 500) : "Webhook event processing failed.";
        await database().query("UPDATE rentwise_paystack_webhook_events SET status=$2,last_error=$3,updated_at=now() WHERE id=$1", [event.id, retry ? "pending" : "failed", detail]);
        console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", service: "worker", event: "paystack_webhook_event_failed", reference: event.reference, attempt: event.attempts, retry, message: detail }));
      }
    }
  } finally {
    paystackWebhookQueueRunning = false;
  }
}

function isRole(value: unknown): value is RoleId {
  return typeof value === "string" && roleIds.includes(value as RoleId);
}

async function getSessionAccount(request: IncomingMessage) {
  const token = getCookie(request, "rentwise_session");
  if (!token) return undefined;
  await ensureDatabase();
  const session = await database().query<{ user_id: string }>("UPDATE rentwise_sessions SET expires_at=now()+($2 * interval '1 second') WHERE token_hash=$1 AND expires_at > now() RETURNING user_id", [hashSessionToken(token), sessionLifetimeSeconds]);
  if (!session.rowCount) return undefined;
  const store = await readStore();
  const account = store.users.find((item) => item.id === session.rows[0].user_id && item.active);
  if (!account) { await deleteSession(token); return undefined; }
  return normalizeSubscriptionAccount(account);
}

function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function createSession(userId: string) {
  await ensureDatabase();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionLifetimeSeconds * 1000);
  await database().query("DELETE FROM rentwise_sessions WHERE expires_at <= now()");
  await database().query("INSERT INTO rentwise_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)", [hashSessionToken(token), userId, expiresAt]);
  return token;
}

function accountEmailIsConfigured() {
  if (!process.env.RESEND_API_KEY || !process.env.RENTWISE_EMAIL_FROM || !process.env.RENTWISE_PUBLIC_URL) return false;
  try {
    const url = new URL(process.env.RENTWISE_PUBLIC_URL.trim());
    return !url.username && !url.password && !url.search && !url.hash && (process.env.NODE_ENV !== "production" || url.protocol === "https:");
  } catch { return false; }
}

function getPublicAppUrl() {
  const configured = process.env.RENTWISE_PUBLIC_URL?.trim();
  if (!configured) throw Object.assign(new Error("Account email is not configured. Set RESEND_API_KEY, RENTWISE_EMAIL_FROM, and RENTWISE_PUBLIC_URL on the server."), { status: 503 });
  let base: URL;
  try { base = new URL(configured); }
  catch { throw Object.assign(new Error("RENTWISE_PUBLIC_URL must be a valid public URL."), { status: 503 }); }
  if (base.username || base.password || base.search || base.hash || (process.env.NODE_ENV === "production" && base.protocol !== "https:")) {
    throw Object.assign(new Error("RENTWISE_PUBLIC_URL must be an HTTPS origin in production, without credentials, query, or fragment."), { status: 503 });
  }
  return base.origin;
}

function escapeEmailHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
}

async function sendAccountEmail(to: string, subject: string, html: string, text: string) {
  if (!accountEmailIsConfigured()) throw Object.assign(new Error("Account email is not configured. Set RESEND_API_KEY, RENTWISE_EMAIL_FROM, and RENTWISE_PUBLIC_URL on the server."), { status: 503 });
  const result = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.RENTWISE_EMAIL_FROM, to: [to], subject, html, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!result.ok) {
    const details = await result.json().catch(() => ({})) as { message?: string };
    console.error("RentWise account email delivery failed:", result.status, details.message ?? "Provider rejected the request.");
    throw Object.assign(new Error("RentWise could not send the account email. Check the email provider setup and try again."), { status: 502 });
  }
}

function checkAccountFlowRateLimit(address: string) {
  const now = Date.now();
  const current = accountFlowAttempts.get(address);
  if (current && now - current.startedAt < 60 * 60 * 1000 && current.count >= 5) {
    throw Object.assign(new Error("Too many account recovery requests. Wait an hour and try again."), { status: 429 });
  }
  if (!current || now - current.startedAt >= 60 * 60 * 1000) accountFlowAttempts.set(address, { count: 1, startedAt: now });
  else current.count += 1;
}

async function issueAccountToken(account: Account, purpose: "verify_email" | "password_reset") {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + (purpose === "password_reset" ? 30 : 24 * 60) * 60_000);
  await withTransaction(async (client) => {
    await client.query("DELETE FROM rentwise_account_tokens WHERE user_id=$1 AND purpose=$2", [account.id, purpose]);
    await client.query("INSERT INTO rentwise_account_tokens(token_hash,user_id,purpose,expires_at) VALUES($1,$2,$3,$4)", [hashSessionToken(token), account.id, purpose, expiresAt]);
  });
  const action = purpose === "password_reset" ? "reset-password" : "verify-email";
  const link = new URL("/", getPublicAppUrl());
  link.hash = new URLSearchParams({ authAction: action, token }).toString();
  const safeName = escapeEmailHtml(account.name);
  const safeLink = escapeEmailHtml(link.toString());
  const subject = purpose === "password_reset" ? "Reset your RentWise password" : "Verify your RentWise email";
  const instruction = purpose === "password_reset" ? "This link expires in 30 minutes and can only be used once." : "This link expires in 24 hours and can only be used once.";
  const actionLabel = purpose === "password_reset" ? "Reset password" : "Verify email address";
  await sendAccountEmail(account.email, subject, `<p>Hello ${safeName},</p><p>${actionLabel} for your RentWise account by opening this link:</p><p><a href="${safeLink}">${actionLabel}</a></p><p>${instruction}</p><p>If you did not request this, you can ignore this email.</p>`, `Hello ${account.name},\n\n${actionLabel}: ${link}\n\n${instruction}\nIf you did not request this, ignore this email.`);
}

async function deleteSession(token: string) {
  if (!token) return;
  await ensureDatabase();
  await database().query("DELETE FROM rentwise_sessions WHERE token_hash=$1", [hashSessionToken(token)]);
}

function requireSuperAdmin(account: Account | undefined) {
  if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
  if (account.role !== "super_admin") throw Object.assign(new Error("Only the Super Administrator can manage role assignments."), { status: 403 });
}

function checkLoginRateLimit(address: string) {
  const now = Date.now();
  const current = loginAttempts.get(address);
  if (current && now - current.startedAt < 15 * 60 * 1000 && current.count >= 10) {
    throw Object.assign(new Error("Too many sign-in attempts. Wait 15 minutes and try again."), { status: 429 });
  }
  if (!current || now - current.startedAt >= 15 * 60 * 1000) loginAttempts.set(address, { count: 1, startedAt: now });
  else current.count += 1;
}

type StoredTenantForReminder = {
  id?: unknown;
  name?: unknown;
  phone?: unknown;
  propertyId?: unknown;
  expirationDate?: unknown;
  reminderDateOverride?: unknown;
  paymentFrequency?: unknown;
  whatsappRemindersOptIn?: unknown;
};

function reminderToday(timeZone = process.env.RENTWISE_REMINDER_TIMEZONE || "Africa/Lagos") {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function addCalendarMonths(dateKey: string, months: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const monthIndex = month - 1 + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const targetDay = Math.min(day, new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate());
  return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

function serverReminderRule(frequency: unknown) {
  const label = typeof frequency === "string" ? frequency.toLowerCase() : "monthly";
  if (label.includes("year") || label.includes("2 years")) return { leadMonths: 2, leadDays: 0, repeatDays: 14 };
  if (label.includes("3 month") || label.includes("6 month") || label.includes("9 month")) return { leadMonths: 1, leadDays: 0, repeatDays: 7 };
  return { leadMonths: 0, leadDays: 7, repeatDays: 2 };
}

function serverFirstReminderDate(expirationDate: string, frequency: unknown) {
  const rule = serverReminderRule(frequency);
  if (rule.leadDays) return new Date(Date.parse(`${expirationDate}T00:00:00Z`) - rule.leadDays * 86_400_000).toISOString().slice(0, 10);
  return addCalendarMonths(expirationDate, -rule.leadMonths);
}

function reminderIsDue(firstDate: string, expirationDate: string, today: string, repeatDays: number) {
  if (firstDate > today || today > expirationDate) return false;
  const elapsed = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${firstDate}T00:00:00Z`)) / 86_400_000);
  return elapsed % repeatDays === 0;
}

function reminderMessageForTenant(tenant: StoredTenantForReminder, property: Record<string, unknown> | undefined, landlordName: string, savedMessage: unknown) {
  const name = typeof tenant.name === "string" ? tenant.name : "Tenant";
  const propertyName = typeof property?.name === "string" ? property.name : "your property";
  const expiration = typeof tenant.expirationDate === "string" ? new Date(`${tenant.expirationDate}T00:00:00`).toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" }) : "the scheduled date";
  const base = typeof savedMessage === "string" && savedMessage.trim()
    ? savedMessage.trim()
    : `Hello ${name}, this is a reminder that your rent for ${propertyName} expires on ${expiration}. Please contact us to discuss your renewal.`;
  return `${base.replaceAll("{{tenantName}}", name).replaceAll("{{propertyName}}", propertyName).replaceAll("{{expirationDate}}", expiration)} — ${landlordName || "Your landlord"} via RentWise`;
}

function normalizedWhatsAppNumber(phone: unknown) {
  let digits = typeof phone === "string" ? phone.replace(/\D/g, "") : "";
  if (digits.startsWith("0")) digits = `234${digits.slice(1)}`;
  return digits.length >= 10 && digits.length <= 15 ? digits : "";
}

async function sendWhatsAppTemplate(phone: string, templateName: string, language: string, message?: string) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const graphVersion = process.env.WHATSAPP_GRAPH_API_VERSION?.trim();
  if (!phoneNumberId || !accessToken || !templateName || !graphVersion) return { status: "not_configured" as const, error: "WhatsApp Cloud API credentials or message template are not configured." };
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 15_000);
  try {
    const result = await fetch(`https://graph.facebook.com/${encodeURIComponent(graphVersion)}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify({
        messaging_product: "whatsapp", to: phone, type: "template",
        template: { name: templateName, language: { code: language }, ...(message === undefined ? {} : { components: [{ type: "body", parameters: [{ type: "text", text: message.slice(0, 1024) }] }] }) },
      }),
    });
    const body = await result.json().catch(() => ({})) as {
      messages?: Array<{ id?: string }>;
      error?: { message?: string; type?: string; code?: number; error_subcode?: number; error_data?: { details?: string }; fbtrace_id?: string };
    };
    if (!result.ok) {
      const metaError = body.error;
      const code = metaError?.code;
      let messageText = metaError?.message || `WhatsApp returned HTTP ${result.status}.`;
      if (code === 190) messageText = "Meta rejected the access token (error 190). It may be expired, revoked, or invalid; replace it with a valid WhatsApp Business token that has messaging permission.";
      else if (code === 10 || code === 200) messageText = `Meta denied the WhatsApp request (error ${code}). Check that the token has whatsapp_business_messaging permission and access to this WhatsApp Business number.`;
      else if (code === 132001) messageText = "Meta could not find an approved template with this exact name and language. Verify the template name, locale, approval status, and WhatsApp Business account.";
      else if (/authentication error/i.test(messageText)) messageText += " Check that the server .env has a current token with whatsapp_business_messaging access, then restart RentWise.";
      if (metaError?.error_data?.details) messageText += ` Details: ${metaError.error_data.details}`;
      if (code !== undefined) messageText += ` (Meta error ${code}${metaError?.error_subcode !== undefined ? `/${metaError.error_subcode}` : ""})`;
      if (metaError?.fbtrace_id) messageText += ` · Meta trace ID ${metaError.fbtrace_id}`;
      return { status: "failed" as const, error: messageText.slice(0, 1000) };
    }
    return { status: "submitted" as const, providerMessageId: body.messages?.[0]?.id };
  } catch (error) {
    return { status: "failed" as const, error: error instanceof Error && error.name === "AbortError" ? "WhatsApp request timed out." : "Could not reach WhatsApp Cloud API." };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendWhatsAppReminder(phone: string, message: string) {
  const templateName = process.env.WHATSAPP_REMINDER_TEMPLATE_NAME?.trim();
  const language = process.env.WHATSAPP_REMINDER_TEMPLATE_LANGUAGE?.trim() || "en";
  if (!templateName) return { status: "not_configured" as const, error: "The approved rent reminder Utility template is not configured." };
  return sendWhatsAppTemplate(phone, templateName, language, message);
}

function whatsappConfigurationStatus() {
  const phoneNumberIdConfigured = Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID?.trim());
  const accessTokenConfigured = Boolean(process.env.WHATSAPP_ACCESS_TOKEN?.trim());
  const templateConfigured = Boolean(process.env.WHATSAPP_REMINDER_TEMPLATE_NAME?.trim());
  const testTemplateConfigured = Boolean(process.env.WHATSAPP_TEST_TEMPLATE_NAME?.trim());
  const graphVersionConfigured = Boolean(process.env.WHATSAPP_GRAPH_API_VERSION?.trim());
  return {
    configured: phoneNumberIdConfigured && accessTokenConfigured && testTemplateConfigured && graphVersionConfigured,
    phoneNumberIdConfigured,
    accessTokenConfigured,
    templateConfigured: testTemplateConfigured,
    graphVersionConfigured,
    templateName: process.env.WHATSAPP_TEST_TEMPLATE_NAME?.trim() || "",
    templateLanguage: process.env.WHATSAPP_TEST_TEMPLATE_LANGUAGE?.trim() || "en_US",
    reminderTemplateConfigured: templateConfigured,
    reminderTemplateName: process.env.WHATSAPP_REMINDER_TEMPLATE_NAME?.trim() || "",
    reminderTemplateLanguage: process.env.WHATSAPP_REMINDER_TEMPLATE_LANGUAGE?.trim() || "en",
  };
}

let reminderSchedulerTimer: ReturnType<typeof setInterval> | undefined;
let reminderSchedulerRunning = false;
let subscriptionLifecycleInitialized = false;
let subscriptionLifecycleRunning = false;
const whatsappTestLastSent = new Map<string, number>();

async function runScheduledRentReminders() {
  if (reminderSchedulerRunning) return;
  reminderSchedulerRunning = true;
  try {
    await ensureDatabase();
    await loadPlanCatalog();
    const today = reminderToday();
    const tenantRows = await database().query<{ organization_id: string; data: unknown }>("SELECT organization_id,data FROM rentwise_app_data WHERE collection='tenants'");
    const store = await readStore();
    for (const row of tenantRows.rows) {
      const tenants = Array.isArray(row.data) ? row.data as StoredTenantForReminder[] : [];
      if (!tenants.length) continue;
      const [propertyResult, messageResult] = await Promise.all([
        database().query<{ data: unknown }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='properties'", [row.organization_id]),
        database().query<{ data: unknown }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='reminderMessages'", [row.organization_id]),
      ]);
      const properties = Array.isArray(propertyResult.rows[0]?.data) ? propertyResult.rows[0].data as Array<Record<string, unknown>> : [];
      const messages = messageResult.rows[0]?.data && typeof messageResult.rows[0].data === "object" && !Array.isArray(messageResult.rows[0].data) ? messageResult.rows[0].data as Record<string, unknown> : {};
      const landlord = store.users.find((user) => user.role === "landlord_owner" && (user.organizationId ?? "rentwise-default") === row.organization_id);
      const plan = effectivePlan(landlord ?? {} as Account);
      if (!landlord?.active || !plan || !landlord.subscriptionExpiresAt || !Number.isFinite(Date.parse(landlord.subscriptionExpiresAt)) || Date.parse(landlord.subscriptionExpiresAt) <= Date.now() || landlord.subscriptionStatus === "suspended" || plan.features.reminders === "none") continue;
      let monthlyNotificationsUsed = Number((await database().query<{ count: string }>("SELECT count(*)::text AS count FROM rentwise_reminder_notifications WHERE organization_id=$1 AND created_at >= date_trunc('month',now()) AND status NOT IN ('failed','not_configured','not_opted_in')", [row.organization_id])).rows[0]?.count ?? 0);
      for (const tenant of tenants) {
        if (typeof tenant.id !== "string" || typeof tenant.expirationDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(tenant.expirationDate)) continue;
        const rule = serverReminderRule(tenant.paymentFrequency);
        const firstDate = typeof tenant.reminderDateOverride === "string"
          && /^\d{4}-\d{2}-\d{2}$/.test(tenant.reminderDateOverride)
          && tenant.reminderDateOverride <= tenant.expirationDate
          ? tenant.reminderDateOverride
          : serverFirstReminderDate(tenant.expirationDate, tenant.paymentFrequency);
        if (!reminderIsDue(firstDate, tenant.expirationDate, today, rule.repeatDays)) continue;
        if (plan.limits.monthlyNotifications !== null && monthlyNotificationsUsed >= plan.limits.monthlyNotifications) continue;
        const property = properties.find((item) => item.id === tenant.propertyId);
        const message = reminderMessageForTenant(tenant, property, landlord?.name ?? "", messages[tenant.id]);
        const portal = await database().query(
          `INSERT INTO rentwise_reminder_notifications(id,organization_id,tenant_id,reminder_date,channel,status,title,message)
           VALUES($1,$2,$3,$4,'portal','submitted','Rent expiry reminder',$5) ON CONFLICT (organization_id,tenant_id,reminder_date,channel) DO NOTHING`,
          [randomUUID(), row.organization_id, tenant.id, today, message],
        );
        if (portal.rowCount) monthlyNotificationsUsed += 1;
        const isAutomatedReminderPlan = plan.features.reminders === "advanced" || plan.features.reminders === "custom";
        if (!isAutomatedReminderPlan || tenant.whatsappRemindersOptIn !== true || (plan.limits.monthlyNotifications !== null && monthlyNotificationsUsed >= plan.limits.monthlyNotifications)) continue;
        const whatsappStatus = "queued";
        const whatsapp = await database().query(
          `INSERT INTO rentwise_reminder_notifications(id,organization_id,tenant_id,reminder_date,channel,status,title,message)
           VALUES($1,$2,$3,$4,'whatsapp',$5,'Rent expiry reminder',$6)
           ON CONFLICT (organization_id,tenant_id,reminder_date,channel) DO UPDATE SET
             status=CASE WHEN rentwise_reminder_notifications.status IN ('not_configured','not_opted_in') AND EXCLUDED.status='queued' THEN 'queued' ELSE rentwise_reminder_notifications.status END,
             message=EXCLUDED.message,updated_at=now()`,
          [randomUUID(), row.organization_id, tenant.id, today, whatsappStatus, message],
        );
        if (whatsapp.rowCount) monthlyNotificationsUsed += 1;
        if (tenant.whatsappRemindersOptIn !== true) continue;
        const configured = Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_REMINDER_TEMPLATE_NAME && process.env.WHATSAPP_GRAPH_API_VERSION);
        if (!configured) {
          await database().query("UPDATE rentwise_reminder_notifications SET status='not_configured',error='WhatsApp Cloud API credentials or approved template are not configured.',updated_at=now() WHERE organization_id=$1 AND tenant_id=$2 AND reminder_date=$3 AND channel='whatsapp' AND status='queued'", [row.organization_id, tenant.id, today]);
          continue;
        }
        const phone = normalizedWhatsAppNumber(tenant.phone);
        if (!phone) {
          await database().query("UPDATE rentwise_reminder_notifications SET status='failed',error='The tenant phone number is not valid for WhatsApp.',updated_at=now() WHERE organization_id=$1 AND tenant_id=$2 AND reminder_date=$3 AND channel='whatsapp' AND status='queued'", [row.organization_id, tenant.id, today]);
          continue;
        }
        const claim = await database().query<{ id: string }>("UPDATE rentwise_reminder_notifications SET status='sending',error=NULL,updated_at=now() WHERE organization_id=$1 AND tenant_id=$2 AND reminder_date=$3 AND channel='whatsapp' AND status='queued' RETURNING id", [row.organization_id, tenant.id, today]);
        if (!claim.rowCount) continue;
        const delivery = await sendWhatsAppReminder(phone, message);
        await database().query("UPDATE rentwise_reminder_notifications SET status=$2,provider_message_id=$3,error=$4,updated_at=now() WHERE id=$1", [claim.rows[0].id, delivery.status, "providerMessageId" in delivery ? delivery.providerMessageId ?? null : null, "error" in delivery ? delivery.error : null]);
      }
    }
  } finally {
    reminderSchedulerRunning = false;
  }
}

export function startRentWiseBackgroundJobs(keepAlive = true) {
  if (reminderSchedulerTimer) return () => undefined;
  const safeRun = () => {
    void runScheduledRentReminders().catch((error) => console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", service: "worker", event: "rent_reminders_failed", message: error instanceof Error ? error.message : "Unknown database or scheduler error." })));
    void runSubscriptionLifecycle().catch((error) => console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", service: "worker", event: "subscription_lifecycle_failed", message: error instanceof Error ? error.message : "Unknown database or subscription scheduler error." })));
    void processPaystackWebhookQueue().catch((error) => console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", service: "worker", event: "paystack_webhook_queue_failed", message: error instanceof Error ? error.message : "Unknown Paystack webhook queue error." })));
  };
  safeRun();
  reminderSchedulerTimer = setInterval(safeRun, 60_000);
  if (!keepAlive) reminderSchedulerTimer.unref?.();
  return () => {
    if (reminderSchedulerTimer) clearInterval(reminderSchedulerTimer);
    reminderSchedulerTimer = undefined;
  };
}

async function runSubscriptionLifecycle() {
  if (subscriptionLifecycleRunning) return;
  subscriptionLifecycleRunning = true;
  try {
  await ensureDatabase();
  if (!subscriptionLifecycleInitialized) {
    await readStore();
    await updateStore((store) => { for (const user of store.users) normalizeSubscriptionAccount(user); });
    subscriptionLifecycleInitialized = true;
  }
  const expired = await database().query<{ user_id: string }>(`UPDATE rentwise_user_subscriptions SET subscription_status='expired',updated_at=now()
    WHERE subscription_status='active' AND expiry_date <= now() RETURNING user_id`);
  for (const row of expired.rows) {
    await database().query("UPDATE rentwise_users SET account=jsonb_set(account,'{subscriptionStatus}','\"expired\"'::jsonb,true),updated_at=now() WHERE id=$1", [row.user_id]);
  }
  const candidates = await database().query<{ user_id: string; plan_id: string; expiry_date: string; days: number }>(`SELECT user_id,plan_id,expiry_date::text,
    CEIL(EXTRACT(EPOCH FROM (expiry_date-now()))/86400)::integer AS days
    FROM rentwise_user_subscriptions WHERE subscription_status='active' AND expiry_date > now()
      AND expiry_date <= now() + interval '8 days' ORDER BY expiry_date`);
  for (const sub of candidates.rows) {
    const remaining = Math.ceil((Date.parse(sub.expiry_date) - Date.now()) / 86_400_000);
    const milestone = [7, 3, 1].find((days) => remaining === days);
    if (!milestone) continue;
    await database().query(`INSERT INTO rentwise_subscription_notifications(id,user_id,plan_id,expiry_date,days_remaining,title,message)
      VALUES($1,$2,$3,$4::timestamptz,$5,$6,$7) ON CONFLICT(user_id,expiry_date,days_remaining) DO NOTHING`,
    [randomUUID(), sub.user_id, sub.plan_id, sub.expiry_date, milestone, `Subscription expires in ${milestone} ${milestone === 1 ? "day" : "days"}`, `Your RentWise subscription expires on ${new Date(sub.expiry_date).toLocaleDateString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "long" })}. Renew to keep access to your workspace.`]);
    await database().query("UPDATE rentwise_user_subscriptions SET last_notified_at=now(),updated_at=now() WHERE user_id=$1", [sub.user_id]);
    await database().query("UPDATE rentwise_users SET account=jsonb_set(account,'{subscriptionLastNotifiedAt}',to_jsonb(now()::text),true),updated_at=now() WHERE id=$1", [sub.user_id]);
  }
  } finally { subscriptionLifecycleRunning = false; }
}

async function route(request: IncomingMessage, response: ServerResponse) {
  const method = request.method ?? "GET";
  const path = (request.url ?? "/").split("?")[0];
  if (path === "/api/health/live" && method === "GET") {
    send(response, 200, { status: "ok" });
    return;
  }
  if (path === "/api/health/ready" && method === "GET") {
    try {
      await database().query("SELECT 1");
      send(response, 200, { status: "ready" });
    } catch {
      send(response, 503, { status: "not_ready", dependency: "database" });
    }
    return;
  }
  await loadPlanCatalog();

  const agentPhotoRequest = /^\/api\/agent\/property-pool\/[^/]+\/[^/]+\/photo$/i.test(path);
  const agentPoolRequest = method === "GET" && (path === "/api/agent/property-pool" || agentPhotoRequest);
  const authRequest = path.startsWith("/api/auth/");
  const planExempt = authRequest || path.startsWith("/api/billing/") || path.startsWith("/api/subscription/notifications") || path === "/api/plans" || path === "/api/users" || /^\/api\/users\/[0-9a-f-]+$/i.test(path);
  if (!planExempt) {
    const requestingAccount = await getSessionAccount(request);
    if (requestingAccount && path === "/api/admin/whatsapp/test" && requestingAccount.role !== "super_admin") {
      throw Object.assign(new Error("Only the Super Administrator can send a WhatsApp test."), { status: 403 });
    }
    const standaloneAgentWorkspaceRequest = requestingAccount?.role === "estate_agent" && !requestingAccount.organizationId
      && (path === "/api/data" || path === "/api/payment-history/sync" || /^\/api\/attachments\/inspection\/[^/]+$/i.test(path) || /^\/api\/agent\/fees\/[0-9a-f-]+\/confirm$/i.test(path));
    if (requestingAccount?.role === "estate_agent" && !requestingAccount.organizationId && !standaloneAgentWorkspaceRequest && !authRequest && !agentPoolRequest) {
      throw Object.assign(new Error("Join a landlord organization before using its management modules. The Property Pool remains available to Estate Agents."), { status: 403 });
    }
    if (requestingAccount && !(await hasActivePlan(requestingAccount))) {
      throw Object.assign(new Error("An active RentWise plan is required to use this module. Open Plans & Usage to subscribe or ask your landlord to restore the organization plan."), { status: 402 });
    }
    if (requestingAccount?.role === "resident_tenant") {
      const tenantPlan = getConfiguredPlan((await accountWithOrganizationPlan(requestingAccount)).subscriptionPlan);
      if (!tenantPlan?.features.tenantPortal) throw Object.assign(new Error("Tenant portal access is available on Professional plans and above. Ask your landlord to upgrade the organization plan."), { status: 403 });
    }
  }
  if (agentPoolRequest) {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in as an Estate Agent to view the property pool."), { status: 401 });
    if (account.role !== "estate_agent") throw Object.assign(new Error("The property pool is available to Estate Agents only."), { status: 403 });
    if (agentPhotoRequest) {
      const [, organizationId, propertyId] = path.match(/^\/api\/agent\/property-pool\/([^/]+)\/([^/]+)\/photo$/i) ?? [];
      const owner = (await readStore()).users.find((user) => user.role === "landlord_owner" && (user.organizationId ?? "rentwise-default") === decodeURIComponent(organizationId ?? "") && user.active);
      if (!owner) throw Object.assign(new Error("This property’s landlord account is inactive."), { status: 404 });
      const requestedIndex = Number(new URL(request.url ?? "/", "http://localhost").searchParams.get("image") ?? "0");
      if (!Number.isInteger(requestedIndex) || requestedIndex < 0 || requestedIndex > 3) throw Object.assign(new Error("Invalid property photo number."), { status: 400 });
      const property = await database().query<{ data: Array<{ id: string; photoName?: string; photoNames?: string[] }> }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='properties'", [decodeURIComponent(organizationId)]);
      const record = property.rows[0]?.data?.find((item) => item.id === decodeURIComponent(propertyId ?? ""));
      const photoNames = Array.isArray(record?.photoNames) && record.photoNames.length ? record.photoNames : record?.photoName ? [record.photoName] : [];
      if (!record || requestedIndex >= photoNames.length) throw Object.assign(new Error("Property photo not found in the available pool."), { status: 404 });
      const attachmentId = requestedIndex === 0 ? `property-${decodeURIComponent(propertyId ?? "")}` : `property-${decodeURIComponent(propertyId ?? "")}-${requestedIndex + 1}`;
      const photo = await database().query<{ mime_type: string; content: Buffer }>("SELECT mime_type,content FROM rentwise_attachments WHERE organization_id=$1 AND category='profile' AND id=$2", [decodeURIComponent(organizationId), attachmentId]);
      if (!photo.rowCount) { response.statusCode = 204; response.end(); return; }
      response.writeHead(200, { "Content-Type": photo.rows[0].mime_type, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" });
      response.end(photo.rows[0].content);
      return;
    }
    await ensureDatabase();
    const [propertyRows, tenantRows, detailsRows, store] = await Promise.all([
      database().query<{ organization_id: string; data: unknown }>("SELECT organization_id,data FROM rentwise_app_data WHERE collection='properties'"),
      database().query<{ organization_id: string; data: unknown }>("SELECT organization_id,data FROM rentwise_app_data WHERE collection='tenants'"),
      database().query<{ organization_id: string; data: Record<string, unknown> }>("SELECT organization_id,data FROM rentwise_app_data WHERE collection='bankTransferDetails'"),
      readStore(),
    ]);
    const tenantData = new Map(tenantRows.rows.map((row) => [row.organization_id, Array.isArray(row.data) ? row.data as Array<Record<string, unknown>> : []]));
    const organizationDetails = new Map(detailsRows.rows.map((row) => [row.organization_id, row.data]));
    const today = reminderToday();
    const properties = propertyRows.rows.flatMap((row) => {
      const owner = store.users.find((user) => user.role === "landlord_owner" && (user.organizationId ?? "rentwise-default") === row.organization_id && user.active);
      if (!owner) return [];
      const details = organizationDetails.get(row.organization_id) ?? {};
      const propertyList = Array.isArray(row.data) ? row.data as Array<Record<string, unknown>> : [];
      return propertyList.flatMap((property) => {
        const units = Math.max(0, Number.isFinite(Number(property.units)) ? Number(property.units) : 0);
        const todayOccupants = (tenantData.get(row.organization_id) ?? []).filter((tenant) => tenant.propertyId === property.id && (!tenant.expirationDate || String(tenant.expirationDate) >= today)).length;
        const availableUnits = Math.max(0, units - todayOccupants);
        if (!property.id || availableUnits < 1) return [];
        return [{
          id: String(property.id), organizationId: row.organization_id,
          name: String(property.name ?? "Property"), type: String(property.type ?? "Property"), apartmentType: String(property.apartmentType ?? ""), address: String(property.address ?? ""), city: String(property.city ?? ""), state: String(property.state ?? ""), units, availableUnits,
          photoNames: (Array.isArray(property.photoNames) && property.photoNames.length ? property.photoNames : typeof property.photoName === "string" && property.photoName ? [property.photoName] : []).filter((name): name is string => typeof name === "string").slice(0, 4),
          photoUrls: (Array.isArray(property.photoNames) && property.photoNames.length ? property.photoNames : typeof property.photoName === "string" && property.photoName ? [property.photoName] : []).slice(0, 4).map((_, index) => `/api/agent/property-pool/${encodeURIComponent(row.organization_id)}/${encodeURIComponent(String(property.id))}/photo?image=${index}`),
          landlord: { name: String(details.landlordName ?? owner.name), email: owner.email, phone: String(details.landlordPhone ?? "") },
        }];
      });
    });
    send(response, 200, { properties });
    return;
  }

  const agentFeeConfirm = path.match(/^\/api\/agent\/fees\/([0-9a-f-]+)\/confirm$/i);
  if (agentFeeConfirm && method === "POST") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    if (account.role !== "estate_agent") throw Object.assign(new Error("Only Estate Agents can confirm their agent fee records."), { status: 403 });
    await ensureDatabase();
    const organizationId = await resolveOrganization(account);
    const payment = await withTransaction(async (client) => {
      const rows = await client.query<{ data: unknown }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='payments' FOR UPDATE", [organizationId]);
      const records = Array.isArray(rows.rows[0]?.data) ? rows.rows[0].data as Array<Record<string, unknown>> : [];
      const record = records.find((item) => item.id === decodeURIComponent(agentFeeConfirm[1]) && item.transactionType === "Agent fee");
      if (!record) throw Object.assign(new Error("Agent fee record was not found."), { status: 404 });
      if (record.status === "Rejected") throw Object.assign(new Error("Rejected agent fees cannot be marked as received."), { status: 409 });
      const before = { ...record };
      record.status = "Paid";
      record.recordedAt = typeof record.recordedAt === "string" ? record.recordedAt : new Date().toISOString();
      await client.query("INSERT INTO rentwise_app_data(organization_id,collection,data) VALUES($1,'payments',$2::jsonb) ON CONFLICT(organization_id,collection) DO UPDATE SET data=EXCLUDED.data,updated_at=now()", [organizationId, JSON.stringify(records)]);
      await client.query("INSERT INTO rentwise_financial_audit(id,organization_id,collection,transaction_id,reference,action,before_data,after_data,actor_id,actor_name) VALUES($1,$2,'payments',$3,$4,'updated',$5::jsonb,$6::jsonb,$7,$8)", [randomUUID(), organizationId, String(record.id), String(record.reference ?? record.id), JSON.stringify(before), JSON.stringify(record), account.id, account.name]);
      return record;
    });
    send(response, 200, { payment });
    return;
  }

  if (path === "/api/billing/paystack/webhook" && method === "POST") {
    const secret = paystackSecret();
    if (!secret) { send(response, 503, { error: "Paystack webhook is not configured." }); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks);
    if (rawBody.length > 256 * 1024) { send(response, 413, { error: "Webhook payload is too large." }); return; }
    if (!verifyPaystackWebhookSignature(rawBody, request.headers)) { send(response, 401, { error: "Invalid Paystack webhook signature." }); return; }
    let event: { event?: string; data?: { reference?: string } };
    try { event = JSON.parse(rawBody.toString("utf8")) as typeof event; }
    catch { send(response, 400, { error: "Invalid Paystack webhook JSON." }); return; }
    if (event.event === "charge.success") {
      const reference = event.data?.reference;
      if (typeof reference !== "string" || !reference.trim() || reference.length > 100) { send(response, 400, { error: "Paystack charge.success event has no valid reference." }); return; }
      try {
        await ensureDatabase();
        await database().query("INSERT INTO rentwise_paystack_webhook_events(id,event_type,reference,status) VALUES($1,$2,$3,'pending') ON CONFLICT(event_type,reference) DO NOTHING", [randomUUID(), event.event, reference]);
      } catch (error) {
        console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", service: "api", event: "paystack_webhook_persist_failed", reference, message: error instanceof Error ? error.message : "Webhook persistence failed." }));
        send(response, 503, { error: "Webhook could not be safely recorded. Paystack should retry delivery." });
        return;
      }
      send(response, 200, { received: true });
      setImmediate(() => { void processPaystackWebhookQueue().catch((error) => console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", service: "worker", event: "paystack_webhook_queue_failed", message: error instanceof Error ? error.message : "Unknown Paystack webhook queue error." }))); });
      return;
    }
    send(response, 200, { received: true });
    return;
  }

  if (path === "/api/plans" && method === "GET") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to view RentWise plans."), { status: 401 });
    send(response, 200, { plans: configuredSubscriptionPlans });
    return;
  }

  if (path === "/api/plans" && method === "PUT") {
    const account = await getSessionAccount(request);
    requireSuperAdmin(account);
    const body = await readJson(request);
    const updatedPlans = applyPlanCatalogEdits(body.plans, configuredSubscriptionPlans);
    await withTransaction(async (client) => {
      await client.query("INSERT INTO rentwise_plan_catalog(catalog_id,plans) VALUES('default',$1::jsonb) ON CONFLICT(catalog_id) DO UPDATE SET plans=EXCLUDED.plans,updated_at=now()", [JSON.stringify(updatedPlans)]);
    });
    configuredSubscriptionPlans = updatedPlans;
    send(response, 200, { plans: configuredSubscriptionPlans });
    return;
  }

  if (path === "/api/billing/status" && method === "GET") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    if (!["landlord_owner", "property_manager", "super_admin"].includes(account.role) && !(account.role === "estate_agent" && !account.organizationId)) throw Object.assign(new Error("Your role cannot manage subscription status."), { status: 403 });
    const organizationId = await resolveOrganization(account);
    const store = await readStore();
    const billingAccount = account.role === "property_manager" ? store.users.find((user) => user.role === "landlord_owner" && (user.organizationId ?? "rentwise-default") === organizationId && user.active) : account;
    if (!billingAccount) throw Object.assign(new Error("The landlord account for this organization could not be found."), { status: 404 });
    const [payments, collections, notificationCount, attachmentBytes] = await Promise.all([
      database().query<{ reference: string; plan_id: string; billing_interval: string; amount_kobo: string; status: string; created_at: string; paid_at: string | null }>("SELECT reference,plan_id,billing_interval,amount_kobo,status,created_at,paid_at FROM rentwise_subscription_payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20", [billingAccount.id]),
      database().query<{ collection: string; data: unknown }>("SELECT collection,data FROM rentwise_app_data WHERE organization_id=$1 AND collection IN ('properties','tenants')", [organizationId]),
      database().query<{ count: string }>("SELECT count(*)::text AS count FROM rentwise_reminder_notifications WHERE organization_id=$1 AND created_at >= date_trunc('month',now()) AND status NOT IN ('failed','not_configured','not_opted_in')", [organizationId]),
      database().query<{ bytes: string }>("SELECT (COALESCE((SELECT sum(octet_length(content)) FROM rentwise_attachments WHERE organization_id=$1),0)+COALESCE((SELECT sum(octet_length(content)) FROM rentwise_inspection_attachments WHERE organization_id=$1),0))::text AS bytes", [organizationId]),
    ]);
    const properties = collections.rows.find((row) => row.collection === "properties")?.data;
    const tenants = collections.rows.find((row) => row.collection === "tenants")?.data;
    const propertyRecords = Array.isArray(properties) ? properties as Array<Record<string, unknown>> : [];
    const tenantRecords = Array.isArray(tenants) ? tenants : [];
    const staffAccounts = store.users.filter((user) => (user.organizationId ?? "rentwise-default") === organizationId && user.active && ["property_manager", "estate_agent"].includes(user.role)).length;
    const usage = { properties: propertyRecords.filter((item) => item.active !== false && item.isActive !== false).length, units: propertyRecords.filter((item) => item.active !== false && item.isActive !== false).reduce((sum, item) => sum + (Number.isFinite(Number(item.units)) ? Math.max(0, Number(item.units)) : 0), 0), tenants: tenantRecords.length, staff: staffAccounts, storageBytes: Number(attachmentBytes.rows[0]?.bytes ?? 0), notifications: Number(notificationCount.rows[0]?.count ?? 0) };
    send(response, 200, { configured: Boolean(paystackSecret()), subscriptionPlan: billingAccount.subscriptionPlan ?? null, subscriptionInterval: billingAccount.subscriptionInterval ?? null, subscriptionExpiresAt: billingAccount.subscriptionExpiresAt ?? null, usage, payments: payments.rows.map((item) => ({ reference: item.reference, planId: item.plan_id, interval: item.billing_interval, amount: Number(item.amount_kobo) / 100, status: item.status, createdAt: item.created_at, paidAt: item.paid_at })) });
    return;
  }

  if (path === "/api/billing/paystack/test" && method === "POST") {
    const account = await getSessionAccount(request);
    requireSuperAdmin(account);
    const secret = paystackSecret();
    if (!secret) throw Object.assign(new Error("Paystack is not configured. Add the secret key to the server .env, then restart RentWise."), { status: 503 });
    let gatewayResponse: Response;
    try {
      gatewayResponse = await fetch("https://api.paystack.co/transaction/totals", { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw Object.assign(new Error("Could not reach Paystack. Check the server’s internet connection and try again."), { status: 502 });
    }
    const gateway = await gatewayResponse.json().catch(() => ({})) as { status?: boolean; message?: string };
    if (!gatewayResponse.ok || !gateway.status) throw Object.assign(new Error(gateway.message || "Paystack rejected the server credentials. Check that the secret key matches the intended test or live mode."), { status: 502 });
    send(response, 200, { connected: true, message: "Paystack authentication succeeded. No payment was charged." });
    return;
  }

  if (path === "/api/billing/free" && method === "POST") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    if (!["landlord_owner", "property_manager"].includes(account.role)) throw Object.assign(new Error("Only the landlord or an assigned Property Manager can select the Free Starter plan."), { status: 403 });
    const freePlan = getConfiguredPlan("free_starter");
    if (!freePlan || freePlan.monthlyPrice !== 0 || freePlan.annualPrice !== 0) throw Object.assign(new Error("Free Starter has a price. Choose a billing term and subscribe to activate it."), { status: 400 });
    const updated = await updateStore((store) => {
      const owner = store.users.find((user) => user.id === account.id) ?? (account.role === "property_manager" ? store.users.find((user) => user.role === "landlord_owner" && (user.organizationId ?? "rentwise-default") === (account.organizationId ?? "rentwise-default") && user.active) : undefined);
      if (!owner) throw Object.assign(new Error("Landlord account was not found."), { status: 404 });
      owner.subscriptionPlan = "free_starter";
      owner.subscriptionInterval = "monthly";
      normalizeSubscriptionAccount(owner);
      return owner;
    });
    send(response, 200, { user: publicAccount(updated) });
    return;
  }

  if (path === "/api/billing/paystack/initialize" && method === "POST") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    if (!["landlord_owner", "property_manager"].includes(account.role) && !(account.role === "estate_agent" && !account.organizationId)) throw Object.assign(new Error("Subscribe as a landlord, assigned Property Manager, or independent Estate Agent."), { status: 403 });
    const secret = paystackSecret();
    if (!secret) throw Object.assign(new Error("Paystack checkout is not configured yet. Add PAYSTACK_SECRET_KEY to the server .env and restart RentWise."), { status: 503 });
    const body = await readJson(request);
    const planId = body.planId;
    const interval = body.interval;
    const normalizedPlanId = typeof planId === "string" ? normalizePlanId(planId) : undefined;
    const selectedPlan = configuredSubscriptionPlans.find((plan) => plan.id === normalizedPlanId);
    if (!selectedPlan || (interval !== "monthly" && interval !== "annually")) throw Object.assign(new Error("Choose a plan and valid monthly or annual billing term."), { status: 400 });
    if (account.role === "estate_agent" && selectedPlan.id === "free_starter") throw Object.assign(new Error("Estate Agents require the Basic plan or higher."), { status: 400 });
    const amount = interval === "monthly" ? selectedPlan.monthlyPrice : selectedPlan.annualPrice;
    if (amount === null || amount <= 0) throw Object.assign(new Error("This plan or billing term uses custom pricing. Contact RentWise to arrange your subscription."), { status: 400 });
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(amount * 100)) throw Object.assign(new Error("This plan price is outside Paystack’s supported amount range. Update the plan price and try again."), { status: 400 });
    let publicUrl: URL | undefined;
    const configuredPublicUrl = process.env.RENTWISE_PUBLIC_URL?.trim();
    if (configuredPublicUrl) {
      try { publicUrl = new URL(configuredPublicUrl); }
      catch { throw Object.assign(new Error("RENTWISE_PUBLIC_URL must be a valid public application URL."), { status: 503 }); }
      if (publicUrl.protocol !== "https:" && process.env.NODE_ENV === "production") throw Object.assign(new Error("Set RENTWISE_PUBLIC_URL to the public HTTPS application address before enabling production checkout."), { status: 503 });
      if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) throw Object.assign(new Error("RENTWISE_PUBLIC_URL must contain only the public site origin/path, without credentials, query, or fragment."), { status: 503 });
    } else if (process.env.NODE_ENV === "production") {
      throw Object.assign(new Error("Production checkout needs RENTWISE_PUBLIC_URL set to the public HTTPS address, then restart RentWise."), { status: 503 });
    }
    const reference = `RW-SUB-${randomUUID()}`;
    const billingAccount = account.role === "property_manager" ? (await readStore()).users.find((user) => user.role === "landlord_owner" && (user.organizationId ?? "rentwise-default") === (account.organizationId ?? "rentwise-default") && user.active) : account;
    if (!billingAccount) throw Object.assign(new Error("The landlord account for this organization could not be found."), { status: 404 });
    await database().query("INSERT INTO rentwise_subscription_payments(reference,user_id,plan_id,billing_interval,amount_kobo,status) VALUES($1,$2,$3,$4,$5,'pending')", [reference, billingAccount.id, selectedPlan.id, interval, amount * 100]);
    const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost:5173";
    const proto = request.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const callbackUrl = publicUrl ? new URL("/api/billing/paystack/callback", publicUrl).toString() : `${proto}://${host}/api/billing/paystack/callback`;
    let gatewayResponse: Response;
    try {
      gatewayResponse = await fetch("https://api.paystack.co/transaction/initialize", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email: billingAccount.email, amount: String(amount * 100), currency: "NGN", reference, callback_url: callbackUrl, metadata: { rentwise_user_id: billingAccount.id, rentwise_plan_id: selectedPlan.id, rentwise_billing_interval: interval, rentwise_initiated_by: account.id } }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      await database().query("UPDATE rentwise_subscription_payments SET status='failed',updated_at=now() WHERE reference=$1", [reference]);
      throw Object.assign(new Error("Could not reach Paystack. Check the server’s internet connection and try again."), { status: 502 });
    }
    const gateway = await gatewayResponse.json().catch(() => ({})) as { status?: boolean; message?: string; data?: { authorization_url?: string } };
    if (!gatewayResponse.ok || !gateway.status || !gateway.data?.authorization_url) {
      await database().query("UPDATE rentwise_subscription_payments SET status='failed',updated_at=now() WHERE reference=$1", [reference]);
      throw Object.assign(new Error(gateway.message || "Paystack could not start checkout. Check the server payment configuration."), { status: 502 });
    }
    await database().query("UPDATE rentwise_subscription_payments SET authorization_url=$2,updated_at=now() WHERE reference=$1", [reference, gateway.data.authorization_url]);
    send(response, 200, { authorizationUrl: gateway.data.authorization_url, reference, amount, currency: "NGN" });
    return;
  }

  if (path === "/api/billing/paystack/callback" && method === "GET") {
    const query = new URL(request.url ?? "/", "http://localhost").searchParams;
    const reference = query.get("reference") ?? query.get("trxref") ?? "";
    try {
      if (!reference || reference.length > 100) throw Object.assign(new Error("Payment reference is missing or invalid."), { status: 400 });
      await verifyPaystackSubscription(reference);
      response.statusCode = 302;
      response.setHeader("Location", "/?billing=success");
      response.end();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Payment verification failed.";
      response.statusCode = 302;
      response.setHeader("Location", `/?billing=failed&reason=${encodeURIComponent(detail.slice(0, 180))}`);
      response.end();
    }
    return;
  }

  if (path === "/api/auth/google" && method === "GET") {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) { send(response, 503, { error: "Google sign-in is not configured yet." }); return; }
    const query = new URL(request.url ?? "/", "http://localhost").searchParams;
    const mode = query.get("mode") === "signup" ? "signup" : "login";
    const requestedRole = query.get("role");
    const role = requestedRole === "resident_tenant" || requestedRole === "estate_agent" ? requestedRole : "landlord_owner";
    const state = randomBytes(32).toString("base64url");
    for (const [key, flow] of googleFlows) if (flow.expiresAt <= Date.now()) googleFlows.delete(key);
    googleFlows.set(state, { mode, role: mode === "signup" ? role : undefined, landlordCode: mode === "signup" && role === "resident_tenant" ? query.get("landlordCode") ?? undefined : undefined, expiresAt: Date.now() + 10 * 60 * 1000 });
    const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorization.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile", state, prompt: "select_account" }).toString();
    response.statusCode = 302;
    response.setHeader("Location", authorization.toString());
    response.end();
    return;
  }

  if (path === "/api/auth/google/callback" && method === "GET") {
    const query = new URL(request.url ?? "/", "http://localhost").searchParams;
    const state = query.get("state") ?? "";
    const flow = googleFlows.get(state);
    googleFlows.delete(state);
    if (!flow || flow.expiresAt <= Date.now()) { response.writeHead(302, { Location: "/?authError=google_state_invalid" }).end(); return; }
    if (query.has("error")) { response.writeHead(302, { Location: "/?authError=google_cancelled" }).end(); return; }
    const code = query.get("code");
    if (!code) { response.writeHead(302, { Location: "/?authError=google_callback_failed" }).end(); return; }
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!redirectUri || !clientId || !clientSecret) { response.writeHead(302, { Location: "/?authError=google_not_configured" }).end(); return; }
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }) });
    if (!tokenResponse.ok) { response.writeHead(302, { Location: "/?authError=google_callback_failed" }).end(); return; }
    const tokens = await tokenResponse.json() as { access_token?: string };
    if (!tokens.access_token) { response.writeHead(302, { Location: "/?authError=google_callback_failed" }).end(); return; }
    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (!profileResponse.ok) { response.writeHead(302, { Location: "/?authError=google_callback_failed" }).end(); return; }
    const profile = await profileResponse.json() as { email?: string; email_verified?: boolean; name?: string };
    const email = normalizeEmail(profile.email);
    if (!email || profile.email_verified !== true) { response.writeHead(302, { Location: "/?authError=google_email_unverified" }).end(); return; }
    let linkedLandlord: Account | undefined;
    let linkedTenantId: string | undefined;
    if (flow.mode === "signup" && flow.role === "resident_tenant" && flow.landlordCode) {
      await ensureLandlordCodes();
      linkedLandlord = landlordMatchesCode((await readStore()).users, flow.landlordCode);
      if (!linkedLandlord) { response.writeHead(302, { Location: "/?authError=landlord_code_invalid" }).end(); return; }
      linkedTenantId = await findTenantRecordByIdentity(linkedLandlord.organizationId ?? "rentwise-default", email);
    }
    const result = await updateStore(async (store, client) => {
      const existing = store.users.find((item) => item.email === email);
      if (existing) { existing.emailVerified = true; return { account: existing, created: false }; }
      if (flow.mode !== "signup") return { account: undefined, created: false };
      if (!store.users.length) return { account: undefined, created: false };
      const role = flow.role ?? "landlord_owner";
      const randomPassword = randomBytes(48).toString("base64url");
      const account = makeAccount({ name: profile.name?.trim() || email.split("@")[0], email, password: randomPassword, role });
      if (role === "landlord_owner") { account.landlordCode = makeLandlordCode(store.users); account.subscriptionPlan = "free_starter"; account.subscriptionInterval = "monthly"; }
      if (role === "resident_tenant" && linkedLandlord) {
        account.organizationId = linkedLandlord.organizationId ?? "rentwise-default";
        account.landlordId = linkedLandlord.id;
        account.tenantId = linkedTenantId;
        if (!account.tenantId) await savePendingTenantApplication(client, account.organizationId, linkedLandlord, account);
      }
      store.users.push(account);
      return { account, created: true };
    });
    if (!result.account) { response.writeHead(302, { Location: "/?authError=google_signup_required" }).end(); return; }
    if (!result.account.active) { response.writeHead(302, { Location: "/?authError=google_account_disabled" }).end(); return; }
    const sessionToken = await createSession(result.account.id);
    setSessionCookie(response, request, sessionToken);
    const suffix = result.created && result.account.role === "resident_tenant" && !result.account.tenantId ? "?googleTenantLink=pending" : "";
    response.writeHead(302, { Location: `/${suffix}` }).end();
    return;
  }

  if (path === "/api/auth/session" && method === "GET") {
    await ensureLandlordCodes();
    const account = await getSessionAccount(request);
    const store = account ? undefined : await readStore();
    send(response, 200, { user: account ? publicAccount(await accountWithOrganizationPlan(account)) : null, needsSetup: !account && store?.users.length === 0, googleEnabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI), accountEmailEnabled: accountEmailIsConfigured() });
    return;
  }

  if (path === "/api/auth/setup" && method === "POST") {
    const body = await readJson(request);
    const input = validateAccountInput(body, true);
    const account = await updateStore((store) => {
      if (store.users.length) throw Object.assign(new Error("Initial setup has already been completed."), { status: 409 });
      const firstAdmin = { ...makeAccount({ ...input, role: "super_admin" }), organizationId: "rentwise-default" };
      store.users.push(firstAdmin);
      return firstAdmin;
    });
    const token = await createSession(account.id);
    setSessionCookie(response, request, token);
    send(response, 201, { user: publicAccount(account) });
    return;
  }

  if (path === "/api/auth/email/verify" && method === "POST") {
    const body = await readJson(request);
    const token = typeof body.token === "string" ? body.token : "";
    if (token.length < 32 || token.length > 256) throw Object.assign(new Error("This verification link is invalid or expired. Request a new one."), { status: 400 });
    await updateStore(async (store, client) => {
      const tokenResult = await client.query<{ user_id: string }>("SELECT user_id FROM rentwise_account_tokens WHERE token_hash=$1 AND purpose='verify_email' AND used_at IS NULL AND expires_at>now() FOR UPDATE", [hashSessionToken(token)]);
      const tokenRow = tokenResult.rows[0];
      const account = tokenRow && store.users.find((user) => user.id === tokenRow.user_id);
      if (!account) throw Object.assign(new Error("This verification link is invalid or expired. Request a new one."), { status: 400 });
      account.emailVerified = true;
      await client.query("UPDATE rentwise_account_tokens SET used_at=now() WHERE token_hash=$1", [hashSessionToken(token)]);
      await client.query("DELETE FROM rentwise_account_tokens WHERE user_id=$1 AND purpose='verify_email' AND token_hash<>$2", [account.id, hashSessionToken(token)]);
    });
    send(response, 200, { ok: true, message: "Email verified. You can now sign in." });
    return;
  }

  if (path === "/api/auth/email/resend" && method === "POST") {
    checkAccountFlowRateLimit(request.socket.remoteAddress ?? "unknown");
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error("Enter the email address used to create your account."), { status: 400 });
    if (!accountEmailIsConfigured()) throw Object.assign(new Error("Account email is not configured. Contact the system administrator."), { status: 503 });
    const account = (await readStore()).users.find((user) => user.email === email && user.active && user.emailVerified === false);
    if (account) await issueAccountToken(account, "verify_email");
    send(response, 200, { ok: true, message: "If that account needs verification, a new link has been sent." });
    return;
  }

  if (path === "/api/auth/password/forgot" && method === "POST") {
    checkAccountFlowRateLimit(request.socket.remoteAddress ?? "unknown");
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error("Enter a valid email address."), { status: 400 });
    if (!accountEmailIsConfigured()) throw Object.assign(new Error("Account recovery email is not configured. Contact the system administrator."), { status: 503 });
    const account = (await readStore()).users.find((user) => user.email === email && user.active);
    if (account) await issueAccountToken(account, "password_reset");
    send(response, 200, { ok: true, message: "If an active account uses that email, a password reset link has been sent." });
    return;
  }

  if (path === "/api/auth/password/reset" && method === "POST") {
    const body = await readJson(request);
    const token = typeof body.token === "string" ? body.token : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 12 || password.length > 200) throw Object.assign(new Error("Use a password between 12 and 200 characters."), { status: 400 });
    if (body.confirmPassword !== password) throw Object.assign(new Error("Password and confirmation do not match."), { status: 400 });
    if (token.length < 32 || token.length > 256) throw Object.assign(new Error("This reset link is invalid or expired. Request a new one."), { status: 400 });
    await updateStore(async (store, client) => {
      const tokenResult = await client.query<{ user_id: string }>("SELECT user_id FROM rentwise_account_tokens WHERE token_hash=$1 AND purpose='password_reset' AND used_at IS NULL AND expires_at>now() FOR UPDATE", [hashSessionToken(token)]);
      const tokenRow = tokenResult.rows[0];
      const account = tokenRow && store.users.find((user) => user.id === tokenRow.user_id && user.active);
      if (!account) throw Object.assign(new Error("This reset link is invalid or expired. Request a new one."), { status: 400 });
      account.salt = randomBytes(16).toString("hex");
      account.passwordHash = scryptSync(password, account.salt, 64).toString("hex");
      await client.query("UPDATE rentwise_account_tokens SET used_at=now() WHERE token_hash=$1", [hashSessionToken(token)]);
      await client.query("DELETE FROM rentwise_account_tokens WHERE user_id=$1 AND purpose='password_reset' AND token_hash<>$2", [account.id, hashSessionToken(token)]);
      await client.query("DELETE FROM rentwise_sessions WHERE user_id=$1", [account.id]);
    });
    clearSessionCookie(response, request);
    send(response, 200, { ok: true, message: "Password updated. Sign in with your new password." });
    return;
  }

  if (path === "/api/auth/signup" && method === "POST") {
    if (!accountEmailIsConfigured()) throw Object.assign(new Error("Self-service signup requires email delivery. Configure RESEND_API_KEY, RENTWISE_EMAIL_FROM, and RENTWISE_PUBLIC_URL on the server."), { status: 503 });
    const body = await readJson(request);
    const input = validateAccountInput(body, true);
    if (body.role !== "landlord_owner" && body.role !== "resident_tenant" && body.role !== "estate_agent") throw Object.assign(new Error("Choose Landlord / Organization Owner, Estate Agent, or Resident / Tenant."), { status: 400 });
    const role = body.role as RoleId;
    if (role === "resident_tenant" && normalizeLandlordCode(body.landlordCode)) await ensureLandlordCodes();
    const result = await updateStore(async (store, client) => {
      if (!store.users.length) throw Object.assign(new Error("Complete the initial Super Administrator setup before public sign-up."), { status: 409 });
      if (store.users.some((item) => item.email === input.email)) throw Object.assign(new Error("An account already uses this email."), { status: 409 });
      const landlord = role === "resident_tenant" ? landlordMatchesCode(store.users, body.landlordCode) : undefined;
      if (role === "resident_tenant" && normalizeLandlordCode(body.landlordCode) && !landlord) throw Object.assign(new Error("That landlord code was not found. Check the code with your landlord and try again."), { status: 400 });
      const newAccount = makeAccount({ ...input, role });
      newAccount.emailVerified = false;
      if (role === "landlord_owner") { newAccount.landlordCode = makeLandlordCode(store.users); newAccount.subscriptionPlan = "free_starter"; newAccount.subscriptionInterval = "monthly"; }
      if (landlord) {
        newAccount.organizationId = landlord.organizationId ?? "rentwise-default";
        newAccount.landlordId = landlord.id;
        newAccount.tenantId = await findTenantRecordByIdentity(newAccount.organizationId, input.email, body.phone);
        if (!newAccount.tenantId) await savePendingTenantApplication(client, newAccount.organizationId, landlord, newAccount, body.phone);
      }
      if (["property_manager", "estate_agent"].includes(newAccount.role)) {
        const organizationId = newAccount.organizationId ?? "rentwise-default";
        const owner = store.users.find((item) => item.role === "landlord_owner" && (item.organizationId ?? "rentwise-default") === organizationId && item.active);
        const staffPlan = getConfiguredPlan(owner?.subscriptionPlan) ?? getConfiguredPlan("free_starter")!;
        const staffCount = store.users.filter((item) => accountCountsAsStaff(item, organizationId)).length;
        if (staffPlan.limits.staff !== null && staffCount + 1 > staffPlan.limits.staff) throw Object.assign(new Error(`${staffPlan.name} includes up to ${staffPlan.limits.staff} staff accounts. Upgrade the organization plan before adding another staff member.`), { status: 403 });
      }
      store.users.push(newAccount);
      return { account: newAccount, landlordMapped: Boolean(landlord), tenantRecordLinked: Boolean(newAccount.tenantId) };
    });
    let verificationEmailSent = false;
    try { await issueAccountToken(result.account, "verify_email"); verificationEmailSent = true; }
    catch (error) { console.error("RentWise signup verification email could not be sent:", error instanceof Error ? error.message : "unknown error"); }
    send(response, 201, { user: publicAccount(result.account), verificationRequired: true, verificationEmailSent, needsTenantLink: role === "resident_tenant" && !result.tenantRecordLinked, landlordMapped: result.landlordMapped, tenantRecordLinked: result.tenantRecordLinked });
    return;
  }

  if (path === "/api/auth/login" && method === "POST") {
    const address = request.socket.remoteAddress ?? "unknown";
    checkLoginRateLimit(address);
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const password = typeof body.password === "string" ? body.password : "";
    const store = await readStore();
    const account = store.users.find((item) => item.email === email && item.active);
    if (!account || !passwordMatches(password, account)) {
      send(response, 401, { error: "Email or password is incorrect." });
      return;
    }
    if (account.emailVerified === false) {
      send(response, 403, { error: "Verify your email address before signing in. Use the resend verification option on this page if needed.", code: "email_unverified" });
      return;
    }
    loginAttempts.delete(address);
    const token = await createSession(account.id);
    setSessionCookie(response, request, token);
    send(response, 200, { user: publicAccount(await accountWithOrganizationPlan(account)) });
    return;
  }

  if (path === "/api/auth/logout" && method === "POST") {
    await deleteSession(getCookie(request, "rentwise_session"));
    clearSessionCookie(response, request);
    send(response, 200, { ok: true });
    return;
  }

  if (path === "/api/auth/link-landlord" && method === "POST") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    if (account.role !== "resident_tenant") throw Object.assign(new Error("Only Resident / Tenant accounts can use a landlord code."), { status: 403 });
    const body = await readJson(request);
    const code = normalizeLandlordCode(body.landlordCode);
    if (!code) throw Object.assign(new Error("Enter the landlord code."), { status: 400 });
    await ensureLandlordCodes();
    const landlord = landlordMatchesCode((await readStore()).users, code);
    if (!landlord) throw Object.assign(new Error("That landlord code was not found. Check the code with your landlord and try again."), { status: 404 });
    const organizationId = landlord.organizationId ?? "rentwise-default";
    const tenantId = await findTenantRecordByIdentity(organizationId, account.email, body.phone);
    const existingTenantOrganization = account.tenantId ? await findTenantOrganization(account.tenantId) : undefined;
    const updated = await updateStore(async (store, client) => {
      const target = store.users.find((item) => item.id === account.id);
      if (!target || target.role !== "resident_tenant") throw Object.assign(new Error("Tenant account not found."), { status: 404 });
      const hasValidExistingTenantRecord = Boolean(target.tenantId && existingTenantOrganization);
      if (hasValidExistingTenantRecord && existingTenantOrganization !== organizationId && !tenantId) throw Object.assign(new Error("This account is linked to a tenant record under another landlord. Ask your current landlord to unlink it before connecting a different profile."), { status: 409 });
      if (hasValidExistingTenantRecord && existingTenantOrganization === organizationId && tenantId && target.tenantId !== tenantId) throw Object.assign(new Error("Your email matches a different tenant record for this landlord. Ask the landlord to review the tenant email."), { status: 409 });
      target.organizationId = organizationId;
      target.landlordId = landlord.id;
      if (tenantId) target.tenantId = tenantId;
      else if (!hasValidExistingTenantRecord) delete target.tenantId;
      if (!target.tenantId) await savePendingTenantApplication(client, organizationId, landlord, target, body.phone);
      return target;
    });
    send(response, 200, { user: publicAccount(updated), landlordMapped: true, tenantRecordLinked: Boolean(updated.tenantId), applicationPending: !updated.tenantId });
    return;
  }

  if (path === "/api/tenant-applications" && method === "GET") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    if (!["landlord_owner", "property_manager", "super_admin"].includes(account.role)) throw Object.assign(new Error("Your role cannot review tenant signups."), { status: 403 });
    await ensureDatabase();
    const organizationId = await resolveOrganization(account);
    await withTransaction(async (client) => {
      const users = await client.query<{ account: Account }>("SELECT account FROM rentwise_users FOR SHARE");
      const mappedResidents = users.rows.map((row) => row.account).filter((user) => user.role === "resident_tenant" && !user.tenantId && user.landlordId && (account.role === "super_admin" || account.role === "property_manager" || user.landlordId === account.id) && (user.organizationId ?? "rentwise-default") === organizationId);
      const landlords = new Map(users.rows.map((row) => row.account).filter((user) => user.role === "landlord_owner").map((user) => [user.id, user]));
      for (const resident of mappedResidents) {
        const landlord = landlords.get(resident.landlordId!);
        if (landlord) await savePendingTenantApplication(client, organizationId, landlord, resident);
      }
    });
    const result = account.role === "landlord_owner"
      ? await database().query("SELECT id, account_id, applicant_name, email, phone, submitted_at FROM rentwise_tenant_applications WHERE organization_id=$1 AND landlord_id=$2 AND status='Pending' ORDER BY submitted_at DESC", [organizationId, account.id])
      : await database().query("SELECT id, account_id, applicant_name, email, phone, submitted_at FROM rentwise_tenant_applications WHERE organization_id=$1 AND status='Pending' ORDER BY submitted_at DESC", [organizationId]);
    send(response, 200, { applications: result.rows.map((row) => ({ id: row.id, accountId: row.account_id, applicantName: row.applicant_name, email: row.email, phone: row.phone, submittedAt: row.submitted_at })) });
    return;
  }

  const assignApplication = path.match(/^\/api\/tenant-applications\/([^/]+)\/assign$/);
  if (assignApplication && method === "POST") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    if (!["landlord_owner", "property_manager", "super_admin"].includes(account.role)) throw Object.assign(new Error("Your role cannot assign tenant signups."), { status: 403 });
    await ensureDatabase();
    const organizationId = await resolveOrganization(account);
    const body = await readJson(request);
    const submitted = body.tenant && typeof body.tenant === "object" && !Array.isArray(body.tenant) ? body.tenant as Record<string, unknown> : undefined;
    if (!submitted) throw Object.assign(new Error("Tenant profile details are required."), { status: 400 });
    const propertyId = typeof submitted.propertyId === "string" ? submitted.propertyId : "";
    const monthlyRent = Number(submitted.monthlyRent);
    const frequency = String(submitted.paymentFrequency ?? "");
    const rentedDate = String(submitted.rentedDate ?? "");
    const expirationDate = String(submitted.expirationDate ?? "");
    const allowedFrequencies = ["Monthly", "Every 3 months", "Every 6 months", "Every 9 months", "Yearly", "Every 2 years"];
    if (!propertyId || !Number.isFinite(monthlyRent) || monthlyRent <= 0 || !allowedFrequencies.includes(frequency) || !/^\d{4}-\d{2}-\d{2}$/.test(rentedDate) || !/^\d{4}-\d{2}-\d{2}$/.test(expirationDate) || expirationDate < rentedDate || !String(submitted.gender ?? "").trim() || !String(submitted.occupation ?? "").trim()) throw Object.assign(new Error("Complete the required tenant details, property, rent, and tenancy dates."), { status: 400 });
    const assignedTenant = await withTransaction(async (client) => {
      const applicationResult = await client.query<{ id: string; account_id: string; landlord_id: string; applicant_name: string; email: string; phone: string }>(
        `SELECT id,account_id,landlord_id,applicant_name,email,phone FROM rentwise_tenant_applications WHERE id=$1 AND organization_id=$2 AND status='Pending' ${account.role === "landlord_owner" ? "AND landlord_id=$3" : ""} FOR UPDATE`,
        account.role === "landlord_owner" ? [decodeURIComponent(assignApplication[1]), organizationId, account.id] : [decodeURIComponent(assignApplication[1]), organizationId],
      );
      const application = applicationResult.rows[0];
      if (!application) throw Object.assign(new Error("This tenant signup is no longer pending or is not assigned to your account."), { status: 404 });
      const propertiesResult = await client.query<{ data: Array<Record<string, unknown>> }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='properties' FOR UPDATE", [organizationId]);
      const properties = propertiesResult.rows[0]?.data ?? [];
      const property = properties.find((item) => item.id === propertyId);
      if (!property) throw Object.assign(new Error("Choose a property from your organization."), { status: 400 });
      const tenantsResult = await client.query<{ data: Array<Record<string, unknown>> }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='tenants' FOR UPDATE", [organizationId]);
      const tenants = tenantsResult.rows[0]?.data ?? [];
      if (tenants.some((item) => item.email && String(item.email).toLowerCase() === application.email.toLowerCase())) throw Object.assign(new Error("A tenant profile already uses this signup email. Review the existing tenant record."), { status: 409 });
      const occupied = tenants.filter((item) => item.propertyId === propertyId).length;
      if (occupied >= Number(property.units)) throw Object.assign(new Error("This property has no available units. Choose another property or update its unit count."), { status: 409 });
      const submittedId = typeof submitted.id === "string" && /^[0-9a-f-]{36}$/i.test(submitted.id) ? submitted.id : randomUUID();
      if (tenants.some((item) => item.id === submittedId)) throw Object.assign(new Error("This tenant profile already exists. Refresh the page and retry."), { status: 409 });
      const tenant = { ...submitted, id: submittedId, name: application.applicant_name, email: application.email, phone: String(submitted.phone ?? application.phone).replace(/\D/g, "").slice(0, 11), propertyId, monthlyRent, paymentFrequency: frequency, rentedDate, expirationDate };
      tenants.unshift(tenant);
      await client.query("INSERT INTO rentwise_app_data(organization_id,collection,data) VALUES($1,'tenants',$2::jsonb) ON CONFLICT(organization_id,collection) DO UPDATE SET data=EXCLUDED.data,updated_at=now()", [organizationId, JSON.stringify(tenants)]);
      const accountResult = await client.query<{ account: Account }>("SELECT account FROM rentwise_users WHERE id=$1 FOR UPDATE", [application.account_id]);
      const resident = accountResult.rows[0]?.account;
      if (!resident || resident.role !== "resident_tenant") throw Object.assign(new Error("The tenant’s user account could not be found."), { status: 409 });
      resident.organizationId = organizationId;
      resident.landlordId = application.landlord_id;
      resident.tenantId = tenant.id;
      await client.query("UPDATE rentwise_users SET account=$2::jsonb,updated_at=now() WHERE id=$1", [resident.id, JSON.stringify(resident)]);
      await client.query("UPDATE rentwise_tenant_applications SET status='Assigned',tenant_id=$2 WHERE id=$1", [application.id, tenant.id]);
      return tenant;
    });
    send(response, 201, { ok: true, tenant: assignedTenant });
    return;
  }

  const renewalReview = path.match(/^\/api\/renewal-requests\/([^/]+)\/review$/);
  if (renewalReview && method === "POST") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    if (!["super_admin", "landlord_owner", "property_manager"].includes(account.role)) throw Object.assign(new Error("Your role cannot review rent renewals."), { status: 403 });
    await ensureDatabase();
    const organizationId = await resolveOrganization(account);
    const body = await readJson(request);
    const decision = body.decision;
    if (decision !== "Approved" && decision !== "Declined") throw Object.assign(new Error("Choose Approved or Declined."), { status: 400 });
    const result = await withTransaction(async (client) => {
      const requestsResult = await client.query<{ data: Array<Record<string, unknown>> }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='renewalRequests' FOR UPDATE", [organizationId]);
      const requests = requestsResult.rows[0]?.data ?? [];
      const request = requests.find((item) => item.id === decodeURIComponent(renewalReview[1]));
      if (!request || request.status !== "Pending") throw Object.assign(new Error("This renewal request is no longer pending. Refresh the page and review its current status."), { status: 409 });
      const paymentsResult = await client.query<{ data: Array<Record<string, unknown>> }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='payments' FOR UPDATE", [organizationId]);
      const payments = paymentsResult.rows[0]?.data ?? [];
      const payment = payments.find((item) => item.id === request.paymentId && item.tenantId === request.tenantId);
      if (!payment) throw Object.assign(new Error("The renewal’s linked payment could not be found."), { status: 409 });
      if (decision === "Approved" && payment.status !== "Paid") throw Object.assign(new Error("Confirm the linked payment as Paid before approving and activating this lease."), { status: 409 });
      request.status = decision;
      const beforePayment = decision === "Declined" ? { ...payment } : undefined;
      if (decision === "Declined") payment.status = "Rejected";
      await client.query("INSERT INTO rentwise_app_data(organization_id,collection,data) VALUES($1,'renewalRequests',$2::jsonb) ON CONFLICT(organization_id,collection) DO UPDATE SET data=EXCLUDED.data,updated_at=now()", [organizationId, JSON.stringify(requests)]);
      if (decision === "Declined") {
        await client.query("INSERT INTO rentwise_app_data(organization_id,collection,data) VALUES($1,'payments',$2::jsonb) ON CONFLICT(organization_id,collection) DO UPDATE SET data=EXCLUDED.data,updated_at=now()", [organizationId, JSON.stringify(payments)]);
        await client.query("INSERT INTO rentwise_financial_audit(id,organization_id,collection,transaction_id,reference,action,before_data,after_data,actor_id,actor_name) VALUES($1,$2,'payments',$3,$4,'updated',$5::jsonb,$6::jsonb,$7,$8)", [randomUUID(), organizationId, String(payment.id), String(payment.reference ?? payment.id), JSON.stringify(beforePayment), JSON.stringify(payment), account.id, account.name]);
      }
      return { request, payment };
    });
    send(response, 200, { ok: true, request: result.request, payment: result.payment });
    return;
  }

  const renewalPaymentConfirm = path.match(/^\/api\/renewal-requests\/([^/]+)\/confirm-payment$/);
  if (renewalPaymentConfirm && method === "POST") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    if (!["super_admin", "landlord_owner", "property_manager"].includes(account.role)) throw Object.assign(new Error("Your role cannot confirm renewal payments."), { status: 403 });
    await ensureDatabase();
    const organizationId = await resolveOrganization(account);
    const result = await withTransaction(async (client) => {
      const requestsResult = await client.query<{ data: Array<Record<string, unknown>> }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='renewalRequests' FOR UPDATE", [organizationId]);
      const request = (requestsResult.rows[0]?.data ?? []).find((item) => item.id === decodeURIComponent(renewalPaymentConfirm[1]));
      if (!request || request.status !== "Pending") throw Object.assign(new Error("Only a pending renewal can have its payment confirmed."), { status: 409 });
      const paymentsResult = await client.query<{ data: Array<Record<string, unknown>> }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='payments' FOR UPDATE", [organizationId]);
      const payments = paymentsResult.rows[0]?.data ?? [];
      const payment = payments.find((item) => item.id === request.paymentId && item.tenantId === request.tenantId);
      if (!payment) throw Object.assign(new Error("The renewal’s linked payment could not be found."), { status: 404 });
      if (payment.status === "Rejected") throw Object.assign(new Error("This payment was rejected. Ask the tenant to submit a new renewal payment."), { status: 409 });
      const before = { ...payment };
      payment.status = "Paid";
      await client.query("INSERT INTO rentwise_app_data(organization_id,collection,data) VALUES($1,'payments',$2::jsonb) ON CONFLICT(organization_id,collection) DO UPDATE SET data=EXCLUDED.data,updated_at=now()", [organizationId, JSON.stringify(payments)]);
      await client.query("INSERT INTO rentwise_financial_audit(id,organization_id,collection,transaction_id,reference,action,before_data,after_data,actor_id,actor_name) VALUES($1,$2,'payments',$3,$4,'updated',$5::jsonb,$6::jsonb,$7,$8)", [randomUUID(), organizationId, String(payment.id), String(payment.reference ?? payment.id), JSON.stringify(before), JSON.stringify(payment), account.id, account.name]);
      return payment;
    });
    send(response, 200, { ok: true, payment: result });
    return;
  }

  const attachmentRoute = path.match(/^\/api\/attachments\/(lease|receipt|maintenance|inspection|profile)\/([^/]+)$/);
  if (attachmentRoute && (method === "GET" || method === "PUT" || method === "DELETE")) {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    const category = attachmentRoute[1];
    if (account.role === "estate_agent" && category !== "inspection") throw Object.assign(new Error("Estate Agents can view system property photos and manage inspection photos only."), { status: 403 });
    const organizationId = await resolveOrganization(account);
    const id = decodeURIComponent(attachmentRoute[2]);
    const canManage = ["super_admin", "landlord_owner", "property_manager", "estate_agent"].includes(account.role);
    if (method === "DELETE") {
      if (category !== "profile" || !writableCollections[account.role].has("properties")) throw Object.assign(new Error("Your role cannot delete this property photo."), { status: 403 });
      await ensureDatabase();
      const properties = await database().query<{ data: Array<{ id: string }> }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='properties'", [organizationId]);
      const knownIds = (properties.rows[0]?.data ?? []).flatMap((property) => [0, 1, 2, 3].map((index) => index === 0 ? `property-${property.id}` : `property-${property.id}-${index + 1}`));
      if (!knownIds.includes(id)) throw Object.assign(new Error("This photo is not attached to a property in your organization."), { status: 404 });
      await database().query("DELETE FROM rentwise_attachments WHERE organization_id=$1 AND category='profile' AND id=$2", [organizationId, id]);
      send(response, 200, { ok: true });
      return;
    }
    if (method === "PUT") {
      const body = await readJson(request);
      const name = typeof body.name === "string" ? body.name.slice(0, 255) : "document";
      const type = typeof body.type === "string" ? body.type.slice(0, 150) : "application/octet-stream";
      const base64 = typeof body.base64 === "string" ? body.base64 : "";
      if (!base64 || base64.length > 15 * 1024 * 1024) throw Object.assign(new Error("Attachment is empty or exceeds the 11 MB file limit."), { status: 400 });
      if (account.role === "resident_tenant") {
        if (category === "receipt") {
          const payments = await database().query<{ data: Array<{ id: string; tenantId: string }> }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='payments'", [organizationId]);
          if (!payments.rows[0]?.data?.some((payment) => payment.id === id && payment.tenantId === account.tenantId)) throw Object.assign(new Error("You can only upload receipts for your own rent payments."), { status: 403 });
        } else if (category === "maintenance") {
          const requests = await database().query<{ data: Array<{ images?: Array<{ id: string }>; tenantId: string }> }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='maintenance'", [organizationId]);
          if (!requests.rows[0]?.data?.some((item) => item.tenantId === account.tenantId && item.images?.some((image) => image.id === id))) throw Object.assign(new Error("This maintenance image is not linked to your request."), { status: 403 });
        } else throw Object.assign(new Error("Tenant accounts cannot upload this document."), { status: 403 });
      } else if (!canManage || (category === "receipt" && !["super_admin", "landlord_owner", "property_manager"].includes(account.role))) throw Object.assign(new Error("Your role cannot upload this attachment."), { status: 403 });
      const content = Buffer.from(base64, "base64");
      if (content.length > 11 * 1024 * 1024) throw Object.assign(new Error("Attachment exceeds the 11 MB file limit."), { status: 400 });
      if (category === "profile" && (!["image/jpeg", "image/png", "image/webp"].includes(type) || content.length > 8 * 1024 * 1024)) throw Object.assign(new Error("Profile photos must be JPG, PNG, or WebP images no larger than 8 MB."), { status: 400 });
      await ensureDatabase();
      const storagePlan = getConfiguredPlan((await accountWithOrganizationPlan(account)).subscriptionPlan) ?? getConfiguredPlan("free_starter")!;
      if (storagePlan.limits.storageMb !== null) {
        const [usage, existingAttachment] = await Promise.all([
          database().query<{ bytes: string }>("SELECT (COALESCE((SELECT sum(octet_length(content)) FROM rentwise_attachments WHERE organization_id=$1),0)+COALESCE((SELECT sum(octet_length(content)) FROM rentwise_inspection_attachments WHERE organization_id=$1),0))::text AS bytes", [organizationId]),
          category === "inspection"
            ? database().query<{ bytes: string }>("SELECT octet_length(content)::text AS bytes FROM rentwise_inspection_attachments WHERE organization_id=$1 AND id=$2", [organizationId, id])
            : database().query<{ bytes: string }>("SELECT octet_length(content)::text AS bytes FROM rentwise_attachments WHERE organization_id=$1 AND category=$2 AND id=$3", [organizationId, category, id]),
        ]);
        const usedBytes = Number(usage.rows[0]?.bytes ?? 0) - Number(existingAttachment.rows[0]?.bytes ?? 0);
        const maximumBytes = storagePlan.limits.storageMb * 1024 * 1024;
        if (usedBytes + content.length > maximumBytes) throw Object.assign(new Error(`${storagePlan.name} includes ${storagePlan.limits.storageMb} MB of document storage. Remove files or upgrade the plan to upload more.`), { status: 413 });
      }
      if (category === "inspection") {
        await database().query("INSERT INTO rentwise_inspection_attachments(organization_id,id,file_name,mime_type,content) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,id) DO UPDATE SET file_name=EXCLUDED.file_name,mime_type=EXCLUDED.mime_type,content=EXCLUDED.content,created_at=now()", [organizationId, id, name, type, content]);
        send(response, 200, { ok: true });
        return;
      }
      await database().query("INSERT INTO rentwise_attachments(organization_id,category,id,file_name,mime_type,content) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,category,id) DO UPDATE SET file_name=EXCLUDED.file_name,mime_type=EXCLUDED.mime_type,content=EXCLUDED.content,created_at=now()", [organizationId, category, id, name, type, content]);
      send(response, 200, { ok: true });
      return;
    }
    if (account.role === "resident_tenant") {
      if (category === "inspection") throw Object.assign(new Error("Tenant accounts cannot view internal inspection files."), { status: 403 });
      if (category === "profile") {
        const tenants = await database().query<{ data: Array<{ id: string; propertyId: string }> }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='tenants'", [organizationId]);
        const ownTenant = tenants.rows[0]?.data?.find((tenant) => tenant.id === account.tenantId);
        const allowed = id === `tenant-${account.tenantId}` || Boolean(ownTenant && (id === `property-${ownTenant.propertyId}` || /^property-.+-[2-4]$/.test(id) && id.startsWith(`property-${ownTenant.propertyId}-`)));
        if (!allowed) throw Object.assign(new Error("You do not have access to this profile photo."), { status: 403 });
      } else {
      const collection = category === "lease" ? "leases" : category === "receipt" ? "payments" : "maintenance";
      const rows = await database().query<{ data: Array<Record<string, unknown>> }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection=$2", [organizationId, collection]);
      const records = rows.rows[0]?.data ?? [];
      const allowedLeaseTenants = category === "lease" ? await residentLeaseTenantIds(account, organizationId) : new Set([account.tenantId]);
      const allowed = category === "maintenance"
        ? records.some((item) => item.tenantId === account.tenantId && Array.isArray(item.images) && item.images.some((image) => (image as Record<string, unknown>).id === id))
        : records.some((item) => allowedLeaseTenants.has(String(item.tenantId ?? "")) && (item.id === id || item.generatedDocumentId === id));
      if (!allowed) throw Object.assign(new Error("You do not have access to this attachment."), { status: 403 });
      }
    }
    const result = category === "inspection"
      ? await database().query<{ file_name: string; mime_type: string; base64: string }>("SELECT file_name,mime_type,encode(content,'base64') AS base64 FROM rentwise_inspection_attachments WHERE organization_id=$1 AND id=$2", [organizationId, id])
      : await database().query<{ file_name: string; mime_type: string; base64: string }>("SELECT file_name,mime_type,encode(content,'base64') AS base64 FROM rentwise_attachments WHERE organization_id=$1 AND category=$2 AND id=$3", [organizationId, category, id]);
    if (!result.rowCount) throw Object.assign(new Error("Attachment not found."), { status: 404 });
    send(response, 200, { name: result.rows[0].file_name, type: result.rows[0].mime_type, base64: result.rows[0].base64 });
    return;
  }

  if (path === "/api/admin/whatsapp/status" && method === "GET") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    if (account.role !== "super_admin") throw Object.assign(new Error("Only the Super Administrator can check WhatsApp integration settings."), { status: 403 });
    send(response, 200, whatsappConfigurationStatus());
    return;
  }

  if (path === "/api/admin/whatsapp/test" && method === "POST") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    if (account.role !== "super_admin") throw Object.assign(new Error("Only the Super Administrator can send a WhatsApp test."), { status: 403 });
    const body = await readJson(request);
    if (body.confirmed !== true) throw Object.assign(new Error("Confirm that the test recipient agreed to receive a WhatsApp message."), { status: 400 });
    const phone = normalizedWhatsAppNumber(body.phone);
    if (!phone) throw Object.assign(new Error("Enter a valid phone number with country code, such as 2348031234567."), { status: 400 });
    const now = Date.now();
    const lastSent = whatsappTestLastSent.get(account.id) ?? 0;
    if (now - lastSent < 30_000) throw Object.assign(new Error("Wait 30 seconds before sending another WhatsApp test."), { status: 429 });
    const config = whatsappConfigurationStatus();
    if (!config.configured) throw Object.assign(new Error("WhatsApp is not fully configured. Add the phone number ID, access token, Graph API version, and approved template settings to the server .env, then restart RentWise."), { status: 503 });
    whatsappTestLastSent.set(account.id, now);
    const testTemplateName = process.env.WHATSAPP_TEST_TEMPLATE_NAME?.trim();
    const testTemplateLanguage = process.env.WHATSAPP_TEST_TEMPLATE_LANGUAGE?.trim() || "en_US";
    if (!testTemplateName) throw Object.assign(new Error("Set WHATSAPP_TEST_TEMPLATE_NAME in the project .env and restart RentWise."), { status: 503 });
    const result = await sendWhatsAppTemplate(phone, testTemplateName, testTemplateLanguage);
    if (result.status !== "submitted") throw Object.assign(new Error("error" in result ? result.error : "WhatsApp could not accept the test message."), { status: 502 });
    send(response, 200, { ok: true, providerAccepted: true, providerMessageId: result.providerMessageId ?? null, recipient: phone });
    return;
  }

  if (path === "/api/resident/reminder-notifications" && method === "GET") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    if (account.role !== "resident_tenant" || !account.tenantId) throw Object.assign(new Error("A linked Resident / Tenant account is required to view reminders."), { status: 403 });
    const organizationId = await resolveOrganization(account);
    const result = await database().query<{ id: string; title: string; message: string; reminder_date: string; created_at: string; read_at: string | null }>(
      "SELECT id,title,message,reminder_date::text,created_at,read_at FROM rentwise_reminder_notifications WHERE organization_id=$1 AND tenant_id=$2 AND channel='portal' ORDER BY reminder_date DESC,created_at DESC LIMIT 50",
      [organizationId, account.tenantId],
    );
    send(response, 200, { notifications: result.rows.map((item) => ({ id: item.id, title: item.title, message: item.message, reminderDate: item.reminder_date, createdAt: item.created_at, readAt: item.read_at })) });
    return;
  }

  if (path === "/api/subscription/notifications" && method === "GET") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    const rows = await database().query<{ id: string; title: string; message: string; days_remaining: number; created_at: string; read_at: string | null }>("SELECT id,title,message,days_remaining,created_at,read_at FROM rentwise_subscription_notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20", [account.id]);
    send(response, 200, { notifications: rows.rows.map((row) => ({ id: row.id, title: row.title, message: row.message, daysRemaining: row.days_remaining, createdAt: row.created_at, readAt: row.read_at })) });
    return;
  }

  const subscriptionNotificationReadRoute = path.match(/^\/api\/subscription\/notifications\/([0-9a-f-]+)\/read$/i);
  if (subscriptionNotificationReadRoute && method === "POST") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    await database().query("UPDATE rentwise_subscription_notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2", [subscriptionNotificationReadRoute[1], account.id]);
    send(response, 200, { ok: true });
    return;
  }

  const residentReminderReadRoute = path.match(/^\/api\/resident\/reminder-notifications\/([0-9a-f-]+)\/read$/i);
  if (residentReminderReadRoute && method === "POST") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    if (account.role !== "resident_tenant" || !account.tenantId) throw Object.assign(new Error("A linked Resident / Tenant account is required to update reminders."), { status: 403 });
    const organizationId = await resolveOrganization(account);
    const result = await database().query(
      "UPDATE rentwise_reminder_notifications SET read_at=COALESCE(read_at,now()),updated_at=now() WHERE id=$1 AND organization_id=$2 AND tenant_id=$3 AND channel='portal'",
      [residentReminderReadRoute[1], organizationId, account.tenantId],
    );
    if (!result.rowCount) throw Object.assign(new Error("Reminder not found."), { status: 404 });
    send(response, 200, { ok: true });
    return;
  }

  if (path === "/api/data" && method === "GET") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    await ensureDatabase();
    const organizationId = await resolveOrganization(account);
    if (account.role === "resident_tenant" && !account.tenantId) {
      if (!account.landlordId) { send(response, 200, { data: { bankTransferDetails: {}, landlordProfile: null } }); return; }
      const [bankDetails, store] = await Promise.all([
        database().query<{ data: unknown }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='bankTransferDetails'", [organizationId]),
        readStore(),
      ]);
      const landlord = store.users.find((user) => user.id === account.landlordId && user.role === "landlord_owner") ?? store.users.find((user) => user.role === "landlord_owner" && (user.organizationId ?? "rentwise-default") === organizationId);
      send(response, 200, { data: { bankTransferDetails: bankDetails.rows[0]?.data ?? {}, landlordProfile: landlord ? { name: landlord.name, email: landlord.email } : null } });
      return;
    }
    const rows = await database().query<{ collection: string; data: unknown; revision: string }>("SELECT collection,data,revision::text FROM rentwise_app_data WHERE organization_id=$1 ORDER BY collection", [organizationId]);
    const revisionsByCollection = new Map(rows.rows.map((row) => [row.collection, Number(row.revision)]));
    const versions = Object.fromEntries([...readableCollections[account.role]].map((collection) => [collection, revisionsByCollection.get(collection) ?? 0]));
    const raw = Object.fromEntries(rows.rows.filter((row) => readableCollections[account.role].has(row.collection)).map((row) => [row.collection, row.data])) as Record<string, unknown>;
    const normalizedRows = await database().query<{ collection: string; payload: unknown }>(
      `SELECT collection,payload FROM (
         SELECT 'properties'::text AS collection,payload,position FROM rentwise_properties WHERE organization_id=$1
         UNION ALL SELECT 'tenants'::text,payload,position FROM rentwise_tenants WHERE organization_id=$1
         UNION ALL SELECT 'leases'::text,payload,position FROM rentwise_leases WHERE organization_id=$1
         UNION ALL SELECT 'payments'::text,payload,position FROM rentwise_payments WHERE organization_id=$1
         UNION ALL SELECT 'expenses'::text,payload,position FROM rentwise_expenses WHERE organization_id=$1
       ) normalized ORDER BY collection,position`,
      [organizationId],
    );
    for (const collection of ["properties", "tenants", "leases", "payments", "expenses"]) {
      if (readableCollections[account.role].has(collection)) raw[collection] = normalizedRows.rows.filter((row) => row.collection === collection).map((row) => row.payload);
    }
    if (account.role === "estate_agent") {
      raw.payments = Array.isArray(raw.payments) ? raw.payments.filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).transactionType === "Agent fee") : [];
      raw.tenants = Array.isArray(raw.tenants) ? raw.tenants.map((item) => {
        const tenant = item && typeof item === "object" ? item as Record<string, unknown> : {};
        return { id: tenant.id, name: tenant.name, propertyId: tenant.propertyId };
      }) : [];
    }
    if (account.role === "resident_tenant") {
      const store = await readStore();
      const landlord = store.users.find((user) => user.id === account.landlordId && user.role === "landlord_owner") ?? store.users.find((user) => user.role === "landlord_owner" && (user.organizationId ?? "rentwise-default") === organizationId);
      raw.landlordProfile = landlord ? { name: landlord.name, email: landlord.email } : null;
    }
    if (account.role === "resident_tenant" && account.tenantId) {
      const tenant = Array.isArray(raw.tenants) ? raw.tenants.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).id === account.tenantId) as Record<string, unknown> | undefined : undefined;
      const propertyId = tenant?.propertyId;
      if (Array.isArray(raw.properties)) raw.properties = raw.properties.filter((item) => item && (item as Record<string, unknown>).id === propertyId);
      if (raw.reminderMessages && typeof raw.reminderMessages === "object" && !Array.isArray(raw.reminderMessages)) raw.reminderMessages = { [account.tenantId]: (raw.reminderMessages as Record<string, unknown>)[account.tenantId] };
    }
    const data = Object.fromEntries(Object.entries(raw).map(([collection, value]) => [collection, tenantScope(account, collection, value, account.tenantId ?? "")]));
    if (account.role === "resident_tenant" && account.tenantId && Array.isArray(raw.leases)) {
      const visibleTenantIds = await residentLeaseTenantIds(account, organizationId);
      data.leases = raw.leases.filter((item) => item && typeof item === "object" && visibleTenantIds.has(String((item as Record<string, unknown>).tenantId ?? "")));
    }
    send(response, 200, { data, versions, organizationId });
    return;
  }

  if (path === "/api/financial-ledger" && method === "GET") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    if (!["super_admin", "platform_admin", "landlord_owner", "property_manager"].includes(account.role)) throw Object.assign(new Error("The property financial ledger is available to landlord and property management roles."), { status: 403 });
    await ensureDatabase();
    const organizationId = await resolveOrganization(account);
    const url = new URL(request.url ?? "/api/financial-ledger", "http://rentwise.local");
    const propertyId = url.searchParams.get("propertyId") ?? "all";
    const category = url.searchParams.get("category") ?? "all";
    const period = url.searchParams.get("period") ?? "all";
    const fromDate = url.searchParams.get("from") ?? "";
    const toDate = url.searchParams.get("to") ?? "";
    const dateKey = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
    const today = reminderToday();
    let periodStart = "";
    if (period === "month") periodStart = `${today.slice(0, 7)}-01`;
    else if (period === "quarter") {
      const month = Number(today.slice(5, 7));
      periodStart = `${today.slice(0, 4)}-${String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
    } else if (period === "year") periodStart = `${today.slice(0, 4)}-01-01`;
    const rows = await database().query<{ collection: string; data: unknown }>(
      `SELECT collection,data FROM (
         SELECT 'properties'::text AS collection,payload AS data,position FROM rentwise_properties WHERE organization_id=$1
         UNION ALL SELECT 'tenants'::text,payload,position FROM rentwise_tenants WHERE organization_id=$1
         UNION ALL SELECT 'payments'::text,payload,position FROM rentwise_payments WHERE organization_id=$1
         UNION ALL SELECT 'expenses'::text,payload,position FROM rentwise_expenses WHERE organization_id=$1
       ) normalized ORDER BY collection,position`,
      [organizationId],
    );
    // This query returns one relational row per record (payload is an object),
    // not one JSON array per collection. Group those payloads before applying
    // the ledger calculations; treating each object as an array silently made
    // every property, payment, and expense disappear from the report.
    const collections = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows.rows) {
      const collectionRecords = collections.get(row.collection) ?? [];
      if (Array.isArray(row.data)) collectionRecords.push(...row.data as Array<Record<string, unknown>>);
      else if (row.data && typeof row.data === "object") collectionRecords.push(row.data as Record<string, unknown>);
      collections.set(row.collection, collectionRecords);
    }
    const properties = collections.get("properties") ?? [];
    const tenants = collections.get("tenants") ?? [];
    const payments = collections.get("payments") ?? [];
    const expenses = collections.get("expenses") ?? [];
    const propertyForTenant = new Map(tenants.map((tenant) => [String(tenant.id ?? ""), String(tenant.propertyId ?? "")]));
    const propertyNames = new Map(properties.map((property) => [String(property.id ?? ""), String(property.name ?? "Property")]));
    const moneyKobo = (value: unknown) => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return 0;
      return value;
    };
    const hasStoredKobo = (record: Record<string, unknown>) => Number.isSafeInteger(record.amountKobo) && Number(record.amountKobo) > 0;
    const paymentIsConfirmed = (payment: Record<string, unknown>) => payment.status === "Paid";
    const unreviewedPayments = payments.filter((payment) => payment.status === undefined || payment.status === null || typeof payment.status !== "string" || payment.status.trim() === "").length;
    const unreviewedAmounts = payments.filter((payment) => !hasStoredKobo(payment)).length + expenses.filter((expense) => !hasStoredKobo(expense) && !["reversed", "void", "cancelled"].includes(String(expense.financialStatus ?? expense.status ?? "").toLowerCase())).length;
    const inPeriod = (dateValue: unknown) => {
      const date = dateKey(dateValue);
      if (!date) return false;
      if (period === "all") return true;
      if (period === "custom") return (!dateKey(fromDate) || date >= fromDate) && (!dateKey(toDate) || date <= toDate);
      if (period === "month" || period === "quarter" || period === "year") return date >= periodStart && date <= today;
      return true;
    };
    const allTransactions: Array<Record<string, unknown>> = [];
    for (const payment of payments) {
      if (!paymentIsConfirmed(payment)) continue;
      const amountKobo = moneyKobo(payment.amountKobo);
      if (amountKobo <= 0) continue;
      const kind = String(payment.transactionType ?? "Rent payment");
      const paymentCategory = ["Initial rent", "Rent renewal", "Rent payment"].includes(kind) ? "Rental income" : "Other income";
      const date = dateKey(payment.paymentDate);
      if (!date) continue;
      const transactionPropertyId = String(payment.propertyId ?? propertyForTenant.get(String(payment.tenantId ?? "")) ?? "");
      allTransactions.push({ id: String(payment.id ?? ""), reference: String(payment.reference ?? payment.id ?? "Unreferenced payment"), date, propertyId: transactionPropertyId, propertyName: propertyNames.get(transactionPropertyId) ?? "Property unavailable", category: paymentCategory, detail: kind, description: String(payment.rentPeriod ?? ""), amountKobo, direction: "income", status: "Confirmed", source: "payment" });
    }
    for (const expense of expenses) {
      if (["reversed", "void", "cancelled"].includes(String(expense.financialStatus ?? expense.status ?? "").toLowerCase())) continue;
      const amountKobo = moneyKobo(expense.amountKobo);
      if (amountKobo <= 0) continue;
      const date = dateKey(expense.expenseDate);
      if (!date) continue;
      allTransactions.push({ id: String(expense.id ?? ""), reference: String(expense.reference ?? expense.id ?? "Unreferenced expense"), date, propertyId: String(expense.propertyId ?? ""), propertyName: propertyNames.get(String(expense.propertyId ?? "")) ?? "Property unavailable", category: String(expense.category ?? "Other operational expense"), detail: String(expense.paidTo ?? "Expense"), description: String(expense.description ?? ""), amountKobo, direction: "expense", status: "Confirmed", source: "expense" });
    }
    const filtered = allTransactions.filter((transaction) =>
      (propertyId === "all" || transaction.propertyId === propertyId)
      && (category === "all" || transaction.category === category)
      && inPeriod(transaction.date),
    ).sort((left, right) => String(right.date).localeCompare(String(left.date)));
    const sum = (items: Array<Record<string, unknown>>, direction: string) => items.reduce((total, item) => total + (item.direction === direction ? BigInt(String(item.amountKobo)) : 0n), 0n).toString();
    const incomeKobo = BigInt(sum(filtered, "income"));
    const expensesKobo = BigInt(sum(filtered, "expense"));
    const propertySummary = properties.filter((property) => propertyId === "all" || property.id === propertyId).map((property) => {
      const propertyTransactions = filtered.filter((transaction) => transaction.propertyId === property.id);
      const rentalKobo = propertyTransactions.filter((transaction) => transaction.category === "Rental income").reduce((total, item) => total + BigInt(String(item.amountKobo)), 0n);
      const otherIncomeKobo = propertyTransactions.filter((transaction) => transaction.direction === "income" && transaction.category !== "Rental income").reduce((total, item) => total + BigInt(String(item.amountKobo)), 0n);
      const expenseByCategory = new Map<string, bigint>();
      for (const transaction of propertyTransactions.filter((item) => item.direction === "expense")) expenseByCategory.set(String(transaction.category), (expenseByCategory.get(String(transaction.category)) ?? 0n) + BigInt(String(transaction.amountKobo)));
      const totalExpensesKobo = [...expenseByCategory.values()].reduce((total, amount) => total + amount, 0n);
      const totalIncomeKobo = rentalKobo + otherIncomeKobo;
      return { id: String(property.id), name: String(property.name ?? "Property"), address: [property.address, property.city, property.state].filter((part) => typeof part === "string" && part).join(", "), rentalIncomeKobo: rentalKobo.toString(), otherIncomeKobo: otherIncomeKobo.toString(), totalExpensesKobo: totalExpensesKobo.toString(), maintenanceExpensesKobo: (expenseByCategory.get("Repairs & maintenance") ?? 0n).toString(), repairExpensesKobo: (expenseByCategory.get("Repairs") ?? 0n).toString(), managementAndAgentFeesKobo: (["Management fees", "Agent fees", "Agent fee"].reduce((total, key) => total + (expenseByCategory.get(key) ?? 0n), 0n)).toString(), otherOperationalExpensesKobo: [...expenseByCategory.entries()].filter(([key]) => !["Repairs & maintenance", "Repairs", "Management fees", "Agent fees", "Agent fee"].includes(key)).reduce((total, [, amount]) => total + amount, 0n).toString(), netProfitKobo: (totalIncomeKobo - totalExpensesKobo).toString() };
    });
    const audit = await database().query<{ id: string; collection: string; transaction_id: string; reference: string; action: string; before_data: unknown; after_data: unknown; actor_name: string; created_at: string }>(
      "SELECT id,collection,transaction_id,reference,action,before_data,after_data,actor_name,created_at FROM rentwise_financial_audit WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 300",
      [organizationId],
    );
    send(response, 200, { summary: { incomeKobo: incomeKobo.toString(), expensesKobo: expensesKobo.toString(), netProfitKobo: (incomeKobo - expensesKobo).toString() }, unreviewedPayments, unreviewedAmounts, properties: propertySummary, transactions: filtered.map((item) => ({ ...item, amountKobo: String(item.amountKobo) })), audit: audit.rows.map((item) => ({ id: item.id, collection: item.collection, transactionId: item.transaction_id, reference: item.reference, action: item.action, before: item.before_data, after: item.after_data, actor: item.actor_name, createdAt: item.created_at })) });
    return;
  }

  const reverseFinancialTransaction = path.match(/^\/api\/financial-ledger\/([^/]+)\/([^/]+)\/reverse$/);
  if (reverseFinancialTransaction && method === "POST") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    if (!["super_admin", "landlord_owner", "property_manager"].includes(account.role)) throw Object.assign(new Error("Your role cannot reverse a financial transaction."), { status: 403 });
    const collection = decodeURIComponent(reverseFinancialTransaction[1]);
    const transactionId = decodeURIComponent(reverseFinancialTransaction[2]);
    if (collection !== "payments" && collection !== "expenses") throw Object.assign(new Error("Unknown financial transaction type."), { status: 400 });
    await ensureDatabase();
    const organizationId = await resolveOrganization(account);
    const body = await readJson(request);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason || reason.length > 500) throw Object.assign(new Error("Enter a brief reason for the reversal."), { status: 400 });
    const reversed = await withTransaction(async (client) => {
      await client.query("INSERT INTO rentwise_app_data(organization_id,collection,data) VALUES($1,$2,'[]'::jsonb) ON CONFLICT DO NOTHING", [organizationId, collection]);
      const stored = await client.query<{ data: Array<Record<string, unknown>> }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection=$2 FOR UPDATE", [organizationId, collection]);
      const records = stored.rows[0]?.data ?? [];
      const transaction = records.find((item) => item.id === transactionId);
      if (!transaction) throw Object.assign(new Error("Financial transaction not found."), { status: 404 });
      if (transaction.status === "Reversed" || transaction.financialStatus === "Reversed") throw Object.assign(new Error("This transaction has already been reversed."), { status: 409 });
      const before = { ...transaction };
      if (collection === "payments") transaction.status = "Reversed";
      else transaction.financialStatus = "Reversed";
      transaction.reversalReason = reason;
      transaction.reversedAt = new Date().toISOString();
      transaction.reversedBy = account.id;
      const reference = typeof transaction.reference === "string" ? transaction.reference : transactionId;
      await client.query("UPDATE rentwise_app_data SET data=$3::jsonb,updated_at=now() WHERE organization_id=$1 AND collection=$2", [organizationId, collection, JSON.stringify(records)]);
      await client.query("INSERT INTO rentwise_financial_audit(id,organization_id,collection,transaction_id,reference,action,before_data,after_data,actor_id,actor_name) VALUES($1,$2,$3,$4,$5,'reversed',$6::jsonb,$7::jsonb,$8,$9)", [randomUUID(), organizationId, collection, transactionId, reference, JSON.stringify(before), JSON.stringify(transaction), account.id, account.name]);
      return transaction;
    });
    send(response, 200, { ok: true, transaction: reversed });
    return;
  }

  if (path === "/api/payment-history/sync" && method === "POST") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    if (!["super_admin", "landlord_owner", "property_manager", "estate_agent"].includes(account.role)) {
      throw Object.assign(new Error("Your role cannot synchronize landlord payment history."), { status: 403 });
    }
    await ensureDatabase();
    const organizationId = await resolveOrganization(account);
    const payments = await withTransaction(async (client) => {
      await client.query("INSERT INTO rentwise_app_data(organization_id,collection,data) VALUES($1,'payments','[]'::jsonb) ON CONFLICT DO NOTHING", [organizationId]);
      const collections = new Set(["tenants", "leases", "inspections"].filter((collection) => writableCollections[account.role].has(collection)));
      const sourceRows = await client.query<{ collection: string; data: unknown }>(
        "SELECT collection,data FROM rentwise_app_data WHERE organization_id=$1 AND collection=ANY($2::text[])",
        [organizationId, [...collections]],
      );
      const sourceData = new Map(sourceRows.rows.map((row) => [row.collection, Array.isArray(row.data) ? row.data as Array<Record<string, unknown>> : []]));
      const paymentRows = await client.query<{ data: unknown }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='payments' FOR UPDATE", [organizationId]);
      const records = Array.isArray(paymentRows.rows[0]?.data) ? paymentRows.rows[0].data as Array<Record<string, unknown>> : [];
      const originalSnapshot = JSON.stringify(records);
      const originalRecords = new Map(records.filter((item) => typeof item.id === "string").map((item) => [String(item.id), JSON.parse(JSON.stringify(item)) as Record<string, unknown>]));
      const renewalRows = await client.query<{ data: unknown }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='renewalRequests'", [organizationId]);
      const renewalPaymentIds = new Set((Array.isArray(renewalRows.rows[0]?.data) ? renewalRows.rows[0].data as Array<Record<string, unknown>> : []).map((item) => item.paymentId).filter((id): id is string => typeof id === "string"));
      for (const payment of records) if (typeof payment.id === "string" && renewalPaymentIds.has(payment.id)) payment.transactionType = "Rent renewal";
      const sources: Array<{ type: string; recordId: string; amount: number; tenantId?: string; propertyId?: string; date: string; period: string; status: "Pending" | "Paid" }> = [];
      for (const tenant of sourceData.get("tenants") ?? []) {
        const amount = Number(tenant.monthlyRent);
        if (typeof tenant.id !== "string" || !Number.isFinite(amount) || amount <= 0) continue;
        sources.push({
          type: "Initial rent", recordId: tenant.id, amount,
          tenantId: tenant.id, propertyId: typeof tenant.propertyId === "string" ? tenant.propertyId : undefined,
          date: String(tenant.rentedDate || tenant.moveInDate || new Date().toISOString().slice(0, 10)),
          period: `Initial rent · ${String(tenant.paymentFrequency || "Rental period")}${tenant.rentedDate || tenant.moveInDate ? ` · ${String(tenant.rentedDate || tenant.moveInDate)}${tenant.expirationDate ? ` – ${String(tenant.expirationDate)}` : ""}` : ""}`,
          status: "Pending",
        });
      }
      for (const lease of sourceData.get("leases") ?? []) {
        const amount = Number(lease.securityDeposit);
        if (typeof lease.id !== "string" || !Number.isFinite(amount)) continue;
        if (amount <= 0) {
          for (let index = records.length - 1; index >= 0; index -= 1) if (records[index].transactionType === "Caution fee" && records[index].sourceRecordId === lease.id && records[index].status === "Pending") records.splice(index, 1);
          continue;
        }
        const tenant = (sourceData.get("tenants") ?? []).find((item) => item.id === lease.tenantId);
        sources.push({ type: "Caution fee", recordId: lease.id, amount,
          tenantId: typeof lease.tenantId === "string" ? lease.tenantId : undefined,
          propertyId: typeof tenant?.propertyId === "string" ? tenant.propertyId : undefined,
          date: String(lease.agreementDate || lease.startDate || new Date().toISOString().slice(0, 10)),
          period: `Caution fee · ${String(lease.reference || lease.id)}`, status: "Pending" });
      }
      for (const inspection of sourceData.get("inspections") ?? []) {
        if (typeof inspection.id !== "string") continue;
        for (const [field, type, title] of [["inspectionFee", "Inspection fee", "Inspection fee"], ["agentFee", "Agent fee", "Agent fee"]] as const) {
          const amount = Number(inspection[field] ?? 0);
          if (!Number.isFinite(amount)) continue;
          if (amount <= 0) {
            for (let index = records.length - 1; index >= 0; index -= 1) if (records[index].transactionType === type && records[index].sourceRecordId === inspection.id && records[index].status === "Pending") records.splice(index, 1);
            continue;
          }
          sources.push({ type, recordId: inspection.id, amount,
            tenantId: typeof inspection.tenantId === "string" ? inspection.tenantId : undefined,
            propertyId: typeof inspection.propertyId === "string" ? inspection.propertyId : undefined,
            date: String(inspection.inspectionDate || new Date().toISOString().slice(0, 10)),
            period: `${title} · ${String(inspection.kind || "Property inspection")}`, status: "Pending" });
        }
      }
      for (const source of sources) {
        const existing = records.find((item) => item.transactionType === source.type && item.sourceRecordId === source.recordId)
          ?? records.find((item) => !item.sourceRecordId && item.tenantId === source.tenantId && item.amount === source.amount && item.paymentDate === source.date && (!item.transactionType || item.transactionType === "Rent payment"));
        if (existing) {
          existing.transactionType = source.type;
          existing.sourceRecordId = source.recordId;
          const syntheticUnverifiedInitialRent = source.type === "Initial rent" && existing.method === "Not recorded";
          if (syntheticUnverifiedInitialRent) existing.status = "Pending";
          if (existing.status !== "Paid" && existing.status !== "Rejected") {
            existing.amount = source.amount;
            existing.tenantId = source.tenantId;
            existing.propertyId = source.propertyId;
            existing.paymentDate = source.date;
            existing.rentPeriod = source.period;
            existing.status = source.status;
          }
          continue;
        }
        const id = randomUUID();
        const year = /^\d{4}/.test(source.date) ? source.date.slice(0, 4) : String(new Date().getFullYear());
        records.unshift({ id, reference: `RW-PAY-${year}-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`,
          transactionType: source.type, sourceRecordId: source.recordId, tenantId: source.tenantId, propertyId: source.propertyId,
          amount: source.amount, paymentDate: source.date, recordedAt: new Date().toISOString(), method: "Not recorded",
          rentPeriod: source.period, status: source.status });
      }
      const currentById = new Map(records.filter((item) => typeof item.id === "string").map((item) => [String(item.id), item]));
      for (const [id, after] of currentById) {
        const before = originalRecords.get(id);
        if (before && JSON.stringify(before) === JSON.stringify(after)) continue;
        await client.query("INSERT INTO rentwise_financial_audit(id,organization_id,collection,transaction_id,reference,action,before_data,after_data,actor_id,actor_name) VALUES($1,$2,'payments',$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)", [randomUUID(), organizationId, id, String(after.reference ?? id), before ? "updated" : "created", before ? JSON.stringify(before) : null, JSON.stringify(after), account.id, account.name]);
      }
      for (const [id, before] of originalRecords) if (!currentById.has(id)) {
        await client.query("INSERT INTO rentwise_financial_audit(id,organization_id,collection,transaction_id,reference,action,before_data,actor_id,actor_name) VALUES($1,$2,'payments',$3,$4,'deleted',$5::jsonb,$6,$7)", [randomUUID(), organizationId, id, String(before.reference ?? id), JSON.stringify(before), account.id, account.name]);
      }
      // Avoid advancing the collection revision on every page load when the sync
      // found nothing to change. This endpoint runs during workspace startup.
      if (JSON.stringify(records) !== originalSnapshot) {
        await client.query("INSERT INTO rentwise_app_data(organization_id,collection,data) VALUES($1,'payments',$2::jsonb) ON CONFLICT(organization_id,collection) DO UPDATE SET data=EXCLUDED.data,updated_at=now()", [organizationId, JSON.stringify(records)]);
      }
      const visiblePayments = account.role === "estate_agent" ? records.filter((record) => record.transactionType === "Agent fee") : records;
      return visiblePayments;
    });
    const savedRevision = await database().query<{ revision: string }>("SELECT revision::text FROM rentwise_app_data WHERE organization_id=$1 AND collection='payments'", [organizationId]);
    send(response, 200, { ok: true, payments, collection: "payments", revision: Number(savedRevision.rows[0]?.revision ?? 0) });
    return;
  }

  if (path === "/api/data" && method === "PUT") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    const organizationId = await resolveOrganization(account);
    const body = await readJson(request);
    const collection = typeof body.collection === "string" ? body.collection : "";
    const expectedRevision = body.expectedRevision;
    if (!dataCollections.has(collection)) throw Object.assign(new Error("Unknown RentWise data collection."), { status: 400 });
    if (!writableCollections[account.role].has(collection)) throw Object.assign(new Error("Your role cannot modify this RentWise information."), { status: 403 });
    let value = body.data;
    let residentWriteCommitted = false;
    if (collection === "bankTransferDetails" && (!value || typeof value !== "object" || Array.isArray(value))) throw Object.assign(new Error("Invalid organization payment details."), { status: 400 });
    if (collection !== "bankTransferDetails" && collection !== "reminderMessages" && !Array.isArray(value)) throw Object.assign(new Error("Collection data must be an array."), { status: 400 });
    if (collection === "expenses") {
      const plan = getConfiguredPlan((await accountWithOrganizationPlan(account)).subscriptionPlan);
      if (!plan || plan.features.expenses === "none") throw Object.assign(new Error("Expense management requires a Basic plan or above."), { status: 403 });
    }
    if (account.role === "resident_tenant") {
      if (!["maintenance", "payments", "renewalRequests"].includes(collection) || !account.tenantId) throw Object.assign(new Error("Your tenant account is not linked to a tenant record."), { status: 403 });
      const tenantId = account.tenantId;
      await withTransaction(async (client) => {
        await requireCollectionRevision(client, organizationId, collection, expectedRevision);
        await client.query("INSERT INTO rentwise_app_data(organization_id,collection,data) VALUES($1,$2,'[]'::jsonb) ON CONFLICT DO NOTHING", [organizationId, collection]);
        const old = await client.query<{ data: unknown }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection=$2 FOR UPDATE", [organizationId, collection]);
        const previous = Array.isArray(old.rows[0]?.data) ? old.rows[0].data as Array<Record<string, unknown>> : [];
        const supplied = Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
        const previousMine = previous.filter((item) => item && item.tenantId === tenantId);
        const previousIds = new Set(previous.map((item) => item.id));
        const newMine = supplied.filter((item) => item && item.tenantId === tenantId && typeof item.id === "string" && !previousIds.has(item.id));
        const others = previous.filter((item) => item && item.tenantId !== tenantId);
        const tenantData = await client.query<{ data: unknown }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='tenants'", [organizationId]);
        const tenants = Array.isArray(tenantData.rows[0]?.data) ? tenantData.rows[0].data as Array<Record<string, unknown>> : [];
        const tenant = tenants.find((item) => item.id === tenantId);
        if (!tenant) throw Object.assign(new Error("Your linked tenant record could not be found."), { status: 403 });

        if (collection === "payments") {
          const allowedMethods = new Set(["Bank transfer", "Cash", "POS", "USSD", "Cheque", "Other"]);
          for (const item of newMine) {
            if (typeof item.id !== "string" || item.id.length > 128 || typeof item.amount !== "number" || !Number.isFinite(item.amount) || item.amount <= 0 || typeof item.paymentDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.paymentDate) || typeof item.rentPeriod !== "string" || !item.rentPeriod.trim() || item.rentPeriod.length > 200 || typeof item.method !== "string" || !allowedMethods.has(item.method) || (item.receiptName !== undefined && (typeof item.receiptName !== "string" || item.receiptName.length > 255))) {
              throw Object.assign(new Error("The submitted payment details are invalid."), { status: 400 });
            }
            item.status = "Pending";
            item.propertyId = tenant.propertyId;
            item.reference = typeof item.reference === "string" && item.reference.length <= 80 ? item.reference : `RW-PAY-${String(item.paymentDate).slice(0, 4)}-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
            item.recordedAt = new Date().toISOString();
          }
        } else if (collection === "renewalRequests") {
          if (previousMine.some((item) => item.status === "Pending") && newMine.length) throw Object.assign(new Error("You already have a renewal waiting for landlord review."), { status: 409 });
          const paymentsData = await client.query<{ data: unknown }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='payments'", [organizationId]);
          const payments = Array.isArray(paymentsData.rows[0]?.data) ? paymentsData.rows[0].data as Array<Record<string, unknown>> : [];
          for (const item of newMine) {
            const payment = payments.find((entry) => entry.id === item.paymentId && entry.tenantId === tenantId);
            if (typeof item.id !== "string" || item.id.length > 128 || !payment || payment.status !== "Pending" || typeof item.reference !== "string" || item.reference.length > 100 || typeof item.startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.startDate) || typeof item.expirationDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.expirationDate) || item.expirationDate < item.startDate || typeof item.rentAmount !== "number" || !Number.isFinite(item.rentAmount) || item.rentAmount <= 0 || !["Monthly", "Every 3 months", "Every 6 months", "Every 9 months", "Yearly", "Every 2 years"].includes(String(item.paymentFrequency)) || typeof item.submittedDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.submittedDate) || payment.amount !== item.rentAmount) {
              throw Object.assign(new Error("The submitted renewal request is invalid or its payment record is missing."), { status: 400 });
            }
            item.status = "Pending";
            delete item.approvedLeaseId;
          }
        } else {
          for (const item of newMine) {
            const imageList = Array.isArray(item.images) ? item.images as Array<Record<string, unknown>> : [];
            if (typeof item.id !== "string" || item.id.length > 128 || typeof item.title !== "string" || !item.title.trim() || item.title.length > 150 || typeof item.description !== "string" || !item.description.trim() || item.description.length > 5000 || !["Major", "Minor"].includes(String(item.repairType)) || typeof item.submittedDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.submittedDate) || imageList.length > 10 || imageList.some((image) => typeof image.id !== "string" || image.id.length > 128 || typeof image.name !== "string" || image.name.length > 255)) {
              throw Object.assign(new Error("The submitted maintenance request is invalid."), { status: 400 });
            }
            item.propertyId = tenant.propertyId;
            item.status = "Open";
          }
        }
        value = [...others, ...previousMine, ...newMine];
        await client.query("INSERT INTO rentwise_app_data(organization_id,collection,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(organization_id,collection) DO UPDATE SET data=EXCLUDED.data,updated_at=now()", [organizationId, collection, JSON.stringify(value)]);
        residentWriteCommitted = true;
      });
    }
    if (!residentWriteCommitted) {
      await ensureDatabase();
      if (["properties", "tenants"].includes(collection) && ["landlord_owner", "property_manager"].includes(account.role)) {
        const planAccount = await accountWithOrganizationPlan(account);
        const plan = getConfiguredPlan(planAccount.subscriptionPlan) ?? getConfiguredPlan("free_starter")!;
        const records = value as Array<Record<string, unknown>>;
        await withTransaction(async (client) => {
          await requireCollectionRevision(client, organizationId, collection, expectedRevision);
          await client.query("INSERT INTO rentwise_app_data(organization_id,collection,data) VALUES($1,$2,'[]'::jsonb) ON CONFLICT DO NOTHING", [organizationId, collection]);
          const stored = await client.query<{ data: Array<Record<string, unknown>> }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection=$2 FOR UPDATE", [organizationId, collection]);
          const existing = stored.rows[0]?.data ?? [];
          const previousIds = new Set(existing.map((item) => item.id));
          if (collection === "properties") {
            const active = (item: Record<string, unknown>) => item.active !== false && item.isActive !== false;
            const oldProperties = existing.filter(active);
            const newProperties = records.filter(active);
            const added = newProperties.filter((item) => !previousIds.has(item.id));
            const maxProperties = plan.limits.properties;
            if (maxProperties !== null && newProperties.length > maxProperties && (added.length > 0 || newProperties.length > oldProperties.length)) throw Object.assign(new Error(`${plan.name} allows up to ${maxProperties} active properties. Upgrade your plan to add more.`), { status: 403 });
            const units = (items: Array<Record<string, unknown>>) => items.filter(active).reduce((sum, item) => sum + (Number.isFinite(Number(item.units)) ? Math.max(0, Number(item.units)) : 0), 0);
            const unitTotal = units(records);
            const previousUnitTotal = units(existing);
            if (plan.limits.units !== null && unitTotal > plan.limits.units && unitTotal > previousUnitTotal) throw Object.assign(new Error(`${plan.name} allows up to ${plan.limits.units} active rental units. Upgrade your plan to add more.`), { status: 403 });
          } else {
            const added = records.filter((item) => typeof item.id === "string" && !previousIds.has(item.id));
            const maxTenants = plan.limits.tenants;
            if (maxTenants !== null && existing.length + added.length > maxTenants && added.length > 0) throw Object.assign(new Error(`${plan.name} allows up to ${maxTenants} tenant records. Upgrade your plan to add more.`), { status: 403 });
          }
          await client.query("INSERT INTO rentwise_app_data(organization_id,collection,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(organization_id,collection) DO UPDATE SET data=EXCLUDED.data,updated_at=now()", [organizationId, collection, JSON.stringify(records)]);
        });
      } else if (collection === "maintenance" && ["landlord_owner", "property_manager"].includes(account.role)) {
        const requests = value as Array<Record<string, unknown>>;
        for (const request of requests) {
          if (request.actualCost !== undefined && (typeof request.actualCost !== "number" || !Number.isFinite(request.actualCost) || request.actualCost < 0)) throw Object.assign(new Error("Maintenance actual cost must be a valid amount of zero or more."), { status: 400 });
        }
        await withTransaction(async (client) => {
          await requireCollectionRevision(client, organizationId, collection, expectedRevision);
          await client.query("INSERT INTO rentwise_app_data(organization_id,collection,data) VALUES($1,'maintenance','[]'::jsonb) ON CONFLICT DO NOTHING", [organizationId]);
          await client.query("INSERT INTO rentwise_app_data(organization_id,collection,data) VALUES($1,'expenses','[]'::jsonb) ON CONFLICT DO NOTHING", [organizationId]);
          await client.query("INSERT INTO rentwise_app_data(organization_id,collection,data) VALUES($1,'maintenanceVendors','[]'::jsonb) ON CONFLICT DO NOTHING", [organizationId]);
          const [savedExpenses, vendorsData] = await Promise.all([
            client.query<{ data: Array<Record<string, unknown>> }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='expenses' FOR UPDATE", [organizationId]),
            client.query<{ data: Array<Record<string, unknown>> }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection='maintenanceVendors'", [organizationId]),
          ]);
          const expenses = savedExpenses.rows[0]?.data ?? [];
          const vendors = vendorsData.rows[0]?.data ?? [];
          for (const request of requests) {
            const amount = request.actualCost;
            if (request.status !== "Resolved" || typeof request.id !== "string" || !request.id || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) continue;
            const existingIndex = expenses.findIndex((expense) => expense.sourceMaintenanceRequestId === request.id);
            const vendor = vendors.find((item) => item.id === request.vendorId);
            const expense = {
              id: existingIndex >= 0 ? expenses[existingIndex].id : randomUUID(),
              propertyId: typeof request.propertyId === "string" ? request.propertyId : "",
              category: "Repairs & maintenance",
              amount,
              expenseDate: typeof request.resolvedDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(request.resolvedDate) ? request.resolvedDate : typeof request.submittedDate === "string" ? request.submittedDate : new Date().toISOString().slice(0, 10),
              paidTo: typeof vendor?.name === "string" ? vendor.name : "Maintenance vendor",
              description: `Resolved work order: ${typeof request.title === "string" ? request.title : "Maintenance"}`,
              sourceMaintenanceRequestId: request.id,
            };
            if (existingIndex >= 0) expenses[existingIndex] = expense;
            else expenses.unshift(expense);
          }
          await client.query("INSERT INTO rentwise_app_data(organization_id,collection,data) VALUES($1,'maintenance',$2::jsonb) ON CONFLICT(organization_id,collection) DO UPDATE SET data=EXCLUDED.data,updated_at=now()", [organizationId, JSON.stringify(requests)]);
          await client.query("INSERT INTO rentwise_app_data(organization_id,collection,data) VALUES($1,'expenses',$2::jsonb) ON CONFLICT(organization_id,collection) DO UPDATE SET data=EXCLUDED.data,updated_at=now()", [organizationId, JSON.stringify(expenses)]);
        });
      } else if (["payments", "expenses"].includes(collection)) {
        const supplied = value as Array<Record<string, unknown>>;
        const uniqueIds = new Set<string>();
        const uniqueReferences = new Set<string>();
        const uniqueSources = new Set<string>();
        for (const item of supplied) {
          if (typeof item.id !== "string" || !item.id || uniqueIds.has(item.id)) throw Object.assign(new Error("Financial transactions must have unique record IDs."), { status: 400 });
          uniqueIds.add(item.id);
          if (typeof item.reference === "string" && item.reference.trim()) {
            if (uniqueReferences.has(item.reference.trim())) throw Object.assign(new Error("Financial transaction references must be unique."), { status: 409 });
            uniqueReferences.add(item.reference.trim());
          }
          const sourceId = typeof item.sourceMaintenanceRequestId === "string" && collection === "expenses"
            ? `maintenance:${item.sourceMaintenanceRequestId}`
            : typeof item.sourceRecordId === "string" && collection === "payments"
              ? `${String(item.transactionType ?? "payment")}:${item.sourceRecordId}` : "";
          if (sourceId) {
            if (uniqueSources.has(sourceId)) throw Object.assign(new Error("This source record already has a linked financial transaction."), { status: 409 });
            uniqueSources.add(sourceId);
          }
        }
        await withTransaction(async (client) => {
          await requireCollectionRevision(client, organizationId, collection, expectedRevision);
          await client.query("INSERT INTO rentwise_app_data(organization_id,collection,data) VALUES($1,$2,'[]'::jsonb) ON CONFLICT DO NOTHING", [organizationId, collection]);
          const stored = await client.query<{ data: Array<Record<string, unknown>> }>("SELECT data FROM rentwise_app_data WHERE organization_id=$1 AND collection=$2 FOR UPDATE", [organizationId, collection]);
          const previous = stored.rows[0]?.data ?? [];
          const oldById = new Map(previous.filter((item) => typeof item.id === "string").map((item) => [String(item.id), item]));
          const newById = new Map(supplied.filter((item) => typeof item.id === "string").map((item) => [String(item.id), item]));
          for (const [id, after] of newById) {
            const before = oldById.get(id);
            if (before && JSON.stringify(before) === JSON.stringify(after)) continue;
            const action = after.status === "Reversed" || after.financialStatus === "Reversed" ? "reversed" : before ? "updated" : "created";
            const reference = String(after.reference ?? before?.reference ?? id);
            await client.query("INSERT INTO rentwise_financial_audit(id,organization_id,collection,transaction_id,reference,action,before_data,after_data,actor_id,actor_name) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)", [randomUUID(), organizationId, collection, id, reference, action, before ? JSON.stringify(before) : null, JSON.stringify(after), account.id, account.name]);
          }
          for (const [id, before] of oldById) if (!newById.has(id)) {
            await client.query("INSERT INTO rentwise_financial_audit(id,organization_id,collection,transaction_id,reference,action,before_data,actor_id,actor_name) VALUES($1,$2,$3,$4,$5,'deleted',$6::jsonb,$7,$8)", [randomUUID(), organizationId, collection, id, String(before.reference ?? id), JSON.stringify(before), account.id, account.name]);
          }
          await client.query("UPDATE rentwise_app_data SET data=$3::jsonb,updated_at=now() WHERE organization_id=$1 AND collection=$2", [organizationId, collection, JSON.stringify(supplied)]);
        });
      } else {
        await withTransaction(async (client) => {
          await requireCollectionRevision(client, organizationId, collection, expectedRevision);
          await client.query("INSERT INTO rentwise_app_data(organization_id,collection,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(organization_id,collection) DO UPDATE SET data=EXCLUDED.data,updated_at=now()", [organizationId, collection, JSON.stringify(value)]);
        });
      }
    }
    const savedRevision = await database().query<{ revision: string }>("SELECT revision::text FROM rentwise_app_data WHERE organization_id=$1 AND collection=$2", [organizationId, collection]);
    send(response, 200, { ok: true, collection, revision: Number(savedRevision.rows[0]?.revision ?? 0) });
    return;
  }

  if (path === "/api/data/import" && method === "POST") {
    const account = await getSessionAccount(request);
    if (!account) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    if (!["super_admin", "landlord_owner", "property_manager"].includes(account.role)) throw Object.assign(new Error("Your role cannot import browser data."), { status: 403 });
    const organizationId = await resolveOrganization(account);
    const body = await readJson(request);
    if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) throw Object.assign(new Error("Invalid RentWise import."), { status: 400 });
    await withTransaction(async (client) => {
      const existing = await client.query("SELECT 1 FROM rentwise_app_data WHERE organization_id=$1 LIMIT 1", [organizationId]);
      if (existing.rowCount) return;
      const migrationOrder: Record<string, number> = { properties: 0, tenants: 1, leases: 2, payments: 3, expenses: 4 };
      const entries = Object.entries(body.data as Record<string, unknown>).sort(([left], [right]) => (migrationOrder[left] ?? 10) - (migrationOrder[right] ?? 10));
      for (const [collection, value] of entries) {
        if (!dataCollections.has(collection)) continue;
        await client.query("INSERT INTO rentwise_app_data(organization_id,collection,data) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING", [organizationId, collection, JSON.stringify(value)]);
      }
    });
    send(response, 200, { ok: true });
    return;
  }

  if (path === "/api/users" && method === "GET") {
    const currentAccount = await getSessionAccount(request);
    if (!currentAccount) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    if (currentAccount.role !== "super_admin" && currentAccount.role !== "platform_admin") throw Object.assign(new Error("Only administrators can view account assignments."), { status: 403 });
    let store = await readStore();
    const needsSubscriptionMigration = store.users.some((user) => user.subscriptionPlan && user.subscriptionPlan !== "free_starter" && (!user.subscriptionStartAt || !user.subscriptionDurationDays || !user.subscriptionExpiresAt || !user.subscriptionStatus));
    if (needsSubscriptionMigration) {
      const startsAt = Date.now();
      await updateStore((currentStore) => {
        for (const user of currentStore.users) {
          if (user.subscriptionPlan && user.subscriptionPlan !== "free_starter") normalizeSubscriptionAccount(user, startsAt);
        }
      });
      store = await readStore();
    }
    const users = currentAccount.role === "platform_admin"
      ? store.users.filter((user) => ["landlord_owner", "property_manager", "estate_agent", "resident_tenant"].includes(user.role))
      : store.users;
    send(response, 200, { users: await Promise.all(users.map(async (user) => publicAccount(await accountWithOrganizationPlan(user)))) });
    return;
  }

  if (path === "/api/users" && method === "POST") {
    const currentAccount = await getSessionAccount(request);
    if (!currentAccount) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
    const isPlatformAdmin = currentAccount.role === "platform_admin";
    if (currentAccount.role !== "super_admin" && !isPlatformAdmin) throw Object.assign(new Error("Only administrators can create role accounts."), { status: 403 });
    const body = await readJson(request);
    const input = validateAccountInput(body);
    if (!isRole(body.role)) { send(response, 400, { error: "Choose a valid role." }); return; }
    if (isPlatformAdmin && !["landlord_owner", "property_manager", "estate_agent", "resident_tenant"].includes(body.role)) {
      throw Object.assign(new Error("Platform Administrators can create Landlord, Property Manager, Estate Agent, and Resident / Tenant accounts only."), { status: 403 });
    }
    const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    if (body.role === "resident_tenant" && !tenantId && !isPlatformAdmin) { send(response, 400, { error: "Assign a tenant record to a Resident / Tenant account." }); return; }
    const requestedOrganizationId = typeof body.organizationId === "string" ? body.organizationId.trim() : currentAccount?.organizationId ?? "rentwise-default";
    const requestedLandlordId = typeof body.landlordId === "string" ? body.landlordId.trim() : "";
    const account = await updateStore(async (store, client) => {
      if (store.users.some((item) => item.email === input.email)) throw Object.assign(new Error("An account already uses this email."), { status: 409 });
      const newAccount = makeAccount({ ...input, role: body.role as RoleId, tenantId: tenantId || undefined });
      if (newAccount.role === "landlord_owner") { newAccount.landlordCode = makeLandlordCode(store.users); newAccount.subscriptionPlan = "free_starter"; newAccount.subscriptionInterval = "monthly"; }
      if (newAccount.role === "resident_tenant" && requestedLandlordId) {
        const landlord = store.users.find((item) => item.id === requestedLandlordId && item.role === "landlord_owner" && item.active);
        if (!landlord) throw Object.assign(new Error("Choose an active landlord account."), { status: 400 });
        newAccount.landlordId = landlord.id;
        newAccount.organizationId = landlord.organizationId ?? "rentwise-default";
        if (!newAccount.tenantId) await savePendingTenantApplication(client, newAccount.organizationId, landlord, newAccount, body.phone);
      }
      if (!["landlord_owner", "resident_tenant"].includes(newAccount.role)) {
        const validOrganization = store.users.some((item) => item.role === "landlord_owner" && item.organizationId === requestedOrganizationId) || (!isPlatformAdmin && requestedOrganizationId === (currentAccount?.organizationId ?? "rentwise-default"));
        if (!validOrganization) throw Object.assign(new Error("Choose an organization that has a landlord owner account."), { status: 400 });
        newAccount.organizationId = requestedOrganizationId;
      }
      if (["property_manager", "estate_agent"].includes(newAccount.role)) {
        const organizationId = newAccount.organizationId ?? "rentwise-default";
        const owner = store.users.find((item) => item.role === "landlord_owner" && (item.organizationId ?? "rentwise-default") === organizationId && item.active);
        const staffPlan = getConfiguredPlan(owner?.subscriptionPlan) ?? getConfiguredPlan("free_starter")!;
        const staffCount = store.users.filter((item) => accountCountsAsStaff(item, organizationId)).length;
        if (staffPlan.limits.staff !== null && staffCount + 1 > staffPlan.limits.staff) throw Object.assign(new Error(`${staffPlan.name} includes up to ${staffPlan.limits.staff} staff accounts. Upgrade the organization plan before adding another staff member.`), { status: 403 });
      }
      store.users.push(newAccount);
      return newAccount;
    });
    send(response, 201, { user: publicAccount(account) });
    return;
  }

  const userRoute = path.match(/^\/api\/users\/([0-9a-f-]+)$/i);
  if (userRoute && method === "PATCH") {
    const currentAccount = await getSessionAccount(request);
    requireSuperAdmin(currentAccount);
    const body = await readJson(request);
    const account = await updateStore(async (store, client) => {
      const target = store.users.find((item) => item.id === userRoute[1]);
      if (!target) throw Object.assign(new Error("Account not found."), { status: 404 });
      const wasActiveSuperAdmin = target.role === "super_admin" && target.active;
      if (target.id === currentAccount?.id && body.role !== undefined && body.role !== "super_admin") throw Object.assign(new Error("You cannot change your own Super Administrator role."), { status: 400 });
      if (body.name !== undefined) {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (name.length < 2 || name.length > 100) throw Object.assign(new Error("Enter a name between 2 and 100 characters."), { status: 400 });
        target.name = name;
      }
      if (body.email !== undefined) {
        const email = normalizeEmail(body.email);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error("Enter a valid email address."), { status: 400 });
        if (store.users.some((item) => item.id !== target.id && item.email === email)) throw Object.assign(new Error("An account already uses this email."), { status: 409 });
        target.email = email;
      }
      if (body.subscriptionPlan !== undefined) {
        if (body.subscriptionPlan === null) { delete target.subscriptionPlan; delete target.subscriptionStartAt; delete target.subscriptionDurationDays; delete target.subscriptionExpiresAt; delete target.subscriptionStatus; delete target.subscriptionLastNotifiedAt; delete target.subscriptionInterval; await client.query("DELETE FROM rentwise_subscription_notifications WHERE user_id=$1", [target.id]); }
        else {
          const planId = typeof body.subscriptionPlan === "string" ? normalizePlanId(body.subscriptionPlan) : undefined;
          if (!planId) throw Object.assign(new Error("Choose a valid billing plan."), { status: 400 });
          if ((body.role ?? target.role) === "estate_agent" && planId === "free_starter") throw Object.assign(new Error("Estate Agents require the Basic plan or higher."), { status: 400 });
          const durationDays = planId === "free_starter" ? 0 : body.subscriptionDurationDays === undefined ? (body.subscriptionInterval === "annually" ? 365 : 30) : Number(body.subscriptionDurationDays);
          if (planId !== "free_starter" && ![30, 90, 180, 365].includes(durationDays)) throw Object.assign(new Error("Choose a subscription term of 30, 90, 180, or 365 days."), { status: 400 });
          target.subscriptionPlan = planId;
          target.subscriptionInterval = durationDays === 365 ? "annually" : "monthly";
          if (planId === "free_starter") normalizeSubscriptionAccount(target);
          else {
            target.subscriptionStartAt = new Date().toISOString();
            target.subscriptionDurationDays = durationDays;
            target.subscriptionExpiresAt = subscriptionExpiry(target.subscriptionStartAt, durationDays);
            target.subscriptionStatus = "active";
            delete target.subscriptionLastNotifiedAt;
            await client.query("DELETE FROM rentwise_subscription_notifications WHERE user_id=$1", [target.id]);
          }
        }
      }
      if (body.password !== undefined) {
        if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 200) throw Object.assign(new Error("Use a password between 12 and 200 characters."), { status: 400 });
        target.salt = randomBytes(16).toString("hex");
        target.passwordHash = scryptSync(body.password, target.salt, 64).toString("hex");
      }
      if (body.role !== undefined) {
        if (!isRole(body.role)) throw Object.assign(new Error("Choose a valid role."), { status: 400 });
        if (body.role === "resident_tenant" && typeof body.tenantId !== "string") throw Object.assign(new Error("Assign a tenant record to a Resident / Tenant account."), { status: 400 });
        target.role = body.role;
        target.tenantId = body.role === "resident_tenant" ? String(body.tenantId).trim() : undefined;
        if (body.role === "resident_tenant" && !target.tenantId) throw Object.assign(new Error("Assign a tenant record to a Resident / Tenant account."), { status: 400 });
      }
      if (body.tenantId !== undefined && body.role === undefined) {
        if (target.role !== "resident_tenant") throw Object.assign(new Error("Only Resident / Tenant accounts can be linked to a tenant record."), { status: 400 });
        if (typeof body.tenantId !== "string" || !body.tenantId.trim()) throw Object.assign(new Error("Choose a tenant record to link this account."), { status: 400 });
        target.tenantId = body.tenantId.trim();
      }
      if (body.active !== undefined) {
        if (typeof body.active !== "boolean") throw Object.assign(new Error("Invalid account status."), { status: 400 });
        if (target.id === currentAccount?.id && !body.active) throw Object.assign(new Error("You cannot disable your own account."), { status: 400 });
        target.active = body.active;
      }
      if (["property_manager", "estate_agent"].includes(target.role) && target.active) {
        const organizationId = target.organizationId ?? "rentwise-default";
        const owner = store.users.find((item) => item.role === "landlord_owner" && (item.organizationId ?? "rentwise-default") === organizationId && item.active);
        const staffPlan = getConfiguredPlan(owner?.subscriptionPlan) ?? getConfiguredPlan("free_starter")!;
        const staffCount = store.users.filter((item) => item.id !== target.id && accountCountsAsStaff(item, organizationId)).length;
        if (staffPlan.limits.staff !== null && staffCount + 1 > staffPlan.limits.staff) throw Object.assign(new Error(`${staffPlan.name} includes up to ${staffPlan.limits.staff} staff accounts. Upgrade the organization plan before assigning this role.`), { status: 403 });
      }
      if (wasActiveSuperAdmin && !store.users.some((item) => item.role === "super_admin" && item.active)) throw Object.assign(new Error("At least one active Super Administrator account must remain."), { status: 400 });
      return target;
    });
    if (body.password !== undefined && account.id !== currentAccount?.id) {
      await database().query("DELETE FROM rentwise_sessions WHERE user_id=$1", [account.id]);
    }
    send(response, 200, { user: publicAccount(account) });
    return;
  }

  if (userRoute && method === "DELETE") {
    const currentAccount = await getSessionAccount(request);
    requireSuperAdmin(currentAccount);
    await updateStore((store) => {
      const index = store.users.findIndex((item) => item.id === userRoute[1]);
      if (index < 0) throw Object.assign(new Error("Account not found."), { status: 404 });
      const target = store.users[index];
      if (target.id === currentAccount?.id) throw Object.assign(new Error("You cannot delete your own account."), { status: 400 });
      if (target.role === "super_admin" && target.active && store.users.filter((item) => item.id !== target.id && item.role === "super_admin" && item.active).length === 0) throw Object.assign(new Error("At least one active Super Administrator account must remain."), { status: 400 });
      store.users.splice(index, 1);
    });
    await database().query("DELETE FROM rentwise_sessions WHERE user_id=$1", [userRoute[1]]);
    send(response, 200, { ok: true });
    return;
  }

  send(response, 404, { error: "API route not found." });
}

export function rentwiseApiHandler(request: IncomingMessage, response: ServerResponse) {
  const pathname = (request.url ?? "").split("?")[0];
  if (pathname !== "/api" && !pathname.startsWith("/api/")) return false;
  void route(request, response).catch((error: unknown) => {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 400;
    const message = error instanceof Error ? error.message : "Request failed.";
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", service: "api", event: "request_failed", method: request.method ?? "?", path: pathname, status, message }));
    if (!response.headersSent) send(response, status, { error: message });
    else response.end();
  });
  return true;
}

function authMiddleware(request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) {
  if (!rentwiseApiHandler(request, response)) next();
}

export function rentwiseAuthPlugin(): Plugin {
  return {
    name: "rentwise-authentication",
    configureServer(server) {
      server.middlewares.use(authMiddleware);
      const cleanup = startRentWiseBackgroundJobs(false);
      server.httpServer?.once("close", cleanup);
    },
    configurePreviewServer(server) { server.middlewares.use(authMiddleware); },
  };
}
