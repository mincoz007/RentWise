
import "./App.css";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth, roleLabels, type AuthUser, type RoleId, type SubscriptionPlanId } from "./auth";
import { normalizePlanId, subscriptionPlans, type PlanId, type SubscriptionInterval, type SubscriptionPlanConfig, type PlanLimitKey } from "./plan-catalog";
import type { PDFFont, PDFPage } from "pdf-lib";

type Property = {
  id: string;
  name: string;
  type: string;
  apartmentType?: string;
  address: string;
  city: string;
  state: string;
  units: number;
  photoName?: string;
  photoNames?: string[];
};

type AgentPropertyListing = {
  id: string;
  organizationId: string;
  name: string;
  type: string;
  apartmentType?: string;
  address: string;
  city: string;
  state: string;
  units: number;
  availableUnits: number;
  photoNames: string[];
  photoUrls: string[];
  landlord: { name: string; email: string; phone: string };
};

type PaymentFrequency = "Monthly" | "Every 3 months" | "Every 6 months" | "Every 9 months" | "Yearly" | "Every 2 years";
const paymentFrequencyOptions: Array<{ value: PaymentFrequency; label: string }> = [
  { value: "Monthly", label: "1 month" },
  { value: "Every 3 months", label: "3 months" },
  { value: "Every 6 months", label: "6 months" },
  { value: "Every 9 months", label: "9 months" },
  { value: "Yearly", label: "1 year" },
  { value: "Every 2 years", label: "2 years" },
];

function paymentFrequencyMonths(frequency: PaymentFrequency) {
  if (frequency === "Yearly") return 12;
  if (frequency === "Every 2 years") return 24;
  if (frequency === "Every 9 months") return 9;
  if (frequency === "Every 6 months") return 6;
  if (frequency === "Every 3 months") return 3;
  return 1;
}

function paymentFrequencyLabel(frequency: PaymentFrequency) {
  return paymentFrequencyOptions.find((option) => option.value === frequency)?.label ?? paymentFrequencyOptions[0].label;
}

function propertyPhotoNames(property: Property | undefined) {
  if (!property) return [];
  const names = Array.isArray(property.photoNames) ? property.photoNames.filter((name): name is string => typeof name === "string" && Boolean(name.trim())) : [];
  return (names.length ? names : property.photoName ? [property.photoName] : []).slice(0, 4);
}

function propertyPhotoAttachmentId(propertyId: string, index: number) {
  return index === 0 ? `property-${propertyId}` : `property-${propertyId}-${index + 1}`;
}

type Tenant = {
  id: string;
  name: string;
  phone: string;
  email: string;
  gender?: string;
  nationality?: string;
  maritalStatus?: string;
  residentialAddress?: string;
  residentialCity?: string;
  residentialState?: string;
  occupation?: string;
  employerName?: string;
  employerAddress?: string;
  guarantorName?: string;
  guarantorPhone?: string;
  guarantorEmail?: string;
  guarantorAddress?: string;
  propertyId: string;
  monthlyRent: number;
  paymentFrequency?: PaymentFrequency;
  moveInDate?: string;
  rentedDate?: string;
  expirationDate?: string;
  reminderDateOverride?: string;
  photoName?: string;
  whatsappRemindersOptIn?: boolean;
};

type ResidentReminderNotification = {
  id: string;
  title: string;
  message: string;
  reminderDate: string;
  createdAt: string;
  readAt: string | null;
};

type SubscriptionNotice = { id: string; title: string; message: string; daysRemaining: number; createdAt: string; readAt: string | null };

type WhatsAppSetupStatus = {
  configured: boolean;
  phoneNumberIdConfigured: boolean;
  accessTokenConfigured: boolean;
  templateConfigured: boolean;
  graphVersionConfigured: boolean;
  templateName: string;
  templateLanguage: string;
  reminderTemplateConfigured: boolean;
  reminderTemplateName: string;
  reminderTemplateLanguage: string;
};

type TenantSignup = { id: string; applicantName: string; email: string; phone: string; submittedAt: string };

function sanitizeTenantRecords(value: unknown): Tenant[] {
  if (!Array.isArray(value)) return [];
  const removedFields = ["dateOfBirth", "identityType", "identityNumber", "monthlyIncome", "employerPhone", "nextOfKinName", "nextOfKinRelationship", "nextOfKinPhone", "nextOfKinEmail"];
  return value.filter((item): item is Tenant => Boolean(item && typeof item === "object" && typeof (item as Tenant).id === "string")).map((item) => {
    const sanitized = { ...item } as Tenant & Record<string, unknown>;
    removedFields.forEach((field) => { delete sanitized[field]; });
    return sanitized;
  });
}

type RentPayment = {
  id: string;
  reference?: string;
  tenantId?: string;
  tenantName?: string;
  propertyId?: string;
  transactionType?: "Initial rent" | "Rent renewal" | "Caution fee" | "Inspection fee" | "Agent fee" | "Rent payment";
  sourceRecordId?: string;
  amount: number;
  amountKobo?: number;
  paymentDate: string;
  recordedAt?: string;
  method: string;
  rentPeriod: string;
  status?: "Pending" | "Paid" | "Rejected" | "Reversed" | "";
  reversalReason?: string;
  receiptName?: string;
};

function createPaymentReference(id: string, paymentDate: string) {
  const year = /^\d{4}/.test(paymentDate) ? paymentDate.slice(0, 4) : String(new Date().getFullYear());
  const suffix = id.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 12) || createClientId().replaceAll("-", "").slice(0, 12).toUpperCase();
  return `RW-PAY-${year}-${suffix}`;
}

function getPaymentReference(payment: RentPayment) {
  return payment.reference || createPaymentReference(payment.id, payment.paymentDate);
}

function isConfirmedPayment(payment: RentPayment) {
  return payment.status === "Paid";
}

function paymentStatusLabel(payment: RentPayment) {
  return typeof payment.status === "string" && payment.status.trim() ? payment.status : "Needs review";
}

function isAwaitingPaymentConfirmation(payment: RentPayment) {
  return payment.status !== "Paid" && payment.status !== "Rejected" && payment.status !== "Reversed";
}

function isConfirmedExpense(expense: PropertyExpense) {
  return !["reversed", "void", "cancelled"].includes(String(expense.financialStatus ?? "").toLowerCase());
}

type RenewalRequest = {
  id: string;
  tenantId: string;
  paymentId: string;
  reference: string;
  startDate: string;
  expirationDate: string;
  rentAmount: number;
  paymentFrequency: PaymentFrequency;
  submittedDate: string;
  status: "Pending" | "Approved" | "Declined";
  approvedLeaseId?: string;
};

type PropertyExpense = {
  id: string;
  propertyId: string;
  category: string;
  amount: number;
  amountKobo?: number;
  expenseDate: string;
  paidTo: string;
  description: string;
  sourceMaintenanceRequestId?: string;
  reference?: string;
  financialStatus?: "Confirmed" | "Reversed";
  reversalReason?: string;
};

type FinancialLedgerData = {
  summary: { incomeKobo: string; expensesKobo: string; netProfitKobo: string };
  unreviewedPayments?: number;
  unreviewedAmounts?: number;
  properties: Array<{ id: string; name: string; address: string; rentalIncomeKobo: string; otherIncomeKobo: string; totalExpensesKobo: string; maintenanceExpensesKobo: string; repairExpensesKobo: string; managementAndAgentFeesKobo: string; otherOperationalExpensesKobo: string; netProfitKobo: string }>;
  transactions: Array<{ id: string; reference: string; date: string; propertyId: string; propertyName: string; category: string; detail: string; description: string; amountKobo: string; direction: "income" | "expense"; status: string; source: "payment" | "expense" }>;
  audit: Array<{ id: string; collection: string; transactionId: string; reference: string; action: string; before?: unknown; after?: unknown; actor: string; createdAt: string }>;
};

function koboToNaira(value: string | number) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount / 100 : 0;
}

type LeaseAgreement = {
  id: string;
  tenantId: string;
  reference: string;
  agreementDate?: string;
  startDate: string;
  expirationDate: string;
  rentAmount: number;
  paymentFrequency: PaymentFrequency;
  securityDeposit: number;
  status: "Draft" | "Active" | "Terminated";
  notes: string;
  landlordName?: string;
  landlordAddress?: string;
  landlordPhone?: string;
  tenantAddress?: string;
  witnessName?: string;
  guarantors?: Array<{ name: string; address: string; phone: string }>;
  documentName?: string;
  generatedDocumentId?: string;
  generatedDocumentName?: string;
};

type BankTransferDetails = { bankName: string; accountName: string; accountNumber: string; landlordName?: string; landlordAddress?: string; landlordPhone?: string };
type LandlordProfile = { name: string; email: string };
type MaintenanceRequest = {
  id: string;
  tenantId: string;
  propertyId: string;
  repairType: "Major" | "Minor";
  title: string;
  description: string;
  submittedDate: string;
  status: "Open" | "In Progress" | "Resolved" | "Declined";
  images?: Array<{ id: string; name: string }>;
  vendorId?: string;
  quoteAmount?: number;
  approvalStatus?: "Not requested" | "Pending" | "Approved" | "Declined";
  approvedAmount?: number;
  actualCost?: number;
  resolvedDate?: string;
  workOrderDueDate?: string;
  workOrderNotes?: string;
};
type MaintenanceVendor = { id: string; name: string; company: string; phone: string; email: string; specialty: string; serviceArea: string; active: boolean };
type InspectionKind = "Move-in" | "Routine" | "Move-out" | "Handover";
type InspectionCondition = "Good" | "Fair" | "Needs repair" | "Not checked";
type PropertyInspection = {
  id: string;
  propertyId: string;
  tenantId?: string;
  unitLabel: string;
  kind: InspectionKind;
  inspectionDate: string;
  inspectorName: string;
  inspectionFee?: number;
  agentFee?: number;
  meterReadings: { electricity: string; water: string };
  checklist: { exterior: InspectionCondition; wallsFloors: InspectionCondition; electrical: InspectionCondition; plumbing: InspectionCondition; doorsWindows: InspectionCondition; fixtures: InspectionCondition };
  observations: string;
  handoverNotes: string;
  acknowledgementName: string;
  acknowledgedAt: string;
  photos: Array<{ id: string; name: string }>;
};
type BackupAttachment = { key: string; name: string; type: string; base64: string };

const dataCollectionVersions = new Map<string, number>();
let activeDataOrganizationId = "";

function createClientId() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function dataApi<T = { ok: boolean }>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const callerSignal = init?.signal;
  let timedOut = false;
  callerSignal?.addEventListener("abort", () => controller.abort(), { once: true });
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 45_000);
  let response: Response;
  let requestInit = init;
  const requestMethod = (init?.method ?? "GET").toUpperCase();
  const requestUrl = new URL(url, window.location.href);
  if (requestUrl.pathname === "/api/data" && requestMethod === "PUT" && typeof init?.body === "string") {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const collection = typeof body.collection === "string" ? body.collection : "";
    const revision = dataCollectionVersions.get(`${activeDataOrganizationId}:${collection}`);
    if (revision === undefined) { window.clearTimeout(timeout); throw new Error("RentWise has not loaded the current data version. Reload the workspace and try again."); }
    requestInit = { ...init, body: JSON.stringify({ ...body, expectedRevision: revision }) };
  }
  let result: (T & { error?: string }) | undefined;
  try {
    response = await fetch(url, { ...requestInit, credentials: "include", signal: controller.signal, headers: { "Content-Type": "application/json", ...requestInit?.headers } });
    try { result = await response.json() as T & { error?: string }; }
    catch { result = undefined; }
  } catch {
    window.clearTimeout(timeout);
    if (timedOut) throw new Error("RentWise did not respond within 45 seconds. Check the server and database, then retry.");
    throw new Error("Cannot reach the RentWise server. Check that the host computer and phone are on the same Wi-Fi network and that the server is still running.");
  } finally {
    window.clearTimeout(timeout);
  }
  if (response.status === 401) throw new Error("Your sign-in session is missing or expired. Sign out, sign in again on this device, then retry. This change has not been saved.");
  if (response.status === 403) throw new Error(result?.error || "Your account does not have permission to make this change.");
  if (!response.ok) throw new Error(result?.error || `RentWise could not complete the request (server error ${response.status}). Please retry; if it continues, contact your administrator.`);
  if (!result) throw new Error("RentWise received an unreadable response from the server. Retry, and contact your administrator if this continues.");
  if (result && typeof result === "object") {
    const responseData = result as T & { versions?: Record<string, number>; organizationId?: string; collection?: string; revision?: number };
    if (requestUrl.pathname === "/api/data" && requestMethod === "GET" && responseData.versions && typeof responseData.organizationId === "string") {
      if (activeDataOrganizationId && activeDataOrganizationId !== responseData.organizationId) dataCollectionVersions.clear();
      activeDataOrganizationId = responseData.organizationId;
      for (const [collection, revision] of Object.entries(responseData.versions)) if (Number.isSafeInteger(revision)) dataCollectionVersions.set(`${activeDataOrganizationId}:${collection}`, revision);
    }
    // Custom endpoints can update a collection too (for example payment history
    // synchronization). Keep the next autosave on the revision they just wrote.
    if (typeof responseData.collection === "string" && Number.isSafeInteger(responseData.revision) && activeDataOrganizationId) {
      dataCollectionVersions.set(`${activeDataOrganizationId}:${responseData.collection}`, responseData.revision!);
      if (["payments", "expenses"].includes(responseData.collection)) {
        window.dispatchEvent(new Event("rentwise:financial-data-updated"));
      }
    }
  }
  return result;
}

const pendingCollectionSaves = new Map<string, Promise<void>>();

function saveData(collection: string, data: unknown, onError?: (message: string) => void) {
  // React can schedule more than one autosave for the same collection before
  // the first PUT has returned its new revision. Serialize those writes so a
  // same-device save cannot invalidate its own next save with a stale revision.
  const previous = pendingCollectionSaves.get(collection) ?? Promise.resolve();
  const save = previous.then(() => dataApi("/api/data", { method: "PUT", body: JSON.stringify({ collection, data }) })).then(() => {
    onError?.("");
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "RentWise could not save to PostgreSQL.";
    onError?.(message);
    console.error("RentWise PostgreSQL save failed:", error);
  });
  pendingCollectionSaves.set(collection, save);
  void save.finally(() => { if (pendingCollectionSaves.get(collection) === save) pendingCollectionSaves.delete(collection); });
  return save;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timer = 0;
  return Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = window.setTimeout(() => reject(new Error(message)), timeoutMs); })])
    .finally(() => window.clearTimeout(timer));
}

function readStoredJSON<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") as T ?? fallback; }
  catch { return fallback; }
}

const backupDataKeys = ["rentwise-properties", "rentwise-tenants", "rentwise-reminder-messages", "rentwise-payments", "rentwise-expenses", "rentwise-leases", "rentwise-renewal-requests", "rentwise-bank-transfer-details", "rentwise-maintenance", "rentwise-maintenance-vendors", "rentwise-inspections"];

type PageId = "dashboard" | "properties" | "tenants" | "leases" | "inspections" | "renewals" | "ledger" | "payments" | "agent_fees" | "payment_settings" | "backups" | "maintenance" | "expenses" | "reports" | "reminders" | "resident" | "roles" | "plans" | "agent_properties";

const roleDefinitions: Array<{ id: RoleId; label: string; description: string; pages: PageId[]; editableModules: string[] }> = [
  { id: "super_admin", label: "Super Administrator", description: "Full system oversight and role allocation.", pages: ["dashboard", "properties", "tenants", "leases", "inspections", "renewals", "ledger", "payments", "payment_settings", "backups", "maintenance", "expenses", "reports", "reminders", "resident", "roles", "plans"], editableModules: ["properties", "tenants", "leases", "inspections", "payments", "payment_settings", "backups", "maintenance", "maintenanceVendors", "expenses"] },
  { id: "platform_admin", label: "Platform Administrator", description: "Global platform visibility and creation of landlord, property manager, agent, and tenant accounts.", pages: ["dashboard", "properties", "tenants", "leases", "inspections", "renewals", "ledger", "payments", "maintenance", "expenses", "reports", "reminders", "roles"], editableModules: [] },
  { id: "landlord_owner", label: "Landlord / Organization Owner", description: "Full property, financial, and subscription rights for the organization.", pages: ["dashboard", "properties", "tenants", "leases", "inspections", "renewals", "ledger", "payments", "payment_settings", "backups", "maintenance", "expenses", "reports", "reminders", "plans"], editableModules: ["properties", "tenants", "leases", "inspections", "payments", "payment_settings", "backups", "maintenance", "maintenanceVendors", "expenses"] },
  { id: "property_manager", label: "Property Manager", description: "Full operational and financial access to the landlord’s organization workspace.", pages: ["dashboard", "properties", "tenants", "leases", "inspections", "renewals", "ledger", "payments", "payment_settings", "backups", "maintenance", "expenses", "reports", "reminders", "plans"], editableModules: ["properties", "tenants", "leases", "inspections", "payments", "payment_settings", "backups", "maintenance", "maintenanceVendors", "expenses"] },
  { id: "estate_agent", label: "Estate Agent", description: "View the system property directory and manage inspections, agent fees, expenses, and reports in a personal or assigned workspace.", pages: ["agent_properties", "inspections", "agent_fees", "expenses", "reports"], editableModules: ["inspections", "agent_fees", "expenses"] },
  { id: "resident_tenant", label: "Resident / Tenant", description: "Self-service access to the resident’s own lease, payments, maintenance requests, and reminders.", pages: ["resident", "maintenance", "plans"], editableModules: ["maintenance"] },
];

function roleCanEdit(roleId: RoleId, module: string) {
  return roleDefinitions.find((role) => role.id === roleId)?.editableModules.includes(module) ?? false;
}

async function syncAttachment(category: "lease" | "receipt" | "maintenance" | "inspection" | "profile", id: string, file: File) {
  await dataApi(`/api/attachments/${category}/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ name: file.name, type: file.type, base64: await blobToBase64(file) }) });
}

async function deleteSyncedAttachment(category: "lease" | "receipt" | "maintenance" | "inspection" | "profile", id: string) {
  await dataApi(`/api/attachments/${category}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

async function getSyncedAttachment(category: "lease" | "receipt" | "maintenance" | "inspection" | "profile", id: string): Promise<Blob | undefined> {
  const response = await fetch(`/api/attachments/${category}/${encodeURIComponent(id)}`, { credentials: "include" });
  if (response.status === 404) return undefined;
  const result = await response.json() as { name: string; type: string; base64?: string; error?: string };
  if (!response.ok) throw new Error(result.error || "Could not download the attachment.");
  const binary = atob(result.base64 ?? "");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: result.type });
}

function storeLeaseDocument(leaseId: string, file: File) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let database: IDBDatabase | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      database?.close();
      if (error) reject(error);
      else resolve();
    };
    const timeout = window.setTimeout(() => finish(new Error("Saving the lease file in this browser timed out. Close other RentWise tabs and retry.")), 30_000);
    // Bump the IndexedDB version so browsers that already created an empty v1
    // database (before leaseFiles existed) run the upgrade handler as well.
    const request = indexedDB.open("rentwise-lease-files", 2);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("leaseFiles")) request.result.createObjectStore("leaseFiles"); };
    request.onblocked = () => finish(new Error("The lease file store is busy in another RentWise tab. Close the other tab and retry."));
    request.onerror = () => finish(request.error ?? new Error("Could not open the browser lease file store."));
    request.onsuccess = () => {
      database = request.result;
      if (settled) { database.close(); return; }
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction("leaseFiles", "readwrite");
        transaction.objectStore("leaseFiles").put(file, leaseId);
      } catch (error) { finish(error); return; }
      transaction.oncomplete = () => { window.clearTimeout(timeout); database?.close(); database = undefined; void syncAttachment("lease", leaseId, file).then(() => finish(), finish); };
      transaction.onerror = () => finish(transaction.error ?? new Error("Could not save the lease file in this browser."));
      transaction.onabort = () => finish(transaction.error ?? new Error("The browser cancelled the lease file save."));
    };
  });
}

function readLeaseDocument(leaseId: string) {
  return new Promise<Blob | undefined>((resolve, reject) => {
    const request = indexedDB.open("rentwise-lease-files", 2);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("leaseFiles")) { database.close(); resolve(undefined); return; }
      const transaction = database.transaction("leaseFiles", "readonly");
      const getRequest = transaction.objectStore("leaseFiles").get(leaseId);
      getRequest.onsuccess = () => { const local = getRequest.result as Blob | undefined; void getSyncedAttachment("lease", leaseId).then((remote) => { database.close(); resolve(remote ?? local); }).catch(() => { database.close(); resolve(local); }); };
      getRequest.onerror = () => { database.close(); reject(getRequest.error); };
    };
  });
}

function storePaymentReceipt(paymentId: string, file: File) {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("rentwise-payment-receipts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("receipts");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("receipts", "readwrite");
      transaction.objectStore("receipts").put(file, paymentId);
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  });
}

function readPaymentReceipt(paymentId: string) {
  return new Promise<Blob | undefined>((resolve, reject) => {
    const request = indexedDB.open("rentwise-payment-receipts", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("receipts")) { database.close(); resolve(undefined); return; }
      const transaction = database.transaction("receipts", "readonly");
      const getRequest = transaction.objectStore("receipts").get(paymentId);
      getRequest.onsuccess = () => { const local = getRequest.result as Blob | undefined; void getSyncedAttachment("receipt", paymentId).then((remote) => { database.close(); resolve(remote ?? local); }).catch(() => { database.close(); resolve(local); }); };
      getRequest.onerror = () => { database.close(); reject(getRequest.error); };
    };
  });
}

function storeMaintenanceImage(imageId: string, file: File) {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("rentwise-maintenance-images", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("images");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("images", "readwrite");
      transaction.objectStore("images").put(file, imageId);
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  });
}

function readMaintenanceImage(imageId: string) {
  return new Promise<Blob | undefined>((resolve, reject) => {
    const request = indexedDB.open("rentwise-maintenance-images", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("images")) { database.close(); resolve(undefined); return; }
      const transaction = database.transaction("images", "readonly");
      const getRequest = transaction.objectStore("images").get(imageId);
      getRequest.onsuccess = () => { const local = getRequest.result as Blob | undefined; void getSyncedAttachment("maintenance", imageId).then((remote) => { database.close(); resolve(remote ?? local); }).catch(() => { database.close(); resolve(local); }); };
      getRequest.onerror = () => { database.close(); reject(getRequest.error); };
    };
  });
}

function storeInspectionPhoto(photoId: string, file: File) {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("rentwise-inspection-photos", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("photos");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("photos", "readwrite");
      transaction.objectStore("photos").put(file, photoId);
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  });
}

function readInspectionPhoto(photoId: string) {
  return new Promise<Blob | undefined>((resolve, reject) => {
    const request = indexedDB.open("rentwise-inspection-photos", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("photos")) { database.close(); resolve(undefined); return; }
      const transaction = database.transaction("photos", "readonly");
      const getRequest = transaction.objectStore("photos").get(photoId);
      getRequest.onsuccess = () => { const local = getRequest.result as Blob | undefined; void getSyncedAttachment("inspection", photoId).then((remote) => { database.close(); resolve(remote ?? local); }).catch(() => { database.close(); resolve(local); }); };
      getRequest.onerror = () => { database.close(); reject(getRequest.error); };
    };
  });
}

function readIndexedDbFiles(databaseName: string, storeName: string) {
  return new Promise<Array<{ key: string; file: Blob }>>((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseName === "rentwise-lease-files" ? 2 : 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) { database.close(); resolve([]); return; }
      const transaction = database.transaction(storeName, "readonly");
      const objectStore = transaction.objectStore(storeName);
      const keysRequest = objectStore.getAllKeys();
      const valuesRequest = objectStore.getAll();
      transaction.oncomplete = () => {
        resolve(keysRequest.result.map((key, index) => ({ key: String(key), file: valuesRequest.result[index] as Blob })).filter((entry) => entry.file instanceof Blob));
        database.close();
      };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  });
}

function replaceIndexedDbFiles(databaseName: string, storeName: string, files: Array<{ key: string; file: File }>) {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseName === "rentwise-lease-files" ? 2 : 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) { database.close(); reject(new Error(`Missing ${storeName} store`)); return; }
      const transaction = database.transaction(storeName, "readwrite");
      const objectStore = transaction.objectStore(storeName);
      objectStore.clear();
      files.forEach(({ key, file }) => objectStore.put(file, key));
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  });
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function fileFromBase64(attachment: BackupAttachment) {
  const bytes = Uint8Array.from(atob(attachment.base64), (character) => character.charCodeAt(0));
  return new File([bytes], attachment.name, { type: attachment.type || "application/octet-stream" });
}

function calculateExpirationDate(startDate: string, frequency: PaymentFrequency) {
  if (!startDate) return "";
  const [year, month, day] = startDate.split("-").map(Number);
  const monthsToAdd = paymentFrequencyMonths(frequency);
  const targetMonthIndex = month - 1 + monthsToAdd;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = targetMonthIndex % 12;
  const targetDay = Math.min(day, new Date(targetYear, targetMonth + 1, 0).getDate());
  return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

function rentCycleStartDate(startDate: string, cycle: number, frequency: PaymentFrequency) {
  const [year, month, day] = startDate.split("-").map(Number);
  const targetMonthIndex = month - 1 + cycle * paymentFrequencyMonths(frequency);
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = targetMonthIndex % 12;
  const targetDay = Math.min(day, new Date(targetYear, targetMonth + 1, 0).getDate());
  return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

function reminderRule(frequency: PaymentFrequency) {
  const months = paymentFrequencyMonths(frequency);
  if (months >= 12) return { leadMonths: 2, leadDays: 0, repeatDays: 14, label: "2 months before · every 2 weeks" };
  if (months >= 3) return { leadMonths: 1, leadDays: 0, repeatDays: 7, label: "1 month before · every 1 week" };
  return { leadMonths: 0, leadDays: 7, repeatDays: 2, label: "1 week before · every 2 days" };
}

function calculateReminderDate(expirationDate: string, frequency: PaymentFrequency) {
  if (!expirationDate) return "";
  const [year, month, day] = expirationDate.split("-").map(Number);
  const rule = reminderRule(frequency);
  if (rule.leadDays) {
    const target = new Date(year, month - 1, day - rule.leadDays);
    return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`;
  }
  const targetMonthIndex = month - 1 - rule.leadMonths;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const targetDay = Math.min(day, new Date(targetYear, targetMonth + 1, 0).getDate());
  return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

function nextReminderDate(firstReminderDate: string, expirationDate: string, today: string, repeatDays: number) {
  if (!firstReminderDate || today > expirationDate) return "";
  const toDate = (value: string) => new Date(`${value}T00:00:00`);
  const elapsedDays = Math.max(0, Math.floor((toDate(today).getTime() - toDate(firstReminderDate).getTime()) / 86_400_000));
  const intervalsPassed = Math.ceil(elapsedDays / repeatDays);
  const first = toDate(firstReminderDate);
  first.setDate(first.getDate() + intervalsPassed * repeatDays);
  const next = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}-${String(first.getDate()).padStart(2, "0")}`;
  return next <= expirationDate ? next : "";
}

function formatDate(date: string) {
  return date ? new Date(`${date}T00:00:00`).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" }) : "Not set";
}

function getPlanTermPrice(plan: SubscriptionPlanConfig, interval: SubscriptionInterval) {
  return interval === "monthly" ? plan.monthlyPrice : plan.annualPrice;
}

function formatPlanTermPrice(plan: SubscriptionPlanConfig, interval: SubscriptionInterval) {
  const price = getPlanTermPrice(plan, interval);
  return price === null ? "Custom pricing" : `₦${price.toLocaleString("en-NG")} / ${interval === "monthly" ? "month" : "year"}`;
}

function planLimitBullet(plan: SubscriptionPlanConfig, bullet: string) {
  const rules: Array<{ key: PlanLimitKey; pattern: RegExp; unit: string }> = [
    { key: "properties", pattern: /^(?:1|Up to \d+) properties?$/i, unit: "properties" },
    { key: "units", pattern: /^Up to \d+ rental units$/i, unit: "rental units" },
    { key: "tenants", pattern: /^Up to \d+ tenants$/i, unit: "tenants" },
    { key: "staff", pattern: /^Up to \d+ staff accounts$/i, unit: "staff accounts" },
  ];
  const match = rules.find((rule) => rule.pattern.test(bullet));
  if (!match) return bullet;
  const limit = plan.limits[match.key];
  if (limit === null) return `Unlimited ${match.unit}`;
  if (match.key === "staff" && limit === 0) return "No additional staff accounts";
  return `${match.key === "properties" && limit === 1 ? "1" : `Up to ${limit}`} ${match.key === "properties" && limit === 1 ? "property" : match.unit}`;
}

function SubscriptionCountdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const expiry = Date.parse(expiresAt);
  const remaining = Math.max(0, expiry - now);
  if (!Number.isFinite(remaining) || remaining <= 0) return <span>Expired · account inactive</span>;
  const daysRemaining = Math.ceil(remaining / 86_400_000);
  return <span>{daysRemaining} {daysRemaining === 1 ? "day" : "days"} remaining</span>;
}

function ResidentReminderPanel({ notifications, onMarkRead }: { notifications: ResidentReminderNotification[]; onMarkRead: (id: string) => void }) {
  if (!notifications.length) return <section className="panel resident-reminder-panel"><div className="panel-header"><div><h2>Rent reminders</h2><p>Automatic reminders from your landlord will appear here.</p></div></div><div className="resident-reminder-empty">No rent reminders yet.</div></section>;
  const unread = notifications.filter((notification) => !notification.readAt).length;
  return <section className="panel resident-reminder-panel"><div className="panel-header"><div><h2>Rent reminders</h2><p>{unread ? `${unread} unread reminder${unread === 1 ? "" : "s"}` : "Your rent reminder history"}</p></div></div><div className="resident-reminder-list">{notifications.map((notification) => <article className={`resident-reminder-item ${notification.readAt ? "read" : "unread"}`} key={notification.id}><div className="resident-reminder-item-top"><strong>{notification.title}</strong><time dateTime={notification.createdAt}>{formatDate(notification.reminderDate)}</time></div><p>{notification.message}</p>{!notification.readAt && <button className="row-modify" type="button" onClick={() => onMarkRead(notification.id)}>Mark as read</button>}</article>)}</div></section>;
}

function escapeReceiptHtml(value: string) {
  const replacements: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return value.replace(/[&<>"']/g, (character) => replacements[character] ?? character);
}

function paymentReceiptNumber(payment: RentPayment) {
  const year = payment.paymentDate?.slice(0, 4) || String(new Date().getFullYear());
  const suffix = payment.id.replace(/[^a-z0-9]/gi, "").slice(-8).toUpperCase() || "PAYMENT";
  return `RW-${year}-${suffix}`;
}

function printPaymentReceipt(payment: RentPayment, tenant?: Tenant, property?: Property) {
  if (!isConfirmedPayment(payment)) return;
  const receiptWindow = window.open("", "_blank", "width=860,height=900");
  if (!receiptWindow) {
    window.alert("Allow pop-ups for RentWise, then select Receipt PDF again.");
    return;
  }
  const receiptNumber = paymentReceiptNumber(payment);
  const esc = escapeReceiptHtml;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(receiptNumber)} · RentWise NG</title><style>
    *{box-sizing:border-box}body{margin:0;padding:32px;background:#eef3ef;color:#17221b;font:15px/1.5 Arial,Helvetica,sans-serif}.sheet{max-width:760px;margin:0 auto;background:#fff;border:1px solid #dce5df;border-radius:18px;overflow:hidden;box-shadow:0 18px 50px #15351f18}.topline{height:9px;background:linear-gradient(90deg,#087a47,#29a36a)}.inner{padding:42px 48px}.head{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;border-bottom:1px solid #e7ede9;padding-bottom:28px}.brand{display:flex;align-items:center;gap:12px}.mark{width:46px;height:46px;border-radius:13px;background:#12814b;color:#fff;display:grid;place-items:center;font-weight:800;font-size:24px}.brand-name{font-size:18px;font-weight:800;letter-spacing:.01em}.brand-sub{font-size:10px;letter-spacing:.16em;color:#748078;text-transform:uppercase}.receipt-type{text-align:right}.receipt-type strong{display:block;color:#12814b;font-size:12px;letter-spacing:.12em}.receipt-type span{display:inline-block;margin-top:8px;background:#e7f5ec;color:#12653d;padding:5px 11px;border-radius:999px;font-size:11px;font-weight:700}.title{margin:30px 0 4px;font-size:30px;line-height:1.15}.muted{color:#68756d}.amount-box{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:25px 0;padding:20px 22px;background:#f0f7f2;border:1px solid #d8ebdf;border-radius:12px}.amount-label{font-size:12px;color:#637168}.amount{font-size:28px;font-weight:800;color:#12683f;white-space:nowrap}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:22px 0}.detail{padding:17px 18px;border:1px solid #e5ebe7;border-radius:11px}.detail h2{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#6b776f;margin:0 0 13px}.detail p{margin:5px 0;overflow-wrap:anywhere}.detail strong{color:#27352c}.line-items{width:100%;border-collapse:collapse;margin-top:12px}.line-items th,.line-items td{text-align:left;padding:13px 8px;border-bottom:1px solid #e7ede9}.line-items th{width:38%;color:#69766e;font-size:12px;font-weight:600}.line-items td{font-weight:600}.ref{font-family:Consolas,monospace;color:#176943}.footer{margin-top:28px;padding-top:18px;border-top:1px solid #e7ede9;color:#6b776f;font-size:12px}.actions{display:flex;justify-content:center;gap:10px;padding:0 20px 24px}.actions button{border:0;border-radius:8px;padding:11px 18px;background:#13804b;color:#fff;font-weight:700;font-size:14px;cursor:pointer}.actions .close{background:#eef3ef;color:#26342b}@media(max-width:600px){body{padding:10px}.inner{padding:25px 20px}.head{gap:12px}.title{font-size:25px}.grid{grid-template-columns:1fr}.amount{font-size:23px}}@media print{@page{size:A4;margin:14mm}body{padding:0;background:#fff}.sheet{max-width:none;border:0;border-radius:0;box-shadow:none}.inner{padding:10mm 7mm}.topline{height:6px}.actions{display:none}}
    </style></head><body><main class="sheet"><div class="topline"></div><div class="inner"><header class="head"><div class="brand"><div class="mark">R</div><div><div class="brand-name">RentWise NG</div><div class="brand-sub">Property Management</div></div></div><div class="receipt-type"><strong>OFFICIAL ${esc((payment.transactionType ?? "Rent payment").toUpperCase())} RECEIPT</strong><span>PAYMENT RECEIVED</span></div></header><h1 class="title">Payment receipt</h1><div class="muted">Receipt reference <strong class="ref">${esc(receiptNumber)}</strong></div><section class="amount-box"><div><div class="amount-label">Amount received</div><div class="muted">${esc(payment.method || "Rent payment")}</div></div><div class="amount">₦${payment.amount.toLocaleString("en-NG")}</div></section><div class="grid"><section class="detail"><h2>Received from</h2><p><strong>${esc(tenant?.name ?? payment.tenantName ?? "Property fee")}</strong></p><p class="muted">${esc(tenant?.email ?? "")}</p></section><section class="detail"><h2>For property</h2><p><strong>${esc(property?.name ?? "Rental property")}</strong></p><p class="muted">${esc([property?.address, property?.city, property?.state].filter(Boolean).join(", ") || "Address not recorded")}</p></section></div><table class="line-items"><tbody><tr><th>Payment date</th><td>${esc(formatDate(payment.paymentDate))}</td></tr><tr><th>Transaction type</th><td>${esc(payment.transactionType ?? "Rent payment")}</td></tr><tr><th>Rent period / details</th><td>${esc(payment.rentPeriod || "Not specified")}</td></tr><tr><th>Payment method</th><td>${esc(payment.method || "Not specified")}</td></tr><tr><th>Status</th><td>Paid and confirmed</td></tr><tr><th>Issued by</th><td>RentWise NG</td></tr></tbody></table><footer class="footer">This electronically generated receipt confirms that the landlord or property manager recorded this payment as paid in RentWise NG. Keep it for your records.</footer></div><div class="actions"><button onclick="window.print()">Print / Save as PDF</button><button class="close" onclick="window.close()">Close</button></div></main></body></html>`;
  receiptWindow.document.open();
  receiptWindow.document.write(html);
  receiptWindow.document.close();
  window.setTimeout(() => { receiptWindow.focus(); receiptWindow.print(); }, 350);
}

function getTodayKey() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}

function describeLeaseDuration(startDate: string, endDate: string) {
  const [startYear, startMonth, startDay] = startDate.split("-").map(Number);
  const [endYear, endMonth, endDay] = endDate.split("-").map(Number);
  let months = (endYear - startYear) * 12 + endMonth - startMonth;
  const endMonthLength = new Date(endYear, endMonth, 0).getDate();
  if (endDay < Math.min(startDay, endMonthLength)) months -= 1;
  if (months < 1) {
    const days = Math.max(1, Math.round((new Date(`${endDate}T00:00:00`).getTime() - new Date(`${startDate}T00:00:00`).getTime()) / 86_400_000) + 1);
    return `${days} days`;
  }
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
  const asAgreementNumber = (value: number) => `${words[value] ?? value} (${value})`;
  const yearsText = years ? `${asAgreementNumber(years)} ${years === 1 ? "year" : "years"}` : "";
  const monthsText = remainingMonths ? `${asAgreementNumber(remainingMonths)} ${remainingMonths === 1 ? "month" : "months"}` : "";
  const duration = [yearsText, monthsText].filter(Boolean).join(" and ");
  return years && remainingMonths ? `${duration} (${months} months)` : years ? `${yearsText} (${months} months)` : monthsText;
}

function drawLeaseField(page: PDFPage, font: PDFFont, value: string, x: number, y: number, width: number, rgb: (r: number, g: number, b: number) => ReturnType<typeof import("pdf-lib").rgb>, size = 10) {
  const text = value.trim();
  if (!text) return;
  let fontSize = size;
  while (fontSize > 6.5 && font.widthOfTextAtSize(text, fontSize) > width) fontSize -= 0.25;
  page.drawRectangle({ x: x - 3, y: y - 4, width: width + 6, height: fontSize + 9, color: rgb(1, 1, 1) });
  page.drawText(text, { x, y, font, size: fontSize, color: rgb(0.08, 0.08, 0.08) });
}

function wrapAgreementText(text: string, font: PDFFont, width: number, size: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(candidate, size) > width) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

async function generateFilledLeaseAgreement(lease: LeaseAgreement, tenant: Tenant, property?: Property) {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const response = await fetch("/tenancy-agreement-template.pdf");
  if (!response.ok) throw new Error("The tenancy agreement template could not be loaded.");
  const pdf = await PDFDocument.load(await response.arrayBuffer());
  const pages = pdf.getPages();
  if (pages.length < 3) throw new Error("The tenancy agreement template must contain all three pages.");
  const regular = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const headerPage = pages[0];
  // Replace the template's fixed agency banner with branding unique to this property.
  headerPage.drawRectangle({ x: 14, y: 642, width: 584, height: 136, color: rgb(1, 1, 1) });
  headerPage.drawRectangle({ x: 20, y: 650, width: 572, height: 120, color: rgb(0.95, 0.975, 0.96), borderColor: rgb(0.78, 0.86, 0.81), borderWidth: 0.8 });
  headerPage.drawRectangle({ x: 20, y: 650, width: 7, height: 120, color: rgb(0.03, 0.38, 0.23) });
  const propertyHeading = property?.name?.trim() || "Rental Property";
  const headerPropertyAddress = [property?.address, property?.city, property?.state].map((part) => part?.trim()).filter(Boolean).join(", ");
  headerPage.drawText("PROPERTY", { x: 43, y: 746, font: bold, size: 8, color: rgb(0.12, 0.43, 0.29) });
  let headingSize = 21;
  let headingLines = wrapAgreementText(propertyHeading, bold, 380, headingSize);
  while ((headingLines.length > 2 || headingLines.some((line) => bold.widthOfTextAtSize(line, headingSize) > 380)) && headingSize > 10) {
    headingSize -= 0.5;
    headingLines = wrapAgreementText(propertyHeading, bold, 380, headingSize);
  }
  const headingTop = headingLines.length > 1 ? 717 : 713;
  headingLines.slice(0, 2).forEach((line, index) => headerPage.drawText(line, { x: 43, y: headingTop - index * (headingSize + 3), font: bold, size: headingSize, color: rgb(0.04, 0.23, 0.15) }));
  if (headerPropertyAddress) {
    const addressLines = wrapAgreementText(headerPropertyAddress, regular, 380, 10).slice(0, 2);
    addressLines.forEach((line, index) => headerPage.drawText(line, { x: 43, y: (headingLines.length > 1 ? 674 : 679) - index * 13, font: regular, size: 10, color: rgb(0.27, 0.34, 0.3) }));
  }
  if (property?.photoName) {
    try {
      const photo = await getSyncedAttachment("profile", `property-${property.id}`);
      if (photo) {
        let embeddedPhoto;
        if (photo.type === "image/png") embeddedPhoto = await pdf.embedPng(await photo.arrayBuffer());
        else if (photo.type === "image/jpeg" || photo.type === "image/jpg") embeddedPhoto = await pdf.embedJpg(await photo.arrayBuffer());
        else {
          const bitmap = await createImageBitmap(photo);
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
          bitmap.close();
          const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not prepare the property photo.")), "image/png"));
          embeddedPhoto = await pdf.embedPng(await png.arrayBuffer());
        }
        const photoBox = { x: 466, y: 660, width: 116, height: 100 };
        const photoScale = Math.min(photoBox.width / embeddedPhoto.width, photoBox.height / embeddedPhoto.height);
        const photoWidth = embeddedPhoto.width * photoScale;
        const photoHeight = embeddedPhoto.height * photoScale;
        headerPage.drawImage(embeddedPhoto, { x: photoBox.x + (photoBox.width - photoWidth) / 2, y: photoBox.y + (photoBox.height - photoHeight) / 2, width: photoWidth, height: photoHeight });
      }
    } catch (error) {
      console.warn("Could not add the property photo to the lease PDF:", error);
    }
  }
  const agreementDate = lease.agreementDate ?? lease.startDate;
  const [agreementYear, agreementMonth, agreementDay] = agreementDate.split("-").map(Number);
  const daySuffix = agreementDay % 100 >= 11 && agreementDay % 100 <= 13 ? "th" : agreementDay % 10 === 1 ? "st" : agreementDay % 10 === 2 ? "nd" : agreementDay % 10 === 3 ? "rd" : "th";
  const monthName = new Date(agreementYear, agreementMonth - 1, agreementDay).toLocaleDateString("en-NG", { month: "long" });
  drawLeaseField(pages[0], regular, `${agreementDay}${daySuffix}`, 239, 579, 58, rgb, 10);
  drawLeaseField(pages[0], regular, monthName, 330, 579, 99, rgb, 10);
  pages[0].drawRectangle({ x: 444, y: 575, width: 96, height: 18, color: rgb(1, 1, 1) });
  pages[0].drawText(String(agreementYear).slice(-2), { x: 444.2, y: 579, font: regular, size: 10, color: rgb(0.08, 0.08, 0.08) });
  drawLeaseField(pages[0], regular, lease.landlordName ?? "", 73, 534, 193, rgb, 10);
  drawLeaseField(pages[0], regular, tenant.name, 328, 534, 214, rgb, 10);
  drawLeaseField(pages[0], regular, lease.landlordAddress ?? "", 84, 511, 183, rgb, 9.5);
  drawLeaseField(pages[0], regular, lease.tenantAddress ?? "", 329, 511, 212, rgb, 9.5);
  const propertyAddress = [property?.name, property?.address, property?.city, property?.state].filter(Boolean).join(", ");
  drawLeaseField(pages[0], regular, propertyAddress, 114, 406, 418, rgb, 9.5);
  drawLeaseField(pages[0], regular, property?.apartmentType || property?.type || "", 152, 384, 380, rgb, 9.5);
  const annualRent = Math.round(lease.rentAmount * 12 / paymentFrequencyMonths(lease.paymentFrequency));
  drawLeaseField(pages[0], regular, annualRent.toLocaleString("en-NG"), 295, 310, 131, rgb, 10);
  drawLeaseField(pages[0], regular, lease.securityDeposit.toLocaleString("en-NG"), 160, 296, 93, rgb, 10);

  const [startYear, startMonth, startDay] = lease.startDate.split("-").map(Number);
  const [endYear, endMonth, endDay] = lease.expirationDate.split("-").map(Number);
  const startMonthName = new Date(startYear, startMonth - 1, startDay).toLocaleDateString("en-NG", { month: "long" });
  const endMonthName = new Date(endYear, endMonth - 1, endDay).toLocaleDateString("en-NG", { month: "long" });
  const durationText = describeLeaseDuration(lease.startDate, lease.expirationDate);
  const durationSentence = `The tenancy shall commence on the ${startDay} day, ${startMonthName} month, of 20${String(startYear).slice(-2)}, and shall remain valid until the ${endDay} day, ${endMonthName} month, of 20${String(endYear).slice(-2)}, making a total duration of ${durationText}, unless earlier terminated in accordance with the terms of this agreement.`;
  let paragraphSize = 9.5;
  let durationLines = wrapAgreementText(durationSentence, regular, 465, paragraphSize);
  while (durationLines.length > 3 && paragraphSize > 8.5) {
    paragraphSize -= 0.5;
    durationLines = wrapAgreementText(durationSentence, regular, 465, paragraphSize);
  }
  if (durationLines.length > 3) throw new Error("The lease dates are too long to fit in the agreement template.");
  pages[0].drawRectangle({ x: 70, y: 80, width: 480, height: 48, color: rgb(1, 1, 1) });
  durationLines.forEach((line, index) => pages[0].drawText(line, { x: 72, y: 117 - index * 13.2, font: regular, size: paragraphSize, color: rgb(0.08, 0.08, 0.08) }));

  drawLeaseField(pages[1], regular, tenant.name, 149, 198, 188, rgb, 10);
  drawLeaseField(pages[1], regular, lease.witnessName ?? "", 153, 83, 186, rgb, 10);
  drawLeaseField(pages[2], regular, tenant.name, 149, 200, 188, rgb, 10);
  drawLeaseField(pages[2], regular, lease.landlordName ?? "", 109, 85, 226, rgb, 10);
  pdf.setTitle(`Tenancy Agreement ${lease.reference}`);
  pdf.setAuthor(lease.landlordName ?? "RentWise NG");
  pdf.setSubject(`Tenancy agreement for ${tenant.name}`);
  pdf.setKeywords(["RentWise NG", lease.reference]);
  return pdf.save();
}

const stats = [
  { label: "Total Properties" },
  { label: "Occupied Units" },
  { label: "Rent Collected" },
  { label: "Expenses" },
];

function App() {
  const auth = useAuth();
  const dataReady = useRef(false);
  const [accounts, setAccounts] = useState<AuthUser[]>([]);
  const [agentPropertyListings, setAgentPropertyListings] = useState<AgentPropertyListing[]>([]);
  const [agentPoolLoading, setAgentPoolLoading] = useState(false);
  const [agentPoolError, setAgentPoolError] = useState("");
  const [agentPoolRefresh, setAgentPoolRefresh] = useState(0);
  const [agentPhotoViewer, setAgentPhotoViewer] = useState<{ listingKey: string; index: number } | null>(null);
  const [createAccountRole, setCreateAccountRole] = useState<RoleId>("landlord_owner");
  const [editingAccount, setEditingAccount] = useState<AuthUser | null>(null);
  const [resettingAccount, setResettingAccount] = useState<AuthUser | null>(null);
  const [accountMessage, setAccountMessage] = useState("");
  const [accountError, setAccountError] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  const [landlordCodeInput, setLandlordCodeInput] = useState("");
  const [landlordLinkError, setLandlordLinkError] = useState("");
  const [landlordLinkMessage, setLandlordLinkMessage] = useState("");
  const [landlordLinkBusy, setLandlordLinkBusy] = useState(false);
  const [residentLinkRefresh, setResidentLinkRefresh] = useState(0);
  const [properties, setProperties] = useState<Property[]>(() => {
    if (auth.user.role === "estate_agent") return [];
    try {
      return JSON.parse(localStorage.getItem("rentwise-properties") ?? "[]") as Property[];
    } catch {
      return [];
    }
  });
  const [profilePhotoUrls, setProfilePhotoUrls] = useState<Record<string, string>>({});
  const [subscriptionMessage, setSubscriptionMessage] = useState("");
  const [propertyPlanError, setPropertyPlanError] = useState("");
  const [propertySaveError, setPropertySaveError] = useState("");
  const [propertySaving, setPropertySaving] = useState(false);
  const [propertyPhotoFiles, setPropertyPhotoFiles] = useState<File[]>([]);
  const [propertyPhotoReplacements, setPropertyPhotoReplacements] = useState<Record<number, File>>({});
  const [propertyPhotoRemovals, setPropertyPhotoRemovals] = useState<number[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>(() => {
    if (auth.user.role === "estate_agent") return [];
    try {
      return sanitizeTenantRecords(JSON.parse(localStorage.getItem("rentwise-tenants") ?? "[]"));
    } catch {
      return [];
    }
  });
  const [tenantSignups, setTenantSignups] = useState<TenantSignup[]>([]);
  const [selectedTenantSignup, setSelectedTenantSignup] = useState<TenantSignup | null>(null);
  const [reminderMessages, setReminderMessages] = useState<Record<string, string>>(() => {
    if (auth.user.role === "estate_agent") return {};
    try {
      return JSON.parse(localStorage.getItem("rentwise-reminder-messages") ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  const [reminderFilter, setReminderFilter] = useState<"all" | "ready" | "scheduled" | "overdue">("all");
  const [reminderDateDrafts, setReminderDateDrafts] = useState<Record<string, string>>({});
  const [reminderScheduleSaving, setReminderScheduleSaving] = useState<Record<string, boolean>>({});
  const [reminderScheduleFeedback, setReminderScheduleFeedback] = useState<Record<string, { message?: string; error?: string }>>({});
  const [rentPayments, setRentPayments] = useState<RentPayment[]>(() => {
    if (auth.user.role === "estate_agent") return [];
    try {
      return JSON.parse(localStorage.getItem("rentwise-payments") ?? "[]") as RentPayment[];
    } catch {
      return [];
    }
  });
  const [expenses, setExpenses] = useState<PropertyExpense[]>(() => {
    if (auth.user.role === "estate_agent") return [];
    try {
      return JSON.parse(localStorage.getItem("rentwise-expenses") ?? "[]") as PropertyExpense[];
    } catch {
      return [];
    }
  });
  const [leases, setLeases] = useState<LeaseAgreement[]>(() => {
    if (auth.user.role === "estate_agent") return [];
    try {
      return JSON.parse(localStorage.getItem("rentwise-leases") ?? "[]") as LeaseAgreement[];
    } catch {
      return [];
    }
  });
  const [renewalRequests, setRenewalRequests] = useState<RenewalRequest[]>(() => auth.user.role === "estate_agent" ? [] : readStoredJSON("rentwise-renewal-requests", []));
  const [maintenanceRequests, setMaintenanceRequests] = useState<MaintenanceRequest[]>(() => {
    if (auth.user.role === "estate_agent") return [];
    try { return JSON.parse(localStorage.getItem("rentwise-maintenance") ?? "[]") as MaintenanceRequest[]; }
    catch { return []; }
  });
  const [maintenanceVendors, setMaintenanceVendors] = useState<MaintenanceVendor[]>(() => auth.user.role === "estate_agent" ? [] : readStoredJSON("rentwise-maintenance-vendors", []));
  const [inspections, setInspections] = useState<PropertyInspection[]>(() => auth.user.role === "estate_agent" ? [] : readStoredJSON("rentwise-inspections", []));
  const [isPropertyFormOpen, setIsPropertyFormOpen] = useState(false);
  const [isTenantFormOpen, setIsTenantFormOpen] = useState(false);
  const [isPaymentFormOpen, setIsPaymentFormOpen] = useState(false);
  const [isExpenseFormOpen, setIsExpenseFormOpen] = useState(false);
  const [isLeaseFormOpen, setIsLeaseFormOpen] = useState(false);
  const [isLeaseRenewal, setIsLeaseRenewal] = useState(false);
  const [isInspectionFormOpen, setIsInspectionFormOpen] = useState(false);
  const [editingInspectionId, setEditingInspectionId] = useState<string | null>(null);
  const [inspectionMessage, setInspectionMessage] = useState("");
  const [inspectionError, setInspectionError] = useState("");
  const [inspectionBusy, setInspectionBusy] = useState(false);
  const [inspectionSearch, setInspectionSearch] = useState("");
  const [editingPropertyId, setEditingPropertyId] = useState<string | null>(null);
  const [editingTenantId, setEditingTenantId] = useState<string | null>(null);
  const [editingPaymentId, setEditingPaymentId] = useState<string | null>(null);
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [editingLeaseId, setEditingLeaseId] = useState<string | null>(null);
  const [selectedPropertyType, setSelectedPropertyType] = useState("");
  const [currentRole, setCurrentRole] = useState<RoleId>(auth.user.role);
  const [currentPage, setCurrentPage] = useState<PageId>(() => {
    const hasInitialPlan = ["super_admin", "platform_admin"].includes(auth.user.role)
      || Boolean(auth.user.subscriptionPlan && (!auth.user.subscriptionExpiresAt || Date.parse(auth.user.subscriptionExpiresAt) > Date.now()));
    if (auth.user.role === "estate_agent" && !auth.user.organizationId) return "agent_properties";
    return hasInitialPlan ? "dashboard" : "plans";
  });
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [residentTenantId, setResidentTenantId] = useState("");
  const [residentRenewalMessage, setResidentRenewalMessage] = useState("");
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const [residentPortalSection, setResidentPortalSection] = useState<"overview" | "renewals">("overview");
  const [residentReminderNotifications, setResidentReminderNotifications] = useState<ResidentReminderNotification[]>([]);
  const [residentReminderError, setResidentReminderError] = useState("");
  const [subscriptionNotices, setSubscriptionNotices] = useState<SubscriptionNotice[]>([]);
  const [whatsappSetupStatus, setWhatsappSetupStatus] = useState<WhatsAppSetupStatus | null>(null);
  const [whatsappSetupError, setWhatsappSetupError] = useState("");
  const [whatsappTestPhone, setWhatsappTestPhone] = useState("");
  const [whatsappTestConsent, setWhatsappTestConsent] = useState(false);
  const [whatsappTestBusy, setWhatsappTestBusy] = useState(false);
  const [whatsappTestMessage, setWhatsappTestMessage] = useState("");
  const [whatsappTestError, setWhatsappTestError] = useState("");
  const [residentPaymentMethod, setResidentPaymentMethod] = useState("");
  const [residentPaymentCompleted, setResidentPaymentCompleted] = useState(false);
  const [bankTransferDetails, setBankTransferDetails] = useState<BankTransferDetails>(() => {
    if (auth.user.role === "estate_agent") return { bankName: "", accountName: "", accountNumber: "" };
    try { return JSON.parse(localStorage.getItem("rentwise-bank-transfer-details") ?? "{\"bankName\":\"\",\"accountName\":\"\",\"accountNumber\":\"\"}") as BankTransferDetails; }
    catch { return { bankName: "", accountName: "", accountNumber: "" }; }
  });
  const [landlordProfile, setLandlordProfile] = useState<LandlordProfile | null>(null);
  const [propertySearch, setPropertySearch] = useState("");
  const [tenantSearch, setTenantSearch] = useState("");
  const [rentalStartDate, setRentalStartDate] = useState("");
  const [rentalFrequency, setRentalFrequency] = useState<PaymentFrequency>("Monthly");
  const [rentalExpirationDate, setRentalExpirationDate] = useState("");
  const [tenantFormError, setTenantFormError] = useState("");
  const [paymentDate, setPaymentDate] = useState("");
  const [paymentSearch, setPaymentSearch] = useState("");
  const [agentFeeSearch, setAgentFeeSearch] = useState("");
  const [agentFeeMessage, setAgentFeeMessage] = useState("");
  const [ledgerSearch, setLedgerSearch] = useState("");
  const [arrearsSearch, setArrearsSearch] = useState("");
  const [ledgerStatusFilter, setLedgerStatusFilter] = useState("All");
  const [ledgerPropertyFilter, setLedgerPropertyFilter] = useState("all");
  const [ledgerCategoryFilter, setLedgerCategoryFilter] = useState("all");
  const [ledgerPeriod, setLedgerPeriod] = useState<"all" | "month" | "quarter" | "year" | "custom">("all");
  const [ledgerFromDate, setLedgerFromDate] = useState("");
  const [ledgerToDate, setLedgerToDate] = useState("");
  const [financialLedger, setFinancialLedger] = useState<FinancialLedgerData | null>(null);
  const [financialLedgerBusy, setFinancialLedgerBusy] = useState(false);
  const [financialLedgerError, setFinancialLedgerError] = useState("");
  const [financialLedgerMessage, setFinancialLedgerMessage] = useState("");
  const [ledgerRevision, setLedgerRevision] = useState(0);
  const [expenseDate, setExpenseDate] = useState("");
  const [expenseSearch, setExpenseSearch] = useState("");
  const [leaseSearch, setLeaseSearch] = useState("");
  const [leaseTenantId, setLeaseTenantId] = useState("");
  const [leaseStartDate, setLeaseStartDate] = useState("");
  const [leaseEndDate, setLeaseEndDate] = useState("");
  const [leaseRentAmount, setLeaseRentAmount] = useState("");
  const [leaseCautionFee, setLeaseCautionFee] = useState("");
  const [leaseFrequency, setLeaseFrequency] = useState<PaymentFrequency>("Monthly");
  const [leaseStatus, setLeaseStatus] = useState<"Draft" | "Active" | "Terminated">("Active");
  const [leaseLandlordName, setLeaseLandlordName] = useState("");
  const [leaseLandlordAddress, setLeaseLandlordAddress] = useState("");
  const [leaseTenantAddress, setLeaseTenantAddress] = useState("");
  const [leaseFormError, setLeaseFormError] = useState("");
  const [leaseSaving, setLeaseSaving] = useState(false);
  const [leaseSavingMessage, setLeaseSavingMessage] = useState("");
  const [leaseDocumentMessage, setLeaseDocumentMessage] = useState("");
  const [backupMessage, setBackupMessage] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [reportPeriod, setReportPeriod] = useState<"all" | "month" | "year">("all");
  const [reportPropertyFilter, setReportPropertyFilter] = useState("all");
  const [subscriptionInterval, setSubscriptionInterval] = useState<SubscriptionInterval>("monthly");
  const [assignmentDurations, setAssignmentDurations] = useState<Record<string, number>>({});
  const [billingConfigured, setBillingConfigured] = useState(false);
  const [billingUsage, setBillingUsage] = useState<{ properties: number; units: number; tenants: number; staff: number; storageBytes: number; notifications: number } | null>(null);
  const [billingPayments, setBillingPayments] = useState<Array<{ reference: string; planId: string; interval: string; amount: number; status: string; createdAt: string; paidAt: string | null }>>([]);
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingStatusError, setBillingStatusError] = useState("");
  const [paystackTestBusy, setPaystackTestBusy] = useState(false);
  const [paystackTestMessage, setPaystackTestMessage] = useState("");
  const [paystackTestError, setPaystackTestError] = useState("");
  const [planCatalog, setPlanCatalog] = useState<SubscriptionPlanConfig[]>(() => subscriptionPlans.map((plan) => ({ ...plan, limits: { ...plan.limits }, features: { ...plan.features }, bullets: [...plan.bullets] })));
  const [planDrafts, setPlanDrafts] = useState<SubscriptionPlanConfig[]>([]);
  const [planSettingsBusy, setPlanSettingsBusy] = useState(false);
  const [planSettingsLoading, setPlanSettingsLoading] = useState(false);
  const [planSettingsError, setPlanSettingsError] = useState("");
  const [planSettingsMessage, setPlanSettingsMessage] = useState("");
  const [todayKey, setTodayKey] = useState(getTodayKey);
  const [clientNow, setClientNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    const refreshPlans = () => void dataApi<{ plans: SubscriptionPlanConfig[] }>("/api/plans")
      .then((result) => { if (active) { setPlanCatalog(result.plans); if (auth.user.role === "super_admin") setPlanDrafts(result.plans.map((plan) => ({ ...plan, limits: { ...plan.limits }, features: { ...plan.features }, bullets: [...plan.bullets] }))); setPlanSettingsError(""); } })
      .catch((error: unknown) => { if (active) setPlanSettingsError(error instanceof Error ? error.message : "Could not load saved plan settings."); })
      .finally(() => { if (active) setPlanSettingsLoading(false); });
    setPlanSettingsLoading(true);
    refreshPlans();
    const timer = auth.user.role === "super_admin" ? undefined : window.setInterval(refreshPlans, 60_000);
    return () => { active = false; if (timer) window.clearInterval(timer); };
  }, [auth.user.id, auth.user.role]);

  useEffect(() => {
    let cancelled = false;
    const urls: Record<string, string> = {};
    void Promise.all([
      ...(auth.user.role === "estate_agent" && !auth.user.organizationId ? [] : properties.flatMap((property) => propertyPhotoNames(property).map(async (_name, index) => {
        const key = propertyPhotoAttachmentId(property.id, index);
        const blob = await getSyncedAttachment("profile", key).catch(() => undefined);
        if (blob) urls[key] = URL.createObjectURL(blob);
      }))),
      ...tenants.filter((tenant) => tenant.photoName).map(async (tenant) => {
        const blob = await getSyncedAttachment("profile", `tenant-${tenant.id}`).catch(() => undefined);
        if (blob) urls[`tenant-${tenant.id}`] = URL.createObjectURL(blob);
      }),
    ]).then(() => {
      if (cancelled) Object.values(urls).forEach(URL.revokeObjectURL);
      else setProfilePhotoUrls(urls);
    });
    return () => { cancelled = true; Object.values(urls).forEach(URL.revokeObjectURL); };
  }, [properties, tenants, auth.user.role, auth.user.organizationId]);

  const subscriptionExpiresAt = auth.user.subscriptionExpiresAt ? Date.parse(auth.user.subscriptionExpiresAt) : Number.POSITIVE_INFINITY;
  const subscriptionCurrent = Boolean(auth.user.subscriptionPlan) && subscriptionExpiresAt > clientNow;
  const subscriptionUsable = subscriptionCurrent && auth.user.subscriptionStatus !== "suspended";
  const standaloneEstateAgent = auth.user.role === "estate_agent" && !auth.user.organizationId;
  const effectivePlan = normalizePlanId(auth.user.subscriptionPlan) ?? "free_starter";
  const estateAgentMeetsMinimumPlan = auth.user.role !== "estate_agent" || effectivePlan !== "free_starter";
  const hasPlanAccess = ["super_admin", "platform_admin"].includes(auth.user.role) || subscriptionUsable && estateAgentMeetsMinimumPlan;
  const accessRestricted = !hasPlanAccess;
  const selectedRoleDefinition = roleDefinitions.find((role) => role.id === currentRole) ?? roleDefinitions[2];
  const roleDefinition = selectedRoleDefinition;
  const visibleRoleDefinitions = auth.user.role === "platform_admin"
    ? roleDefinitions.filter((role) => ["landlord_owner", "property_manager", "estate_agent", "resident_tenant"].includes(role.id))
    : roleDefinitions;
  const currentPlan = planCatalog.find((plan) => plan.id === effectivePlan) ?? planCatalog[0];
  const planSettingsDirty = planDrafts.length > 0 && JSON.stringify(planDrafts.map(({ id, monthlyPrice, annualPrice, limits }) => ({ id, monthlyPrice, annualPrice, limits }))) !== JSON.stringify(planCatalog.map(({ id, monthlyPrice, annualPrice, limits }) => ({ id, monthlyPrice, annualPrice, limits })));
  const visiblePlanPages = roleDefinition.pages.filter((page) => page !== "expenses" || currentPlan.features.expenses !== "none").filter((page) => page !== "reminders" || currentPlan.features.reminders !== "none").filter((page) => page !== "resident" || currentPlan.features.tenantPortal).filter((page) => page !== "maintenance" || Boolean(currentPlan.features.maintenance));
  const visiblePages: PageId[] = auth.user.role === "estate_agent"
    ? [...(hasPlanAccess ? ["agent_properties", "inspections", "agent_fees", ...(currentPlan.features.expenses !== "none" ? ["expenses"] as PageId[] : []), "reports"] as PageId[] : []), ...(accessRestricted ? ["plans"] as PageId[] : [])]
    : visiblePlanPages;
  const canEdit = (module: string) => roleCanEdit(currentRole, module);

  useEffect(() => {
    if (auth.user.role !== "super_admin") setCurrentRole(auth.user.role);
  }, [auth.user.role]);

  useEffect(() => {
    if (currentPage !== "agent_properties" || auth.user.role !== "estate_agent") return;
    let cancelled = false;
    setAgentPoolLoading(true);
    setAgentPoolError("");
    void dataApi<{ properties: AgentPropertyListing[] }>("/api/agent/property-pool")
      .then((result) => { if (!cancelled) { setAgentPropertyListings(result.properties); if (!auth.user.organizationId) setProperties(result.properties.map((listing) => ({ id: listing.id, name: listing.name, type: listing.type, apartmentType: listing.apartmentType, address: listing.address, city: listing.city, state: listing.state, units: listing.units, photoName: listing.photoNames[0], photoNames: listing.photoNames }))); } })
      .catch((error: unknown) => { if (!cancelled) setAgentPoolError(error instanceof Error ? error.message : "Could not load available properties."); })
      .finally(() => { if (!cancelled) setAgentPoolLoading(false); });
    return () => { cancelled = true; };
  }, [currentPage, auth.user.role, auth.user.organizationId, agentPoolRefresh]);

  useEffect(() => {
    if (!agentPhotoViewer) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAgentPhotoViewer(null);
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const listing = agentPropertyListings.find((item) => `${item.organizationId}-${item.id}` === agentPhotoViewer.listingKey);
      const count = listing?.photoUrls.length ?? 0;
      if (count < 2) return;
      event.preventDefault();
      setAgentPhotoViewer((current) => current ? { ...current, index: (current.index + (event.key === "ArrowRight" ? 1 : count - 1)) % count } : current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [agentPhotoViewer, agentPropertyListings]);

  useEffect(() => {
    if (!["landlord_owner", "property_manager", "super_admin"].includes(auth.user.role) && !(auth.user.role === "estate_agent" && !auth.user.organizationId)) return;
    let active = true;
    void dataApi<{ configured: boolean; payments: Array<{ reference: string; planId: string; interval: string; amount: number; status: string; createdAt: string; paidAt: string | null }>; usage: { properties: number; units: number; tenants: number; staff: number; storageBytes: number; notifications: number } }>("/api/billing/status")
      .then((result) => { if (active) { setBillingConfigured(result.configured); setBillingPayments(result.payments); setBillingUsage(result.usage); setBillingStatusError(""); } })
      .catch((error: unknown) => { if (active) setBillingStatusError(error instanceof Error ? error.message : "Could not load billing status."); });
    return () => { active = false; };
  }, [auth.user.id, auth.user.role]);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const billingResult = query.get("billing");
    if (!billingResult) return;
    setCurrentPage("plans");
    if (billingResult === "success") setSubscriptionMessage("Payment verified by Paystack. Your subscription is active.");
    else setBillingStatusError(query.get("reason") || "Payment could not be verified. No subscription was activated.");
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  useEffect(() => {
    if (currentPage !== "roles" && currentPage !== "plans") return;
    if (currentPage === "plans" && auth.user.role !== "super_admin") return;
    if (currentPage === "roles" && !["super_admin", "platform_admin"].includes(auth.user.role)) return;
    void auth.listUsers().then(setAccounts).catch((error: unknown) => setAccountError(error instanceof Error ? error.message : "Could not load accounts."));
  }, [currentPage, auth.user.role, agentPoolRefresh]);

  async function createRoleAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAccountError(""); setAccountMessage(""); setAccountBusy(true);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const role = String(form.get("role")) as RoleId;
    try {
      const landlordId = String(form.get("landlordId") ?? "");
      await auth.createAccount({ name: String(form.get("name")), email: String(form.get("email")), password: String(form.get("password")), role, ...(role === "resident_tenant" && form.get("tenantId") ? { tenantId: String(form.get("tenantId")) } : {}), ...(role !== "resident_tenant" && role !== "landlord_owner" ? { organizationId: String(form.get("organizationId")) } : {}), ...(role === "resident_tenant" && landlordId ? { landlordId, phone: String(form.get("phone") ?? "") } : {}) });
      setAccounts(await auth.listUsers()); setAccountMessage("Account created. Share the sign-in email and temporary password securely."); formElement.reset();
    } catch (error) { setAccountError(error instanceof Error ? error.message : "Could not create the account."); }
    finally { setAccountBusy(false); }
  }

  async function connectTenantToLandlord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLandlordLinkError(""); setLandlordLinkMessage(""); setLandlordLinkBusy(true);
    try {
      const form = new FormData(event.currentTarget);
      const result = await auth.linkLandlord(landlordCodeInput, String(form.get("phone") ?? ""));
      setResidentLinkRefresh((current) => current + 1);
      setLandlordLinkMessage(result.tenantRecordLinked ? "Your account is now linked to the landlord and your tenant profile." : "Landlord code accepted. The landlord must have a tenant record with the same sign-in email or phone number. Check those details with the landlord, then submit again.");
      if (result.tenantRecordLinked) setLandlordCodeInput("");
    } catch (error) { setLandlordLinkError(error instanceof Error ? error.message : "Could not connect this tenant account."); }
    finally { setLandlordLinkBusy(false); }
  }

  async function markResidentReminderRead(id: string) {
    try {
      await dataApi(`/api/resident/reminder-notifications/${encodeURIComponent(id)}/read`, { method: "POST", body: "{}" });
      setResidentReminderNotifications((current) => current.map((item) => item.id === id ? { ...item, readAt: new Date().toISOString() } : item));
      setResidentReminderError("");
    } catch (error) {
      setResidentReminderError(error instanceof Error ? error.message : "Could not update this reminder.");
    }
  }

  async function markSubscriptionNoticeRead(id: string) {
    try {
      await dataApi(`/api/subscription/notifications/${encodeURIComponent(id)}/read`, { method: "POST", body: "{}" });
      setSubscriptionNotices((current) => current.map((item) => item.id === id ? { ...item, readAt: new Date().toISOString() } : item));
    } catch (error) {
      setBackupMessage(error instanceof Error ? error.message : "Could not update the subscription notification.");
    }
  }

  async function sendWhatsAppTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (auth.user.role !== "super_admin") return;
    setWhatsappTestError("");
    setWhatsappTestMessage("");
    setWhatsappTestBusy(true);
    try {
      await dataApi<{ ok: boolean; providerAccepted: boolean }>("/api/admin/whatsapp/test", {
        method: "POST",
        body: JSON.stringify({ phone: whatsappTestPhone, confirmed: whatsappTestConsent }),
      });
      setWhatsappTestMessage("WhatsApp accepted the test message for delivery. Check the recipient's phone; carrier or recipient settings can affect final delivery.");
    } catch (error) {
      setWhatsappTestError(error instanceof Error ? error.message : "Could not send the WhatsApp test message.");
    } finally {
      setWhatsappTestBusy(false);
    }
  }

  async function saveReminderScheduleDate(tenantId: string, useAutomaticDate = false) {
    if (!canEdit("tenants")) return;
    const tenant = tenants.find((item) => item.id === tenantId);
    if (!tenant?.expirationDate) return;
    const selectedDate = reminderDateDrafts[tenantId] ?? tenant.reminderDateOverride ?? calculateReminderDate(tenant.expirationDate, tenant.paymentFrequency ?? "Monthly");
    if (!useAutomaticDate && (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate) || selectedDate < todayKey || selectedDate > tenant.expirationDate)) {
      setReminderScheduleFeedback((current) => ({ ...current, [tenantId]: { error: "Choose a reminder date from today through the rent expiration date." } }));
      return;
    }
    setReminderScheduleSaving((current) => ({ ...current, [tenantId]: true }));
    setReminderScheduleFeedback((current) => ({ ...current, [tenantId]: {} }));
    const updatedTenants = tenants.map((item) => {
      if (item.id !== tenantId) return item;
      if (!useAutomaticDate) return { ...item, reminderDateOverride: selectedDate };
      const resetTenant = { ...item };
      delete resetTenant.reminderDateOverride;
      return resetTenant;
    });
    try {
      await dataApi("/api/data", { method: "PUT", body: JSON.stringify({ collection: "tenants", data: updatedTenants }) });
      setTenants(updatedTenants);
      setReminderDateDrafts((current) => { const { [tenantId]: _removed, ...rest } = current; return rest; });
      setReminderScheduleFeedback((current) => ({ ...current, [tenantId]: { message: useAutomaticDate ? "Automatic rent-period schedule restored." : "Custom reminder date saved." } }));
    } catch (error) {
      setReminderScheduleFeedback((current) => ({ ...current, [tenantId]: { error: error instanceof Error ? error.message : "Could not save the reminder date." } }));
    } finally {
      setReminderScheduleSaving((current) => ({ ...current, [tenantId]: false }));
    }
  }

  async function changeAccount(id: string, update: Partial<Pick<AuthUser, "role" | "tenantId" | "active">>) {
    setAccountError(""); setAccountMessage("");
    try { await auth.updateAccount(id, update); setAccounts(await auth.listUsers()); setAccountMessage("Account updated."); }
    catch (error) { setAccountError(error instanceof Error ? error.message : "Could not update the account."); }
  }

  async function linkTenantAccount(id: string, tenantId: string) {
    if (!tenantId) return;
    setAccountError(""); setAccountMessage("");
    try { await auth.updateAccount(id, { tenantId }); setAccounts(await auth.listUsers()); setAccountMessage("Tenant account linked successfully."); }
    catch (error) { setAccountError(error instanceof Error ? error.message : "Could not link this tenant account."); }
  }

  function editPlanPrice(planId: PlanId, field: "monthlyPrice" | "annualPrice", value: string) {
    setPlanDrafts((current) => current.map((plan) => plan.id === planId ? { ...plan, [field]: value === "" ? null : Number(value) } : plan));
    setPlanSettingsMessage("");
    setPlanSettingsError("");
  }

  function editPlanLimit(planId: PlanId, field: PlanLimitKey, value: string) {
    setPlanDrafts((current) => current.map((plan) => plan.id === planId ? { ...plan, limits: { ...plan.limits, [field]: value === "" ? null : Number(value) } } : plan));
    setPlanSettingsMessage("");
    setPlanSettingsError("");
  }

  async function savePlanSettings() {
    if (auth.user.role !== "super_admin" || currentRole !== "super_admin") return;
    setPlanSettingsBusy(true); setPlanSettingsError(""); setPlanSettingsMessage("");
    try {
      const result = await dataApi<{ plans: SubscriptionPlanConfig[] }>("/api/plans", { method: "PUT", body: JSON.stringify({ plans: planDrafts.map(({ id, monthlyPrice, annualPrice, limits }) => ({ id, monthlyPrice, annualPrice, limits })) }) });
      setPlanCatalog(result.plans);
      setPlanDrafts(result.plans.map((plan) => ({ ...plan, limits: { ...plan.limits }, features: { ...plan.features }, bullets: [...plan.bullets] })));
      setPlanSettingsMessage("Plan prices and usage limits saved. New limits are enforced by the server immediately.");
    } catch (error) {
      setPlanSettingsError(error instanceof Error ? error.message : "Could not save plan settings.");
    } finally {
      setPlanSettingsBusy(false);
    }
  }

  async function assignSubscriptionPlan(id: string, subscriptionPlan: SubscriptionPlanId | null, durationDays?: number) {
    if (auth.user.role !== "super_admin" || currentRole !== "super_admin") return;
    setAccountError(""); setAccountMessage(""); setSubscriptionMessage("");
    try {
      await auth.updateAccount(id, { subscriptionPlan, ...(subscriptionPlan && subscriptionPlan !== "free_starter" ? { subscriptionDurationDays: durationDays ?? 30 } : {}) });
      setAccounts(await auth.listUsers());
      const assignedName = accounts.find((account) => account.id === id)?.name ?? "user";
      if (subscriptionPlan && subscriptionPlan !== "free_starter") setAssignmentDurations((current) => ({ ...current, [id]: durationDays ?? 30 }));
      setSubscriptionMessage(subscriptionPlan ? `${planCatalog.find((plan) => plan.id === normalizePlanId(subscriptionPlan))?.name} assigned to ${assignedName}.` : `Billing plan cleared for ${assignedName}.`);
    } catch (error) { setAccountError(error instanceof Error ? error.message : "Could not assign this billing plan."); }
  }

  async function startSubscriptionCheckout(planId: PlanId) {
    if (!(["landlord_owner", "property_manager"].includes(auth.user.role) || auth.user.role === "estate_agent" && standaloneEstateAgent)) return;
    setBillingStatusError("");
    setSubscriptionMessage("");
    setBillingBusy(true);
    try {
      const result = await dataApi<{ authorizationUrl: string }>("/api/billing/paystack/initialize", { method: "POST", body: JSON.stringify({ planId, interval: subscriptionInterval }) });
      window.location.assign(result.authorizationUrl);
    } catch (error) {
      setBillingStatusError(error instanceof Error ? error.message : "Could not start secure checkout.");
      setBillingBusy(false);
    }
  }

  async function testPaystackConnection() {
    if (auth.user.role !== "super_admin") return;
    setPaystackTestBusy(true); setPaystackTestMessage(""); setPaystackTestError("");
    try {
      const result = await dataApi<{ connected: boolean; message: string }>("/api/billing/paystack/test", { method: "POST", body: "{}" });
      setPaystackTestMessage(result.message);
    } catch (error) {
      setPaystackTestError(error instanceof Error ? error.message : "Could not check Paystack connection.");
    } finally { setPaystackTestBusy(false); }
  }

  async function selectFreeStarter() {
    if (!["landlord_owner", "property_manager"].includes(auth.user.role)) return;
    setBillingStatusError(""); setBillingBusy(true);
    try {
      await dataApi("/api/billing/free", { method: "POST", body: "{}" });
      window.location.reload();
    } catch (error) {
      setBillingStatusError(error instanceof Error ? error.message : "Could not activate Free Starter.");
      setBillingBusy(false);
    }
  }

  async function saveAccountDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editingAccount) return;
    const form = new FormData(event.currentTarget); setAccountError(""); setAccountMessage(""); setAccountBusy(true);
    try { await auth.updateAccount(editingAccount.id, { name: String(form.get("name")), email: String(form.get("email")) }); setAccounts(await auth.listUsers()); setEditingAccount(null); setAccountMessage("User details updated."); }
    catch (error) { setAccountError(error instanceof Error ? error.message : "Could not update user details."); }
    finally { setAccountBusy(false); }
  }

  async function resetAccountPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!resettingAccount) return;
    const password = String(new FormData(event.currentTarget).get("password")); setAccountError(""); setAccountMessage(""); setAccountBusy(true);
    try { await auth.updateAccount(resettingAccount.id, { password }); setResettingAccount(null); setAccountMessage(`Password reset for ${resettingAccount.name}. Share the new password securely.`); }
    catch (error) { setAccountError(error instanceof Error ? error.message : "Could not reset the password."); }
    finally { setAccountBusy(false); }
  }

  async function deleteAccount(account: AuthUser) {
    if (!window.confirm(`Delete the account for ${account.name} (${account.email})? This cannot be undone.`)) return;
    setAccountError(""); setAccountMessage("");
    try { await auth.deleteAccount(account.id); setAccounts(await auth.listUsers()); setAccountMessage(`Account for ${account.name} deleted.`); }
    catch (error) { setAccountError(error instanceof Error ? error.message : "Could not delete the account."); }
  }

  useEffect(() => {
    if (accessRestricted && currentPage !== "plans") { setCurrentPage("plans"); return; }
    if (!visiblePages.includes(currentPage)) setCurrentPage(visiblePages.includes("dashboard") ? "dashboard" : visiblePages[0]);
  }, [visiblePages, currentPage, currentRole, effectivePlan, accessRestricted, auth.user.role]);

  useEffect(() => {
    if (["super_admin", "platform_admin"].includes(auth.user.role) || !auth.user.subscriptionPlan || !auth.user.subscriptionExpiresAt) return;
    const remaining = Date.parse(auth.user.subscriptionExpiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) { setCurrentPage("plans"); return; }
    const timer = window.setTimeout(() => setCurrentPage("plans"), remaining);
    return () => window.clearTimeout(timer);
  }, [auth.user.id, auth.user.role, auth.user.subscriptionPlan, auth.user.subscriptionExpiresAt]);

  useEffect(() => {
    setIsPropertyFormOpen(false);
    setIsTenantFormOpen(false);
    setIsPaymentFormOpen(false);
    setIsExpenseFormOpen(false);
    setIsLeaseFormOpen(false);
    setIsLeaseRenewal(false);
  }, [currentRole]);

  useEffect(() => {
    setMobileNavigationOpen(false);
  }, [currentPage, currentRole]);

  useEffect(() => {
    if (!mobileNavigationOpen) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setMobileNavigationOpen(false); };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [mobileNavigationOpen]);

  useEffect(() => {
    if (auth.user.role === "resident_tenant") setResidentTenantId(auth.user.tenantId ?? "");
    else if (tenants.length && !tenants.some((tenant) => tenant.id === residentTenantId)) setResidentTenantId(tenants[0].id);
  }, [tenants, residentTenantId, auth.user.role, auth.user.tenantId]);

  useEffect(() => {
    if (auth.user.role !== "resident_tenant" || !auth.user.tenantId) {
      setResidentReminderNotifications([]);
      setResidentReminderError("");
      return;
    }
    let active = true;
    const loadNotifications = async () => {
      try {
        const result = await dataApi<{ notifications: ResidentReminderNotification[] }>("/api/resident/reminder-notifications");
        if (active) { setResidentReminderNotifications(result.notifications); setResidentReminderError(""); }
      } catch (error) {
        if (active) setResidentReminderError(error instanceof Error ? error.message : "Could not load rent reminders.");
      }
    };
    void loadNotifications();
    const interval = window.setInterval(() => void loadNotifications(), 60_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [auth.user.role, auth.user.tenantId]);

  useEffect(() => {
    if (currentPage !== "reminders" || auth.user.role !== "super_admin") return;
    let active = true;
    const loadWhatsAppStatus = async () => {
      try {
        const status = await dataApi<WhatsAppSetupStatus>("/api/admin/whatsapp/status");
        if (active) { setWhatsappSetupStatus(status); setWhatsappSetupError(""); }
      } catch (error) {
        if (active) setWhatsappSetupError(error instanceof Error ? error.message : "Could not check WhatsApp setup.");
      }
    };
    setWhatsappSetupStatus(null);
    void loadWhatsAppStatus();
    return () => { active = false; };
  }, [currentPage, auth.user.role]);

  useEffect(() => {
    if (currentPage !== "resident") return;
    const frame = window.requestAnimationFrame(() => residentPortalSection === "renewals"
      ? document.getElementById("resident-renewal")?.scrollIntoView({ behavior: "smooth", block: "start" })
      : window.scrollTo({ top: 0, behavior: "smooth" }));
    return () => window.cancelAnimationFrame(frame);
  }, [currentPage, residentPortalSection, residentTenantId]);

  useEffect(() => {
    if (currentPage !== "ledger" || !["super_admin", "landlord_owner", "property_manager"].includes(auth.user.role)) return;
    let active = true;
    let loading = false;
    const refresh = () => {
      if (loading) return;
      loading = true;
      const params = new URLSearchParams({ propertyId: ledgerPropertyFilter, category: ledgerCategoryFilter, period: ledgerPeriod });
      if (ledgerPeriod === "custom") { if (ledgerFromDate) params.set("from", ledgerFromDate); if (ledgerToDate) params.set("to", ledgerToDate); }
      setFinancialLedgerBusy(true);
      setFinancialLedgerError("");
      void dataApi<FinancialLedgerData>(`/api/financial-ledger?${params.toString()}`).then((result) => {
        if (active) { setFinancialLedger(result); setFinancialLedgerError(""); }
      }).catch((error: unknown) => {
        if (active) setFinancialLedgerError(error instanceof Error ? error.message : "Could not load the financial ledger.");
      }).finally(() => { loading = false; if (active) setFinancialLedgerBusy(false); });
    };
    const onFinancialDataUpdated = () => refresh();
    window.addEventListener("rentwise:financial-data-updated", onFinancialDataUpdated);
    refresh();
    // Keep the ledger current when a payment or expense is entered from another device.
    const timer = window.setInterval(refresh, 15_000);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("rentwise:financial-data-updated", onFinancialDataUpdated); };
  }, [currentPage, auth.user.role, ledgerPropertyFilter, ledgerCategoryFilter, ledgerPeriod, ledgerFromDate, ledgerToDate, ledgerRevision]);

  useEffect(() => {
    if (!standaloneEstateAgent) localStorage.setItem("rentwise-properties", JSON.stringify(properties));
    if (dataReady.current && roleCanEdit(auth.user.role, "properties")) void saveData("properties", properties, setBackupMessage);
  }, [properties, auth.user.role, standaloneEstateAgent]);

  useEffect(() => {
    localStorage.setItem("rentwise-tenants", JSON.stringify(tenants));
    if (dataReady.current && roleCanEdit(auth.user.role, "tenants")) void saveData("tenants", tenants, setBackupMessage);
  }, [tenants, auth.user.role]);

  useEffect(() => {
    localStorage.setItem("rentwise-reminder-messages", JSON.stringify(reminderMessages));
    if (dataReady.current && roleCanEdit(auth.user.role, "tenants")) void saveData("reminderMessages", reminderMessages, setBackupMessage);
  }, [reminderMessages, auth.user.role]);

  useEffect(() => {
    if (!standaloneEstateAgent) localStorage.setItem("rentwise-payments", JSON.stringify(rentPayments));
    if (dataReady.current && (roleCanEdit(auth.user.role, "payments") || auth.user.role === "resident_tenant")) void saveData("payments", rentPayments, setBackupMessage);
  }, [rentPayments, auth.user.role, standaloneEstateAgent]);

  useEffect(() => {
    localStorage.setItem("rentwise-renewal-requests", JSON.stringify(renewalRequests));
    if (dataReady.current && (roleCanEdit(auth.user.role, "leases") || auth.user.role === "resident_tenant")) void saveData("renewalRequests", renewalRequests, setBackupMessage);
  }, [renewalRequests, auth.user.role]);

  useEffect(() => {
    if (!standaloneEstateAgent) localStorage.setItem("rentwise-expenses", JSON.stringify(expenses));
    if (dataReady.current && roleCanEdit(auth.user.role, "expenses")) void saveData("expenses", expenses, setBackupMessage);
  }, [expenses, auth.user.role, standaloneEstateAgent]);

  useEffect(() => {
    localStorage.setItem("rentwise-leases", JSON.stringify(leases));
    if (dataReady.current && roleCanEdit(auth.user.role, "leases")) void saveData("leases", leases, setBackupMessage);
  }, [leases, auth.user.role]);

  useEffect(() => {
    localStorage.setItem("rentwise-bank-transfer-details", JSON.stringify(bankTransferDetails));
    if (dataReady.current && roleCanEdit(auth.user.role, "payment_settings")) void saveData("bankTransferDetails", bankTransferDetails, setBackupMessage);
  }, [bankTransferDetails, auth.user.role]);

  useEffect(() => {
    localStorage.setItem("rentwise-maintenance", JSON.stringify(maintenanceRequests));
    if (dataReady.current && roleCanEdit(auth.user.role, "maintenance")) void saveData("maintenance", maintenanceRequests, setBackupMessage);
  }, [maintenanceRequests, auth.user.role]);

  useEffect(() => {
    const resolvedWorkOrders = maintenanceRequests.filter((request) => request.status === "Resolved" && Number.isFinite(request.actualCost) && (request.actualCost ?? 0) > 0);
    if (!resolvedWorkOrders.length) return;
    setExpenses((current) => {
      let next = current;
      for (const request of resolvedWorkOrders) {
        const existingIndex = next.findIndex((expense) => expense.sourceMaintenanceRequestId === request.id);
        const vendor = maintenanceVendors.find((item) => item.id === request.vendorId);
        const linkedExpense: PropertyExpense = {
          id: existingIndex >= 0 ? next[existingIndex].id : createClientId(),
          propertyId: request.propertyId,
          category: "Repairs & maintenance",
          amount: request.actualCost!,
          expenseDate: request.resolvedDate ?? request.submittedDate,
          paidTo: vendor?.name ?? "Maintenance vendor",
          description: `Resolved work order: ${request.title}`,
          sourceMaintenanceRequestId: request.id,
        };
        if (existingIndex >= 0) {
          if (JSON.stringify(next[existingIndex]) === JSON.stringify(linkedExpense)) continue;
          next = next.map((expense, index) => index === existingIndex ? linkedExpense : expense);
        } else {
          next = [linkedExpense, ...next];
        }
      }
      return next;
    });
  }, [maintenanceRequests, maintenanceVendors]);

  useEffect(() => {
    localStorage.setItem("rentwise-maintenance-vendors", JSON.stringify(maintenanceVendors));
    if (dataReady.current && roleCanEdit(auth.user.role, "maintenanceVendors")) void saveData("maintenanceVendors", maintenanceVendors, setBackupMessage);
  }, [maintenanceVendors, auth.user.role]);

  useEffect(() => {
    if (!standaloneEstateAgent) localStorage.setItem("rentwise-inspections", JSON.stringify(inspections));
    if (dataReady.current && roleCanEdit(auth.user.role, "inspections")) void saveData("inspections", inspections, setBackupMessage);
  }, [inspections, auth.user.role, standaloneEstateAgent]);

  useEffect(() => {
    let cancelled = false;
    dataReady.current = false;
    if (!hasPlanAccess && !["super_admin", "platform_admin"].includes(auth.user.role)) return () => { cancelled = true; };
    if (standaloneEstateAgent) {
      setProperties([]); setTenants([]); setReminderMessages({}); setRentPayments([]); setRenewalRequests([]); setExpenses([]); setLeases([]); setBankTransferDetails({ bankName: "", accountName: "", accountNumber: "" }); setLandlordProfile(null); setMaintenanceRequests([]); setMaintenanceVendors([]); setInspections([]);
    }
    void (async () => {
      try {
        if ((auth.user.role === "super_admin" || auth.user.role === "landlord_owner") && (auth.user.organizationId ?? "rentwise-default") === "rentwise-default") {
          const importData = {
            properties: readStoredJSON("rentwise-properties", []),
            tenants: sanitizeTenantRecords(readStoredJSON("rentwise-tenants", [])),
            reminderMessages: readStoredJSON("rentwise-reminder-messages", {}),
            payments: readStoredJSON("rentwise-payments", []),
            renewalRequests: readStoredJSON("rentwise-renewal-requests", []),
            expenses: readStoredJSON("rentwise-expenses", []),
            leases: readStoredJSON("rentwise-leases", []),
            bankTransferDetails: readStoredJSON("rentwise-bank-transfer-details", { bankName: "", accountName: "", accountNumber: "" }),
            maintenance: readStoredJSON("rentwise-maintenance", []),
            maintenanceVendors: readStoredJSON("rentwise-maintenance-vendors", []),
            inspections: readStoredJSON("rentwise-inspections", []),
          };
          await dataApi("/api/data/import", { method: "POST", body: JSON.stringify({ data: importData }) });
          const [leaseFiles, receipts, images, inspectionPhotos] = await Promise.all([
            readIndexedDbFiles("rentwise-lease-files", "leaseFiles"),
            readIndexedDbFiles("rentwise-payment-receipts", "receipts"),
            readIndexedDbFiles("rentwise-maintenance-images", "images"),
            readIndexedDbFiles("rentwise-inspection-photos", "photos"),
          ]);
          for (const [category, files] of [["lease", leaseFiles], ["receipt", receipts], ["maintenance", images], ["inspection", inspectionPhotos]] as const) {
            for (const entry of files) {
              try {
                const file = entry.file instanceof File ? entry.file : new File([entry.file], entry.key, { type: entry.file.type });
                await syncAttachment(category, entry.key, file);
              } catch (error) { console.warn(`Could not migrate ${category} attachment ${entry.key}:`, error); }
            }
          }
        }
        const result = await dataApi<{ data: Record<string, unknown> }>("/api/data");
        if (cancelled) return;
        if (["landlord_owner", "property_manager", "super_admin"].includes(auth.user.role)) {
          const signupResult = await dataApi<{ applications: TenantSignup[] }>("/api/tenant-applications");
          if (!cancelled) setTenantSignups(signupResult.applications);
        } else setTenantSignups([]);
        const saved = result.data;
        if (auth.user.role === "resident_tenant" && !auth.user.tenantId) {
          setProperties([]); setTenants([]); setRentPayments([]); setRenewalRequests([]); setLeases([]); setMaintenanceRequests([]); setMaintenanceVendors([]); setInspections([]); setExpenses([]); setReminderMessages({});
        }
        if (Array.isArray(saved.properties) && !standaloneEstateAgent) setProperties(saved.properties as Property[]);
        if (Array.isArray(saved.tenants)) setTenants(sanitizeTenantRecords(saved.tenants));
        if (saved.reminderMessages && typeof saved.reminderMessages === "object") setReminderMessages(saved.reminderMessages as Record<string, string>);
        if (Array.isArray(saved.payments)) setRentPayments(saved.payments as RentPayment[]);
        if (Array.isArray(saved.renewalRequests)) setRenewalRequests(saved.renewalRequests as RenewalRequest[]);
        if (Array.isArray(saved.expenses)) setExpenses(saved.expenses as PropertyExpense[]);
        if (Array.isArray(saved.leases)) setLeases(saved.leases as LeaseAgreement[]);
        if (saved.bankTransferDetails && typeof saved.bankTransferDetails === "object") setBankTransferDetails(saved.bankTransferDetails as BankTransferDetails);
        setLandlordProfile(saved.landlordProfile && typeof saved.landlordProfile === "object" ? saved.landlordProfile as LandlordProfile : null);
        if (Array.isArray(saved.maintenance)) setMaintenanceRequests(saved.maintenance as MaintenanceRequest[]);
        if (Array.isArray(saved.maintenanceVendors)) setMaintenanceVendors(saved.maintenanceVendors as MaintenanceVendor[]);
        if (Array.isArray(saved.inspections)) setInspections(saved.inspections as PropertyInspection[]);
        let paymentHistorySyncFailed = false;
        if (["super_admin", "landlord_owner", "property_manager", "estate_agent"].includes(auth.user.role)) {
          try {
        const synced = await dataApi<{ payments: RentPayment[] }>("/api/payment-history/sync", { method: "POST", body: "{}" });
            if (!cancelled) setRentPayments(synced.payments);
          } catch (error) {
            paymentHistorySyncFailed = true;
            if (!cancelled) setBackupMessage(error instanceof Error ? `Payment History sync failed: ${error.message}` : "Payment History sync failed.");
          }
        }
        dataReady.current = true;
        if (!paymentHistorySyncFailed) setBackupMessage("");
      } catch (error) {
        if (!cancelled) setBackupMessage(error instanceof Error ? error.message : "Could not connect to PostgreSQL.");
      }
    })();
    return () => { cancelled = true; };
  }, [auth.user.id, auth.user.role, auth.user.organizationId, auth.user.tenantId, residentLinkRefresh, hasPlanAccess, standaloneEstateAgent]);

  useEffect(() => {
    if (currentPage !== "tenants" || !["landlord_owner", "property_manager", "super_admin"].includes(auth.user.role)) return;
    let cancelled = false;
    const refreshSignups = () => void dataApi<{ applications: TenantSignup[] }>("/api/tenant-applications").then((result) => { if (!cancelled) setTenantSignups(result.applications); }).catch((error: unknown) => { if (!cancelled) console.warn("Could not refresh tenant signups:", error); });
    refreshSignups();
    const timer = window.setInterval(refreshSignups, 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [currentPage, auth.user.id, auth.user.role]);

  useEffect(() => {
    if (currentPage !== "renewals" && currentPage !== "resident") return;
    let cancelled = false;
    const refreshRenewals = () => void dataApi<{ data: Record<string, unknown> }>("/api/data").then(({ data }) => {
      if (cancelled) return;
      if (Array.isArray(data.renewalRequests)) setRenewalRequests(data.renewalRequests as RenewalRequest[]);
      if (Array.isArray(data.payments)) setRentPayments(data.payments as RentPayment[]);
    }).catch((error: unknown) => console.warn("Could not refresh renewal status:", error));
    const timer = window.setInterval(refreshRenewals, 8000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [currentPage, auth.user.id, auth.user.role, auth.user.tenantId]);

  useEffect(() => {
    const timer = window.setInterval(() => { setTodayKey(getTodayKey()); setClientNow(Date.now()); }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => void dataApi<{ notifications: SubscriptionNotice[] }>("/api/subscription/notifications").then((result) => { if (active) setSubscriptionNotices(result.notifications); }).catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, 5 * 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [auth.user.id]);

  async function addProperty(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit("properties")) return;
    if (!dataReady.current) {
      setPropertySaveError(backupMessage || "RentWise has not finished loading its saved records. Wait for the sync to finish before saving.");
      return;
    }
    const formElement = event.currentTarget;
    const formData = new FormData(formElement);
    const existingProperty = properties.find((property) => property.id === editingPropertyId);
    const existingPhotoNames = propertyPhotoNames(existingProperty);
    const selectedPhotos = propertyPhotoFiles.filter((photo) => photo.size > 0);
    const removedPhotoIndexes = new Set(propertyPhotoRemovals);
    const retainedPhotos = existingPhotoNames.flatMap((name, sourceIndex) => removedPhotoIndexes.has(sourceIndex) ? [] : [{ name: propertyPhotoReplacements[sourceIndex]?.name ?? name, sourceIndex, file: propertyPhotoReplacements[sourceIndex] }]);
    const finalPhotoEntries = [...retainedPhotos, ...selectedPhotos.map((file) => ({ name: file.name, sourceIndex: -1, file }))];
    if (finalPhotoEntries.length > 4) {
      setPropertySaveError(`This property can have up to 4 photos. Remove a photo or choose fewer new images.`);
      return;
    }
    const invalidPhoto = [...Object.values(propertyPhotoReplacements), ...selectedPhotos].find((photo) => !["image/jpeg", "image/png", "image/webp"].includes(photo.type) || photo.size > 8 * 1024 * 1024);
    if (invalidPhoto) {
      setPropertySaveError("Choose JPG, PNG, or WebP images no larger than 8 MB each.");
      return;
    }
    const requestedUnits = Number(formData.get("units"));
    const propertyCountWithoutEdited = properties.filter((property) => property.id !== editingPropertyId).length;
    const unitCountWithoutEdited = properties.filter((property) => property.id !== editingPropertyId).reduce((sum, property) => sum + property.units, 0);
    if (currentPlan.limits.properties !== null && !editingPropertyId && propertyCountWithoutEdited >= currentPlan.limits.properties) { setPropertyPlanError(`${currentPlan.name} allows up to ${currentPlan.limits.properties} properties. Choose a higher plan to add more.`); return; }
    if (currentPlan.limits.units !== null && unitCountWithoutEdited + requestedUnits > currentPlan.limits.units) { setPropertyPlanError(`${currentPlan.name} allows up to ${currentPlan.limits.units} rental units. Choose a higher plan to add more.`); return; }
    setPropertyPlanError("");
    const newProperty: Property = {
      id: editingPropertyId ?? createClientId(),
      name: String(formData.get("name")).trim(),
      type: String(formData.get("type")),
      apartmentType: String(formData.get("apartmentType") ?? ""),
      address: String(formData.get("address")).trim(),
      city: String(formData.get("city")).trim(),
      state: String(formData.get("state")),
      units: requestedUnits,
      photoNames: finalPhotoEntries.map((photo) => photo.name),
      photoName: finalPhotoEntries[0]?.name,
    };
    const updatedProperties = editingPropertyId
      ? properties.map((property) => property.id === editingPropertyId ? newProperty : property)
      : [newProperty, ...properties];
    setPropertySaving(true);
    setPropertySaveError("");
    try {
      for (const [targetIndex, photo] of finalPhotoEntries.entries()) {
        const targetAttachmentId = propertyPhotoAttachmentId(newProperty.id, targetIndex);
        if (photo.file) {
          await syncAttachment("profile", targetAttachmentId, photo.file);
        } else if (photo.sourceIndex !== targetIndex) {
          const sourceAttachmentId = propertyPhotoAttachmentId(newProperty.id, photo.sourceIndex);
          const blob = await getSyncedAttachment("profile", sourceAttachmentId);
          if (!blob) throw new Error(`Could not retain property photo ${photo.sourceIndex + 1}; please try again.`);
          await syncAttachment("profile", targetAttachmentId, new File([blob], photo.name, { type: blob.type }));
        }
      }
      await dataApi("/api/data", { method: "PUT", body: JSON.stringify({ collection: "properties", data: updatedProperties }) });
      for (let index = finalPhotoEntries.length; index < existingPhotoNames.length; index += 1) await deleteSyncedAttachment("profile", propertyPhotoAttachmentId(newProperty.id, index));
      setProperties(updatedProperties);
      setPropertyPhotoFiles([]);
      setPropertyPhotoReplacements({});
      setPropertyPhotoRemovals([]);
      setBackupMessage("");
      setCurrentPage("properties");
      setIsPropertyFormOpen(false);
      formElement.reset();
    } catch (error) {
      const message = error instanceof Error ? error.message : "RentWise could not save this property.";
      setPropertySaveError(message);
      setBackupMessage(message);
    } finally {
      setPropertySaving(false);
    }
  }

  function openPropertyForm() {
    if (!canEdit("properties")) return;
    setEditingPropertyId(null);
    setSelectedPropertyType("");
    setPropertyPlanError("");
    setPropertySaveError("");
    setPropertyPhotoFiles([]);
    setPropertyPhotoReplacements({});
    setPropertyPhotoRemovals([]);
    setIsPropertyFormOpen(true);
  }

  function openPropertyEdit(property: Property) {
    if (!canEdit("properties")) return;
    setEditingPropertyId(property.id);
    setSelectedPropertyType(property.type);
    setPropertyPlanError("");
    setPropertySaveError("");
    setPropertyPhotoFiles([]);
    setPropertyPhotoReplacements({});
    setPropertyPhotoRemovals([]);
    setIsPropertyFormOpen(true);
  }

  async function addTenant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit("tenants")) return;
    const formElement = event.currentTarget;
    const formData = new FormData(formElement);
    const missingFields = [
      !String(formData.get("name") ?? "").trim() && "tenant full name",
      !String(formData.get("phone") ?? "").replace(/\D/g, "") && "phone number",
      !String(formData.get("gender") ?? "").trim() && "gender",
      !String(formData.get("occupation") ?? "").trim() && "occupation / job title",
    ].filter((field): field is string => Boolean(field));
    if (missingFields.length) {
      setTenantFormError(`Please complete the required field${missingFields.length > 1 ? "s" : ""}: ${missingFields.join(", ")}.`);
      return;
    }
    const propertyId = String(formData.get("propertyId"));
    const photo = formData.get("photo");
    if (photo instanceof File && photo.size > 0 && (!["image/jpeg", "image/png", "image/webp"].includes(photo.type) || photo.size > 8 * 1024 * 1024)) {
      setTenantFormError("Choose a JPG, PNG, or WebP tenant photo no larger than 8 MB.");
      return;
    }
    const selectedProperty = properties.find((property) => property.id === propertyId);
    const currentOccupancy = tenants.filter((tenant) => tenant.propertyId === propertyId && tenant.id !== editingTenantId).length;
    if (!selectedProperty || currentOccupancy >= selectedProperty.units) {
      setTenantFormError("This property has no available units. Choose another property or update its unit count.");
      return;
    }
    setTenantFormError("");
    const newTenant: Tenant = {
      id: editingTenantId ?? createClientId(),
      name: String(formData.get("name")).trim(),
      phone: String(formData.get("phone") ?? "").replace(/\D/g, "").slice(0, 11),
      email: String(formData.get("email")).trim(),
      gender: String(formData.get("gender") ?? ""),
      nationality: String(formData.get("nationality") ?? "Nigerian").trim(),
      maritalStatus: String(formData.get("maritalStatus") ?? ""),
      residentialAddress: String(formData.get("residentialAddress") ?? "").trim(),
      residentialCity: String(formData.get("residentialCity") ?? "").trim(),
      residentialState: String(formData.get("residentialState") ?? "").trim(),
      occupation: String(formData.get("occupation") ?? "").trim(),
      employerName: String(formData.get("employerName") ?? "").trim(),
      employerAddress: String(formData.get("employerAddress") ?? "").trim(),
      guarantorName: String(formData.get("guarantorName") ?? "").trim(),
      guarantorPhone: String(formData.get("guarantorPhone") ?? "").trim(),
      guarantorEmail: String(formData.get("guarantorEmail") ?? "").trim(),
      guarantorAddress: String(formData.get("guarantorAddress") ?? "").trim(),
      propertyId,
      monthlyRent: Number(String(formData.get("monthlyRent")).replaceAll(",", "")),
      paymentFrequency: String(formData.get("paymentFrequency")) as PaymentFrequency,
      rentedDate: String(formData.get("rentedDate")),
      expirationDate: String(formData.get("expirationDate")),
      reminderDateOverride: tenants.find((tenant) => tenant.id === editingTenantId)?.reminderDateOverride,
      whatsappRemindersOptIn: formData.get("whatsappRemindersOptIn") === "on",
      photoName: photo instanceof File && photo.size > 0 ? photo.name : tenants.find((tenant) => tenant.id === editingTenantId)?.photoName,
    };
    let savedTenant = newTenant;
    try {
      if (photo instanceof File && photo.size > 0) await syncAttachment("profile", `tenant-${newTenant.id}`, photo);
      if (selectedTenantSignup) {
        const result = await dataApi<{ tenant: Tenant }>(`/api/tenant-applications/${encodeURIComponent(selectedTenantSignup.id)}/assign`, { method: "POST", body: JSON.stringify({ tenant: newTenant }) });
        savedTenant = result.tenant;
        setTenants((current) => [result.tenant, ...current.filter((tenant) => tenant.id !== result.tenant.id)]);
        setTenantSignups((current) => current.filter((signup) => signup.id !== selectedTenantSignup.id));
        setSelectedTenantSignup(null);
      } else {
        const updatedTenants = editingTenantId
          ? tenants.map((tenant) => tenant.id === editingTenantId ? newTenant : tenant)
          : [newTenant, ...tenants];
        await dataApi("/api/data", { method: "PUT", body: JSON.stringify({ collection: "tenants", data: updatedTenants }) });
        setTenants(updatedTenants);
      }
    } catch (error) {
      setTenantFormError(error instanceof Error ? error.message : "Could not save the tenant profile.");
      return;
    }
    if (!editingTenantId && savedTenant.monthlyRent > 0) {
      try {
        const result = await dataApi<{ payments: RentPayment[] }>("/api/payment-history/sync", { method: "POST", body: "{}" });
        setRentPayments(result.payments);
      } catch (error) {
        setBackupMessage(`Tenant saved, but the initial rent was not added to Payment History: ${error instanceof Error ? error.message : "please retry."}`);
      }
    }
    setCurrentPage("tenants");
    setIsTenantFormOpen(false);
    formElement.reset();
  }

  function openTenantForm() {
    if (!canEdit("tenants")) return;
    setEditingTenantId(null);
    setSelectedTenantSignup(null);
    setTenantFormError("");
    const today = new Date();
    const todayString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    setRentalStartDate(todayString);
    setRentalFrequency("Monthly");
    setRentalExpirationDate(calculateExpirationDate(todayString, "Monthly"));
    setIsTenantFormOpen(true);
  }

  function openTenantSignup(signup: TenantSignup) {
    if (!canEdit("tenants")) return;
    setEditingTenantId(null);
    setSelectedTenantSignup(signup);
    setTenantFormError("");
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    setRentalStartDate(date);
    setRentalFrequency("Monthly");
    setRentalExpirationDate(calculateExpirationDate(date, "Monthly"));
    setIsTenantFormOpen(true);
  }

  function openTenantEdit(tenant: Tenant) {
    if (!canEdit("tenants")) return;
    const frequency = tenant.paymentFrequency ?? "Monthly";
    const startDate = tenant.rentedDate ?? tenant.moveInDate ?? "";
    setEditingTenantId(tenant.id);
    setTenantFormError("");
    setRentalFrequency(frequency);
    setRentalStartDate(startDate);
    setRentalExpirationDate(tenant.expirationDate ?? calculateExpirationDate(startDate, frequency));
    setIsTenantFormOpen(true);
  }

  function openPaymentForm() {
    if (!canEdit("payments")) return;
    setEditingPaymentId(null);
    const today = new Date();
    setPaymentDate([today.getFullYear(), String(today.getMonth() + 1).padStart(2, "0"), String(today.getDate()).padStart(2, "0")].join("-"));
    setIsPaymentFormOpen(true);
  }

  function openPaymentEdit(payment: RentPayment) {
    if (!canEdit("payments")) return;
    setEditingPaymentId(payment.id);
    setPaymentDate(payment.paymentDate);
    setIsPaymentFormOpen(true);
  }

  function addPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit("payments")) return;
    const formData = new FormData(event.currentTarget);
    const id = editingPaymentId ?? createClientId();
    const tenantId = String(formData.get("tenantId") ?? "") || undefined;
    const paymentDate = String(formData.get("paymentDate"));
    const existingPayment = rentPayments.find((payment) => payment.id === editingPaymentId);
    const newPayment: RentPayment = {
      id,
      reference: existingPayment?.reference ?? createPaymentReference(id, paymentDate),
      tenantId,
      tenantName: tenantId ? tenants.find((tenant) => tenant.id === tenantId)?.name : String(formData.get("tenantName") ?? "").trim() || existingPayment?.tenantName,
      propertyId: tenants.find((tenant) => tenant.id === tenantId)?.propertyId ?? (String(formData.get("propertyId") ?? "") || existingPayment?.propertyId),
      transactionType: existingPayment?.transactionType ?? "Rent payment",
      sourceRecordId: existingPayment?.sourceRecordId,
      amount: Number(String(formData.get("amount")).replaceAll(",", "")),
      paymentDate,
      recordedAt: existingPayment?.recordedAt ?? new Date().toISOString(),
      method: String(formData.get("method")),
      rentPeriod: String(formData.get("rentPeriod")).trim(),
      status: String(formData.get("status") ?? "Paid") as "Pending" | "Paid",
      receiptName: rentPayments.find((payment) => payment.id === editingPaymentId)?.receiptName,
    };
    setRentPayments((current) => editingPaymentId
      ? current.map((payment) => payment.id === editingPaymentId ? newPayment : payment)
      : [newPayment, ...current]);
    setCurrentPage("payments");
    setIsPaymentFormOpen(false);
    event.currentTarget.reset();
  }

  async function confirmAgentFee(payment: RentPayment) {
    if (!canEdit("agent_fees")) return;
    setAgentFeeMessage("");
    try {
      const result = await dataApi<{ payment: RentPayment }>(`/api/agent/fees/${encodeURIComponent(payment.id)}/confirm`, { method: "POST", body: "{}" });
      setRentPayments((current) => current.map((item) => item.id === payment.id ? result.payment : item));
      setAgentFeeMessage("Agent fee marked as received.");
    } catch (error) {
      setAgentFeeMessage(error instanceof Error ? error.message : "Could not update the agent fee status.");
    }
  }

  async function submitResidentRenewal(event: FormEvent<HTMLFormElement>, tenant: Tenant) {
    event.preventDefault();
    if (currentRole !== "resident_tenant") return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    const frequency = String(formData.get("paymentFrequency")) as PaymentFrequency;
    const rentAmount = Number(String(formData.get("amount")).replaceAll(",", ""));
    if (!Number.isFinite(rentAmount) || rentAmount <= 0) {
      setResidentRenewalMessage("Enter a rent amount greater than zero.");
      return;
    }
    if (formData.get("paymentCompleted") !== "on") {
      setResidentRenewalMessage("Confirm you completed the selected payment method before submitting.");
      return;
    }
    const receipt = formData.get("receipt");
    if (receipt instanceof File && receipt.size > 10 * 1024 * 1024) {
      setResidentRenewalMessage("The receipt must be 10 MB or smaller.");
      return;
    }
    if (receipt instanceof File && receipt.size > 0 && !["application/pdf", "image/jpeg", "image/png"].includes(receipt.type)) {
      setResidentRenewalMessage("Upload the receipt as a PDF, JPG, or PNG image.");
      return;
    }
    const today = getTodayKey();
    const startDateObject = new Date(`${tenant.expirationDate || today}T00:00:00`);
    if (!tenant.expirationDate || tenant.expirationDate < today) startDateObject.setTime(new Date(`${today}T00:00:00`).getTime());
    else startDateObject.setDate(startDateObject.getDate() + 1);
    const startDate = `${startDateObject.getFullYear()}-${String(startDateObject.getMonth() + 1).padStart(2, "0")}-${String(startDateObject.getDate()).padStart(2, "0")}`;
    const expirationDate = calculateExpirationDate(startDate, frequency);
    const paymentId = createClientId();
    if (receipt instanceof File && receipt.size > 0) {
      try {
        await storePaymentReceipt(paymentId, receipt);
      } catch {
        setResidentRenewalMessage("The receipt could not be saved in this browser. Please try another file.");
        return;
      }
    }
    const newPayment: RentPayment = {
      id: paymentId,
      reference: createPaymentReference(paymentId, today),
      tenantId: tenant.id,
      propertyId: tenant.propertyId,
      transactionType: "Rent renewal",
      amount: rentAmount,
      paymentDate: today,
      recordedAt: new Date().toISOString(),
      method: String(formData.get("method")),
      rentPeriod: `${formatDate(startDate)} – ${formatDate(expirationDate)}`,
      status: "Pending",
      receiptName: receipt instanceof File && receipt.size > 0 ? receipt.name : undefined,
    };
    const request: RenewalRequest = {
      id: createClientId(),
      tenantId: tenant.id,
      paymentId,
      reference: "RN-" + today.slice(0, 4) + "-" + createClientId().slice(0, 6).toUpperCase(),
      startDate,
      expirationDate,
      rentAmount,
      paymentFrequency: frequency,
      submittedDate: today,
      status: "Pending",
    };
    try {
      const updatedPayments = [newPayment, ...rentPayments];
      await dataApi("/api/data", { method: "PUT", body: JSON.stringify({ collection: "payments", data: updatedPayments }) });
      if (receipt instanceof File && receipt.size > 0) await syncAttachment("receipt", paymentId, receipt);
      const updatedRequests = [request, ...renewalRequests];
      await dataApi("/api/data", { method: "PUT", body: JSON.stringify({ collection: "renewalRequests", data: updatedRequests }) });
      setRentPayments(updatedPayments);
      setRenewalRequests(updatedRequests);
    } catch (error) {
      setResidentRenewalMessage(error instanceof Error ? `Could not submit renewal: ${error.message}` : "Could not submit the renewal. Please try again.");
      return;
    }
    setResidentRenewalMessage(`Renewal request ${request.reference} submitted for ${formatDate(startDate)} to ${formatDate(expirationDate)}. Payment is pending landlord confirmation.`);
    form.reset();
    setResidentPaymentCompleted(false);
    setResidentPaymentMethod("");
  }

  async function submitMaintenanceRequest(event: FormEvent<HTMLFormElement>, tenant: Tenant) {
    event.preventDefault();
    if (currentRole !== "resident_tenant") return;
    setMaintenanceMessage("");
    const form = event.currentTarget;
    const formData = new FormData(form);
    const title = String(formData.get("title")).trim();
    const description = String(formData.get("description")).trim();
    if (!title || !description) return;
    const selectedImages = formData.getAll("images").filter((item): item is File => item instanceof File && item.size > 0);
    const acceptedImageTypes = ["image/jpeg", "image/png", "image/webp"];
    if (selectedImages.length > 10) { setMaintenanceMessage("Attach no more than 10 images to one request."); return; }
    if (selectedImages.some((file) => !acceptedImageTypes.includes(file.type))) { setMaintenanceMessage("Upload images in JPG, PNG, or WebP format."); return; }
    if (selectedImages.some((file) => file.size > 8 * 1024 * 1024)) { setMaintenanceMessage("Each image must be 8 MB or smaller."); return; }
    const imageDetails = selectedImages.map((file) => ({ id: createClientId(), name: file.name }));
    try {
      await Promise.all(selectedImages.map((file, index) => storeMaintenanceImage(imageDetails[index].id, file)));
    } catch {
      setMaintenanceMessage("The images could not be saved in this browser. Please try again.");
      return;
    }
    const request: MaintenanceRequest = {
      id: createClientId(),
      tenantId: tenant.id,
      propertyId: tenant.propertyId,
      repairType: String(formData.get("repairType")) as "Major" | "Minor",
      title,
      description,
      submittedDate: getTodayKey(),
      status: "Open",
      images: imageDetails,
    };
    try {
      await dataApi("/api/data", { method: "PUT", body: JSON.stringify({ collection: "maintenance", data: [request, ...maintenanceRequests] }) });
      await Promise.all(selectedImages.map((file, index) => syncAttachment("maintenance", imageDetails[index].id, file)));
    } catch (error) {
      setMaintenanceMessage(error instanceof Error ? `Could not submit the maintenance request: ${error.message}` : "Could not submit the maintenance request. Please try again.");
      return;
    }
    setMaintenanceRequests((current) => [request, ...current]);
    form.reset();
    setMaintenanceMessage("Maintenance request submitted" + (imageDetails.length ? " with " + imageDetails.length + (imageDetails.length === 1 ? " image." : " images.") : "."));
  }

  function openInspectionForm(inspection?: PropertyInspection) {
    setEditingInspectionId(inspection?.id ?? null);
    setInspectionError("");
    setInspectionMessage("");
    setIsInspectionFormOpen(true);
  }

  async function saveInspection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit("inspections")) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    const existing = inspections.find((item) => item.id === editingInspectionId);
    const propertyId = String(formData.get("propertyId") ?? "");
    const tenantId = String(formData.get("tenantId") ?? "") || undefined;
    const tenant = tenantId ? tenants.find((item) => item.id === tenantId) : undefined;
    const property = properties.find((item) => item.id === propertyId);
    if (!property || (tenantId && (!tenant || tenant.propertyId !== propertyId))) {
      setInspectionError("Select a valid property and a tenant assigned to that property.");
      return;
    }
    const selectedPhotos = formData.getAll("photos").filter((item): item is File => item instanceof File && item.size > 0);
    if (selectedPhotos.length > 10 || selectedPhotos.some((file) => !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024)) {
      setInspectionError("Choose up to 10 JPG, PNG, or WebP photos, each no larger than 8 MB.");
      return;
    }
    setInspectionBusy(true);
    setInspectionError("");
    const addedPhotos = selectedPhotos.map((file) => ({ id: createClientId(), name: file.name }));
    const checklist = (field: string): InspectionCondition => String(formData.get(field) ?? "Not checked") as InspectionCondition;
    const record: PropertyInspection = {
      id: existing?.id ?? createClientId(), propertyId, tenantId,
      unitLabel: String(formData.get("unitLabel") ?? "").trim(),
      kind: String(formData.get("kind") ?? "Routine") as InspectionKind,
      inspectionDate: String(formData.get("inspectionDate") ?? getTodayKey()),
      inspectorName: String(formData.get("inspectorName") ?? "").trim(),
      inspectionFee: Number(String(formData.get("inspectionFee") ?? "").replaceAll(",", "")) || 0,
      agentFee: Number(String(formData.get("agentFee") ?? "").replaceAll(",", "")) || 0,
      meterReadings: { electricity: String(formData.get("electricity") ?? "").trim(), water: String(formData.get("water") ?? "").trim() },
      checklist: { exterior: checklist("exterior"), wallsFloors: checklist("wallsFloors"), electrical: checklist("electrical"), plumbing: checklist("plumbing"), doorsWindows: checklist("doorsWindows"), fixtures: checklist("fixtures") },
      observations: String(formData.get("observations") ?? "").trim(),
      handoverNotes: String(formData.get("handoverNotes") ?? "").trim(),
      acknowledgementName: String(formData.get("acknowledgementName") ?? "").trim(),
      acknowledgedAt: String(formData.get("acknowledgedAt") ?? ""),
      photos: [...(existing?.photos ?? []), ...addedPhotos],
    };
    const updated = existing ? inspections.map((item) => item.id === record.id ? record : item) : [record, ...inspections];
    try {
      await Promise.all(selectedPhotos.map(async (file, index) => {
        await storeInspectionPhoto(addedPhotos[index].id, file);
        await syncAttachment("inspection", addedPhotos[index].id, file);
      }));
      await dataApi("/api/data", { method: "PUT", body: JSON.stringify({ collection: "inspections", data: updated }) });
      setInspections(updated);
      setInspectionMessage(existing ? "Inspection updated." : "Inspection saved.");
      setIsInspectionFormOpen(false);
      try {
        const syncedFees = await dataApi<{ payments: RentPayment[] }>("/api/payment-history/sync", { method: "POST", body: "{}" });
        setRentPayments(syncedFees.payments);
      } catch (error) {
        setBackupMessage(`Inspection saved, but its fees were not added to Payment History: ${error instanceof Error ? error.message : "please retry."}`);
      }
    } catch (error) {
      setInspectionError(error instanceof Error ? error.message : "Could not save this inspection. Please retry.");
    } finally {
      setInspectionBusy(false);
    }
  }

  async function downloadInspectionPhoto(photo: { id: string; name: string }) {
    try {
      const file = await readInspectionPhoto(photo.id);
      if (!file) { alert("This inspection photo is not available."); return; }
      const url = URL.createObjectURL(file);
      const link = document.createElement("a"); link.href = url; link.download = photo.name; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { alert("The inspection photo could not be opened."); }
  }

  function updateMaintenanceRequest(id: string, patch: Partial<MaintenanceRequest>) {
    setMaintenanceRequests((current) => current.map((item) => item.id === id ? { ...item, ...patch, ...(patch.status === "Resolved" && item.status !== "Resolved" ? { resolvedDate: getTodayKey() } : {}) } : item));
  }

  async function saveMaintenanceVendor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit("maintenanceVendors")) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const vendor: MaintenanceVendor = {
      id: createClientId(), name: String(values.get("name") ?? "").trim(), company: String(values.get("company") ?? "").trim(),
      phone: String(values.get("phone") ?? "").trim(), email: String(values.get("email") ?? "").trim(), specialty: String(values.get("specialty") ?? "").trim(),
      serviceArea: String(values.get("serviceArea") ?? "").trim(), active: true,
    };
    if (!vendor.name || !vendor.phone || !vendor.specialty) return;
    const updated = [vendor, ...maintenanceVendors];
    try {
      await dataApi("/api/data", { method: "PUT", body: JSON.stringify({ collection: "maintenanceVendors", data: updated }) });
      setMaintenanceVendors(updated);
      form.reset();
    } catch (error) {
      setMaintenanceMessage(error instanceof Error ? `Vendor was not saved: ${error.message}` : "Vendor was not saved.");
    }
  }

  async function reviewRenewalRequest(request: RenewalRequest, decision: "Approved" | "Declined") {
    if (!canEdit("leases")) return;
    const tenant = tenants.find((item) => item.id === request.tenantId);
    const payment = rentPayments.find((item) => item.id === request.paymentId);
    if (decision === "Approved" && (!tenant || payment?.status !== "Paid")) {
      setBackupMessage("Confirm the renewal payment as Paid before activating this lease.");
      return;
    }
    try {
      let nextLease: LeaseAgreement | undefined;
      if (decision === "Approved" && tenant) {
        const previousLease = leases.filter((lease) => lease.tenantId === tenant.id && lease.status === "Active").sort((left, right) => right.expirationDate.localeCompare(left.expirationDate))[0];
        const property = properties.find((item) => item.id === tenant.propertyId);
        const leaseId = createClientId();
        const safeReference = request.reference.replace(/[^a-z0-9_-]+/gi, "-");
        nextLease = {
          id: leaseId,
          tenantId: tenant.id,
          reference: request.reference,
          agreementDate: getTodayKey(),
          startDate: request.startDate,
          expirationDate: request.expirationDate,
          rentAmount: request.rentAmount,
          paymentFrequency: request.paymentFrequency,
          securityDeposit: previousLease?.securityDeposit ?? 0,
          status: "Active",
          notes: "Renewal approved from tenant portal request.",
          landlordName: bankTransferDetails.landlordName?.trim() || bankTransferDetails.accountName?.trim() || auth.user.name,
          landlordAddress: bankTransferDetails.landlordAddress?.trim() || "",
          landlordPhone: bankTransferDetails.landlordPhone?.trim(),
          tenantAddress: [property?.address, property?.city, property?.state].filter(Boolean).join(", "),
          witnessName: previousLease?.witnessName,
          guarantors: previousLease?.guarantors,
          generatedDocumentId: `${leaseId}-generated`,
          generatedDocumentName: `${safeReference || "Tenancy-Agreement"}.pdf`,
        };
        const generatedBytes = await generateFilledLeaseAgreement(nextLease, tenant, property);
        const generatedFile = new File([new Blob([generatedBytes as BlobPart], { type: "application/pdf" })], nextLease.generatedDocumentName!, { type: "application/pdf" });
        const updatedLeases = [nextLease, ...leases];
        await dataApi("/api/data", { method: "PUT", body: JSON.stringify({ collection: "leases", data: updatedLeases }) });
        await storeLeaseDocument(nextLease.generatedDocumentId!, generatedFile);
        const updatedTenants = tenants.map((item) => item.id === tenant.id ? { ...item, rentedDate: request.startDate, expirationDate: request.expirationDate, monthlyRent: request.rentAmount, paymentFrequency: request.paymentFrequency } : item);
        await dataApi("/api/data", { method: "PUT", body: JSON.stringify({ collection: "tenants", data: updatedTenants }) });
        setLeases(updatedLeases);
        setTenants(updatedTenants);
      }
      const reviewed = await dataApi<{ request: RenewalRequest; payment: RentPayment }>(`/api/renewal-requests/${encodeURIComponent(request.id)}/review`, { method: "POST", body: JSON.stringify({ decision }) });
      const updatedRequests = renewalRequests.map((item) => item.id === request.id ? { ...item, ...reviewed.request, ...(nextLease ? { approvedLeaseId: nextLease.id } : {}) } : item);
      setRentPayments((current) => current.map((item) => item.id === reviewed.payment.id ? reviewed.payment : item));
      setRenewalRequests(updatedRequests);
      setBackupMessage(decision === "Approved" ? `Renewal approved. Lease ${request.reference} is active and its PDF is available to the tenant.` : `Renewal ${request.reference} declined. Its payment is marked Rejected and is visible to the tenant.`);
    } catch (error) {
      setBackupMessage(error instanceof Error ? `Could not review renewal: ${error.message}` : "Could not review this renewal request.");
    }
  }

  async function confirmRenewalPayment(request: RenewalRequest) {
    if (!canEdit("leases")) return;
    if (!window.confirm("Confirm that you have received this renewal payment? This will mark the payment as Paid and enable lease approval.")) return;
    try {
      const result = await dataApi<{ payment: RentPayment }>(`/api/renewal-requests/${encodeURIComponent(request.id)}/confirm-payment`, { method: "POST", body: "{}" });
      setRentPayments((current) => current.map((payment) => payment.id === result.payment.id ? result.payment : payment));
      setBackupMessage("Payment confirmed. You can now approve and activate this renewal.");
    } catch (error) {
      setBackupMessage(error instanceof Error ? `Could not confirm renewal payment: ${error.message}` : "Could not confirm renewal payment.");
    }
  }

  function openExpenseForm() {
    if (!canEdit("expenses")) return;
    setEditingExpenseId(null);
    const today = new Date();
    setExpenseDate([today.getFullYear(), String(today.getMonth() + 1).padStart(2, "0"), String(today.getDate()).padStart(2, "0")].join("-"));
    setIsExpenseFormOpen(true);
  }

  function openExpenseEdit(expense: PropertyExpense) {
    if (!canEdit("expenses")) return;
    setEditingExpenseId(expense.id);
    setExpenseDate(expense.expenseDate);
    setIsExpenseFormOpen(true);
  }

  function saveExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit("expenses")) return;
    const formData = new FormData(event.currentTarget);
    const expense: PropertyExpense = {
      id: editingExpenseId ?? createClientId(),
      propertyId: String(formData.get("propertyId")),
      category: String(formData.get("category")),
      amount: Number(String(formData.get("amount")).replaceAll(",", "")),
      expenseDate: String(formData.get("expenseDate")),
      paidTo: String(formData.get("paidTo")).trim(),
      description: String(formData.get("description")).trim(),
      sourceMaintenanceRequestId: expenses.find((item) => item.id === editingExpenseId)?.sourceMaintenanceRequestId,
    };
    setExpenses((current) => editingExpenseId
      ? current.map((item) => item.id === editingExpenseId ? expense : item)
      : [expense, ...current]);
    setCurrentPage("expenses");
    setIsExpenseFormOpen(false);
    event.currentTarget.reset();
  }

  function openLeaseForm(lease?: LeaseAgreement) {
    if (!canEdit("leases")) return;
    setIsLeaseRenewal(false);
    const tenant = tenants.find((item) => item.id === lease?.tenantId) ?? tenants[0];
    const property = properties.find((item) => item.id === tenant?.propertyId);
    const startDate = lease?.startDate ?? tenant?.rentedDate ?? getTodayKey();
    const frequency = lease?.paymentFrequency ?? tenant?.paymentFrequency ?? "Monthly";
    setLeaseLandlordName(lease?.landlordName || bankTransferDetails.landlordName?.trim() || bankTransferDetails.accountName?.trim() || auth.user.name);
    setLeaseLandlordAddress(lease?.landlordAddress || bankTransferDetails.landlordAddress?.trim() || "");
    setLeaseTenantAddress(lease?.tenantAddress ?? [property?.address, property?.city, property?.state].filter(Boolean).join(", "));
    setLeaseCautionFee(lease?.securityDeposit.toLocaleString("en-NG") ?? "");
    setEditingLeaseId(lease?.id ?? null);
    setLeaseTenantId(lease?.tenantId ?? tenant?.id ?? "");
    setLeaseStartDate(startDate);
    setLeaseEndDate(lease?.expirationDate ?? tenant?.expirationDate ?? calculateExpirationDate(startDate, frequency));
    setLeaseRentAmount((lease?.rentAmount ?? tenant?.monthlyRent ?? 0).toLocaleString("en-NG"));
    setLeaseFrequency(frequency);
    setLeaseStatus(lease?.status ?? "Active");
    setLeaseFormError("");
    setIsLeaseFormOpen(true);
  }

  function openLeaseRenewal(lease: LeaseAgreement) {
    if (!canEdit("leases")) return;
    const tenant = tenants.find((item) => item.id === lease.tenantId);
    const property = properties.find((item) => item.id === tenant?.propertyId);
    const nextDay = new Date(`${lease.expirationDate}T00:00:00`);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextDayKey = `${nextDay.getFullYear()}-${String(nextDay.getMonth() + 1).padStart(2, "0")}-${String(nextDay.getDate()).padStart(2, "0")}`;
    const startDate = lease.expirationDate < getTodayKey() ? getTodayKey() : nextDayKey;
    setEditingLeaseId(null);
    setIsLeaseRenewal(true);
    setLeaseTenantId(lease.tenantId);
    setLeaseStartDate(startDate);
    setLeaseFrequency(lease.paymentFrequency);
    setLeaseEndDate(calculateExpirationDate(startDate, lease.paymentFrequency));
    setLeaseRentAmount(lease.rentAmount.toLocaleString("en-NG"));
    setLeaseCautionFee(lease.securityDeposit.toLocaleString("en-NG"));
    setLeaseStatus("Active");
    setLeaseLandlordName(lease.landlordName || bankTransferDetails.landlordName?.trim() || bankTransferDetails.accountName?.trim() || auth.user.name);
    setLeaseLandlordAddress(lease.landlordAddress || bankTransferDetails.landlordAddress?.trim() || "");
    setLeaseTenantAddress(lease.tenantAddress ?? [property?.address, property?.city, property?.state].filter(Boolean).join(", "));
    setLeaseFormError("");
    setIsLeaseFormOpen(true);
  }

  async function saveLease(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit("leases")) return;
    if (leaseSaving) return;
    const formElement = event.currentTarget;
    const formData = new FormData(formElement);
    const reference = String(formData.get("reference")).trim() || "LA-" + new Date().getFullYear() + "-" + createClientId().slice(0, 6).toUpperCase();
    const selectedFile = formData.get("document");
    const existingLease = leases.find((lease) => lease.id === editingLeaseId);
    const leaseId = editingLeaseId ?? createClientId();
    const tenantId = String(formData.get("tenantId"));
    const startDate = String(formData.get("startDate"));
    const expirationDate = String(formData.get("expirationDate"));
    const tenant = tenants.find((item) => item.id === tenantId);
    if (!tenant) {
      setLeaseFormError("Select a tenant before generating the agreement.");
      return;
    }
    if (!startDate || !expirationDate || expirationDate < startDate) {
      setLeaseFormError("The lease expiration date must be on or after its start date.");
      return;
    }
    if (selectedFile instanceof File && selectedFile.size > 0 && selectedFile.size > 10 * 1024 * 1024) {
      setLeaseFormError("The document must be 10 MB or smaller.");
      return;
    }
    if (selectedFile instanceof File && selectedFile.size > 0 && !/\.(pdf|doc|docx)$/i.test(selectedFile.name)) {
      setLeaseFormError("Upload a PDF or Word document (.pdf, .doc, or .docx).");
      return;
    }
    setLeaseFormError("");
    const generatedDocumentId = existingLease?.generatedDocumentId ?? `${leaseId}-generated`;
    const safeReference = reference.replace(/[^a-z0-9_-]+/gi, "-");
    const lease: LeaseAgreement = {
      id: leaseId,
      tenantId,
      reference,
      agreementDate: existingLease?.agreementDate ?? getTodayKey(),
      startDate,
      expirationDate,
      rentAmount: Number(String(formData.get("rentAmount")).replaceAll(",", "")),
      paymentFrequency: String(formData.get("paymentFrequency")) as PaymentFrequency,
      securityDeposit: Number(String(formData.get("securityDeposit") || "0").replaceAll(",", "")),
      status: String(formData.get("status")) as "Draft" | "Active" | "Terminated",
      notes: String(formData.get("notes")).trim(),
      landlordName: String(formData.get("landlordName")).trim(),
      landlordAddress: String(formData.get("landlordAddress")).trim(),
      landlordPhone: bankTransferDetails.landlordPhone?.trim() ?? existingLease?.landlordPhone,
      tenantAddress: String(formData.get("tenantAddress")).trim(),
      witnessName: String(formData.get("witnessName") ?? "").trim() || existingLease?.witnessName,
      guarantors: [1, 2].map((number) => ({
        name: String(formData.get(`guarantor${number}Name`) ?? "").trim(),
        address: String(formData.get(`guarantor${number}Address`) ?? "").trim(),
        phone: String(formData.get(`guarantor${number}Phone`) ?? "").trim(),
      })),
      documentName: selectedFile instanceof File && selectedFile.size > 0 ? selectedFile.name : existingLease?.documentName,
      generatedDocumentId,
      generatedDocumentName: `${safeReference || "Tenancy-Agreement"}.pdf`,
    };
    setLeaseSaving(true);
    setLeaseSavingMessage("Generating completed agreement PDF…");
    try {
      const generatedBytes = await withTimeout(
        generateFilledLeaseAgreement(lease, tenant, properties.find((property) => property.id === tenant.propertyId)),
        30_000,
        "Generating the PDF took too long. Check that the tenancy agreement template is available, then retry.",
      );
      const generatedFile = new File([new Blob([generatedBytes as BlobPart], { type: "application/pdf" })], lease.generatedDocumentName ?? "Tenancy-Agreement.pdf", { type: "application/pdf" });
      const documents = [storeLeaseDocument(generatedDocumentId, generatedFile)];
      if (selectedFile instanceof File && selectedFile.size > 0) documents.push(storeLeaseDocument(leaseId, selectedFile));
      setLeaseSavingMessage("Saving agreement files to this device and the server…");
      await Promise.all(documents);

      const updatedLeases = editingLeaseId
        ? leases.map((item) => item.id === editingLeaseId ? lease : item)
        : [lease, ...leases];
      setLeaseSavingMessage("Saving lease record to PostgreSQL…");
      await dataApi("/api/data", { method: "PUT", body: JSON.stringify({ collection: "leases", data: updatedLeases }) });

      let updatedTenants = tenants;
      if (lease.status === "Active") {
        setLeaseSavingMessage("Updating the tenant’s rental dates…");
        updatedTenants = tenants.map((item) => item.id === lease.tenantId
          ? { ...item, rentedDate: lease.startDate, expirationDate: lease.expirationDate, monthlyRent: lease.rentAmount, paymentFrequency: lease.paymentFrequency }
          : item);
        await dataApi("/api/data", { method: "PUT", body: JSON.stringify({ collection: "tenants", data: updatedTenants }) });
      }

      setLeases(updatedLeases);
      if (lease.status === "Active") setTenants(updatedTenants);
      let paymentSyncFailed = false;
      try {
        const result = await dataApi<{ payments: RentPayment[] }>("/api/payment-history/sync", { method: "POST", body: "{}" });
        setRentPayments(result.payments);
      } catch (error) {
        paymentSyncFailed = true;
        setBackupMessage(`Lease saved, but its caution fee was not added to Payment History: ${error instanceof Error ? error.message : "please retry."}`);
      }
      if (!paymentSyncFailed) setBackupMessage("");
      setCurrentPage(isLeaseRenewal ? "renewals" : "leases");
      setIsLeaseFormOpen(false);
      setIsLeaseRenewal(false);
      formElement.reset();
    } catch (error) {
      console.error("Lease agreement generation or sync failed:", error);
      setLeaseFormError(error instanceof Error ? error.message : "The lease could not be saved. Check your connection and try again.");
    } finally {
      setLeaseSaving(false);
      setLeaseSavingMessage("");
    }
  }

  async function downloadLeaseDocument(lease: LeaseAgreement) {
    try {
      const file = await readLeaseDocument(lease.id);
      if (!file) {
        setLeaseDocumentMessage("This file is not available in this browser. Lease documents are currently stored on the device where they were uploaded.");
        return;
      }
      setLeaseDocumentMessage("");
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = lease.documentName ?? "lease-agreement";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setLeaseDocumentMessage("The lease document could not be opened in this browser.");
    }
  }

  async function downloadGeneratedLeaseDocument(lease: LeaseAgreement) {
    try {
      if (!lease.generatedDocumentId) {
        setLeaseDocumentMessage("Open and save this lease to generate its completed agreement PDF.");
        return;
      }
      const tenant = tenants.find((item) => item.id === lease.tenantId);
      let file: Blob | undefined;
      if (tenant) {
        // Rebuild on download so existing agreements also pick up the current
        // property-specific heading and photo, even if their saved PDF is older.
        const bytes = await generateFilledLeaseAgreement(lease, tenant, properties.find((item) => item.id === tenant.propertyId));
        file = new File([new Blob([bytes as BlobPart], { type: "application/pdf" })], lease.generatedDocumentName ?? "completed-tenancy-agreement.pdf", { type: "application/pdf" });
        if (canEdit("leases")) {
          try {
            await storeLeaseDocument(lease.generatedDocumentId, file as File);
          } catch (error) {
            console.warn("Updated generated agreement could not be synced; downloading the newly generated copy:", error);
          }
        }
      }
      if (!file) file = await readLeaseDocument(lease.generatedDocumentId);
      if (!file && lease.id !== lease.generatedDocumentId) file = await readLeaseDocument(lease.id);
      if (!file) {
        setLeaseDocumentMessage("The tenant record linked to this lease is unavailable, so the completed PDF cannot be rebuilt.");
        return;
      }
      if (!file) {
        setLeaseDocumentMessage("The completed agreement could not be rebuilt. Check the tenancy agreement template and try again.");
        return;
      }
      setLeaseDocumentMessage("");
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = lease.generatedDocumentName ?? "completed-tenancy-agreement.pdf";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setLeaseDocumentMessage(error instanceof Error ? `The completed tenancy agreement could not be opened: ${error.message}` : "The completed tenancy agreement could not be opened.");
    }
  }

  async function downloadPaymentReceipt(payment: RentPayment) {
    try {
      const file = await readPaymentReceipt(payment.id);
      if (!file) {
        alert("This receipt is not available in this browser. Receipts are stored on the device where they were uploaded.");
        return;
      }
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = payment.receiptName ?? "payment-receipt";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      alert("The payment receipt could not be opened in this browser.");
    }
  }

  async function downloadMaintenanceImage(image: { id: string; name: string }) {
    try {
      const file = await readMaintenanceImage(image.id);
      if (!file) { alert("This image is not available in this browser."); return; }
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = image.name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      alert("The maintenance image could not be opened.");
    }
  }

  async function downloadFullBackup() {
    setBackupBusy(true);
    setBackupMessage("");
    try {
      const [leaseDocuments, paymentReceipts, maintenanceImages, inspectionPhotos, profilePhotos] = await Promise.all([
        readIndexedDbFiles("rentwise-lease-files", "leaseFiles"),
        readIndexedDbFiles("rentwise-payment-receipts", "receipts"),
        readIndexedDbFiles("rentwise-maintenance-images", "images"),
        readIndexedDbFiles("rentwise-inspection-photos", "photos"),
        Promise.all([
          ...properties.flatMap((property) => propertyPhotoNames(property).map(async (name, index) => { const key = propertyPhotoAttachmentId(property.id, index); return { key, name, blob: await getSyncedAttachment("profile", key) }; })),
          ...tenants.filter((tenant) => tenant.photoName).map(async (tenant) => ({ key: `tenant-${tenant.id}`, name: tenant.photoName!, blob: await getSyncedAttachment("profile", `tenant-${tenant.id}`) })),
        ]),
      ]);
      const serializeFiles = async (entries: Array<{ key: string; file: Blob }>) => Promise.all(entries.map(async ({ key, file }) => ({ key, name: file instanceof File ? file.name : key, type: file.type, base64: await blobToBase64(file) })));
      const backup = {
        format: "rentwise-full-backup",
        version: 1,
        createdAt: new Date().toISOString(),
        localData: Object.fromEntries(backupDataKeys.map((key) => [key, localStorage.getItem(key)])),
        leaseDocuments: await serializeFiles(leaseDocuments),
        paymentReceipts: await serializeFiles(paymentReceipts),
        maintenanceImages: await serializeFiles(maintenanceImages),
        inspectionPhotos: await serializeFiles(inspectionPhotos),
        profilePhotos: await Promise.all(profilePhotos.filter((photo): photo is typeof photo & { blob: Blob } => Boolean(photo.blob)).map(async ({ key, name, blob }) => ({ key, name, type: blob.type, base64: await blobToBase64(blob) }))),
      };
      const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `rentwise-backup-${getTodayKey()}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setBackupMessage("Full backup downloaded, including records, lease files, and payment receipts.");
    } catch {
      setBackupMessage("The backup could not be created. Check browser storage and try again.");
    } finally {
      setBackupBusy(false);
    }
  }

  async function restoreFullBackup(file: File) {
    setBackupBusy(true);
    setBackupMessage("");
    try {
      const backup = JSON.parse(await file.text()) as {
        format?: string;
        version?: number;
        localData?: Record<string, string | null>;
        leaseDocuments?: BackupAttachment[];
        paymentReceipts?: BackupAttachment[];
        maintenanceImages?: BackupAttachment[];
        inspectionPhotos?: BackupAttachment[];
        profilePhotos?: BackupAttachment[];
      };
      if (backup.format !== "rentwise-full-backup" || backup.version !== 1 || !backup.localData || !Array.isArray(backup.leaseDocuments) || !Array.isArray(backup.paymentReceipts) || (backup.maintenanceImages !== undefined && !Array.isArray(backup.maintenanceImages)) || (backup.inspectionPhotos !== undefined && !Array.isArray(backup.inspectionPhotos))) {
        throw new Error("Invalid backup file");
      }
      const isValidAttachment = (item: BackupAttachment) => item && typeof item.key === "string" && typeof item.name === "string" && typeof item.type === "string" && typeof item.base64 === "string";
      if (!backup.leaseDocuments.every(isValidAttachment) || !backup.paymentReceipts.every(isValidAttachment) || !(backup.maintenanceImages ?? []).every(isValidAttachment) || !(backup.inspectionPhotos ?? []).every(isValidAttachment) || !(backup.profilePhotos ?? []).every(isValidAttachment)) throw new Error("Invalid attachment data");
      if (!window.confirm("Restore this RentWise backup? It will replace the current records and uploaded documents in this browser.")) {
        setBackupBusy(false);
        return;
      }
      const restoreFiles = (items: BackupAttachment[]) => items.map((attachment) => ({ key: attachment.key, file: fileFromBase64(attachment) }));
      await Promise.all([
        replaceIndexedDbFiles("rentwise-lease-files", "leaseFiles", restoreFiles(backup.leaseDocuments)),
        replaceIndexedDbFiles("rentwise-payment-receipts", "receipts", restoreFiles(backup.paymentReceipts)),
        replaceIndexedDbFiles("rentwise-maintenance-images", "images", restoreFiles(backup.maintenanceImages ?? [])),
        replaceIndexedDbFiles("rentwise-inspection-photos", "photos", restoreFiles(backup.inspectionPhotos ?? [])),
      ]);
      await Promise.all((backup.profilePhotos ?? []).map((attachment) => syncAttachment("profile", attachment.key, fileFromBase64(attachment))));
      backupDataKeys.forEach((key) => {
        const value = backup.localData?.[key];
        if (typeof value === "string") localStorage.setItem(key, value);
        else localStorage.removeItem(key);
      });
      setBackupMessage("Backup restored. RentWise is reloading the restored data.");
      window.setTimeout(() => window.location.reload(), 700);
    } catch {
      setBackupMessage("Could not restore this file. Choose a valid RentWise backup and try again.");
    } finally {
      setBackupBusy(false);
    }
  }

  const totalRentCollected = rentPayments.filter(isConfirmedPayment).reduce((total, payment) => total + payment.amount, 0);
  const pendingPaymentTotal = rentPayments.filter(isAwaitingPaymentConfirmation).reduce((total, payment) => total + payment.amount, 0);
  const rejectedPaymentTotal = rentPayments.filter((payment) => payment.status === "Rejected").reduce((total, payment) => total + payment.amount, 0);
  const totalExpenses = expenses.filter(isConfirmedExpense).reduce((total, expense) => total + expense.amount, 0);
  const recentPayments = rentPayments.slice(0, 4);
  const getOccupiedUnits = (propertyId: string) => tenants.filter((tenant) => tenant.propertyId === propertyId).length;
  const getPaymentPropertyId = (payment: RentPayment) => payment.propertyId ?? tenants.find((tenant) => tenant.id === payment.tenantId)?.propertyId;
  const filteredPayments = rentPayments.filter((payment) => {
    const tenant = tenants.find((item) => item.id === payment.tenantId);
    const property = properties.find((item) => item.id === getPaymentPropertyId(payment));
    return `${getPaymentReference(payment)} ${payment.transactionType ?? "Rent payment"} ${tenant?.name ?? payment.tenantName ?? ""} ${property?.name ?? ""} ${payment.method} ${payment.rentPeriod} ${paymentStatusLabel(payment)}`.toLowerCase().includes(paymentSearch.toLowerCase());
  });
  const agentFeePayments = rentPayments.filter((payment) => payment.transactionType === "Agent fee").sort((left, right) => right.paymentDate.localeCompare(left.paymentDate));
  const filteredAgentFeePayments = agentFeePayments.filter((payment) => {
    const property = properties.find((item) => item.id === getPaymentPropertyId(payment));
    const inspection = inspections.find((item) => item.id === payment.sourceRecordId);
    return `${getPaymentReference(payment)} ${property?.name ?? ""} ${inspection?.unitLabel ?? ""} ${inspection?.kind ?? ""} ${payment.status ?? "Pending"} ${payment.rentPeriod}`.toLowerCase().includes(agentFeeSearch.toLowerCase());
  });
  const confirmedAgentFees = agentFeePayments.filter((payment) => payment.status === "Paid").reduce((total, payment) => total + payment.amount, 0);
  const pendingAgentFees = agentFeePayments.filter(isAwaitingPaymentConfirmation).reduce((total, payment) => total + payment.amount, 0);
  const occupiedUnitTotal = properties.reduce((count, property) => count + Math.min(getOccupiedUnits(property.id), property.units), 0);
  const getAvailableUnits = (property: Property, excludingTenantId?: string | null) => Math.max(0, property.units - tenants.filter((tenant) => tenant.propertyId === property.id && tenant.id !== excludingTenantId).length);
  const hasAvailableUnits = properties.some((property) => getAvailableUnits(property) > 0);
  const isInReportPeriod = (date: string) => {
    if (reportPeriod === "all") return true;
    const [year, month] = date.split("-").map(Number);
    const [currentYear, currentMonth] = todayKey.split("-").map(Number);
    return reportPeriod === "year" ? year === currentYear : year === currentYear && month === currentMonth;
  };
  const reportPayments = rentPayments.filter((payment) => isConfirmedPayment(payment) && isInReportPeriod(payment.paymentDate) && (reportPropertyFilter === "all" || getPaymentPropertyId(payment) === reportPropertyFilter));
  const reportExpenses = expenses.filter((expense) => isConfirmedExpense(expense) && isInReportPeriod(expense.expenseDate) && (reportPropertyFilter === "all" || expense.propertyId === reportPropertyFilter));
  const reportRentPayments = reportPayments.filter((payment) => !["Caution fee", "Inspection fee", "Agent fee"].includes(payment.transactionType ?? ""));
  const reportCautionPayments = reportPayments.filter((payment) => payment.transactionType === "Caution fee");
  const reportServiceFeePayments = reportPayments.filter((payment) => payment.transactionType === "Inspection fee" || payment.transactionType === "Agent fee");
  const reportAgentFeePayments = reportPayments.filter((payment) => payment.transactionType === "Agent fee");
  const reportRentTotal = reportRentPayments.reduce((total, payment) => total + payment.amount, 0);
  const reportCautionTotal = reportCautionPayments.reduce((total, payment) => total + payment.amount, 0);
  const reportServiceFeeTotal = reportServiceFeePayments.reduce((total, payment) => total + payment.amount, 0);
  const reportAgentFeeTotal = reportAgentFeePayments.reduce((total, payment) => total + payment.amount, 0);
  const reportExpenseTotal = reportExpenses.reduce((total, expense) => total + expense.amount, 0);
  const rentLedgerRows = tenants.map((tenant) => {
    const tenantLeases = leases.filter((lease) => lease.tenantId === tenant.id && lease.status !== "Draft").sort((left, right) => left.startDate.localeCompare(right.startDate) || left.expirationDate.localeCompare(right.expirationDate));
    const latestLease = tenantLeases[tenantLeases.length - 1];
    const frequency = latestLease?.paymentFrequency ?? tenant.paymentFrequency ?? "Monthly";
    const rentAmount = latestLease?.rentAmount ?? tenant.monthlyRent;
    const startDate = latestLease?.startDate ?? tenant.rentedDate ?? tenant.moveInDate ?? "";
    const expirationDate = latestLease?.expirationDate ?? tenant.expirationDate ?? "";
    const scheduleTerms = tenantLeases.length ? tenantLeases.map((lease) => ({ startDate: lease.startDate, expirationDate: lease.expirationDate, frequency: lease.paymentFrequency, amount: lease.rentAmount })) : [{ startDate, expirationDate, frequency, amount: rentAmount }];
    const dueByDate = new Map<string, number>();
    for (const term of scheduleTerms) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(term.startDate) || !Number.isFinite(term.amount) || term.amount <= 0) continue;
      for (let cycle = 0; cycle < 1200; cycle += 1) {
        const cycleDate = rentCycleStartDate(term.startDate, cycle, term.frequency);
        if (cycleDate > todayKey || (term.expirationDate && cycleDate >= term.expirationDate)) break;
        dueByDate.set(cycleDate, term.amount);
      }
    }
    const duePeriods = [...dueByDate.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, amount]) => ({ date, amount }));
    const scheduleReady = scheduleTerms.some((term) => /^\d{4}-\d{2}-\d{2}$/.test(term.startDate) && Number.isFinite(term.amount) && term.amount > 0);
    const tenantPayments = rentPayments.filter((payment) => payment.tenantId === tenant.id && payment.paymentDate <= todayKey && !["Caution fee", "Inspection fee", "Agent fee"].includes(payment.transactionType ?? ""));
    const confirmedPaid = tenantPayments.filter(isConfirmedPayment).reduce((total, payment) => total + payment.amount, 0);
    const pendingAmount = tenantPayments.filter(isAwaitingPaymentConfirmation).reduce((total, payment) => total + payment.amount, 0);
    const expectedDue = duePeriods.reduce((total, period) => total + period.amount, 0);
    const balance = Math.max(0, expectedDue - confirmedPaid);
    const credit = Math.max(0, confirmedPaid - expectedDue);
    let paidRemaining = confirmedPaid;
    let oldestUnpaidDate: string | undefined;
    for (const period of duePeriods) {
      if (paidRemaining >= period.amount) paidRemaining -= period.amount;
      else { oldestUnpaidDate = period.date; break; }
    }
    const daysOverdue = oldestUnpaidDate ? Math.max(0, Math.floor((Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${oldestUnpaidDate}T00:00:00Z`)) / 86_400_000)) : 0;
    const currentTermPeriods = duePeriods.filter((period) => period.date >= startDate).length;
    const nextDueDate = scheduleReady ? rentCycleStartDate(startDate, currentTermPeriods, frequency) : "";
    const withinLease = !expirationDate || nextDueDate < expirationDate;
    const status = !scheduleReady ? "Dates needed" : balance > 0 ? daysOverdue > 0 ? "Overdue" : "Due" : credit > 0 ? "In advance" : duePeriods.length === 0 ? "Not due" : "Up to date";
    return { tenant, property: properties.find((property) => property.id === tenant.propertyId), frequency, rentAmount, startDate, expirationDate, scheduleReady, expectedDue, confirmedPaid, pendingAmount, balance, credit, daysOverdue, nextDueDate: withinLease ? nextDueDate : "", status };
  });
  const rentLedgerTotalDue = rentLedgerRows.reduce((total, row) => total + row.expectedDue, 0);
  const rentLedgerTotalPaid = rentLedgerRows.reduce((total, row) => total + row.confirmedPaid, 0);
  const rentLedgerOutstanding = rentLedgerRows.reduce((total, row) => total + row.balance, 0);
  const rentLedgerPending = rentLedgerRows.reduce((total, row) => total + row.pendingAmount, 0);
  const rentLedgerOverdueCount = rentLedgerRows.filter((row) => row.status === "Overdue" || row.status === "Due").length;
  const filteredRentLedgerRows = rentLedgerRows.filter((row) => {
    const query = `${row.tenant.name} ${row.property?.name ?? ""} ${row.property?.city ?? ""}`.toLowerCase();
    return query.includes(arrearsSearch.toLowerCase()) && (ledgerStatusFilter === "All" || row.status === ledgerStatusFilter);
  }).sort((left, right) => right.balance - left.balance || right.daysOverdue - left.daysOverdue);
  const propertyReportRows = properties.filter((property) => reportPropertyFilter === "all" || property.id === reportPropertyFilter).map((property) => {
    const propertyPayments = reportPayments.filter((payment) => getPaymentPropertyId(payment) === property.id);
    const rentReceived = propertyPayments.filter((payment) => !["Caution fee", "Inspection fee", "Agent fee"].includes(payment.transactionType ?? "")).reduce((total, payment) => total + payment.amount, 0);
    const serviceFees = propertyPayments.filter((payment) => payment.transactionType === "Inspection fee" || payment.transactionType === "Agent fee").reduce((total, payment) => total + payment.amount, 0);
    const cautionFees = propertyPayments.filter((payment) => payment.transactionType === "Caution fee").reduce((total, payment) => total + payment.amount, 0);
    const costs = reportExpenses.filter((expense) => expense.propertyId === property.id).reduce((total, expense) => total + expense.amount, 0);
    return { property, occupied: getOccupiedUnits(property.id), available: getAvailableUnits(property), rentReceived, serviceFees, cautionFees, costs, net: rentReceived + serviceFees - costs };
  });
  const reportExpiryLimit = new Date(`${todayKey}T00:00:00`);
  reportExpiryLimit.setDate(reportExpiryLimit.getDate() + 90);
  const reportExpiryLimitKey = `${reportExpiryLimit.getFullYear()}-${String(reportExpiryLimit.getMonth() + 1).padStart(2, "0")}-${String(reportExpiryLimit.getDate()).padStart(2, "0")}`;
  const tenantReportRows = tenants.filter((tenant) => reportPropertyFilter === "all" || tenant.propertyId === reportPropertyFilter).map((tenant) => {
    const tenantLeases = leases.filter((lease) => lease.tenantId === tenant.id && lease.status !== "Draft").sort((left, right) => left.expirationDate.localeCompare(right.expirationDate));
    const currentLease = tenantLeases.filter((lease) => lease.status === "Active").at(-1) ?? tenantLeases.at(-1);
    return {
      tenant,
      property: properties.find((property) => property.id === tenant.propertyId),
      lease: currentLease,
      rentAmount: currentLease?.rentAmount ?? tenant.monthlyRent,
      paymentFrequency: currentLease?.paymentFrequency ?? tenant.paymentFrequency ?? "Monthly",
      startDate: currentLease?.startDate ?? tenant.rentedDate ?? tenant.moveInDate ?? "",
      expirationDate: currentLease?.expirationDate ?? tenant.expirationDate ?? "",
    };
  });
  const arrearsReportRows = rentLedgerRows.filter((row) => row.balance > 0 && (reportPropertyFilter === "all" || row.property?.id === reportPropertyFilter)).sort((left, right) => right.daysOverdue - left.daysOverdue);
  const arrearsAging = [
    { label: "Not yet overdue", min: 0, max: 0 },
    { label: "1–30 days", min: 1, max: 30 },
    { label: "31–60 days", min: 31, max: 60 },
    { label: "61–90 days", min: 61, max: 90 },
    { label: "Over 90 days", min: 91, max: Number.POSITIVE_INFINITY },
  ].map((bucket) => ({ ...bucket, count: arrearsReportRows.filter((row) => row.daysOverdue >= bucket.min && row.daysOverdue <= bucket.max).length, amount: arrearsReportRows.filter((row) => row.daysOverdue >= bucket.min && row.daysOverdue <= bucket.max).reduce((sum, row) => sum + row.balance, 0) }));
  const leaseExpiryRows = tenantReportRows.filter((row) => (!row.lease || row.lease.status === "Active") && row.expirationDate && row.expirationDate >= todayKey && row.expirationDate <= reportExpiryLimitKey).sort((left, right) => left.expirationDate.localeCompare(right.expirationDate));
  const maintenanceReportRows = maintenanceRequests.filter((request) => reportPropertyFilter === "all" || request.propertyId === reportPropertyFilter).sort((left, right) => right.submittedDate.localeCompare(left.submittedDate));
  const inspectionReportRows = inspections.filter((inspection) => reportPropertyFilter === "all" || inspection.propertyId === reportPropertyFilter).sort((left, right) => right.inspectionDate.localeCompare(left.inspectionDate));
  const canViewFinancialReports = ["super_admin", "platform_admin", "landlord_owner", "property_manager"].includes(currentRole);
  const todayAtMidnight = new Date(`${todayKey}T00:00:00`);
  const reminderWindowDate = new Date(todayAtMidnight);
  reminderWindowDate.setDate(reminderWindowDate.getDate() + 90);
  const reminderWindowKey = `${reminderWindowDate.getFullYear()}-${String(reminderWindowDate.getMonth() + 1).padStart(2, "0")}-${String(reminderWindowDate.getDate()).padStart(2, "0")}`;
  const reminderRows = tenants.flatMap((tenant) => {
    const expirationDate = tenant.expirationDate;
    if (!expirationDate) return [];
    const frequency = tenant.paymentFrequency ?? "Monthly";
    const rule = reminderRule(frequency);
    const defaultReminderDate = calculateReminderDate(expirationDate, frequency);
    const reminderDate = tenant.reminderDateOverride && /^\d{4}-\d{2}-\d{2}$/.test(tenant.reminderDateOverride) && tenant.reminderDateOverride <= expirationDate
      ? tenant.reminderDateOverride
      : defaultReminderDate;
    const expiration = new Date(`${expirationDate}T00:00:00`);
    const daysUntilExpiration = Math.round((expiration.getTime() - todayAtMidnight.getTime()) / 86_400_000);
    if (reminderDate > reminderWindowKey && daysUntilExpiration >= 0 && !tenant.reminderDateOverride) return [];
    const nextReminder = nextReminderDate(reminderDate, expirationDate, todayKey, rule.repeatDays);
    const daysUntilReminder = Math.round((new Date(`${reminderDate}T00:00:00`).getTime() - todayAtMidnight.getTime()) / 86_400_000);
    return [{ tenant, property: properties.find((property) => property.id === tenant.propertyId), daysUntilExpiration, reminderDate, nextReminder, daysUntilReminder, reminderRuleLabel: rule.label }];
  }).sort((left, right) => left.daysUntilExpiration - right.daysUntilExpiration);
  const overdueReminderCount = reminderRows.filter((row) => row.daysUntilExpiration < 0).length;
  const readyReminderCount = reminderRows.filter((row) => row.daysUntilExpiration >= 0 && row.nextReminder === todayKey).length;
  const scheduledReminderCount = reminderRows.filter((row) => row.daysUntilExpiration >= 0 && row.nextReminder > todayKey && row.nextReminder <= reminderWindowKey).length;
  const filteredReminderRows = reminderRows.filter((row) => reminderFilter === "all"
    || reminderFilter === "ready" && row.daysUntilExpiration >= 0 && row.nextReminder === todayKey
    || reminderFilter === "scheduled" && row.daysUntilExpiration >= 0 && row.nextReminder > todayKey && row.nextReminder <= reminderWindowKey
    || reminderFilter === "overdue" && row.daysUntilExpiration < 0);
  const renewalWindowDate = new Date(`${todayKey}T00:00:00`);
  renewalWindowDate.setDate(renewalWindowDate.getDate() + 90);
  const renewalWindowKey = `${renewalWindowDate.getFullYear()}-${String(renewalWindowDate.getMonth() + 1).padStart(2, "0")}-${String(renewalWindowDate.getDate()).padStart(2, "0")}`;
  const latestActiveLeases = leases.filter((lease) => lease.status === "Active").reduce<LeaseAgreement[]>((latest, lease) => {
    const existingIndex = latest.findIndex((item) => item.tenantId === lease.tenantId);
    if (existingIndex === -1) return [...latest, lease];
    if (lease.expirationDate > latest[existingIndex].expirationDate) latest[existingIndex] = lease;
    return latest;
  }, []);
  const renewalItems: Array<{ lease: LeaseAgreement; tenant: Tenant; property?: Property; daysUntilExpiration: number }> = latestActiveLeases.flatMap((lease) => {
    const tenant = tenants.find((item) => item.id === lease.tenantId);
    if (!tenant || lease.expirationDate > renewalWindowKey) return [];
    const expiration = new Date(`${lease.expirationDate}T00:00:00`);
    const daysUntilExpiration = Math.round((expiration.getTime() - todayAtMidnight.getTime()) / 86_400_000);
    return [{ lease, tenant, property: properties.find((item) => item.id === tenant.propertyId), daysUntilExpiration }];
  });
  tenants.forEach((tenant) => {
    if (leases.some((lease) => lease.tenantId === tenant.id) || !tenant.expirationDate || tenant.expirationDate > renewalWindowKey) return;
    const expiration = new Date(`${tenant.expirationDate}T00:00:00`);
    const daysUntilExpiration = Math.round((expiration.getTime() - todayAtMidnight.getTime()) / 86_400_000);
    renewalItems.push({ lease: { id: `legacy-${tenant.id}`, tenantId: tenant.id, reference: `TENANT-${tenant.id.slice(0, 6).toUpperCase()}`, startDate: tenant.rentedDate ?? tenant.moveInDate ?? "", expirationDate: tenant.expirationDate, rentAmount: tenant.monthlyRent, paymentFrequency: tenant.paymentFrequency ?? "Monthly", securityDeposit: 0, status: "Active", notes: "" }, tenant, property: properties.find((item) => item.id === tenant.propertyId), daysUntilExpiration });
  });
  renewalItems.sort((left, right) => left.daysUntilExpiration - right.daysUntilExpiration);
  const dashboardRentTrend = Array.from({ length: 6 }, (_, index) => {
    const monthDate = new Date(`${todayKey}T00:00:00`);
    monthDate.setDate(1);
    monthDate.setMonth(monthDate.getMonth() - (5 - index));
    const key = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, "0")}`;
    const amount = rentPayments.filter((payment) => isConfirmedPayment(payment) && payment.paymentDate.startsWith(key)).reduce((sum, payment) => sum + payment.amount, 0);
    return { key, label: monthDate.toLocaleDateString("en-NG", { month: "short" }), amount };
  });
  const dashboardTrendMax = Math.max(...dashboardRentTrend.map((month) => month.amount), 1);
  const dashboardTrendTotal = dashboardRentTrend.reduce((sum, month) => sum + month.amount, 0);
  const dashboardUnitTotal = properties.reduce((sum, property) => sum + property.units, 0);
  const dashboardAvailableUnits = Math.max(0, dashboardUnitTotal - occupiedUnitTotal);
  const dashboardOccupancyPercent = dashboardUnitTotal ? Math.round((occupiedUnitTotal / dashboardUnitTotal) * 100) : 0;

  function downloadReportExcel() {
    const xmlEscape = (value: string | number) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&apos;");
    const periodLabel = reportPeriod === "all" ? "All time" : reportPeriod === "month" ? "This month" : "This year";
    const rows: Array<Array<string | number>> = [["RentWise NG Property Report"], ["Reporting period", periodLabel], ["Property filter", reportPropertyFilter === "all" ? "All properties" : properties.find((property) => property.id === reportPropertyFilter)?.name ?? "Selected property"]];
    if (currentRole === "estate_agent") rows.push(
      ["Agent fees received", reportAgentFeeTotal], ["Expenses recorded", reportExpenseTotal],
      [], ["Agent fee details"], ["Reference", "Date", "Property", "Amount", "Status"],
      ...reportAgentFeePayments.map((payment) => [getPaymentReference(payment), payment.paymentDate, properties.find((property) => property.id === getPaymentPropertyId(payment))?.name ?? "Property unavailable", payment.amount, paymentStatusLabel(payment)]),
      [], ["Expense details"], ["Date", "Property", "Category", "Paid to", "Description", "Amount"],
      ...reportExpenses.map((expense) => [expense.expenseDate, properties.find((property) => property.id === expense.propertyId)?.name ?? "Property unavailable", expense.category, expense.paidTo, expense.description, expense.amount]),
      [], ["Inspections and handovers"], ["Date", "Property", "Unit", "Type", "Inspector", "Inspection fee", "Agent fee", "Observations"],
      ...inspectionReportRows.map((inspection) => [inspection.inspectionDate, properties.find((property) => property.id === inspection.propertyId)?.name ?? "Property unavailable", inspection.unitLabel, inspection.kind, inspection.inspectorName, inspection.inspectionFee ?? 0, inspection.agentFee ?? 0, inspection.observations]),
    );
    if (canViewFinancialReports) rows.push(
      ["Rent collected", reportRentTotal], ["Service fees collected", reportServiceFeeTotal], ["Caution deposits recorded", reportCautionTotal], ["Expenses recorded", reportExpenseTotal], ["Net operating result", reportRentTotal + reportServiceFeeTotal - reportExpenseTotal],
      [], ["Property", "Type", "Apartment type", "Occupied tenant records", "Total units", "Available by count", "Rent received", "Service fees", "Caution deposits recorded", "Expenses", "Net operating result"],
      ...propertyReportRows.map((row) => [row.property.name, row.property.type, row.property.apartmentType ?? "", row.occupied, row.property.units, row.available, row.rentReceived, row.serviceFees, row.cautionFees, row.costs, row.net]),
      [], ["Arrears by tenant"], ["Tenant", "Property", "Rent frequency", "Balance due", "Days overdue", "Status"],
      ...arrearsReportRows.map((row) => [row.tenant.name, row.property?.name ?? "Property unavailable", paymentFrequencyLabel(row.frequency), row.balance, row.daysOverdue, row.status]),
      [], ["Payment transaction details"], ["Reference", "Date", "Tenant", "Property", "Type", "Method", "Period", "Amount", "Status"],
      ...reportPayments.map((payment) => [getPaymentReference(payment), payment.paymentDate, tenants.find((tenant) => tenant.id === payment.tenantId)?.name ?? payment.tenantName ?? "Property fee", properties.find((property) => property.id === getPaymentPropertyId(payment))?.name ?? "Property unavailable", payment.transactionType ?? "Rent payment", payment.method, payment.rentPeriod, payment.amount, paymentStatusLabel(payment)]),
      [], ["Expense details"], ["Date", "Property", "Category", "Paid to", "Description", "Amount"],
      ...reportExpenses.map((expense) => [expense.expenseDate, properties.find((property) => property.id === expense.propertyId)?.name ?? "Property unavailable", expense.category, expense.paidTo, expense.description, expense.amount]),
    );
    if (currentRole !== "estate_agent") rows.push([], ["Tenant rental schedule"], ["Tenant", "Property", "Payment length", "Current lease rent", "Lease reference", "Rented date", "Expiration date"],
      ...tenantReportRows.map(({ tenant, property, lease, paymentFrequency, rentAmount, startDate, expirationDate }) => [tenant.name, property?.name ?? "Property unavailable", paymentFrequencyLabel(paymentFrequency), rentAmount, lease?.reference ?? "Tenant record", startDate, expirationDate]));
    if (currentRole !== "estate_agent") rows.push([], ["Lease expirations in next 90 days"], ["Tenant", "Property", "Lease reference", "Rent", "Expiration date"], ...leaseExpiryRows.map(({ tenant, property, lease, rentAmount, expirationDate }) => [tenant.name, property?.name ?? "Property unavailable", lease?.reference ?? "Tenant record", rentAmount, expirationDate]));
    if (currentRole !== "estate_agent") {
      rows.push([], ["Maintenance work orders"], ["Submitted", "Property", "Tenant", "Issue", "Status", "Vendor", "Quote", "Approved", "Actual cost"], ...maintenanceReportRows.map((request) => [request.submittedDate, properties.find((property) => property.id === request.propertyId)?.name ?? "Property unavailable", tenants.find((tenant) => tenant.id === request.tenantId)?.name ?? "", request.title, request.status, maintenanceVendors.find((vendor) => vendor.id === request.vendorId)?.name ?? "Unassigned", request.quoteAmount ?? 0, request.approvedAmount ?? 0, request.actualCost ?? 0]));
      rows.push([], ["Inspections and handovers"], ["Date", "Property", "Unit", "Type", "Inspector", "Inspection fee", "Agent fee", "Observations"], ...inspectionReportRows.map((inspection) => [inspection.inspectionDate, properties.find((property) => property.id === inspection.propertyId)?.name ?? "Property unavailable", inspection.unitLabel, inspection.kind, inspection.inspectorName, inspection.inspectionFee ?? 0, inspection.agentFee ?? 0, inspection.observations]));
    }
    const columnName = (index: number) => {
      let column = "";
      while (index > 0) {
        const remainder = (index - 1) % 26;
        column = String.fromCharCode(65 + remainder) + column;
        index = Math.floor((index - 1) / 26);
      }
      return column;
    };
    const sheetRows = rows.map((row, rowIndex) => {
      const cells = row.map((value, columnIndex) => {
        const reference = columnName(columnIndex + 1) + (rowIndex + 1);
        return typeof value === "number"
          ? "<c r=\"" + reference + "\"><v>" + value + "</v></c>"
          : "<c r=\"" + reference + "\" t=\"inlineStr\"><is><t xml:space=\"preserve\">" + xmlEscape(value) + "</t></is></c>";
      }).join("");
      return "<row r=\"" + (rowIndex + 1) + "\">" + cells + "</row>";
    }).join("");
    const worksheetXml = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>" + sheetRows + "</sheetData></worksheet>";
    const files = [
      { name: "[Content_Types].xml", contents: "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/></Types>" },
      { name: "_rels/.rels", contents: "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>" },
      { name: "xl/workbook.xml", contents: "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"Property Report\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>" },
      { name: "xl/_rels/workbook.xml.rels", contents: "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/></Relationships>" },
      { name: "xl/worksheets/sheet1.xml", contents: worksheetXml },
    ];
    const encoder = new TextEncoder();
    const crc32 = (bytes: Uint8Array) => {
      let crc = 0xffffffff;
      for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      return (crc ^ 0xffffffff) >>> 0;
    };
    const localParts: Uint8Array[] = [];
    const centralParts: Uint8Array[] = [];
    let localOffset = 0;
    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const dataBytes = encoder.encode(file.contents);
      const checksum = crc32(dataBytes);
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const localView = new DataView(localHeader.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint32(14, checksum, true);
      localView.setUint32(18, dataBytes.length, true);
      localView.setUint32(22, dataBytes.length, true);
      localView.setUint16(26, nameBytes.length, true);
      localHeader.set(nameBytes, 30);
      localParts.push(localHeader, dataBytes);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(centralHeader.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint32(16, checksum, true);
      centralView.setUint32(20, dataBytes.length, true);
      centralView.setUint32(24, dataBytes.length, true);
      centralView.setUint16(28, nameBytes.length, true);
      centralView.setUint32(42, localOffset, true);
      centralHeader.set(nameBytes, 46);
      centralParts.push(centralHeader);
      localOffset += localHeader.length + dataBytes.length;
    }
    const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
    const endRecord = new Uint8Array(22);
    const endView = new DataView(endRecord.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, localOffset, true);
    const archiveParts = [...localParts, ...centralParts, endRecord];
    const archiveLength = archiveParts.reduce((total, part) => total + part.length, 0);
    const archiveBytes = new Uint8Array(new ArrayBuffer(archiveLength));
    let archiveOffset = 0;
    archiveParts.forEach((part) => { archiveBytes.set(part, archiveOffset); archiveOffset += part.length; });
    const blob = new Blob([archiveBytes.buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "rentwise-report-" + reportPeriod + "-" + new Date().toISOString().slice(0, 10) + ".xlsx";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const visibleFinancialTransactions = (financialLedger?.transactions ?? []).filter((transaction) =>
    `${transaction.reference} ${transaction.propertyName} ${transaction.category} ${transaction.detail} ${transaction.description}`.toLowerCase().includes(ledgerSearch.toLowerCase()),
  );
  const financialCategoryOptions = [...new Set((financialLedger?.transactions ?? []).map((item) => item.category))].sort();
  const downloadFinancialLedgerCsv = () => {
    if (!financialLedger) return;
    const rows = [["Date", "Reference", "Property", "Category", "Details", "Description", "Type", "Amount (NGN)", "Status"], ...visibleFinancialTransactions.map((item) => [item.date, item.reference, item.propertyName, item.category, item.detail, item.description, item.direction, koboToNaira(item.amountKobo).toFixed(2), item.status])];
    const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll("\"", "\"\"")}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `rentwise-property-ledger-${new Date().toISOString().slice(0, 10)}.csv`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const reverseFinancialTransaction = async (transaction: FinancialLedgerData["transactions"][number]) => {
    const reason = window.prompt(`Enter a reason to reverse ${transaction.reference}:`);
    if (!reason?.trim()) return;
    try {
      const result = await dataApi<{ ok: boolean; transaction: Record<string, unknown> }>(`/api/financial-ledger/${transaction.source}/${encodeURIComponent(transaction.id)}/reverse`, { method: "POST", body: JSON.stringify({ reason: reason.trim() }) });
      if (transaction.source === "payment") setRentPayments((records) => records.map((item) => item.id === transaction.id ? { ...item, ...result.transaction } as RentPayment : item));
      else setExpenses((records) => records.map((item) => item.id === transaction.id ? { ...item, ...result.transaction } as PropertyExpense : item));
      setFinancialLedgerMessage(`Transaction ${transaction.reference} was reversed and removed from the financial totals.`);
      setLedgerRevision((revision) => revision + 1);
    } catch (error) {
      setFinancialLedgerError(error instanceof Error ? error.message : "Could not reverse this transaction.");
    }
  };

  return (
    <div className="app-shell">
      <aside id="rentwise-navigation" className={`sidebar ${mobileNavigationOpen ? "mobile-nav-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">R</div>
          <div>
            <strong>RentWise NG</strong>
            <span>PROPERTY MANAGEMENT</span>
          </div>
        </div>

        <div className="workspace-label">WORKSPACE</div>
        <nav className="navigation" onClick={() => setMobileNavigationOpen(false)}>
          {accessRestricted ? <><button className={`nav-item ${currentPage === "plans" ? "active" : ""}`} type="button" onClick={() => setCurrentPage("plans")}><span className="nav-icon" aria-hidden="true">◇</span><span>Plans &amp; Usage</span></button></> : <>
          {roleDefinition.pages.includes("dashboard") && <button className={`nav-item ${currentPage === "dashboard" ? "active" : ""}`} type="button" onClick={() => setCurrentPage("dashboard")}><span className="nav-icon" aria-hidden="true">▦</span><span>Dashboard</span></button>}
          {visiblePages.includes("agent_properties") && <button className={`nav-item ${currentPage === "agent_properties" ? "active" : ""}`} type="button" onClick={() => setCurrentPage("agent_properties")}><span className="nav-icon" aria-hidden="true">⌂</span><span>Properties</span></button>}
          {roleDefinition.pages.includes("properties") && <button className={`nav-item ${currentPage === "properties" ? "active" : ""}`} type="button" onClick={() => setCurrentPage("properties")}><span className="nav-icon" aria-hidden="true">⌂</span><span>Properties</span></button>}
          {roleDefinition.pages.includes("tenants") && <button className={`nav-item ${currentPage === "tenants" ? "active" : ""}`} type="button" onClick={() => setCurrentPage("tenants")}><span className="nav-icon" aria-hidden="true">♙</span><span>Tenants</span></button>}
          {roleDefinition.pages.includes("leases") && <button className={`nav-item ${currentPage === "leases" ? "active" : ""}`} type="button" onClick={() => setCurrentPage("leases")}><span className="nav-icon" aria-hidden="true">▣</span><span>Lease Agreements</span></button>}
          {roleDefinition.pages.includes("inspections") && <button className={`nav-item ${currentPage === "inspections" ? "active" : ""}`} type="button" onClick={() => setCurrentPage("inspections")}><span className="nav-icon" aria-hidden="true">⌕</span><span>Inspections &amp; Handover</span></button>}
          {roleDefinition.pages.includes("renewals") && <button className={`nav-item ${currentPage === "renewals" ? "active" : ""}`} type="button" onClick={() => setCurrentPage("renewals")}><span className="nav-icon" aria-hidden="true">↻</span><span>Rent Renewals</span>{renewalItems.length > 0 && <span className="nav-count">{renewalItems.length}</span>}</button>}
          {roleDefinition.pages.includes("maintenance") && currentRole !== "resident_tenant" && Boolean(currentPlan.features.maintenance) && <button className={`nav-item ${currentPage === "maintenance" ? "active" : ""}`} type="button" onClick={() => setCurrentPage("maintenance")}><span className="nav-icon" aria-hidden="true">⚒</span><span>Maintenance requests</span>{maintenanceRequests.filter((request) => request.status === "Open").length > 0 && <span className="nav-count">{maintenanceRequests.filter((request) => request.status === "Open").length}</span>}</button>}
          {roleDefinition.pages.includes("ledger") && <button className={`nav-item ${currentPage === "ledger" ? "active" : ""}`} type="button" onClick={() => setCurrentPage("ledger")}><span className="nav-icon" aria-hidden="true">≡</span><span>Property Financial Ledger</span>{rentLedgerOverdueCount > 0 && <span className="nav-count">{rentLedgerOverdueCount}</span>}</button>}
          {roleDefinition.pages.includes("payments") && <button className={`nav-item ${currentPage === "payments" ? "active" : ""}`} type="button" onClick={() => setCurrentPage("payments")}><span className="nav-icon" aria-hidden="true">₦</span><span>Rent & Payments</span></button>}
          {roleDefinition.pages.includes("agent_fees") && <button className={`nav-item ${currentPage === "agent_fees" ? "active" : ""}`} type="button" onClick={() => setCurrentPage("agent_fees")}><span className="nav-icon" aria-hidden="true">₦</span><span>Agent fees</span>{agentFeePayments.filter((payment) => payment.status === "Pending").length > 0 && <span className="nav-count">{agentFeePayments.filter((payment) => payment.status === "Pending").length}</span>}</button>}
          {roleDefinition.pages.includes("payment_settings") && <button className={`nav-item ${currentPage === "payment_settings" ? "active" : ""}`} type="button" onClick={() => setCurrentPage("payment_settings")}><span className="nav-icon" aria-hidden="true">⚙</span><span>Bank Details</span></button>}
          {roleDefinition.pages.includes("reminders") && <button className={`nav-item ${currentPage === "reminders" ? "active" : ""}`} type="button" onClick={() => setCurrentPage("reminders")}><span className="nav-icon" aria-hidden="true">◷</span><span>Rent reminders</span>{readyReminderCount + overdueReminderCount > 0 && <span className="nav-count">{readyReminderCount + overdueReminderCount}</span>}</button>}
          {roleDefinition.pages.includes("expenses") && <button className={`nav-item expense-nav-item ${currentPage === "expenses" ? "active" : ""}`} type="button" onClick={() => setCurrentPage("expenses")}><span className="nav-icon expense-nav-icon" aria-hidden="true">↗</span><span>Expenses</span></button>}
          {roleDefinition.pages.includes("reports") && <button className={`nav-item ${currentPage === "reports" ? "active" : ""}`} type="button" onClick={() => setCurrentPage("reports")}><span className="nav-icon" aria-hidden="true">▤</span><span>Reports</span></button>}
          {roleDefinition.pages.includes("plans") && <button className={`nav-item ${currentPage === "plans" ? "active" : ""}`} type="button" onClick={() => setCurrentPage("plans")}><span className="nav-icon" aria-hidden="true">◇</span><span>Plans &amp; Usage</span></button>}
          {roleDefinition.pages.includes("resident") && <button className={`nav-item ${currentPage === "resident" && residentPortalSection === "overview" ? "active" : ""}`} type="button" onClick={() => { setResidentPortalSection("overview"); setCurrentPage("resident"); }}><span className="nav-icon" aria-hidden="true">♙</span><span>Resident portal</span></button>}
          {currentRole === "resident_tenant" && <button className={`nav-item ${currentPage === "resident" && residentPortalSection === "renewals" ? "active" : ""}`} type="button" onClick={() => { setResidentPortalSection("renewals"); setCurrentPage("resident"); }}><span className="nav-icon" aria-hidden="true">↻</span><span>Rent Renewals</span></button>}
          {currentRole === "resident_tenant" && <button className={`nav-item ${currentPage === "maintenance" ? "active" : ""}`} type="button" onClick={() => setCurrentPage("maintenance")}><span className="nav-icon" aria-hidden="true">⚒</span><span>Maintenance</span>{maintenanceRequests.filter((request) => request.status === "Open" && request.tenantId === residentTenantId).length > 0 && <span className="nav-count">{maintenanceRequests.filter((request) => request.status === "Open" && request.tenantId === residentTenantId).length}</span>}</button>}
          {roleDefinition.pages.includes("roles") && <button className={`nav-item ${currentPage === "roles" ? "active" : ""}`} type="button" onClick={() => setCurrentPage("roles")}><span className="nav-icon" aria-hidden="true">⚙</span><span>Access roles</span></button>}
          {roleDefinition.pages.includes("backups") && <button className={`nav-item ${currentPage === "backups" ? "active" : ""}`} type="button" onClick={() => setCurrentPage("backups")}><span className="nav-icon" aria-hidden="true">⇩</span><span>Backup & Restore</span></button>}
          </>}
        </nav>

        <div className="sidebar-bottom">
          <div className="help-card">
            <div className="help-icon">?</div>
            <strong>Need some help?</strong>
            <p>Learn how to manage your properties.</p>
            <button onClick={() => alert("Help centre coming soon.")}>
              Visit help centre →
            </button>
          </div>
          <div className="profile">
            <div className="avatar">{auth.user.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase()}</div>
            <div className="profile-info">
              <strong>{auth.user.name}</strong>
              <span>{roleLabels[auth.user.role]}</span>
            </div>
            <button className="profile-menu" type="button" title="Sign out" onClick={() => void auth.logout()}>↪</button>
          </div>
        </div>
      </aside>

      {mobileNavigationOpen && <button className="mobile-nav-backdrop" type="button" aria-label="Close navigation menu" onClick={() => setMobileNavigationOpen(false)} />}

      <main className="main-content">
        <header className="topbar">
          <button className="mobile-nav-toggle" type="button" aria-label={mobileNavigationOpen ? "Close navigation menu" : "Open navigation menu"} aria-expanded={mobileNavigationOpen} aria-controls="rentwise-navigation" onClick={() => setMobileNavigationOpen((open) => !open)}><span aria-hidden="true">{mobileNavigationOpen ? "×" : "☰"}</span></button>
          <div className="breadcrumb">Workspace <span>/</span> {currentPage === "agent_properties" ? "Properties" : currentPage === "dashboard" ? "Dashboard" : currentPage === "properties" ? "Properties" : currentPage === "tenants" ? "Tenants" : currentPage === "leases" ? "Lease Agreements" : currentPage === "inspections" ? "Inspections & Handover" : currentPage === "renewals" ? "Rent Renewals" : currentPage === "ledger" ? "Property Financial Ledger" : currentPage === "maintenance" ? "Maintenance requests" : currentPage === "payments" ? "Rent & Payments" : currentPage === "agent_fees" ? "Agent fees" : currentPage === "payment_settings" ? "Bank Details" : currentPage === "backups" ? "Backup & Restore" : currentPage === "expenses" ? "Expenses" : currentPage === "reports" ? "Reports" : currentPage === "resident" ? "Resident Portal" : currentPage === "roles" ? "Access Roles" : currentPage === "plans" ? "Plans & Usage" : "Rent reminders"}</div>
          <div className="topbar-actions">
            {auth.user.role === "super_admin" ? <label className="role-switcher"><span>Preview role</span><select value={currentRole} onChange={(event) => setCurrentRole(event.target.value as RoleId)} aria-label="Preview app as role">{roleDefinitions.map((role) => <option key={role.id} value={role.id}>{role.label}</option>)}</select></label> : <span className="today-label">{roleLabels[auth.user.role]}</span>}
            <span className="today-label">● Signed in as {auth.user.name}</span>
            <button className="icon-button" aria-label="Notifications">♧</button>
            <button className="secondary-button" type="button" onClick={() => void auth.logout()}>Sign out</button>
          </div>
        </header>

        <section className="page-content" id="dashboard">
          {backupMessage && <div className="api-status-alert" role="alert"><strong>RentWise could not sync with the server.</strong><span>{backupMessage}</span></div>}
          {subscriptionNotices.filter((notice) => !notice.readAt).map((notice) => <div className="billing-notice subscription-expiry-notice" role="status" key={notice.id}><strong>{notice.title}.</strong> {notice.message}<button className="row-modify" type="button" onClick={() => void markSubscriptionNoticeRead(notice.id)}>Dismiss</button></div>)}
          {standaloneEstateAgent && currentPage !== "agent_properties" && <div className="reminder-notice"><strong>Personal Estate Agent workspace.</strong> Your inspections, agent fee records, expenses, and reports are saved under your account. The shared property directory remains view-only.</div>}
          {currentPage === "agent_properties" ? (
            <>
              <div className="welcome-row"><div><p className="eyebrow">PROPERTY PORTFOLIO · VIEW ONLY</p><h1>Properties</h1><p className="subtitle">View available properties across the system, with property photos and landlord contact details.</p></div><button type="button" className="secondary-button" onClick={() => setAgentPoolRefresh((value) => value + 1)} disabled={agentPoolLoading}>{agentPoolLoading ? "Refreshing…" : "Refresh properties"}</button></div>
              {agentPoolError && <div className="api-status-alert" role="alert">{agentPoolError}</div>}
              {agentPoolLoading && !agentPropertyListings.length ? <div className="panel-footer">Loading property listings…</div> : agentPropertyListings.length ? <div className="agent-pool-grid">{agentPropertyListings.map((listing) => <article className="panel agent-property-card" key={`${listing.organizationId}-${listing.id}`}>
                <div className="agent-property-image">{listing.photoUrls.length ? <div className="agent-property-gallery">{listing.photoUrls.map((photoUrl, index) => <button className="agent-property-photo-button" type="button" key={photoUrl} aria-label={`View ${listing.name} photo ${index + 1}`} title="View photo" onClick={() => setAgentPhotoViewer({ listingKey: `${listing.organizationId}-${listing.id}`, index })}><img src={photoUrl} alt={`${listing.name} property photo ${index + 1}`} loading="lazy" /></button>)}</div> : <div className="agent-property-image-placeholder" aria-label="No property photo available">Property photo not provided</div>}</div>
                <div className="agent-property-content"><div className="agent-property-title"><div><h2>{listing.name}</h2><span>{listing.apartmentType ? `${listing.type} · ${listing.apartmentType}` : listing.type}</span></div><span className="status paid">{listing.availableUnits} available</span></div>
                  <p className="agent-property-address">{[listing.address, listing.city, listing.state].filter(Boolean).join(", ") || "Address not provided"}</p>
                  <div className="agent-landlord-contact"><strong>Landlord</strong><span>{listing.landlord.name}</span><a href={`mailto:${listing.landlord.email}`}>{listing.landlord.email}</a>{listing.landlord.phone ? <a href={`tel:${listing.landlord.phone.replace(/[^+\d]/g, "")}`}>{listing.landlord.phone}</a> : <span>Phone not provided</span>}</div>
                </div>
              </article>)}</div> : <div className="properties-empty"><strong>No available properties yet</strong><p>Listings appear here when active landlords have vacant rental units recorded in RentWise.</p></div>}
            </>
          ) : currentPage === "dashboard" ? (
            <>
          <div className="welcome-row">
            <div>
              <p className="eyebrow">PROPERTY OVERVIEW</p>
              <h1>Welcome to RentWise NG <span>✦</span></h1>
              <p className="subtitle">Manage your properties, tenants and rent payments in one place.</p>
            </div>
            {canEdit("properties") && <button className="primary-button" onClick={openPropertyForm}>
              + Add property
            </button>}
          </div>

          {["landlord_owner", "property_manager"].includes(auth.user.role) && auth.user.landlordCode && <section className="panel landlord-code-card"><div><p className="eyebrow">TENANT SELF-SIGNUP</p><h2>Organization landlord code</h2><p>Share this code with tenants so they can connect their RentWise account to this organization.</p></div><input className="landlord-code-value" value={auth.user.landlordCode} readOnly onFocus={(event) => event.currentTarget.select()} aria-label="Landlord code; select and copy to share" /><small>Tenants should register with the same email saved in their tenant record.</small></section>}

          <div className="stats-grid">
            {stats.filter((stat) => stat.label === "Total Properties" || stat.label === "Occupied Units" ? roleDefinition.pages.includes("properties") : stat.label === "Rent Collected" ? roleDefinition.pages.includes("payments") : roleDefinition.pages.includes("expenses")).map((stat) => (
              <article className={`stat-card ${stat.label === "Expenses" ? "expense-stat" : ""}`} key={stat.label}>
                <div className="stat-top">
                  <span>{stat.label}</span>
                  <span className="stat-icon">↗</span>
                </div>
                <div className="stat-value">{stat.label === "Total Properties" ? properties.length : stat.label === "Occupied Units" ? occupiedUnitTotal : "₦" + (stat.label === "Rent Collected" ? totalRentCollected : totalExpenses).toLocaleString("en-NG")}</div>
                <div className="stat-detail">{stat.label === "Total Properties" ? properties.length + " registered" : stat.label === "Occupied Units" ? "Across " + properties.length + " registered properties" : stat.label === "Rent Collected" ? rentPayments.length + " recorded " + (rentPayments.length === 1 ? "payment" : "payments") : expenses.length + " recorded " + (expenses.length === 1 ? "expense" : "expenses")}</div>
              </article>
            ))}
          </div>

          <div className="dashboard-visuals">
            {roleDefinition.pages.includes("payments") && <section className="panel chart-panel rent-trend-panel">
              <div className="panel-header chart-panel-header"><div><p className="eyebrow">CASH FLOW</p><h2>Rent collection</h2><p>Paid rent over the last six months</p></div><div className="chart-total"><span>6-month total</span><strong>₦{dashboardTrendTotal.toLocaleString("en-NG")}</strong></div></div>
              <div className="rent-trend-chart" role="img" aria-label={`Rent collected over the last six months totals ${dashboardTrendTotal.toLocaleString("en-NG")} naira`}>
                {dashboardRentTrend.map((month) => <div className="trend-column" key={month.key}>
                  <span className="trend-amount">{month.amount ? `₦${new Intl.NumberFormat("en-NG", { notation: "compact", maximumFractionDigits: 1 }).format(month.amount)}` : "—"}</span>
                  <div className="trend-bar-track"><div className={`trend-bar ${month.amount ? "has-value" : ""}`} style={{ height: `${month.amount ? Math.max(8, (month.amount / dashboardTrendMax) * 100) : 4}%` }} /></div>
                  <span className="trend-month">{month.label}</span>
                </div>)}
              </div>
              {!dashboardTrendTotal && <p className="chart-empty-note">Record paid rent to see your collection trend.</p>}
            </section>}
            {roleDefinition.pages.includes("properties") && <section className="panel chart-panel occupancy-panel">
              <div className="panel-header chart-panel-header"><div><p className="eyebrow">PORTFOLIO HEALTH</p><h2>Unit occupancy</h2><p>Occupied compared with available units</p></div><button className="text-button" type="button" onClick={() => setCurrentPage("properties")}>Properties →</button></div>
              <div className="occupancy-content">
                <div className="occupancy-donut" style={{ background: `conic-gradient(var(--rw-forest) 0% ${dashboardOccupancyPercent}%, #e9e5db ${dashboardOccupancyPercent}% 100%)` }} role="img" aria-label={`${dashboardOccupancyPercent}% of units are occupied`}><div className="occupancy-donut-center"><strong>{dashboardOccupancyPercent}%</strong><span>occupied</span></div></div>
                <div className="occupancy-legend"><div><span className="legend-swatch occupied-swatch"/><span>Occupied</span><strong>{occupiedUnitTotal}</strong></div><div><span className="legend-swatch available-swatch"/><span>Available</span><strong>{dashboardAvailableUnits}</strong></div><div className="occupancy-total"><span>Total units</span><strong>{dashboardUnitTotal}</strong></div></div>
              </div>
              {!dashboardUnitTotal && <p className="chart-empty-note">Add a property to start tracking occupancy.</p>}
            </section>}
          </div>

          {properties.length > 0 && (
            <section className="panel properties-panel" id="properties">
              <div className="panel-header">
                <div><h2>Your properties</h2><p>Properties you have registered</p></div>
              </div>
              <div className="property-list">
                {properties.map((property) => (
                  <article className="property-row" key={property.id}>
                    <span className="property-symbol">⌂</span>
                    <div className="property-details">
                      <strong>{property.name}</strong>
                      <span>{property.address}, {property.city}, {property.state}</span>
                    </div>
                    <span className="property-type">{property.apartmentType ? `${property.type} · ${property.apartmentType}` : property.type}</span>
                    <span className="property-units">{getOccupiedUnits(property.id)} occupied · {getAvailableUnits(property)} available</span>
                    {canEdit("properties") && <button className="row-modify" type="button" onClick={() => openPropertyEdit(property)}>Modify</button>}
                  </article>
                ))}
              </div>
              <div className="panel-footer">Saved in this browser</div>
            </section>
          )}

          <div className="content-grid">
            {roleDefinition.pages.includes("payments") && <section className="panel payments-panel">
              <div className="panel-header">
                <div>
                  <h2>Recent payments</h2>
                  <p>Latest rent transactions</p>
                </div>
                <button className="text-button" onClick={() => setCurrentPage("payments")}>
                  View all →
                </button>
              </div>

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>TENANT</th>
                      <th>PROPERTY</th>
                      <th>AMOUNT</th>
                      <th>DATE</th>
                      <th>METHOD</th>
                      <th>STATUS</th>
                      <th>ACTION</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentPayments.length ? recentPayments.map((payment) => {
                      const tenant = tenants.find((item) => item.id === payment.tenantId);
                      const property = properties.find((item) => item.id === tenant?.propertyId);
                      return <tr key={payment.id}><td><strong>{tenant?.name ?? "Tenant unavailable"}</strong></td><td>{property?.name ?? "—"}</td><td className="amount">₦{payment.amount.toLocaleString("en-NG")}</td><td>{formatDate(payment.paymentDate)}</td><td>{payment.method}</td><td>{paymentStatusLabel(payment)}</td><td>{canEdit("payments") && <button className="row-modify" type="button" onClick={() => openPaymentEdit(payment)}>Modify</button>}</td></tr>;
                    }) : <tr><td colSpan={7} className="empty-table-cell">No rent payments recorded yet.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="panel-footer">{rentPayments.length ? "Saved in this browser" : "Record a payment to start your history"}</div>
            </section>}

            <section className="panel activity-panel">
              <div className="panel-header">
                <div>
                  <h2>Quick actions</h2>
                  <p>Common property tasks</p>
                </div>
              </div>
              {canEdit("tenants") && <button className="quick-action" onClick={openTenantForm} disabled={!hasAvailableUnits}>
                <span className="action-icon green">♙</span>
                <span><strong>Add a tenant</strong><small>Register a new tenant</small></span>
                <span className="action-arrow">→</span>
              </button>}
              {canEdit("payments") && <button className="quick-action" onClick={openPaymentForm} disabled={tenants.length === 0 && !standaloneEstateAgent}>
                <span className="action-icon gold">₦</span>
                <span><strong>Record payment</strong><small>Log cash or bank transfer</small></span>
                <span className="action-arrow">→</span>
              </button>}
              {canEdit("expenses") && <button className="quick-action expense-quick-action" onClick={openExpenseForm} disabled={properties.length === 0}>
                <span className="action-icon expense-action-icon">↗</span>
                <span><strong>Add an expense</strong><small>Track property spending</small></span>
                <span className="action-arrow">→</span>
              </button>}
              {roleDefinition.pages.includes("reminders") && <div className="reminder">
                <span>◷</span>
                <div><strong>Rent reminders</strong><p>Review tenants with upcoming rent expirations.</p><button className="text-button reminder-link" onClick={() => setCurrentPage("reminders")}>View reminders →</button></div>
              </div>}
            </section>
          </div>

          <footer className="page-footer">
            <span>© 2026 RentWise NG</span>
            <span>Built for property management in Nigeria</span>
          </footer>
            </>
          ) : currentPage === "properties" ? (
            <>
              <div className="welcome-row">
                <div>
                  <p className="eyebrow">PROPERTY MANAGEMENT</p>
                  <h1>Your properties</h1>
                  <p className="subtitle">View and find the properties registered in this browser.</p>
                </div>
                {canEdit("properties") && <button className="primary-button" onClick={openPropertyForm}>+ Add property</button>}
              </div>
              <section className="panel properties-page-panel" id="properties">
                <div className="panel-header properties-page-header">
                  <div><h2>Property list</h2><p>{properties.length} {properties.length === 1 ? "property" : "properties"} registered</p></div>
                  <input className="property-search" type="search" placeholder="Search name or city" value={propertySearch} onChange={(event) => setPropertySearch(event.target.value)} aria-label="Search properties by name or city" />
                </div>
                {properties.filter((property) => `${property.name} ${property.city} ${property.state}`.toLowerCase().includes(propertySearch.toLowerCase())).length > 0 ? (
                  <div className="property-list">
                    {properties.filter((property) => `${property.name} ${property.city} ${property.state}`.toLowerCase().includes(propertySearch.toLowerCase())).map((property) => (
                      <article className="property-row" key={property.id}>
                        {propertyPhotoNames(property).length ? <div className="property-row-photos">{propertyPhotoNames(property).map((_name, index) => { const photoId = propertyPhotoAttachmentId(property.id, index); return profilePhotoUrls[photoId] ? <img className="property-profile-photo" key={photoId} src={profilePhotoUrls[photoId]} alt={`${property.name} photo ${index + 1}`} /> : null; })}</div> : <span className="property-symbol">⌂</span>}
                        <div className="property-details">
                          <strong>{property.name}</strong>
                          <span>{property.address}, {property.city}, {property.state}</span>
                        </div>
                        <span className="property-type">{property.apartmentType ? `${property.type} · ${property.apartmentType}` : property.type}</span>
                        <span className="property-units">{getOccupiedUnits(property.id)} occupied · {getAvailableUnits(property)} available</span>
                        {canEdit("properties") && <button className="row-modify" type="button" onClick={() => openPropertyEdit(property)}>Modify</button>}
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="properties-empty">
                    <span className="property-symbol">⌂</span>
                    <strong>{properties.length ? "No matching properties" : "No properties registered yet"}</strong>
                    <p>{properties.length ? "Try a different name or city." : "Add your first property to see it listed here."}</p>
                    {!properties.length && canEdit("properties") && <button className="primary-button" onClick={openPropertyForm}>+ Add property</button>}
                  </div>
                )}
                <div className="panel-footer">Saved in this browser</div>
              </section>
              <footer className="page-footer"><span>© 2026 RentWise NG</span><span>Built for property management in Nigeria</span></footer>
            </>
          ) : currentPage === "tenants" ? (
            <>
              <div className="welcome-row">
                <div>
                  <p className="eyebrow">TENANT MANAGEMENT</p>
                  <h1>Your tenants</h1>
                  <p className="subtitle">Manage tenant biodata, tenancy KYC, and property assignments in one profile.</p>
                </div>
                {canEdit("tenants") && <button className="primary-button" onClick={openTenantForm} disabled={!hasAvailableUnits} title={!hasAvailableUnits ? "All registered units are assigned" : undefined}>+ Add tenant</button>}
              </div>
              {tenantSignups.length > 0 && <section className="panel properties-page-panel">
                <div className="panel-header properties-page-header"><div><h2>Tenant signups awaiting assignment</h2><p>These residents registered with your landlord code. Complete their tenancy profile and assign an available property.</p></div><span className="status-badge status-pending">{tenantSignups.length} pending</span></div>
                <div className="property-list">{tenantSignups.map((signup) => <article className="property-row tenant-row" key={signup.id}>
                  <span className="tenant-avatar">{signup.applicantName.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase()}</span>
                  <div className="property-details"><strong>{signup.applicantName}</strong><span>{signup.email}{signup.phone ? ` · ${signup.phone}` : ""}</span><span className="tenant-dates">Signed up {formatDate(String(signup.submittedAt).slice(0, 10))}</span></div>
                  {canEdit("tenants") && <button className="primary-button" type="button" onClick={() => openTenantSignup(signup)} disabled={!hasAvailableUnits} title={!hasAvailableUnits ? "All registered units are assigned" : undefined}>Complete profile &amp; assign property</button>}
                </article>)}</div>
              </section>}
              <section className="panel properties-page-panel">
                <div className="panel-header properties-page-header">
                  <div><h2>Tenant list</h2><p>{tenants.length} {tenants.length === 1 ? "tenant" : "tenants"} registered</p>{properties.length > 0 && !hasAvailableUnits && <p className="field-hint">All registered units are assigned. Increase a property’s unit count to add another tenant.</p>}</div>
                  <input className="property-search" type="search" placeholder="Search tenant or property" value={tenantSearch} onChange={(event) => setTenantSearch(event.target.value)} aria-label="Search tenants or properties" />
                </div>
                {tenants.filter((tenant) => {
                  const property = properties.find((item) => item.id === tenant.propertyId);
                  return `${tenant.name} ${tenant.phone} ${property?.name ?? ""}`.toLowerCase().includes(tenantSearch.toLowerCase());
                }).length > 0 ? (
                  <div className="property-list">
                    {tenants.filter((tenant) => {
                      const property = properties.find((item) => item.id === tenant.propertyId);
                      return `${tenant.name} ${tenant.phone} ${property?.name ?? ""}`.toLowerCase().includes(tenantSearch.toLowerCase());
                    }).map((tenant) => {
                      const property = properties.find((item) => item.id === tenant.propertyId);
                      return (
                        <article className="property-row tenant-row" key={tenant.id}>
                          {profilePhotoUrls[`tenant-${tenant.id}`] ? <img className="tenant-avatar tenant-profile-photo" src={profilePhotoUrls[`tenant-${tenant.id}`]} alt={`${tenant.name} profile`} /> : <span className="tenant-avatar">{tenant.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase()}</span>}
                          <div className="property-details"><strong>{tenant.name}</strong><span>{tenant.phone}{tenant.email ? ` · ${tenant.email}` : ""}</span><span className="tenant-dates">Rented {formatDate(tenant.rentedDate ?? tenant.moveInDate ?? "")} · Expires {formatDate(tenant.expirationDate ?? "")}</span></div>
                          <div className="property-details tenant-property"><strong>{property?.name ?? "Property unavailable"}</strong><span>{property ? `${property.city}, ${property.state}` : ""}</span></div>
                          <span className="tenant-rent">₦{tenant.monthlyRent.toLocaleString("en-NG")} / {paymentFrequencyLabel(tenant.paymentFrequency ?? "Monthly")}</span>
                          {canEdit("tenants") && <button className="row-modify" type="button" onClick={() => openTenantEdit(tenant)}>Modify</button>}
                          <details className="tenant-kyc-details"><summary>{tenant.occupation || tenant.residentialAddress || tenant.guarantorName ? "View KYC biodata" : "KYC biodata not completed"}</summary><div className="tenant-kyc-summary-grid"><div><strong>Personal details</strong><span>Gender: {tenant.gender || "—"} · Marital status: {tenant.maritalStatus || "—"}</span><span>Nationality: {tenant.nationality || "—"}</span></div><div><strong>Residence &amp; work</strong><span>{[tenant.residentialAddress, tenant.residentialCity, tenant.residentialState].filter(Boolean).join(", ") || "Address not provided"}</span><span>{tenant.occupation || "Occupation not provided"}{tenant.employerName ? ` · ${tenant.employerName}` : ""}</span><span>Employer address: {tenant.employerAddress || "—"}</span></div><div><strong>Guarantor</strong><span>{tenant.guarantorName || "—"} · {tenant.guarantorPhone || "—"}</span><span>Guarantor email: {tenant.guarantorEmail || "—"}</span><span>Guarantor address: {tenant.guarantorAddress || "—"}</span></div></div></details>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="properties-empty">
                    <span className="property-symbol">♙</span>
                    <strong>{tenants.length ? "No matching tenants" : "No tenants registered yet"}</strong>
                    <p>{properties.length ? (tenants.length ? "Try a different name or property." : "Register a tenant and assign them to a property.") : "Add a property first, then you can assign a tenant to it."}</p>
                    {hasAvailableUnits && tenants.length === 0 && canEdit("tenants") && <button className="primary-button" onClick={openTenantForm}>+ Add tenant</button>}
                    {properties.length > 0 && !hasAvailableUnits && tenants.length > 0 && <p>All registered units are currently assigned.</p>}
                    {properties.length === 0 && <button className="secondary-button" onClick={() => setCurrentPage("properties")}>Go to properties</button>}
                  </div>
                )}
                <div className="panel-footer">Saved in this browser</div>
              </section>
              <footer className="page-footer"><span>© 2026 RentWise NG</span><span>Built for property management in Nigeria</span></footer>
            </>
          ) : currentPage === "leases" ? (
            <>
              <div className="welcome-row">
                <div><p className="eyebrow">TENANCY MANAGEMENT</p><h1>Lease Agreements</h1><p className="subtitle">Register lease terms and keep each agreement linked to its tenant.</p></div>
                {canEdit("leases") && <button className="primary-button" onClick={() => openLeaseForm()} disabled={tenants.length === 0}>+ Add lease</button>}
              </div>
              <div className="stats-grid payment-summary-grid">
                <article className="stat-card"><div className="stat-top"><span>Lease agreements</span></div><div className="stat-value">{leases.length}</div><div className="stat-detail">Saved in this browser</div></article>
                <article className="stat-card"><div className="stat-top"><span>Active agreements</span></div><div className="stat-value">{leases.filter((lease) => lease.status === "Active" && lease.expirationDate >= todayKey).length}</div><div className="stat-detail">Current and upcoming leases</div></article>
              </div>
              <section className="panel properties-page-panel">
                <div className="panel-header properties-page-header">
                  <div><h2>Agreement register</h2><p>Lease terms by tenant and property</p></div>
                  <input className="property-search" type="search" placeholder="Search tenant or reference" value={leaseSearch} onChange={(event) => setLeaseSearch(event.target.value)} aria-label="Search lease agreements" />
                </div>
                {leaseDocumentMessage && <div className="reminder-notice" role="status">{leaseDocumentMessage}</div>}
                {leases.filter((lease) => {
                  const tenant = tenants.find((item) => item.id === lease.tenantId);
                  const property = properties.find((item) => item.id === tenant?.propertyId);
                  return (tenant?.name + " " + (property?.name ?? "") + " " + lease.reference + " " + lease.status).toLowerCase().includes(leaseSearch.toLowerCase());
                }).length ? (
                  <div className="table-wrap"><table>
                    <thead><tr><th>REFERENCE</th><th>TENANT / PROPERTY</th><th>LEASE TERM</th><th>RENT</th><th>CAUTION FEE</th><th>DOCUMENT</th><th>STATUS</th><th>ACTION</th></tr></thead>
                    <tbody>{leases.filter((lease) => {
                      const tenant = tenants.find((item) => item.id === lease.tenantId);
                      const property = properties.find((item) => item.id === tenant?.propertyId);
                      return (tenant?.name + " " + (property?.name ?? "") + " " + lease.reference + " " + lease.status).toLowerCase().includes(leaseSearch.toLowerCase());
                    }).map((lease) => {
                      const tenant = tenants.find((item) => item.id === lease.tenantId);
                      const property = properties.find((item) => item.id === tenant?.propertyId);
                      const displayStatus = lease.status === "Active" && lease.expirationDate < todayKey ? "Expired" : lease.status;
                      return <tr key={lease.id}><td><strong>{lease.reference}</strong></td><td><strong>{tenant?.name ?? "Tenant unavailable"}</strong><br /><small>{property?.name ?? "Property unavailable"}</small></td><td>{formatDate(lease.startDate)} – {formatDate(lease.expirationDate)}</td><td className="amount">₦{lease.rentAmount.toLocaleString("en-NG")} / {paymentFrequencyLabel(lease.paymentFrequency)}</td><td className="amount">₦{lease.securityDeposit.toLocaleString("en-NG")}</td><td><div className="lease-document-actions">{lease.generatedDocumentId && <button className="row-modify" type="button" onClick={() => void downloadGeneratedLeaseDocument(lease)}>Completed PDF</button>}{lease.documentName && <button className="row-modify" type="button" onClick={() => void downloadLeaseDocument(lease)}>Uploaded file</button>}{!lease.generatedDocumentId && !lease.documentName && <small>Save to generate</small>}</div></td><td><span className={"status " + (displayStatus === "Active" ? "paid" : displayStatus === "Expired" || displayStatus === "Terminated" ? "overdue" : "pending")}>{displayStatus}</span></td><td>{canEdit("leases") && <button className="row-modify" type="button" onClick={() => openLeaseForm(lease)}>Modify</button>}</td></tr>;
                    })}</tbody>
                  </table></div>
                ) : (
                  <div className="properties-empty"><span className="property-symbol">▣</span><strong>{leases.length ? "No matching lease agreements" : "No lease agreements yet"}</strong><p>{leases.length ? "Try another tenant name or reference." : tenants.length ? "Add a lease agreement to record a tenant’s terms." : "Add a tenant before creating a lease agreement."}</p>{!leases.length && tenants.length > 0 && canEdit("leases") && <button className="primary-button" onClick={() => openLeaseForm()}>+ Add lease</button>}{tenants.length === 0 && <button className="secondary-button" onClick={() => setCurrentPage("tenants")}>Go to tenants</button>}</div>
                )}
                <div className="panel-footer">Lease records are saved in this browser. Active agreements update the linked tenant’s rent and expiration dates.</div>
              </section>
              <footer className="page-footer"><span>© 2026 RentWise NG</span><span>Built for property management in Nigeria</span></footer>
            </>
          ) : currentPage === "inspections" ? (
            <>
              <div className="welcome-row"><div><p className="eyebrow">PROPERTY OPERATIONS</p><h1>Inspections &amp; Handover</h1><p className="subtitle">Record property condition, meter readings, and move-in or move-out handover details.</p></div>{canEdit("inspections") && <button className="primary-button" type="button" onClick={() => openInspectionForm()} disabled={!properties.length}>+ New inspection</button>}</div>
              {inspectionMessage && <div className="reminder-notice" role="status">{inspectionMessage}</div>}
              <section className="panel properties-page-panel"><div className="panel-header properties-page-header"><div><h2>Inspection register</h2><p>{inspections.length} saved {inspections.length === 1 ? "inspection" : "inspections"}</p></div><input className="property-search" type="search" placeholder="Search property, tenant, or inspector" value={inspectionSearch} onChange={(event) => setInspectionSearch(event.target.value)} aria-label="Search inspections" /></div>
                {inspections.filter((item) => { const property = properties.find((row) => row.id === item.propertyId); const tenant = tenants.find((row) => row.id === item.tenantId); return `${property?.name ?? ""} ${tenant?.name ?? ""} ${item.inspectorName} ${item.kind} ${item.unitLabel}`.toLowerCase().includes(inspectionSearch.toLowerCase()); }).length ? <div className="maintenance-request-list">{inspections.filter((item) => { const property = properties.find((row) => row.id === item.propertyId); const tenant = tenants.find((row) => row.id === item.tenantId); return `${property?.name ?? ""} ${tenant?.name ?? ""} ${item.inspectorName} ${item.kind} ${item.unitLabel}`.toLowerCase().includes(inspectionSearch.toLowerCase()); }).map((item) => { const property = properties.find((row) => row.id === item.propertyId); const tenant = tenants.find((row) => row.id === item.tenantId); return <article className="maintenance-request-card" key={item.id}><div className="maintenance-request-heading"><div><span className="maintenance-type minor">{item.kind}</span><strong>{property?.name ?? "Property unavailable"}{item.unitLabel ? ` · ${item.unitLabel}` : ""}</strong></div><span className="status pending">{formatDate(item.inspectionDate)}</span></div><div className="maintenance-request-meta"><span>Tenant: <strong>{tenant?.name ?? "Not assigned"}</strong></span><span>Inspector: <strong>{item.inspectorName || "—"}</strong></span><span>Electricity: {item.meterReadings.electricity || "—"}</span><span>Water: {item.meterReadings.water || "—"}</span><span>Inspection fee: <strong>₦{(item.inspectionFee ?? 0).toLocaleString("en-NG")}</strong></span><span>Agent fee: <strong>₦{(item.agentFee ?? 0).toLocaleString("en-NG")}</strong></span></div><p>{item.observations || "No observations recorded."}</p><p><strong>Handover:</strong> {item.handoverNotes || "—"}{item.acknowledgementName ? ` · Acknowledged by ${item.acknowledgementName}${item.acknowledgedAt ? ` on ${formatDate(item.acknowledgedAt)}` : ""}` : ""}</p><div className="maintenance-image-list">{item.photos.map((photo) => <button className="row-modify" type="button" key={photo.id} onClick={() => void downloadInspectionPhoto(photo)}>Photo: {photo.name}</button>)}{canEdit("inspections") && <button className="row-modify" type="button" onClick={() => openInspectionForm(item)}>Modify</button>}</div></article>; })}</div> : <div className="properties-empty"><strong>No inspections recorded</strong><p>Create a routine, move-in, move-out, or handover record.</p>{canEdit("inspections") && properties.length > 0 && <button className="primary-button" onClick={() => openInspectionForm()}>+ New inspection</button>}</div>}
              </section>
              <section className="panel properties-page-panel"><div className="panel-header"><div><h2>Condition checklist overview</h2><p>Saved inspection records keep item-by-item condition ratings on file.</p></div></div>{inspections.length ? <div className="table-wrap"><table><thead><tr><th>PROPERTY / UNIT</th><th>EXTERIOR</th><th>WALLS / FLOORS</th><th>ELECTRICAL</th><th>PLUMBING</th><th>DOORS / WINDOWS</th><th>FIXTURES</th><th>INSPECTION FEE</th><th>AGENT FEE</th></tr></thead><tbody>{inspections.map((item) => <tr key={item.id}><td>{properties.find((property) => property.id === item.propertyId)?.name ?? "Property"}{item.unitLabel ? ` / ${item.unitLabel}` : ""}</td><td>{item.checklist.exterior}</td><td>{item.checklist.wallsFloors}</td><td>{item.checklist.electrical}</td><td>{item.checklist.plumbing}</td><td>{item.checklist.doorsWindows}</td><td>{item.checklist.fixtures}</td><td>₦{(item.inspectionFee ?? 0).toLocaleString("en-NG")}</td><td>₦{(item.agentFee ?? 0).toLocaleString("en-NG")}</td></tr>)}</tbody></table></div> : <div className="panel-footer">Checklist ratings will appear here after the first inspection.</div>}</section>
            </>
          ) : currentPage === "renewals" ? (
            <>
              <div className="welcome-row reports-heading"><div><p className="eyebrow">TENANCY MANAGEMENT</p><h1>Rent Renewals</h1><p className="subtitle">Review active leases expiring within 90 days and prepare a new rental term.</p></div><span className="reminder-schedule-badge">90-day renewal window</span></div>
              <div className="stats-grid payment-summary-grid"><article className="stat-card"><div className="stat-top"><span>Tenant requests</span></div><div className="stat-value">{renewalRequests.filter((request) => request.status === "Pending").length}</div><div className="stat-detail">Waiting for landlord review</div></article><article className="stat-card"><div className="stat-top"><span>Due within 90 days</span></div><div className="stat-value">{renewalItems.filter((item) => item.daysUntilExpiration >= 0).length}</div><div className="stat-detail">Active leases approaching expiration</div></article><article className="stat-card"><div className="stat-top"><span>Expired</span></div><div className="stat-value">{renewalItems.filter((item) => item.daysUntilExpiration < 0).length}</div><div className="stat-detail">Active lease records past expiration</div></article></div>
              <section className="panel properties-page-panel"><div className="panel-header"><div><h2>Tenant-submitted requests</h2><p>Confirm the linked payment in Rent &amp; Payments before approving.</p></div></div>
                {renewalRequests.length ? <div className="table-wrap"><table><thead><tr><th>TENANT / PROPERTY</th><th>REQUESTED TERM</th><th>RENT</th><th>PAYMENT</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>{renewalRequests.slice().sort((left, right) => right.submittedDate.localeCompare(left.submittedDate)).map((request) => { const tenant = tenants.find((item) => item.id === request.tenantId); const property = properties.find((item) => item.id === tenant?.propertyId); const payment = rentPayments.find((item) => item.id === request.paymentId); return <tr key={request.id}><td><strong>{tenant?.name ?? "Tenant unavailable"}</strong><br /><small>{property?.name ?? "Property unavailable"}</small></td><td>{formatDate(request.startDate)} – {formatDate(request.expirationDate)}<br /><small>{paymentFrequencyLabel(request.paymentFrequency)} · {formatDate(request.submittedDate)}</small></td><td className="amount">₦{request.rentAmount.toLocaleString("en-NG")}</td><td>{payment?.status ?? "Payment missing"}{payment?.receiptName && <><br /><button className="row-modify" type="button" onClick={() => void downloadPaymentReceipt(payment)}>View receipt</button></>}</td><td><span className={"status " + (request.status === "Approved" ? "paid" : request.status === "Declined" ? "overdue" : "pending")}>{request.status}</span></td><td>{request.status === "Pending" && <div className="account-actions">{payment?.status === "Pending" && <button className="row-modify" type="button" disabled={!canEdit("leases")} onClick={() => void confirmRenewalPayment(request)}>Confirm payment received</button>}<button className="primary-button" type="button" disabled={!canEdit("leases") || payment?.status !== "Paid" || !tenant} title={payment?.status !== "Paid" ? "Confirm the linked payment as received before activating this renewal." : !tenant ? "The linked tenant profile is unavailable." : undefined} onClick={() => void reviewRenewalRequest(request, "Approved")}>Approve &amp; activate</button><button className="danger-button" type="button" disabled={!canEdit("leases")} onClick={() => void reviewRenewalRequest(request, "Declined")}>Decline</button></div>}{request.status === "Approved" && <small>Lease activated</small>}{request.status === "Declined" && <small>Payment rejected</small>}</td></tr>; })}</tbody></table></div> : <div className="properties-empty"><strong>No tenant-submitted renewal requests</strong><p>Requests from resident accounts will appear here.</p></div>}
              </section>
              <section className="panel properties-page-panel"><div className="panel-header"><div><h2>Renewal queue</h2><p>Renewal creates a new lease record and keeps the existing agreement for history.</p></div></div>
                {renewalItems.length ? <div className="table-wrap"><table><thead><tr><th>TENANT / PROPERTY</th><th>CURRENT TERM ENDS</th><th>STATUS</th><th>CURRENT RENT</th><th>ACTION</th></tr></thead><tbody>{renewalItems.map(({ lease, tenant, property, daysUntilExpiration }) => <tr key={lease.id}><td><strong>{tenant.name}</strong><br /><small>{property?.name ?? "Property unavailable"}</small></td><td>{formatDate(lease.expirationDate)}</td><td><span className={"status " + (daysUntilExpiration < 0 ? "overdue" : daysUntilExpiration <= 30 ? "pending" : "paid")}>{daysUntilExpiration < 0 ? `${Math.abs(daysUntilExpiration)} days overdue` : daysUntilExpiration === 0 ? "Expires today" : `${daysUntilExpiration} days left`}</span></td><td className="amount">₦{lease.rentAmount.toLocaleString("en-NG")} / {paymentFrequencyLabel(lease.paymentFrequency)}</td><td>{canEdit("leases") && <button className="row-modify" type="button" onClick={() => openLeaseRenewal(lease)}>Renew rent</button>}</td></tr>)}</tbody></table></div> : <div className="properties-empty"><span className="property-symbol">↻</span><strong>No renewals due soon</strong><p>Leases approaching expiration within 90 days will appear here.</p></div>}
                <div className="panel-footer">Saving a renewal adds a new lease agreement and updates the linked tenant’s current rent and expiration date.</div>
              </section>
            </>
          ) : currentPage === "ledger" ? (
            <>
              <div className="welcome-row reports-heading"><div><p className="eyebrow">PROPERTY FINANCE</p><h1>Property Financial Ledger</h1><p className="subtitle">Portfolio income, expenses, and net performance from confirmed financial records.</p></div><div className="ledger-actions"><button className="secondary-button" type="button" onClick={downloadFinancialLedgerCsv} disabled={!financialLedger || financialLedgerBusy}>Download CSV</button>{canEdit("payments") && <button className="primary-button" type="button" onClick={() => { setCurrentPage("payments"); openPaymentForm(); }}>+ Record payment</button>}</div></div>
              <section className="panel financial-ledger-filter-panel"><div className="financial-ledger-filters">
                <label>Property<select value={ledgerPropertyFilter} onChange={(event) => setLedgerPropertyFilter(event.target.value)}><option value="all">All properties</option>{properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}</select></label>
                <label>Period<select value={ledgerPeriod} onChange={(event) => setLedgerPeriod(event.target.value as typeof ledgerPeriod)}><option value="all">All dates</option><option value="month">This month</option><option value="quarter">This quarter</option><option value="year">This year</option><option value="custom">Custom range</option></select></label>
                {ledgerPeriod === "custom" && <><label>From<input type="date" value={ledgerFromDate} onChange={(event) => setLedgerFromDate(event.target.value)} /></label><label>To<input type="date" value={ledgerToDate} onChange={(event) => setLedgerToDate(event.target.value)} /></label></>}
                <label>Category<select value={ledgerCategoryFilter} onChange={(event) => setLedgerCategoryFilter(event.target.value)}><option value="all">All categories</option><option value="Rental income">Rental income</option><option value="Other income">Other income</option>{financialCategoryOptions.filter((item) => !["Rental income", "Other income"].includes(item)).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
                <label className="financial-ledger-search">Search<input type="search" value={ledgerSearch} onChange={(event) => setLedgerSearch(event.target.value)} placeholder="Reference, category, property…" /></label>
              </div></section>
              {financialLedgerError && <div className="form-error financial-ledger-feedback" role="alert">{financialLedgerError}</div>}{financialLedgerMessage && <div className="reminder-notice financial-ledger-feedback" role="status">{financialLedgerMessage}</div>}{financialLedger && financialLedger.unreviewedPayments ? <div className="reminder-notice financial-ledger-feedback" role="status"><strong>{financialLedger.unreviewedPayments} legacy payment record(s) need review.</strong> They have no explicit status, so they are excluded from income. Review them in <button className="row-modify" type="button" onClick={() => setCurrentPage("payments")}>Rent &amp; Payments</button> and mark Paid only after confirming receipt.</div> : null}{financialLedger && financialLedger.unreviewedAmounts ? <div className="reminder-notice financial-ledger-feedback" role="status"><strong>{financialLedger.unreviewedAmounts} financial record(s) do not have a valid stored kobo amount.</strong> They are excluded from ledger totals; open the matching payment or expense record and save a valid amount.</div> : null}
              {financialLedgerBusy && !financialLedger ? <section className="panel"><div className="panel-footer">Loading verified property ledger from the server…</div></section> : financialLedger && <>
                <div className="stats-grid payment-summary-grid financial-ledger-summary">
                  <article className="stat-card income-stat"><div className="stat-top"><span>Grand total income</span><span className="ledger-stat-icon">↗</span></div><div className="stat-value">₦{koboToNaira(financialLedger.summary.incomeKobo).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div><div className="stat-detail">Confirmed transactions received</div></article>
                  <article className="stat-card expense-stat"><div className="stat-top"><span>Grand total expenses</span><span className="ledger-stat-icon">↘</span></div><div className="stat-value">₦{koboToNaira(financialLedger.summary.expensesKobo).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div><div className="stat-detail">Recorded operating expenses</div></article>
                  <article className={`stat-card ${BigInt(financialLedger.summary.netProfitKobo) < 0n ? "expense-stat" : "profit-stat"}`}><div className="stat-top"><span>Net profit / loss</span><span className="ledger-stat-icon">≈</span></div><div className="stat-value">₦{koboToNaira(financialLedger.summary.netProfitKobo).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div><div className="stat-detail">Income minus expenses</div></article>
                </div>
                <section className="panel financial-property-panel"><div className="panel-header"><div><h2>Property-by-property performance</h2><p>Independent income, operating costs, and net profit for each property.</p></div><span className="financial-result-count">{financialLedger.properties.length} properties</span></div>
                  {financialLedger.properties.length ? <div className="financial-property-grid">{financialLedger.properties.map((item) => <article className="financial-property-card" key={item.id}><div className="financial-property-title"><div><h3>{item.name}</h3><p>{item.address || "Address not recorded"}</p></div><span className={BigInt(item.netProfitKobo) < 0n ? "financial-negative" : "financial-positive"}>{BigInt(item.netProfitKobo) < 0n ? "Loss" : "Profit"}</span></div><div className="financial-property-net"><span>Net profit / loss</span><strong>₦{koboToNaira(item.netProfitKobo).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></div><div className="financial-breakdown"><div><span>Rental income</span><strong>₦{koboToNaira(item.rentalIncomeKobo).toLocaleString("en-NG")}</strong></div><div><span>Other property income</span><strong>₦{koboToNaira(item.otherIncomeKobo).toLocaleString("en-NG")}</strong></div><div><span>Maintenance expenses</span><strong>₦{koboToNaira(item.maintenanceExpensesKobo).toLocaleString("en-NG")}</strong></div><div><span>Repair expenses</span><strong>₦{koboToNaira(item.repairExpensesKobo).toLocaleString("en-NG")}</strong></div><div><span>Management / agent fees</span><strong>₦{koboToNaira(item.managementAndAgentFeesKobo).toLocaleString("en-NG")}</strong></div><div><span>Other operating expenses</span><strong>₦{koboToNaira(item.otherOperationalExpensesKobo).toLocaleString("en-NG")}</strong></div><div className="financial-breakdown-total"><span>Total expenses</span><strong>₦{koboToNaira(item.totalExpensesKobo).toLocaleString("en-NG")}</strong></div></div></article>)}</div> : <div className="properties-empty"><strong>No properties match this filter</strong><p>Add property records to view portfolio performance.</p></div>}
                </section>
                {financialLedger.properties.length > 1 && <section className="panel financial-chart-panel"><div className="panel-header"><div><h2>Income and expense comparison</h2><p>Property totals for the selected reporting period.</p></div></div><div className="financial-chart">{financialLedger.properties.map((item) => { const income = koboToNaira(item.rentalIncomeKobo) + koboToNaira(item.otherIncomeKobo); const cost = koboToNaira(item.totalExpensesKobo); const maximum = Math.max(1, ...financialLedger.properties.map((property) => koboToNaira(property.rentalIncomeKobo) + koboToNaira(property.otherIncomeKobo)), ...financialLedger.properties.map((property) => koboToNaira(property.totalExpensesKobo))); return <div className="financial-chart-row" key={item.id}><span title={item.name}>{item.name}</span><div><i className="financial-income-bar" style={{ width: `${Math.max(income > 0 ? 1 : 0, income / maximum * 100)}%` }} /></div><strong>₦{income.toLocaleString("en-NG")}</strong><div><i className="financial-expense-bar" style={{ width: `${Math.max(cost > 0 ? 1 : 0, cost / maximum * 100)}%` }} /></div><strong>₦{cost.toLocaleString("en-NG")}</strong></div>; })}<div className="financial-chart-legend"><span><i className="financial-income-bar" /> Income</span><span><i className="financial-expense-bar" /> Expenses</span></div></div></section>}
                <section className="panel properties-page-panel"><div className="panel-header"><div><h2>Financial transactions</h2><p>Only confirmed receipts and recorded expenses affect the totals. Pending, rejected, and reversed payments are excluded.</p></div><span className="financial-result-count">{visibleFinancialTransactions.length} records</span></div>
                  {visibleFinancialTransactions.length ? <div className="table-wrap"><table className="financial-transactions-table"><thead><tr><th>DATE / REFERENCE</th><th>PROPERTY</th><th>CATEGORY / DETAILS</th><th>DESCRIPTION</th><th>TYPE</th><th>AMOUNT</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>{visibleFinancialTransactions.map((item) => <tr key={`${item.source}-${item.id}`}><td>{formatDate(item.date)}<br /><small>{item.reference}</small></td><td>{item.propertyName}</td><td><strong>{item.category}</strong><br /><small>{item.detail}</small></td><td>{item.description || "—"}</td><td><span className={`financial-direction ${item.direction}`}>{item.direction === "income" ? "Income" : "Expense"}</span></td><td className="amount">{item.direction === "expense" ? "−" : "+"}₦{koboToNaira(item.amountKobo).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td><td><span className="status paid">{item.status}</span></td><td>{["super_admin", "landlord_owner", "property_manager"].includes(auth.user.role) && <button className="danger-button financial-reverse-button" type="button" onClick={() => void reverseFinancialTransaction(item)}>Reverse</button>}</td></tr>)}</tbody></table></div> : <div className="properties-empty"><strong>No financial transactions in this view</strong><p>Confirmed rent and other received payments, plus expenses, will appear here.</p></div>}
                </section>
                <details className="panel financial-audit-panel"><summary>Transaction audit history <span>{financialLedger.audit.length} events</span></summary>{financialLedger.audit.length ? <div className="table-wrap"><table><thead><tr><th>WHEN</th><th>REFERENCE</th><th>RECORD</th><th>ACTION</th><th>BY</th><th>CHANGE DETAIL</th></tr></thead><tbody>{financialLedger.audit.map((event) => <tr key={event.id}><td>{formatDate(event.createdAt.slice(0, 10))}<br /><small>{new Date(event.createdAt).toLocaleTimeString()}</small></td><td>{event.reference}</td><td>{event.collection === "payments" ? "Payment" : "Expense"}</td><td><span className={`status ${event.action === "reversed" || event.action === "deleted" ? "overdue" : "pending"}`}>{event.action}</span></td><td>{event.actor}</td><td><details><summary>View change</summary><pre>{JSON.stringify({ before: event.before, after: event.after }, null, 2)}</pre></details></td></tr>)}</tbody></table></div> : <div className="properties-empty"><p>No payment or expense edits have been recorded yet.</p></div>}</details>
              </>}
              <section className="panel properties-page-panel rent-arrears-panel"><div className="panel-header"><div><h2>Rent arrears and scheduled collections</h2><p>Outstanding and upcoming rent are tracked separately from collected income.</p></div><div className="stats-inline"><span>Due ₦{rentLedgerTotalDue.toLocaleString("en-NG")}</span><span>Collected ₦{rentLedgerTotalPaid.toLocaleString("en-NG")}</span><span>Outstanding ₦{rentLedgerOutstanding.toLocaleString("en-NG")}</span><span>Pending ₦{rentLedgerPending.toLocaleString("en-NG")}</span></div></div>
                <div className="panel-header properties-page-header"><div><h3>Tenant balances</h3><p>Oldest outstanding rent is considered overdue first.</p></div><div className="ledger-filters"><input className="property-search" type="search" placeholder="Search tenant or property" value={arrearsSearch} onChange={(event) => setArrearsSearch(event.target.value)} aria-label="Search rent ledger" /><select aria-label="Filter rent ledger by status" value={ledgerStatusFilter} onChange={(event) => setLedgerStatusFilter(event.target.value)}><option>All</option><option>Overdue</option><option>Due</option><option>Up to date</option><option>In advance</option><option>Not due</option><option>Dates needed</option></select></div></div>
                {filteredRentLedgerRows.length ? <div className="table-wrap"><table className="rent-ledger-table"><thead><tr><th>TENANT / PROPERTY</th><th>RENT TERM</th><th>SCHEDULED DUE</th><th>CONFIRMED PAID</th><th>PENDING</th><th>OUTSTANDING</th><th>STATUS</th></tr></thead><tbody>{filteredRentLedgerRows.map((row) => <tr key={row.tenant.id}><td><strong>{row.tenant.name}</strong><br /><small>{row.property?.name ?? "Property unavailable"}</small></td><td>{row.scheduleReady ? <>₦{row.rentAmount.toLocaleString("en-NG")} / {paymentFrequencyLabel(row.frequency)}<br /><small>{formatDate(row.startDate)} – {formatDate(row.expirationDate)}</small>{row.nextDueDate && <><br /><small>Next due {formatDate(row.nextDueDate)}</small></>}</> : <span>Set rent dates and amount</span>}</td><td className="amount">₦{row.expectedDue.toLocaleString("en-NG")}</td><td className="amount">₦{row.confirmedPaid.toLocaleString("en-NG")}{row.credit > 0 && <><br /><small>₦{row.credit.toLocaleString("en-NG")} advance</small></>}</td><td className="amount">₦{row.pendingAmount.toLocaleString("en-NG")}</td><td className="amount">₦{row.balance.toLocaleString("en-NG")}</td><td><span className={`status ${row.status === "Overdue" ? "overdue" : row.status === "Up to date" || row.status === "In advance" ? "paid" : "pending"}`}>{row.status}{row.balance > 0 && row.daysOverdue > 0 ? <><br /><small>{row.daysOverdue} days overdue</small></> : null}</span></td></tr>)}</tbody></table></div> : <div className="properties-empty"><strong>{rentLedgerRows.length ? "No matching rent balances" : "No tenants to show yet"}</strong><p>{rentLedgerRows.length ? "Try another search or status filter." : "Add tenants with rent dates to start tracking scheduled rent."}</p></div>}
                <div className="panel-footer">Scheduled or unpaid rent never appears as collected income in the Property Financial Ledger.</div>
              </section>
              <footer className="page-footer"><span>© 2026 RentWise NG</span><span>Built for property management in Nigeria</span></footer>
            </>
          ) : currentPage === "maintenance" ? (
            currentRole === "resident_tenant" ? (
              <>
                <div className="welcome-row"><div><p className="eyebrow">RESIDENT SERVICES</p><h1>Maintenance requests</h1><p className="subtitle">Report a major or minor repair issue at your property.</p></div></div>
                <div className="reminder-notice">Requests are sent to the property team for review. Choose Major for urgent or significant repairs, and Minor for routine issues.</div>
                {(() => {
                  const tenant = tenants.find((item) => item.id === residentTenantId);
                  const property = properties.find((item) => item.id === tenant?.propertyId);
                  const residentRequests = maintenanceRequests.filter((request) => request.tenantId === residentTenantId);
                  return tenant ? <>
                    <section className="panel properties-page-panel">
                      <div className="panel-header"><div><h2>Report a repair</h2><p>{property?.name ?? "Your property"}</p></div></div>
                      <form className="property-form maintenance-form" onSubmit={(event) => submitMaintenanceRequest(event, tenant)}>
                        <label>Repair priority<select name="repairType" defaultValue="Minor" required><option value="Major">Major repair</option><option value="Minor">Minor repair</option></select></label>
                        <label>Issue title<input name="title" placeholder="e.g. Water leak in kitchen" required maxLength={100} /></label>
                        <label>Describe the issue<textarea name="description" rows={4} placeholder="Explain what needs repair and where it is located." required maxLength={1200} /></label>
                        <label>Upload images <span className="optional-label">Optional · select multiple · JPG, PNG, or WebP · max 10 images, 8 MB each</span><input name="images" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" multiple /></label>
                        {maintenanceMessage && <div className="reminder-notice" role="status">{maintenanceMessage}</div>}
                        {leaseFormError && <p className="form-error" role="alert">{leaseFormError}</p>}
                <div className="form-actions"><button className="primary-button" type="submit">Submit maintenance request</button></div>
                      </form>
                    </section>
                    <section className="panel properties-panel"><div className="panel-header"><div><h2>Your requests</h2><p>Follow up on maintenance reports for this property</p></div></div>{residentRequests.length ? <div className="maintenance-request-list">{residentRequests.map((request) => <article className="maintenance-request-card" key={request.id}><div className="maintenance-request-heading"><div><span className={"maintenance-type " + request.repairType.toLowerCase()}>{request.repairType} repair</span><strong>{request.title}</strong></div><span className={"status " + (request.status === "Resolved" ? "paid" : request.status === "Declined" ? "overdue" : "pending")}>{request.status}</span></div><p>{request.description}</p><div className="maintenance-request-meta"><span>Submitted {formatDate(request.submittedDate)}</span><span>{property?.name ?? "Property unavailable"}</span></div>{request.images?.length ? <div className="maintenance-image-list">{request.images.map((image) => <button className="row-modify" type="button" key={image.id} onClick={() => downloadMaintenanceImage(image)}>Download {image.name}</button>)}</div> : null}</article>)}</div> : <div className="properties-empty"><strong>No maintenance requests yet</strong><p>Your submitted repair requests and their status will appear here.</p></div>}</section>
                  </> : <div className="properties-empty"><strong>Tenant record unavailable</strong><p>Select a resident preview with a tenant record to submit a request.</p></div>;
                })()}
              </>
            ) : (
              <>
                <div className="welcome-row"><div><p className="eyebrow">PROPERTY OPERATIONS</p><h1>Maintenance requests</h1><p className="subtitle">Review repair issues submitted by residents.</p></div></div>
                <div className="stats-grid payment-summary-grid"><article className="stat-card"><div className="stat-top"><span>Open requests</span></div><div className="stat-value">{maintenanceRequests.filter((request) => request.status === "Open").length}</div><div className="stat-detail">Awaiting review</div></article><article className="stat-card"><div className="stat-top"><span>In progress</span></div><div className="stat-value">{maintenanceRequests.filter((request) => request.status === "In Progress").length}</div><div className="stat-detail">Currently being handled</div></article></div>
                <section className="panel properties-page-panel"><div className="panel-header"><div><h2>Maintenance vendors</h2><p>Keep approved repair providers and contact details in one place.</p></div></div>{canEdit("maintenanceVendors") && <form className="property-form vendor-form" onSubmit={(event) => void saveMaintenanceVendor(event)}><div className="form-row"><label>Vendor name<input name="name" placeholder="Contact person" required /></label><label>Company<input name="company" placeholder="Company name" /></label></div><div className="form-row"><label>Phone<input name="phone" type="tel" placeholder="Phone number" required /></label><label>Email<input name="email" type="email" placeholder="Email address" /></label></div><div className="form-row"><label>Specialty<input name="specialty" placeholder="e.g. Plumbing" required /></label><label>Service area<input name="serviceArea" placeholder="City or area" /></label></div><div className="form-actions"><button className="primary-button" type="submit">Add vendor</button></div></form>}{maintenanceVendors.length ? <div className="table-wrap"><table><thead><tr><th>VENDOR</th><th>SPECIALTY</th><th>PHONE / EMAIL</th><th>SERVICE AREA</th></tr></thead><tbody>{maintenanceVendors.filter((vendor) => vendor.active).map((vendor) => <tr key={vendor.id}><td><strong>{vendor.name}</strong>{vendor.company ? <><br />{vendor.company}</> : null}</td><td>{vendor.specialty}</td><td>{vendor.phone}{vendor.email ? <><br />{vendor.email}</> : null}</td><td>{vendor.serviceArea || "—"}</td></tr>)}</tbody></table></div> : <div className="panel-footer">No vendors have been added.</div>}</section>
                <section className="panel properties-page-panel"><div className="panel-header"><div><h2>Request register &amp; work orders</h2><p>Assign vendors, review quotes, approve costs, and track the repair schedule.</p></div></div>{maintenanceRequests.length ? <div className="maintenance-request-list">{maintenanceRequests.map((request) => {
                  const tenant = tenants.find((item) => item.id === request.tenantId);
                  const property = properties.find((item) => item.id === request.propertyId);
                  const assignedVendor = maintenanceVendors.find((vendor) => vendor.id === request.vendorId);
                  return <article className="maintenance-request-card" key={request.id}><div className="maintenance-request-heading"><div><span className={"maintenance-type " + request.repairType.toLowerCase()}>{request.repairType} repair</span><strong>{request.title}</strong></div><label className="maintenance-status-label">Status<select value={request.status} disabled={!canEdit("maintenance")} onChange={(event) => updateMaintenanceRequest(request.id, { status: event.target.value as MaintenanceRequest["status"] })}><option>Open</option><option>In Progress</option><option>Resolved</option><option>Declined</option></select></label></div><p>{request.description}</p><div className="maintenance-request-meta"><span>Tenant: <strong>{tenant?.name ?? "Tenant unavailable"}</strong></span><span>Property: <strong>{property?.name ?? "Property unavailable"}</strong></span><span>Submitted: {formatDate(request.submittedDate)}</span></div>{request.images?.length ? <div className="maintenance-image-list">{request.images.map((image) => <button className="row-modify" type="button" key={image.id} onClick={() => downloadMaintenanceImage(image)}>Download {image.name}</button>)}</div> : null}<div className="work-order-grid"><label>Assign vendor<select disabled={!canEdit("maintenance")} value={request.vendorId ?? ""} onChange={(event) => updateMaintenanceRequest(request.id, { vendorId: event.target.value || undefined })}><option value="">Select vendor</option>{maintenanceVendors.filter((vendor) => vendor.active).map((vendor) => <option value={vendor.id} key={vendor.id}>{vendor.name} · {vendor.specialty}</option>)}</select></label><label>Quote (₦)<input disabled={!canEdit("maintenance")} type="number" min="0" step="0.01" defaultValue={request.quoteAmount ?? ""} onBlur={(event) => updateMaintenanceRequest(request.id, { quoteAmount: event.target.value ? Number(event.target.value) : undefined })} /></label><label>Approval<select disabled={!canEdit("maintenance")} value={request.approvalStatus ?? "Not requested"} onChange={(event) => updateMaintenanceRequest(request.id, { approvalStatus: event.target.value as MaintenanceRequest["approvalStatus"] })}><option>Not requested</option><option>Pending</option><option>Approved</option><option>Declined</option></select></label><label>Approved amount (₦)<input disabled={!canEdit("maintenance")} type="number" min="0" step="0.01" defaultValue={request.approvedAmount ?? ""} onBlur={(event) => updateMaintenanceRequest(request.id, { approvedAmount: event.target.value ? Number(event.target.value) : undefined })} /></label><label>Actual cost (₦)<input disabled={!canEdit("maintenance")} type="number" min="0" step="0.01" defaultValue={request.actualCost ?? ""} onBlur={(event) => updateMaintenanceRequest(request.id, { actualCost: event.target.value ? Number(event.target.value) : undefined })} /></label><label>Target date<input disabled={!canEdit("maintenance")} type="date" value={request.workOrderDueDate ?? ""} onChange={(event) => updateMaintenanceRequest(request.id, { workOrderDueDate: event.target.value })} /></label><label className="work-order-notes">Work order notes<textarea disabled={!canEdit("maintenance")} rows={2} defaultValue={request.workOrderNotes ?? ""} placeholder="Scope, instructions, or completion notes" onBlur={(event) => updateMaintenanceRequest(request.id, { workOrderNotes: event.target.value })} /></label></div>{assignedVendor && <div className="panel-footer">Assigned to {assignedVendor.name} ({assignedVendor.phone}). Save changes automatically.</div>}</article>;
                })}</div> : <div className="properties-empty"><strong>No maintenance requests yet</strong><p>Resident repair reports will appear here for review.</p></div>}<div className="panel-footer">Request updates and work order details are saved to the organization’s database.</div></section>
              </>
            )
          ) : currentPage === "agent_fees" ? (
            <>
              <div className="welcome-row"><div><p className="eyebrow">AGENT COMPENSATION</p><h1>Agent fees</h1><p className="subtitle">Fees recorded on Inspections &amp; Handover appear here automatically.</p></div><button className="primary-button" type="button" disabled={!properties.length} onClick={() => { setCurrentPage("inspections"); openInspectionForm(); }}>+ Record from inspection</button></div>
              {agentFeeMessage && <div className={agentFeeMessage === "Agent fee marked as received." ? "reminder-notice" : "form-error"} role="status">{agentFeeMessage}</div>}
              <div className="stats-grid payment-summary-grid"><article className="stat-card"><div className="stat-top"><span>Agent fees recorded</span></div><div className="stat-value">{agentFeePayments.length}</div><div className="stat-detail">Linked to inspections and handovers</div></article><article className="stat-card"><div className="stat-top"><span>Received</span></div><div className="stat-value">₦{confirmedAgentFees.toLocaleString("en-NG")}</div><div className="stat-detail">Confirmed agent fees</div></article><article className="stat-card"><div className="stat-top"><span>Awaiting receipt</span></div><div className="stat-value">₦{pendingAgentFees.toLocaleString("en-NG")}</div><div className="stat-detail">Mark received when collected</div></article></div>
              <section className="panel properties-page-panel"><div className="panel-header properties-page-header"><div><h2>Agent fee records</h2><p>Fee amount, property, linked inspection, and collection status</p></div><input className="property-search" type="search" placeholder="Search property, unit, or status" value={agentFeeSearch} onChange={(event) => setAgentFeeSearch(event.target.value)} aria-label="Search agent fees" /></div>{filteredAgentFeePayments.length ? <div className="table-wrap"><table><thead><tr><th>DATE</th><th>PROPERTY / UNIT</th><th>INSPECTION</th><th>FEE</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>{filteredAgentFeePayments.map((payment) => { const property = properties.find((item) => item.id === getPaymentPropertyId(payment)); const inspection = inspections.find((item) => item.id === payment.sourceRecordId); return <tr key={payment.id}><td>{formatDate(payment.paymentDate)}<br /><small>{getPaymentReference(payment)}</small></td><td><strong>{property?.name ?? "Property unavailable"}</strong>{inspection?.unitLabel && <><br /><small>{inspection.unitLabel}</small></>}</td><td>{inspection ? `${inspection.kind} · ${formatDate(inspection.inspectionDate)}` : payment.rentPeriod || "Inspection record"}</td><td className="amount">₦{payment.amount.toLocaleString("en-NG")}</td><td><span className={`status ${payment.status === "Paid" ? "paid" : payment.status === "Rejected" ? "overdue" : "pending"}`}>{payment.status ?? "Pending"}</span></td><td>{payment.status === "Pending" && canEdit("agent_fees") ? <button className="row-modify" type="button" onClick={() => void confirmAgentFee(payment)}>Mark received</button> : "—"}</td></tr>; })}</tbody></table></div> : <div className="properties-empty"><strong>{agentFeePayments.length ? "No matching agent fees" : "No agent fees recorded yet"}</strong><p>{agentFeePayments.length ? "Try a different search." : "Enter an agent fee on an inspection or handover to create a fee record here."}</p>{!agentFeePayments.length && properties.length > 0 && <button className="secondary-button" type="button" onClick={() => { setCurrentPage("inspections"); openInspectionForm(); }}>Create an inspection</button>}</div>}<div className="panel-footer">Agent fees are recorded from inspection forms and stored in your authorized workspace.</div></section>
            </>
          ) : currentPage === "payments" ? (
            <>
              <div className="welcome-row">
                <div>
                  <p className="eyebrow">RENT MANAGEMENT</p>
                  <h1>Rent &amp; Payments</h1>
                  <p className="subtitle">Record rent received and review your payment history.</p>
                </div>
                {canEdit("payments") && <button className="primary-button" onClick={openPaymentForm} disabled={tenants.length === 0 && !standaloneEstateAgent}>+ Record payment</button>}
              </div>
              <div className="stats-grid payment-summary-grid">
                <article className="stat-card"><div className="stat-top"><span>Confirmed received</span></div><div className="stat-value">₦{totalRentCollected.toLocaleString("en-NG")}</div><div className="stat-detail">{rentPayments.filter(isConfirmedPayment).length} confirmed transactions</div></article>
                <article className="stat-card"><div className="stat-top"><span>Pending confirmation</span></div><div className="stat-value">₦{pendingPaymentTotal.toLocaleString("en-NG")}</div><div className="stat-detail">{rentPayments.filter(isAwaitingPaymentConfirmation).length} pending or unreviewed transactions</div></article>
                <article className="stat-card expense-stat"><div className="stat-top"><span>Rejected</span></div><div className="stat-value">₦{rejectedPaymentTotal.toLocaleString("en-NG")}</div><div className="stat-detail">{rentPayments.filter((payment) => payment.status === "Rejected").length} rejected transactions; excluded from received</div></article>
                <article className="stat-card"><div className="stat-top"><span>All transactions</span></div><div className="stat-value">{rentPayments.length}</div><div className="stat-detail">Every status appears in Payment History</div></article>
              </div>
              <section className="panel properties-page-panel">
                <div className="panel-header properties-page-header">
                  <div><h2>Payment history</h2><p>Recorded rent payments</p></div>
                  <input className="property-search" type="search" placeholder="Search ref, tenant, property, or status" value={paymentSearch} onChange={(event) => setPaymentSearch(event.target.value)} aria-label="Search payments by reference, tenant, property, method, period, or status" />
                </div>
                <div className="reminder-notice"><strong>Payment status guide:</strong> Paid means funds were confirmed; Pending is awaiting confirmation; Rejected was declined. Legacy records without a status are marked Needs review and excluded from confirmed received until you verify them.</div>
                {filteredPayments.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>TENANT / PROPERTY / REFERENCE</th><th>TRANSACTION TYPE</th><th>RENT PERIOD</th><th>AMOUNT</th><th>PAYMENT DATE</th><th>METHOD</th><th>STATUS</th><th>RECEIPT</th><th>ACTION</th></tr></thead>
                      <tbody>
                        {filteredPayments.map((payment) => {
                          const tenant = tenants.find((item) => item.id === payment.tenantId);
                          const property = properties.find((item) => item.id === getPaymentPropertyId(payment));
                          return <tr key={payment.id}><td><strong>{tenant?.name ?? payment.tenantName ?? "Property fee"}</strong><br />{property?.name ?? "Property unavailable"}<br /><small>Ref: {getPaymentReference(payment)}</small></td><td>{payment.transactionType ?? "Rent payment"}</td><td>{payment.rentPeriod || "—"}</td><td className="amount">₦{payment.amount.toLocaleString("en-NG")}</td><td>{formatDate(payment.paymentDate)}{payment.recordedAt && <><br /><small>Entered {formatDate(payment.recordedAt.slice(0, 10))}</small></>}</td><td>{payment.method}</td><td><span className={"status " + (payment.status === "Paid" ? "paid" : payment.status === "Rejected" ? "overdue" : "pending")}>{paymentStatusLabel(payment)}</span></td><td><div className="payment-receipt-actions">{(payment.tenantId || payment.tenantName) && isConfirmedPayment(payment) && <button className="row-modify" type="button" onClick={() => printPaymentReceipt(payment, tenant, property)}>Receipt PDF</button>}{payment.receiptName && <button className="row-modify" type="button" onClick={() => downloadPaymentReceipt(payment)}>Proof</button>}{payment.status === "Pending" && !payment.receiptName && <span className="receipt-pending-note">After confirmation</span>}</div></td><td>{canEdit("payments") && <button className="row-modify" type="button" onClick={() => openPaymentEdit(payment)}>{payment.status === "Paid" || payment.status === "Rejected" ? "Modify" : "Confirm"}</button>}</td></tr>;
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="properties-empty"><span className="property-symbol">₦</span><strong>{rentPayments.length ? "No matching payments" : "No payments recorded yet"}</strong><p>{rentPayments.length ? "Try another search." : "Record a payment to start your rent history."}</p>{!rentPayments.length && canEdit("payments") && (tenants.length > 0 || standaloneEstateAgent) && <button className="primary-button" onClick={openPaymentForm}>+ Record payment</button>}{!tenants.length && !standaloneEstateAgent && <button className="secondary-button" onClick={() => setCurrentPage("tenants")}>Add a tenant first</button>}</div>
                )}
                <div className="panel-footer">{filteredPayments.length} of {rentPayments.length} transactions shown · confirmed, pending, and rejected records are retained in the organization’s payment history</div>
              </section>
              <footer className="page-footer"><span>© 2026 RentWise NG</span><span>Built for property management in Nigeria</span></footer>
            </>
          ) : currentPage === "expenses" ? (
            <>
              <div className="welcome-row expenses-heading">
                <div><p className="eyebrow">PROPERTY COSTS</p><h1>Expenses</h1><p className="subtitle">Track costs against the properties you manage.</p></div>
                {canEdit("expenses") && <button className="primary-button" onClick={openExpenseForm} disabled={properties.length === 0}>+ Add expense</button>}
              </div>
              <div className="stats-grid payment-summary-grid expense-summary-grid">
                <article className="stat-card expense-stat"><div className="stat-top"><span>Total expenses recorded</span></div><div className="stat-value">₦{totalExpenses.toLocaleString("en-NG")}</div><div className="stat-detail">Across {expenses.length} {expenses.length === 1 ? "expense" : "expenses"}</div></article>
                <article className="stat-card expense-stat"><div className="stat-top"><span>Expense records</span></div><div className="stat-value">{expenses.length}</div><div className="stat-detail">Saved in this browser</div></article>
              </div>
              <section className="panel properties-page-panel expense-history-panel">
                <div className="panel-header properties-page-header">
                  <div><h2>Expense history</h2><p>Recorded property costs</p></div>
                  <input className="property-search" type="search" placeholder="Search property or category" value={expenseSearch} onChange={(event) => setExpenseSearch(event.target.value)} aria-label="Search expenses by property or category" />
                </div>
                {expenses.filter((expense) => {
                  const property = properties.find((item) => item.id === expense.propertyId);
                  return `${property?.name ?? ""} ${expense.category} ${expense.paidTo} ${expense.description}`.toLowerCase().includes(expenseSearch.toLowerCase());
                }).length ? (
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>PROPERTY</th><th className="expense-column">CATEGORY / DETAILS</th><th>DATE</th><th className="expense-column">AMOUNT</th><th>ACTION</th></tr></thead>
                      <tbody>
                        {expenses.filter((expense) => {
                          const property = properties.find((item) => item.id === expense.propertyId);
                          return `${property?.name ?? ""} ${expense.category} ${expense.paidTo} ${expense.description}`.toLowerCase().includes(expenseSearch.toLowerCase());
                        }).map((expense) => {
                          const property = properties.find((item) => item.id === expense.propertyId);
                          return <tr key={expense.id}><td><strong>{property?.name ?? "Property unavailable"}</strong></td><td><span className="expense-category">{expense.category}</span>{expense.sourceMaintenanceRequestId && <><br /><small>From resolved work order</small></>}<br /><small>{expense.description || expense.paidTo || "—"}</small></td><td>{formatDate(expense.expenseDate)}</td><td className="amount expense-amount">₦{expense.amount.toLocaleString("en-NG")}</td><td>{expense.sourceMaintenanceRequestId ? <small>Managed by work order</small> : canEdit("expenses") && <button className="row-modify" type="button" onClick={() => openExpenseEdit(expense)}>Modify</button>}</td></tr>;
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="properties-empty expenses-empty"><span className="property-symbol">↗</span><strong>{expenses.length ? "No matching expenses" : "No expenses recorded yet"}</strong><p>{expenses.length ? "Try another search." : properties.length ? "Add an expense to start tracking property costs." : "Add a property before recording an expense."}</p>{!expenses.length && properties.length > 0 && canEdit("expenses") && <button className="primary-button" onClick={openExpenseForm}>+ Add expense</button>}{!properties.length && <button className="secondary-button" onClick={() => setCurrentPage("properties")}>Go to properties</button>}</div>
                )}
                <div className="panel-footer">Expense records are saved in this browser</div>
              </section>
              <footer className="page-footer"><span>© 2026 RentWise NG</span><span>Built for property management in Nigeria</span></footer>
            </>
          ) : currentPage === "reports" ? (
            <>
              <div className="welcome-row reports-heading">
                <div><p className="eyebrow">{currentRole === "estate_agent" ? "AGENT OPERATIONS" : currentRole === "property_manager" ? "PROPERTY OPERATIONS" : currentRole === "platform_admin" ? "READ-ONLY PORTFOLIO VIEW" : "BUSINESS OVERVIEW"}</p><h1>Reports</h1><p className="subtitle">Role-appropriate portfolio, tenancy, and operating reports from RentWise records.</p><p className="report-period-print">Period: {reportPeriod === "all" ? "All time" : reportPeriod === "month" ? "This month" : "This year"}</p></div>
                <div className="report-actions">
                  <label className="report-period-label">Reporting period<select className="report-period" value={reportPeriod} onChange={(event) => setReportPeriod(event.target.value as "all" | "month" | "year")}><option value="all">All time</option><option value="month">This month</option><option value="year">This year</option></select></label>
                  <label className="report-period-label">Property<select className="report-period" value={reportPropertyFilter} onChange={(event) => setReportPropertyFilter(event.target.value)}><option value="all">All properties</option>{properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}</select></label>
                  <button className="secondary-button" type="button" onClick={() => window.print()}>Download PDF</button>
                  <button className="primary-button" type="button" onClick={downloadReportExcel}>Download Excel</button>
                </div>
              </div>
              <div className="stats-grid report-summary-grid">
                {currentRole === "estate_agent" && <><article className="stat-card"><div className="stat-top"><span>Agent fees received</span></div><div className="stat-value">₦{reportAgentFeeTotal.toLocaleString("en-NG")}</div><div className="stat-detail">{reportAgentFeePayments.length} confirmed agent fees</div></article><article className="stat-card expense-stat"><div className="stat-top"><span>Expenses</span></div><div className="stat-value">₦{reportExpenseTotal.toLocaleString("en-NG")}</div><div className="stat-detail">{reportExpenses.length} recorded expenses</div></article></>}
                {canViewFinancialReports && <><article className="stat-card"><div className="stat-top"><span>Rent received</span></div><div className="stat-value">₦{reportRentTotal.toLocaleString("en-NG")}</div><div className="stat-detail">{reportRentPayments.length} confirmed rent transactions</div></article>
                <article className="stat-card"><div className="stat-top"><span>Service fees</span></div><div className="stat-value">₦{reportServiceFeeTotal.toLocaleString("en-NG")}</div><div className="stat-detail">Inspection and agent fees</div></article>
                <article className="stat-card"><div className="stat-top"><span>Caution deposits</span></div><div className="stat-value">₦{reportCautionTotal.toLocaleString("en-NG")}</div><div className="stat-detail">Excluded from rental income</div></article>
                <article className="stat-card expense-stat"><div className="stat-top"><span>Expenses</span></div><div className="stat-value">₦{reportExpenseTotal.toLocaleString("en-NG")}</div><div className="stat-detail">{reportExpenses.length} recorded expenses</div></article>
                <article className="stat-card"><div className="stat-top"><span>Net operating result</span></div><div className="stat-value">₦{(reportRentTotal + reportServiceFeeTotal - reportExpenseTotal).toLocaleString("en-NG")}</div><div className="stat-detail">Rent and service fees minus recorded expenses</div></article></>}
                <article className="stat-card"><div className="stat-top"><span>Tenant records / units</span></div><div className="stat-value">{properties.filter((property) => reportPropertyFilter === "all" || property.id === reportPropertyFilter).reduce((count, property) => count + Math.min(getOccupiedUnits(property.id), property.units), 0)} / {properties.filter((property) => reportPropertyFilter === "all" || property.id === reportPropertyFilter).reduce((count, property) => count + property.units, 0)}</div><div className="stat-detail">Approximate occupancy from tenant-property links</div></article>
                {currentRole !== "estate_agent" && <article className="stat-card"><div className="stat-top"><span>Leases ending soon</span></div><div className="stat-value">{leaseExpiryRows.length}</div><div className="stat-detail">Within the next 90 days</div></article>}
              </div>
              {canViewFinancialReports && <section className="panel properties-page-panel">
                <div className="panel-header"><div><h2>Property financial performance</h2><p>Rent and service fees, deposits held, expenses, and net operating result</p></div></div>
                {propertyReportRows.length ? (
                  <div className="table-wrap"><table>
                    <thead><tr><th>PROPERTY</th><th>TENANTS / UNITS</th><th>RENT</th><th>SERVICE FEES</th><th>CAUTION RECEIVED</th><th>EXPENSES</th><th>OPERATING RESULT</th></tr></thead>
                    <tbody>{propertyReportRows.map((row) => <tr key={row.property.id}><td><strong>{row.property.name}</strong><br /><small>{row.property.city}, {row.property.state}</small></td><td>{Math.min(row.occupied, row.property.units)} / {row.property.units}<br /><small>{row.available} available by count</small></td><td className="amount">₦{row.rentReceived.toLocaleString("en-NG")}</td><td className="amount">₦{row.serviceFees.toLocaleString("en-NG")}</td><td className="amount">₦{row.cautionFees.toLocaleString("en-NG")}</td><td className="amount expense-amount">₦{row.costs.toLocaleString("en-NG")}</td><td className="amount">₦{row.net.toLocaleString("en-NG")}</td></tr>)}</tbody>
                  </table></div>
                ) : <div className="properties-empty"><span className="property-symbol">▤</span><strong>No property data yet</strong><p>Add a property to see occupancy and financial summaries here.</p>{canEdit("properties") && <button className="primary-button" onClick={openPropertyForm}>+ Add property</button>}</div>}
                <div className="panel-footer">Caution fees are excluded from rent and operating result. Occupancy is estimated from tenant-property links; individual units are not yet linked to tenants.</div>
              </section>}
              {currentRole !== "estate_agent" && <section className="panel properties-page-panel report-tenants-panel">
                <div className="panel-header"><div><h2>Tenant rent roll</h2><p>Current lease terms, including the latest active lease where available</p></div></div>
                {tenantReportRows.length ? (
                  <div className="table-wrap"><table>
                    <thead><tr><th>TENANT</th><th>PROPERTY</th><th>PAYMENT LENGTH</th><th>RENT AMOUNT</th><th>LEASE REFERENCE</th><th>START DATE</th><th>EXPIRATION DATE</th></tr></thead>
                    <tbody>{tenantReportRows.map(({ tenant, property, lease, paymentFrequency, rentAmount, startDate, expirationDate }) => <tr key={tenant.id}><td><strong>{tenant.name}</strong></td><td>{property?.name ?? "Property unavailable"}</td><td>{paymentFrequencyLabel(paymentFrequency)}</td><td className="amount">₦{rentAmount.toLocaleString("en-NG")}</td><td>{lease?.reference ?? "Tenant record"}</td><td>{formatDate(startDate)}</td><td>{formatDate(expirationDate)}</td></tr>)}</tbody>
                  </table></div>
                ) : <div className="properties-empty"><strong>No tenants registered yet</strong><p>Tenant payment length and expiration dates will appear here.</p></div>}
                <div className="panel-footer">Property and lease information reflects the selected property filter.</div>
              </section>}
              {currentRole !== "estate_agent" && <section className="panel properties-page-panel report-tenants-panel"><div className="panel-header"><div><h2>Lease expirations and renewals</h2><p>Active tenancies expiring within the next 90 days</p></div></div>
                {leaseExpiryRows.length ? <div className="table-wrap"><table><thead><tr><th>TENANT</th><th>PROPERTY</th><th>LEASE</th><th>RENT</th><th>EXPIRATION</th><th>RENEWAL REQUEST</th></tr></thead><tbody>{leaseExpiryRows.map(({ tenant, property, lease, rentAmount, expirationDate }) => <tr key={tenant.id}><td><strong>{tenant.name}</strong></td><td>{property?.name ?? "Property unavailable"}</td><td>{lease?.reference ?? "Tenant record"}</td><td className="amount">₦{rentAmount.toLocaleString("en-NG")}</td><td>{formatDate(expirationDate)}</td><td>{renewalRequests.filter((request) => request.tenantId === tenant.id).sort((left, right) => right.submittedDate.localeCompare(left.submittedDate))[0]?.status ?? "Not submitted"}</td></tr>)}</tbody></table></div> : <div className="properties-empty"><strong>No lease expirations in the next 90 days</strong></div>}
              </section>}
              {canViewFinancialReports && <>
                <section className="panel properties-page-panel report-tenants-panel"><div className="panel-header"><div><h2>Arrears and aging</h2><p>Current unpaid rent; confirmed rent is applied to oldest due periods</p></div></div>
                  <div className="report-aging-grid">{arrearsAging.map((bucket) => <article className="report-aging-card" key={bucket.label}><span>{bucket.label}</span><strong>₦{bucket.amount.toLocaleString("en-NG")}</strong><small>{bucket.count} tenant{bucket.count === 1 ? "" : "s"}</small></article>)}</div>
                  {arrearsReportRows.length ? <div className="table-wrap"><table><thead><tr><th>TENANT</th><th>PROPERTY</th><th>RENT TERM</th><th>OUTSTANDING</th><th>DAYS OVERDUE</th><th>STATUS</th></tr></thead><tbody>{arrearsReportRows.map((row) => <tr key={row.tenant.id}><td><strong>{row.tenant.name}</strong></td><td>{row.property?.name ?? "Property unavailable"}</td><td>₦{row.rentAmount.toLocaleString("en-NG")} / {paymentFrequencyLabel(row.frequency)}</td><td className="amount">₦{row.balance.toLocaleString("en-NG")}</td><td>{row.daysOverdue}</td><td>{row.status}</td></tr>)}</tbody></table></div> : <div className="properties-empty"><strong>No rent balances are outstanding</strong><p>Pending payments are not counted as confirmed collections.</p></div>}
                </section>
                <section className="panel properties-page-panel report-tenants-panel"><div className="panel-header"><div><h2>Payment transaction report</h2><p>Confirmed records for the selected period; pending and rejected payments are excluded from received totals</p></div></div>
                  {reportPayments.length ? <div className="table-wrap"><table><thead><tr><th>DATE / REFERENCE</th><th>TENANT</th><th>PROPERTY</th><th>TRANSACTION</th><th>METHOD / PERIOD</th><th>AMOUNT</th></tr></thead><tbody>{reportPayments.map((payment) => <tr key={payment.id}><td>{formatDate(payment.paymentDate)}<br /><small>{getPaymentReference(payment)}</small></td><td>{tenants.find((tenant) => tenant.id === payment.tenantId)?.name ?? payment.tenantName ?? "Property fee"}</td><td>{properties.find((property) => property.id === getPaymentPropertyId(payment))?.name ?? "Property unavailable"}</td><td>{payment.transactionType ?? "Rent payment"}</td><td>{payment.method}<br /><small>{payment.rentPeriod}</small></td><td className="amount">₦{payment.amount.toLocaleString("en-NG")}</td></tr>)}</tbody></table></div> : <div className="properties-empty"><strong>No confirmed transactions for this period</strong><p>Try another reporting period or property.</p></div>}
                </section>
                <section className="panel properties-page-panel report-tenants-panel"><div className="panel-header"><div><h2>Expense report</h2><p>Recorded costs by property, category, payee, and date</p></div></div>
                  {reportExpenses.length ? <div className="table-wrap"><table><thead><tr><th>DATE</th><th>PROPERTY</th><th>CATEGORY</th><th>PAID TO</th><th>DESCRIPTION</th><th>AMOUNT</th></tr></thead><tbody>{reportExpenses.map((expense) => <tr key={expense.id}><td>{formatDate(expense.expenseDate)}</td><td>{properties.find((property) => property.id === expense.propertyId)?.name ?? "Property unavailable"}</td><td>{expense.category}</td><td>{expense.paidTo}</td><td>{expense.description}</td><td className="amount expense-amount">₦{expense.amount.toLocaleString("en-NG")}</td></tr>)}</tbody></table></div> : <div className="properties-empty"><strong>No expenses recorded for this period</strong></div>}
                </section>
              </>}
              {currentRole === "estate_agent" && <>
                <section className="panel properties-page-panel report-tenants-panel"><div className="panel-header"><div><h2>Agent fee report</h2><p>Confirmed agent fees for the selected period</p></div></div>{reportAgentFeePayments.length ? <div className="table-wrap"><table><thead><tr><th>DATE / REFERENCE</th><th>PROPERTY</th><th>AMOUNT</th></tr></thead><tbody>{reportAgentFeePayments.map((payment) => <tr key={payment.id}><td>{formatDate(payment.paymentDate)}<br /><small>{getPaymentReference(payment)}</small></td><td>{properties.find((property) => property.id === getPaymentPropertyId(payment))?.name ?? "Property unavailable"}</td><td className="amount">₦{payment.amount.toLocaleString("en-NG")}</td></tr>)}</tbody></table></div> : <div className="properties-empty"><strong>No confirmed agent fees for this period</strong></div>}</section>
                <section className="panel properties-page-panel report-tenants-panel"><div className="panel-header"><div><h2>Expense report</h2><p>Recorded costs by property, category, payee, and date</p></div></div>{reportExpenses.length ? <div className="table-wrap"><table><thead><tr><th>DATE</th><th>PROPERTY</th><th>CATEGORY</th><th>PAID TO</th><th>DESCRIPTION</th><th>AMOUNT</th></tr></thead><tbody>{reportExpenses.map((expense) => <tr key={expense.id}><td>{formatDate(expense.expenseDate)}</td><td>{properties.find((property) => property.id === expense.propertyId)?.name ?? "Property unavailable"}</td><td>{expense.category}</td><td>{expense.paidTo}</td><td>{expense.description}</td><td className="amount expense-amount">₦{expense.amount.toLocaleString("en-NG")}</td></tr>)}</tbody></table></div> : <div className="properties-empty"><strong>No expenses recorded for this period</strong></div>}</section>
                <section className="panel properties-page-panel report-tenants-panel"><div className="panel-header"><div><h2>Inspections and handovers</h2><p>Inspection outcomes and fees for the selected period</p></div></div>{inspectionReportRows.length ? <div className="table-wrap"><table><thead><tr><th>DATE / TYPE</th><th>PROPERTY / UNIT</th><th>INSPECTOR</th><th>FEES</th><th>FINDINGS / HANDOVER</th></tr></thead><tbody>{inspectionReportRows.map((inspection) => <tr key={inspection.id}><td>{formatDate(inspection.inspectionDate)}<br /><small>{inspection.kind}</small></td><td>{properties.find((property) => property.id === inspection.propertyId)?.name ?? "Property unavailable"}<br /><small>{inspection.unitLabel}</small></td><td>{inspection.inspectorName}</td><td>₦{(inspection.inspectionFee ?? 0).toLocaleString("en-NG")} inspection<br />₦{(inspection.agentFee ?? 0).toLocaleString("en-NG")} agent</td><td>{inspection.observations || inspection.handoverNotes || "No notes recorded"}</td></tr>)}</tbody></table></div> : <div className="properties-empty"><strong>No inspections or handovers recorded for this period</strong></div>}</section>
              </>}
              {currentRole !== "estate_agent" && <>
                <section className="panel properties-page-panel report-tenants-panel"><div className="panel-header"><div><h2>Maintenance and work orders</h2><p>Open, in-progress, and resolved work by property and vendor</p></div></div>
                  <div className="report-operation-stats"><span>Open <strong>{maintenanceReportRows.filter((row) => row.status === "Open").length}</strong></span><span>In progress <strong>{maintenanceReportRows.filter((row) => row.status === "In Progress").length}</strong></span><span>Resolved <strong>{maintenanceReportRows.filter((row) => row.status === "Resolved").length}</strong></span></div>
                  {maintenanceReportRows.length ? <div className="table-wrap"><table><thead><tr><th>SUBMITTED / AGE</th><th>PROPERTY / TENANT</th><th>ISSUE</th><th>STATUS</th><th>VENDOR</th><th>QUOTE / APPROVED / ACTUAL</th></tr></thead><tbody>{maintenanceReportRows.map((request) => { const ageDays = /^\d{4}-\d{2}-\d{2}$/.test(request.submittedDate) ? Math.max(0, Math.floor((Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${request.submittedDate}T00:00:00Z`)) / 86_400_000)) : 0; return <tr key={request.id}><td>{formatDate(request.submittedDate)}<br /><small>{ageDays} days since submitted</small>{request.workOrderDueDate && <><br /><small>Due {formatDate(request.workOrderDueDate)}</small></>}</td><td>{properties.find((property) => property.id === request.propertyId)?.name ?? "Property unavailable"}<br /><small>{tenants.find((tenant) => tenant.id === request.tenantId)?.name ?? "Tenant unavailable"}</small></td><td><strong>{request.title}</strong><br /><small>{request.repairType} · {request.description}</small></td><td>{request.status}</td><td>{maintenanceVendors.find((vendor) => vendor.id === request.vendorId)?.name ?? "Unassigned"}</td><td>₦{(request.quoteAmount ?? 0).toLocaleString("en-NG")} / ₦{(request.approvedAmount ?? 0).toLocaleString("en-NG")} / ₦{(request.actualCost ?? 0).toLocaleString("en-NG")}</td></tr>; })}</tbody></table></div> : <div className="properties-empty"><strong>No maintenance requests recorded</strong></div>}
                </section>
                <section className="panel properties-page-panel report-tenants-panel"><div className="panel-header"><div><h2>Inspections and handovers</h2><p>Inspection outcomes, fees, and property handover activity</p></div></div>
                  {inspectionReportRows.length ? <div className="table-wrap"><table><thead><tr><th>DATE / TYPE</th><th>PROPERTY / UNIT</th><th>INSPECTOR</th><th>FEES</th><th>FINDINGS / HANDOVER</th></tr></thead><tbody>{inspectionReportRows.map((inspection) => <tr key={inspection.id}><td>{formatDate(inspection.inspectionDate)}<br /><small>{inspection.kind}</small></td><td>{properties.find((property) => property.id === inspection.propertyId)?.name ?? "Property unavailable"}<br /><small>{inspection.unitLabel}</small></td><td>{inspection.inspectorName}</td><td>₦{(inspection.inspectionFee ?? 0).toLocaleString("en-NG")} inspection<br />₦{(inspection.agentFee ?? 0).toLocaleString("en-NG")} agent</td><td>{inspection.observations || inspection.handoverNotes || "No notes recorded"}</td></tr>)}</tbody></table></div> : <div className="properties-empty"><strong>No inspections or handovers recorded</strong></div>}
                </section>
              </>}
              <div className="reminder-notice" role="note"><strong>Report scope:</strong> Caution fees are reported separately and excluded from operating income. These reports summarize RentWise records and are not reconciled financial statements. Occupancy is approximate until individual unit assignments are recorded.</div>
              <footer className="page-footer"><span>© 2026 RentWise NG</span><span>Built for property management in Nigeria</span></footer>
            </>
          ) : currentPage === "reminders" ? (
            <>
              <div className="welcome-row reports-heading">
                <div><p className="eyebrow">TENANCY MANAGEMENT</p><h1>Rent reminders</h1><p className="subtitle">Reminder timing and repeat intervals follow each tenant’s rent period.</p></div>
                <span className="reminder-schedule-badge">Schedule by rent period</span>
              </div>
              <div className="reminder-notice" role="status"><strong>Automatic reminders:</strong> RentWise posts a reminder in the tenant portal on each scheduled date. WhatsApp delivery is automatic after the tenant has consented and the WhatsApp Business Cloud API plus an approved Utility template are configured. SMS remains a prefilled draft for manual sending.</div>
              {auth.user.role === "super_admin" && <section className="panel whatsapp-integration-panel">
                <div className="panel-header"><div><h2>WhatsApp integration</h2><p>Test the Cloud API with Meta’s plain-text sample template; scheduled rent reminders use a separate Utility template. The status below checks settings are present, not whether Meta has validated the token.</p></div><span className={`status ${whatsappSetupStatus?.configured ? "paid" : "pending"}`}>{whatsappSetupStatus ? whatsappSetupStatus.configured ? "Settings entered" : "Setup required" : "Checking setup…"}</span></div>
                {whatsappSetupError && <div className="form-error whatsapp-setup-error" role="alert">{whatsappSetupError}</div>}
                {whatsappSetupStatus && <div className="whatsapp-setup-checks"><span className={whatsappSetupStatus.phoneNumberIdConfigured ? "ready" : "missing"}>Phone number ID</span><span className={whatsappSetupStatus.accessTokenConfigured ? "ready" : "missing"}>Access token</span><span className={whatsappSetupStatus.graphVersionConfigured ? "ready" : "missing"}>Graph API version</span><span className={whatsappSetupStatus.templateConfigured ? "ready" : "missing"}>Test template</span></div>}
                {whatsappSetupStatus?.templateConfigured && <p className="whatsapp-template-info">Test template: <strong>{whatsappSetupStatus.templateName}</strong> · Language: {whatsappSetupStatus.templateLanguage} · no variables</p>}
                {whatsappSetupStatus?.reminderTemplateConfigured && <p className="whatsapp-template-info">Reminder template: <strong>{whatsappSetupStatus.reminderTemplateName}</strong> · Language: {whatsappSetupStatus.reminderTemplateLanguage} · must be an approved Utility template with one body variable</p>}
                <form className="property-form whatsapp-test-form" onSubmit={(event) => void sendWhatsAppTest(event)}>
                  <label>Test recipient WhatsApp number<input type="tel" inputMode="tel" value={whatsappTestPhone} onChange={(event) => setWhatsappTestPhone(event.target.value)} placeholder="e.g. 2348031234567" required /><span className="field-hint">Include the country code, without spaces or a plus sign. For Nigeria, start with 234.</span></label>
                  <label className="whatsapp-consent-field"><span className="whatsapp-consent-control"><input type="checkbox" checked={whatsappTestConsent} onChange={(event) => setWhatsappTestConsent(event.target.checked)} required /><span><strong>I have permission to send this test to the recipient.</strong><small>Pressing the test button sends a real WhatsApp message through your configured Business account.</small></span></span></label>
                  {whatsappTestError && <p className="form-error" role="alert">{whatsappTestError}</p>}
                  {whatsappTestMessage && <div className="reminder-notice" role="status">{whatsappTestMessage}</div>}
                  <div className="form-actions"><button className="primary-button" type="submit" disabled={whatsappTestBusy || !whatsappSetupStatus?.configured}>{whatsappTestBusy ? "Sending test…" : "Send WhatsApp test"}</button></div>
                </form>
                {!whatsappSetupStatus?.configured && <div className="whatsapp-setup-guide"><strong>Complete setup in the project’s <code>.env</code> file</strong><p className="whatsapp-env-warning"><code>.env.example</code> is only a sample. RentWise does not load credentials from it.</p><code>WHATSAPP_PHONE_NUMBER_ID<br />WHATSAPP_ACCESS_TOKEN<br />WHATSAPP_GRAPH_API_VERSION<br />WHATSAPP_TEST_TEMPLATE_NAME<br />WHATSAPP_TEST_TEMPLATE_LANGUAGE<br />WHATSAPP_REMINDER_TEMPLATE_NAME<br />WHATSAPP_REMINDER_TEMPLATE_LANGUAGE</code><p>The test template may have no variables. Scheduled reminders separately require an approved Utility template with one body variable, <code>{"{{1}}"}</code>. Keep the access token in the server’s <code>.env</code>, then restart RentWise.</p></div>}
              </section>}
              <div className="stats-grid payment-summary-grid reminder-summary-grid">
                <article className="stat-card"><div className="stat-top"><span>Ready today</span></div><div className="stat-value">{readyReminderCount}</div><div className="stat-detail">First reminder or repeat date is today</div></article>
                <article className="stat-card"><div className="stat-top"><span>Scheduled next</span></div><div className="stat-value">{scheduledReminderCount}</div><div className="stat-detail">Reminder dates in the next 90 days</div></article>
                <article className="stat-card expense-stat"><div className="stat-top"><span>Expired</span></div><div className="stat-value">{overdueReminderCount}</div><div className="stat-detail">Tenancies past their saved expiration date</div></article>
              </div>
              <section className="panel properties-page-panel">
                <div className="panel-header"><div><h2>Reminder schedule</h2><p>Set a custom first reminder date per tenant or restore the rent-period schedule</p></div></div>
                <div className="reminder-filter-row" role="group" aria-label="Filter rent reminders">
                  {([ ["all", "All schedules", reminderRows.length], ["ready", "Ready today", readyReminderCount], ["scheduled", "Scheduled", scheduledReminderCount], ["overdue", "Expired", overdueReminderCount] ] as const).map(([filter, label, count]) => <button key={filter} type="button" className={`reminder-filter-chip ${reminderFilter === filter ? "active" : ""}`} aria-pressed={reminderFilter === filter} onClick={() => setReminderFilter(filter)}>{label}<span>{count}</span></button>)}
                </div>
                {filteredReminderRows.length ? (
                  <div className="reminder-list">{filteredReminderRows.map(({ tenant, property, daysUntilExpiration, reminderDate, nextReminder, daysUntilReminder, reminderRuleLabel }) => {
                    const message = reminderMessages[tenant.id] ?? ("Hello " + tenant.name + ", this is a reminder that your rent for " + (property?.name ?? "your property") + " expires on " + formatDate(tenant.expirationDate ?? "") + ". Please contact us to discuss your renewal. — RentWise NG");
                    const whatsappNumber = tenant.phone.replace(/\D/g, "").replace(/^0/, "234");
                    const smsNumber = tenant.phone.replace(/[^\d+]/g, "");
                    return (
                      <article className="reminder-card" key={tenant.id}>
                        <div className="reminder-card-heading">
                          <div><strong>{tenant.name}</strong><span>{property?.name ?? "Property unavailable"} · {tenant.phone}</span></div>
                          <span className={"status " + (daysUntilExpiration < 0 ? "overdue" : nextReminder === todayKey ? "paid" : "pending")}>{daysUntilExpiration < 0 ? Math.abs(daysUntilExpiration) + " days expired" : nextReminder === todayKey ? "Reminder due today" : "Reminder scheduled"}</span>
                        </div>
                        <div className="reminder-card-dates"><span>Rent period: <strong>{paymentFrequencyLabel(tenant.paymentFrequency ?? "Monthly")}</strong></span><span>Repeat: <strong>{reminderRuleLabel.split("·").pop()?.trim()}</strong></span><span>First reminder: <strong>{daysUntilReminder > 0 ? `In ${daysUntilReminder} days · ${formatDate(reminderDate)}` : formatDate(reminderDate)}</strong></span><span>Next reminder: <strong>{nextReminder ? nextReminder === todayKey ? "Due today" : formatDate(nextReminder) : "No follow-up after expiration"}</strong></span><span>Expiration date: <strong>{formatDate(tenant.expirationDate ?? "")}</strong></span></div>
                        {canEdit("tenants") && <div className="reminder-date-control"><label>First reminder date<input type="date" min={todayKey} max={tenant.expirationDate} value={reminderDateDrafts[tenant.id] ?? reminderDate} onChange={(event) => { setReminderDateDrafts((current) => ({ ...current, [tenant.id]: event.target.value })); setReminderScheduleFeedback((current) => ({ ...current, [tenant.id]: {} })); }} /></label><button className="row-modify" type="button" disabled={reminderScheduleSaving[tenant.id]} onClick={() => void saveReminderScheduleDate(tenant.id)}>{reminderScheduleSaving[tenant.id] ? "Saving…" : "Save date"}</button>{tenant.reminderDateOverride && <button className="row-modify" type="button" disabled={reminderScheduleSaving[tenant.id]} onClick={() => void saveReminderScheduleDate(tenant.id, true)}>Use automatic date</button>}{reminderScheduleFeedback[tenant.id]?.error && <span className="form-error" role="alert">{reminderScheduleFeedback[tenant.id]?.error}</span>}{reminderScheduleFeedback[tenant.id]?.message && <span className="reminder-date-saved" role="status">{reminderScheduleFeedback[tenant.id]?.message}</span>}</div>}
                        <label className="reminder-message-label">Message to tenant<textarea rows={4} value={message} readOnly={!canEdit("tenants")} onChange={(event) => setReminderMessages((current) => ({ ...current, [tenant.id]: event.target.value }))} /></label>
                        <div className="reminder-card-actions">
                          <a className="secondary-button" href={"https://wa.me/" + whatsappNumber + "?text=" + encodeURIComponent(message)} target="_blank" rel="noreferrer">Open WhatsApp draft</a>
                          <a className="secondary-button" href={"sms:" + smsNumber + "?body=" + encodeURIComponent(message)}>Open SMS draft</a>
                          {canEdit("tenants") && <button className="row-modify" type="button" onClick={() => openTenantEdit(tenant)}>Modify tenant</button>}
                        </div>
                      </article>
                    );
                  })}</div>
                ) : (
                  <div className="properties-empty"><span className="property-symbol">◷</span><strong>{reminderRows.length ? "No reminders match this filter" : "No reminders scheduled in the next 90 days"}</strong><p>{tenants.some((tenant) => tenant.expirationDate) ? "The schedule will update automatically as expiration dates approach." : "Add an expiration date to a tenant record to see reminders here."}</p>{tenants.length > 0 && !tenants.some((tenant) => tenant.expirationDate) && <button className="secondary-button" onClick={() => setCurrentPage("tenants")}>Go to tenants</button>}</div>
                )}
                <div className="panel-footer">Upcoming schedule includes the next 90 days. Portal reminders are generated automatically. WhatsApp messages require tenant consent and active Meta credentials; SMS opens a prefilled draft.</div>
              </section>
              <footer className="page-footer"><span>© 2026 RentWise NG</span><span>Built for property management in Nigeria</span></footer>
            </>
          ) : currentPage === "resident" ? (
            <>
              <div className="welcome-row"><div><p className="eyebrow">SELF-SERVICE</p><h1>Resident portal</h1><p className="subtitle">Review a tenant’s lease and payment history.</p></div>{auth.user.role !== "resident_tenant" && <label className="role-switcher"><span>Preview tenant</span><select value={residentTenantId} onChange={(event) => { setResidentTenantId(event.target.value); setResidentRenewalMessage(""); setResidentPaymentMethod(""); setResidentPaymentCompleted(false); }}>{tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</select></label>}</div>
              <div className="reminder-notice">{auth.user.role === "resident_tenant" ? "Your saved rent reminders and tenancy information are shown here." : "Tenant selection is a local preview only. Sign in as a Resident / Tenant to view that tenant’s private notifications."}</div>
              {auth.user.role === "resident_tenant" && <>{residentReminderError && <div className="form-error resident-reminder-error" role="alert">{residentReminderError}</div>}<ResidentReminderPanel notifications={residentReminderNotifications} onMarkRead={(id) => void markResidentReminderRead(id)} /></>}
              {(() => {
                const tenant = tenants.find((item) => item.id === residentTenantId);
                const property = properties.find((item) => item.id === tenant?.propertyId);
                const tenantLeases = leases.filter((lease) => lease.tenantId === residentTenantId);
                const tenantPayments = rentPayments.filter((payment) => payment.tenantId === residentTenantId);
                const residentRentReceived = tenantPayments.filter((payment) => payment.status !== "Pending" && payment.status !== "Rejected" && !["Caution fee", "Inspection fee", "Agent fee"].includes(payment.transactionType ?? "")).reduce((sum, payment) => sum + payment.amount, 0);
                const residentCautionFees = tenantPayments.filter((payment) => payment.transactionType === "Caution fee" && payment.status !== "Pending" && payment.status !== "Rejected").reduce((sum, payment) => sum + payment.amount, 0);
                const residentPendingTotal = tenantPayments.filter(isAwaitingPaymentConfirmation).reduce((sum, payment) => sum + payment.amount, 0);
                const tenantRenewalRequests = renewalRequests.filter((request) => request.tenantId === tenant?.id).sort((left, right) => right.submittedDate.localeCompare(left.submittedDate));
                const hasPendingRenewal = tenantRenewalRequests.some((request) => request.status === "Pending");
                return tenant ? <><div className="resident-profile-photos">{profilePhotoUrls[`tenant-${tenant.id}`] ? <img className="tenant-profile-photo" src={profilePhotoUrls[`tenant-${tenant.id}`]} alt={`${tenant.name} profile`} /> : null}{profilePhotoUrls[`property-${tenant.propertyId}`] ? <img className="property-profile-photo" src={profilePhotoUrls[`property-${tenant.propertyId}`]} alt={`${property?.name ?? "Property"} profile`} /> : null}<strong>{tenant.name}</strong></div><div className="stats-grid payment-summary-grid"><article className="stat-card"><div className="stat-top"><span>Property</span></div><div className="stat-value">{property?.name ?? "—"}</div><div className="stat-detail">{property?.address ?? "Property address unavailable"}</div></article><article className="stat-card"><div className="stat-top"><span>Rent</span></div><div className="stat-value">₦{tenant.monthlyRent.toLocaleString("en-NG")}</div><div className="stat-detail">{paymentFrequencyLabel(tenant.paymentFrequency ?? "Monthly")}</div></article><article className="stat-card"><div className="stat-top"><span>Rental period</span></div><div className="stat-value">{formatDate(tenant.rentedDate ?? tenant.moveInDate ?? "")}</div><div className="stat-detail">Expires {formatDate(tenant.expirationDate ?? "")}</div></article></div><section className="panel properties-page-panel report-tenants-panel"><div className="panel-header"><div><h2>Your account statement</h2><p>Confirmed rent, caution deposits, and payments awaiting landlord review</p></div></div><div className="stats-grid payment-summary-grid"><article className="stat-card"><div className="stat-top"><span>Rent paid</span></div><div className="stat-value">₦{residentRentReceived.toLocaleString("en-NG")}</div></article><article className="stat-card"><div className="stat-top"><span>Caution deposit paid</span></div><div className="stat-value">₦{residentCautionFees.toLocaleString("en-NG")}</div></article><article className="stat-card"><div className="stat-top"><span>Pending confirmation</span></div><div className="stat-value">₦{residentPendingTotal.toLocaleString("en-NG")}</div></article></div><div className="panel-footer">The transaction table below is your full payment statement. Pending payments are not counted as confirmed.</div></section><section className="panel landlord-details-panel"><div className="panel-header"><div><h2>Landlord details</h2><p>Contact and payment information for the owner linked to your code.</p></div></div><div className="tenant-kyc-summary-grid"><div><strong>Landlord / organization</strong><span>{bankTransferDetails.landlordName || landlordProfile?.name || bankTransferDetails.accountName || "Not provided"}</span><span>{landlordProfile?.email || "Email not provided"}</span><span>{bankTransferDetails.landlordPhone || "Phone not provided"}</span></div><div><strong>Address &amp; payment</strong><span>{bankTransferDetails.landlordAddress || "Address not provided"}</span><span>{bankTransferDetails.bankName || "Bank not provided"}</span><span>{bankTransferDetails.accountName || "Account name not provided"}{bankTransferDetails.accountNumber ? ` · ${bankTransferDetails.accountNumber}` : ""}</span></div></div></section><section className="panel"><div className="panel-header"><div><h2>Lease agreements</h2><p>Your saved lease records</p></div></div><div className="table-wrap"><table><thead><tr><th>REFERENCE</th><th>PERIOD</th><th>RENT</th><th>STATUS</th><th>DOCUMENT</th></tr></thead><tbody>{tenantLeases.map((lease) => <tr key={lease.id}><td>{lease.reference}</td><td>{formatDate(lease.startDate)} – {formatDate(lease.expirationDate)}</td><td>₦{lease.rentAmount.toLocaleString("en-NG")} / {paymentFrequencyLabel(lease.paymentFrequency)}</td><td>{lease.status}</td><td><div className="lease-document-actions">{lease.generatedDocumentId && <button className="row-modify" type="button" onClick={() => void downloadGeneratedLeaseDocument(lease)}>Completed agreement</button>}{lease.documentName && <div className="resident-shared-document"><small>Landlord upload: {lease.documentName}</small><button className="row-modify" type="button" aria-label={`Download landlord-uploaded lease copy ${lease.documentName}`} onClick={() => void downloadLeaseDocument(lease)}>Download copy</button></div>}{!lease.generatedDocumentId && !lease.documentName && <small>Not shared yet</small>}</div></td></tr>)}{tenantLeases.length === 0 && <tr><td colSpan={5}><div className="properties-empty"><strong>No lease record is linked to this tenant</strong><p>Ask your landlord to save the lease against the tenant profile linked to this sign-in.</p></div></td></tr>}</tbody></table></div>{leaseDocumentMessage && <div className="reminder-notice" role="status">{leaseDocumentMessage}</div>}</section><section id="resident-renewal" className="panel properties-panel"><div className="panel-header"><div><h2>Renew your rent</h2><p>Choose your renewal period, amount, and payment method.</p></div></div>{residentRenewalMessage && <div className="reminder-notice" role="status">{residentRenewalMessage}</div>}{hasPendingRenewal ? <div className="properties-empty"><strong>Renewal submitted</strong><p>Your renewal request is waiting for landlord review. Payment status: pending confirmation.</p></div> : <form className="property-form resident-renewal-form" onSubmit={(event) => submitResidentRenewal(event, tenant)}><div className="form-row"><label>Payment period<select name="paymentFrequency" defaultValue={tenant.paymentFrequency ?? "Monthly"} required>{paymentFrequencyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label>Rent amount (₦)<input name="amount" type="text" inputMode="numeric" pattern="[0-9,]*" defaultValue={tenant.monthlyRent.toLocaleString("en-NG")} required onChange={(event) => { const digits = event.target.value.replace(/\D/g, ""); event.target.value = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ","); }} /></label></div><label>Payment method<select name="method" value={residentPaymentMethod} onChange={(event) => { setResidentPaymentMethod(event.target.value); setResidentPaymentCompleted(false); }} required><option value="" disabled>Select payment method</option><option>Bank transfer</option><option>Cash</option><option>POS</option><option>USSD</option><option>Cheque</option><option>Other</option></select></label>{["Bank transfer", "POS", "USSD"].includes(residentPaymentMethod) && (bankTransferDetails.bankName && bankTransferDetails.accountName && bankTransferDetails.accountNumber.length === 10 ? <div className="bank-transfer-details"><h3>Landlord / organization bank account</h3><dl><div><dt>Bank</dt><dd>{bankTransferDetails.bankName}</dd></div><div><dt>Account name</dt><dd>{bankTransferDetails.accountName}</dd></div><div><dt>Account number</dt><dd>{bankTransferDetails.accountNumber}</dd></div></dl><p>{residentPaymentMethod === "Bank transfer" ? "Complete the transfer to this account, then submit your renewal for landlord confirmation." : `Use these details as you complete the ${residentPaymentMethod} payment, then submit for landlord confirmation.`}</p></div> : <div className="reminder-notice">Landlord or organization bank details are not set up yet. Please contact the owner.</div>)}<label className="payment-completed-check"><input name="paymentCompleted" type="checkbox" checked={residentPaymentCompleted} onChange={(event) => setResidentPaymentCompleted(event.target.checked)} required /><span>I have completed this payment using the selected method.</span></label>{residentPaymentCompleted && <label>Upload payment receipt <span className="optional-label">Optional · PDF, JPG, or PNG · up to 10 MB</span><input name="receipt" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" /><span className="field-hint">Attach the receipt after completing your payment.</span></label>}<div className="reminder-notice">Submitting records your chosen method and creates a pending payment for the landlord to confirm. This app does not process or debit funds online.</div><div className="form-actions"><button className="primary-button" type="submit" disabled={!residentPaymentCompleted || (["Bank transfer", "POS", "USSD"].includes(residentPaymentMethod) && !(bankTransferDetails.bankName && bankTransferDetails.accountName && bankTransferDetails.accountNumber.length === 10))}>Submit renewal &amp; payment</button></div></form>}</section>{tenantRenewalRequests.length > 0 && <section className="panel properties-panel"><div className="panel-header"><div><h2>Renewal request history</h2><p>See the landlord decision and linked payment status.</p></div></div><div className="table-wrap"><table><thead><tr><th>REFERENCE</th><th>REQUESTED TERM</th><th>AMOUNT</th><th>PAYMENT STATUS</th><th>REQUEST STATUS</th></tr></thead><tbody>{tenantRenewalRequests.map((request) => { const payment = tenantPayments.find((item) => item.id === request.paymentId); return <tr key={request.id}><td>{request.reference}</td><td>{formatDate(request.startDate)} – {formatDate(request.expirationDate)}<br /><small>{paymentFrequencyLabel(request.paymentFrequency)}</small></td><td>₦{request.rentAmount.toLocaleString("en-NG")}</td><td><span className={"status " + (payment?.status === "Paid" ? "paid" : payment?.status === "Rejected" ? "overdue" : "pending")}>{(payment ? paymentStatusLabel(payment) : "Pending")}</span></td><td><span className={"status " + (request.status === "Approved" ? "paid" : request.status === "Declined" ? "overdue" : "pending")}>{request.status === "Declined" ? "Rejected" : request.status}</span>{request.status === "Declined" && <small><br />Contact your landlord if you need clarification.</small>}</td></tr>; })}</tbody></table></div></section>}<section className="panel properties-panel"><div className="panel-header"><div><h2>Rent payment history</h2><p>Payments recorded for this tenant</p></div></div><div className="table-wrap"><table><thead><tr><th>REFERENCE</th><th>TRANSACTION TYPE</th><th>RENT PERIOD</th><th>AMOUNT</th><th>PAYMENT DATE</th><th>METHOD</th><th>STATUS</th><th>RECEIPT</th></tr></thead><tbody>{tenantPayments.map((payment) => <tr key={payment.id}><td><small>{getPaymentReference(payment)}</small></td><td>{payment.transactionType ?? "Rent payment"}</td><td>{payment.rentPeriod}</td><td>₦{payment.amount.toLocaleString("en-NG")}</td><td>{formatDate(payment.paymentDate)}</td><td>{payment.method}</td><td>{paymentStatusLabel(payment)}</td><td><div className="payment-receipt-actions">{isConfirmedPayment(payment) && <button className="row-modify" type="button" onClick={() => printPaymentReceipt(payment, tenant, property)}>Receipt PDF</button>}{payment.receiptName && <button className="row-modify" type="button" onClick={() => downloadPaymentReceipt(payment)}>Proof</button>}{payment.status === "Pending" && <span className="receipt-pending-note">Awaiting confirmation</span>}</div></td></tr>)}</tbody></table></div></section></> : <div className="properties-empty"><strong>No tenant record is linked</strong><p>Enter the landlord code and the phone number on your tenant record. RentWise will match your sign-in email first and phone second.</p>{landlordProfile && <div className="landlord-details-pending"><strong>{bankTransferDetails.landlordName || landlordProfile.name}</strong><span>{landlordProfile.email}</span><span>{bankTransferDetails.landlordPhone || "Phone not provided"} · {bankTransferDetails.landlordAddress || "Address not provided"}</span><span>{bankTransferDetails.bankName || "Bank not provided"} · {bankTransferDetails.accountName || "Account name not provided"}{bankTransferDetails.accountNumber ? ` · ${bankTransferDetails.accountNumber}` : ""}</span></div>}{auth.user.role === "resident_tenant" && <form className="tenant-landlord-link-form" onSubmit={(event) => void connectTenantToLandlord(event)}><label>Landlord code<input value={landlordCodeInput} onChange={(event) => setLandlordCodeInput(event.target.value.toUpperCase())} placeholder="e.g. RW-AB12CD34" autoComplete="off" required /></label><label>Phone number on tenant record<input name="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="Use the phone number your landlord has on file" /></label><button className="primary-button" type="submit" disabled={landlordLinkBusy}>{landlordLinkBusy ? "Connecting…" : "Connect to landlord"}</button>{landlordLinkError && <div className="form-error" role="alert">{landlordLinkError}</div>}{landlordLinkMessage && <div className="reminder-notice" role="status">{landlordLinkMessage}</div>}</form>}</div>;
              })()}
            </>
          ) : currentPage === "payment_settings" ? (
            <>
              <div className="welcome-row"><div><p className="eyebrow">PAYMENT SETUP</p><h1>Bank &amp; landlord details</h1><p className="subtitle">The owner profile is used to prefill new tenancy agreements.</p></div></div>
              <section className="panel properties-page-panel"><div className="panel-header"><div><h2>Landlord / organization profile</h2><p>Keep the legal name and address current for lease documents.</p></div></div><form className="property-form bank-details-form" onSubmit={(event) => event.preventDefault()}><div className="form-row"><label>Landlord / organization name<input value={bankTransferDetails.landlordName ?? ""} onChange={(event) => setBankTransferDetails((current) => ({ ...current, landlordName: event.target.value }))} placeholder={bankTransferDetails.accountName || auth.user.name} autoComplete="organization" /></label><label>Landlord phone <span className="optional-label">Optional</span><input type="tel" value={bankTransferDetails.landlordPhone ?? ""} onChange={(event) => setBankTransferDetails((current) => ({ ...current, landlordPhone: event.target.value }))} placeholder="Contact phone" autoComplete="tel" /></label></div><label>Landlord / organization address<input value={bankTransferDetails.landlordAddress ?? ""} onChange={(event) => setBankTransferDetails((current) => ({ ...current, landlordAddress: event.target.value }))} placeholder="Registered or contact address" autoComplete="street-address" /></label><div className="reminder-notice">New lease forms use this profile automatically. The account name is used when no landlord name is saved; your signed-in account name is the final fallback.</div><div className="panel-header"><div><h2>Organization bank account</h2><p>These details appear to residents when they choose a transfer payment.</p></div></div><label>Bank name<input value={bankTransferDetails.bankName} onChange={(event) => setBankTransferDetails((current) => ({ ...current, bankName: event.target.value }))} placeholder="e.g. Access Bank" autoComplete="organization" required /></label><label>Account name<input value={bankTransferDetails.accountName} onChange={(event) => setBankTransferDetails((current) => ({ ...current, accountName: event.target.value }))} placeholder="Name on the account" autoComplete="name" required /></label><label>Account number<input value={bankTransferDetails.accountNumber} onChange={(event) => setBankTransferDetails((current) => ({ ...current, accountNumber: event.target.value.replace(/\D/g, "").slice(0, 10) }))} placeholder="10-digit account number" inputMode="numeric" maxLength={10} required /></label><div className="reminder-notice">Profile and payment details save automatically to this organization’s RentWise records.</div></form></section>
            </>
          ) : currentPage === "backups" ? (
            <>
              <div className="welcome-row"><div><p className="eyebrow">DATA PROTECTION</p><h1>Backup &amp; Restore</h1><p className="subtitle">Download a complete copy of your RentWise data and uploaded documents.</p></div></div>
              <div className="content-grid backup-grid">
                <section className="panel backup-card"><div className="panel-header"><div><h2>Create a backup</h2><p>Includes properties, tenants, leases, payments, expenses, maintenance vendors and work orders, inspections, settings, and uploaded files.</p></div></div><div className="backup-card-content"><button className="primary-button" type="button" onClick={downloadFullBackup} disabled={backupBusy}>{backupBusy ? "Preparing backup…" : "Download full backup"}</button><p>Save the downloaded JSON file somewhere safe, such as an external drive or secure cloud folder.</p></div></section>
                <section className="panel backup-card"><div className="panel-header"><div><h2>Restore a backup</h2><p>Load a previously downloaded RentWise backup into this browser.</p></div></div><div className="backup-card-content"><label className="backup-file-label">Choose backup file<input type="file" accept=".json,application/json" disabled={backupBusy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void restoreFullBackup(file); event.currentTarget.value = ""; }} /></label><p>Restoring replaces the current local records and attachments. RentWise will ask you to confirm before applying it.</p></div></section>
              </div>
              <div className="reminder-notice">Backup files contain tenant details and landlord bank account information. Store them securely. These backups are local files and are not uploaded to a server.</div>
              {backupMessage && <div className="reminder-notice" role="status">{backupMessage}</div>}
            </>
          ) : currentPage === "plans" ? (
            <>
              <div className="welcome-row plans-heading"><div><p className="eyebrow">SUBSCRIPTION</p><h1>{accessRestricted ? "Choose a plan to continue" : "Plans & usage"}</h1><p className="subtitle">Compare five plans, review current usage, and choose monthly or annual billing. Paid subscriptions are verified through Paystack.</p></div><span className="plan-current-badge">{subscriptionUsable ? `${currentPlan.name} · ${auth.user.subscriptionDurationDays ? `${auth.user.subscriptionDurationDays} days` : "Active"}` : "No active plan"}</span></div>
              {accessRestricted && <div className="billing-notice" role="alert"><strong>{auth.user.role === "landlord_owner" ? "This organization needs an active subscription." : "Your account does not have an active plan."}</strong> {auth.user.role === "landlord_owner" ? "Choose a plan below to restore access for your organization and its members." : auth.user.role === "resident_tenant" ? "Your plan is managed by your landlord. Ask them to activate or renew the organization plan." : auth.user.role === "estate_agent" && standaloneEstateAgent ? "The property pool and Estate Agent modules are available after you activate a Basic or higher plan." : auth.user.role === "estate_agent" ? "Estate Agent access, including the property pool, requires Basic or higher on the landlord’s organization plan. Ask the landlord to upgrade the subscription." : "Ask your landlord or organization owner to activate or renew the plan."}</div>}
              {accessRestricted && auth.user.role === "resident_tenant" && !auth.user.tenantId && <section className="panel properties-page-panel"><div className="panel-header"><div><h2>Connect to your landlord</h2><p>Enter the code shared by your landlord to link your account to their organization.</p></div></div><form className="property-form tenant-landlord-link-form" onSubmit={(event) => void connectTenantToLandlord(event)}><label>Landlord code<input value={landlordCodeInput} onChange={(event) => setLandlordCodeInput(event.target.value.toUpperCase())} placeholder="e.g. RW-AB12CD34" autoComplete="off" required /></label><label>Phone number on tenant record<input name="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="Use the phone number your landlord has on file" /></label><button className="primary-button" type="submit" disabled={landlordLinkBusy}>{landlordLinkBusy ? "Connecting…" : "Connect to landlord"}</button>{landlordLinkError && <div className="form-error" role="alert">{landlordLinkError}</div>}{landlordLinkMessage && <div className="reminder-notice" role="status">{landlordLinkMessage}</div>}</form></section>}
              {auth.user.subscriptionPlan && (auth.user.subscriptionExpiresAt ? <div className="billing-notice" role={subscriptionUsable ? "status" : "alert"}><strong>{auth.user.subscriptionStatus === "suspended" ? "Subscription suspended · account access inactive" : subscriptionCurrent ? "Subscription active" : "Subscription expired · account access inactive"}.</strong> {subscriptionCurrent && auth.user.subscriptionStatus !== "suspended" ? <>Started {auth.user.subscriptionStartAt ? formatDate(auth.user.subscriptionStartAt.slice(0, 10)) : "—"} · expires {formatDate(auth.user.subscriptionExpiresAt.slice(0, 10))} · duration {auth.user.subscriptionDurationDays ?? "—"} days · <SubscriptionCountdown expiresAt={auth.user.subscriptionExpiresAt} />. Renew before expiry to prevent an interruption.</> : "Operational modules are locked. Renew the plan below to restore access."}</div> : <div className="billing-notice" role="status"><strong>Subscription active.</strong> This plan has no expiry date.</div>)}
              <div className="billing-notice" role="note"><strong>Secure checkout and activation.</strong> RentWise redirects to Paystack, then verifies the transaction on the server. This does not charge tenants’ rent; it pays for your RentWise account.</div>
              {auth.user.role === "super_admin" && <section className="panel plan-settings-panel"><div className="panel-header"><div><h2>Edit plan pricing and limits</h2><p>Changes are saved to PostgreSQL and are enforced on the server as soon as they are saved.</p></div>{planSettingsLoading && <span className="plan-selected-chip">Loading…</span>}</div>
                {planSettingsError && <div className="form-error" role="alert">{planSettingsError}</div>}{planSettingsMessage && <div className="reminder-notice" role="status">{planSettingsMessage}</div>}
                <div className="plan-settings-grid">{planDrafts.map((plan) => <article className="plan-settings-card" key={plan.id}><div className="plan-settings-heading"><div><strong>{plan.name}</strong><small>{plan.audience}</small></div><span>{plan.id.replaceAll("_", " ")}</span></div>
                  <div className="form-row"><label>Monthly price (₦)<input type="number" min={plan.id === "free_starter" ? 0 : 1} max="1000000000" step="1" value={plan.monthlyPrice ?? ""} placeholder="Custom pricing" onChange={(event) => editPlanPrice(plan.id, "monthlyPrice", event.target.value)} /><small>Leave blank to offer custom pricing for this term.</small></label><label>Annual price (₦)<input type="number" min={plan.id === "free_starter" ? 0 : 1} max="1000000000" step="1" value={plan.annualPrice ?? ""} placeholder="Custom pricing" onChange={(event) => editPlanPrice(plan.id, "annualPrice", event.target.value)} /><small>Set yearly pricing independently from monthly.</small></label></div>
                  <div className="plan-limit-edit-grid">{([ ["properties", "Properties"], ["units", "Rental units"], ["tenants", "Tenants"], ["staff", "Staff accounts"], ["storageMb", "Storage (MB)"], ["monthlyNotifications", "Monthly notifications"] ] as Array<[PlanLimitKey, string]>).map(([key, label]) => <label key={key}>{label}<input type="number" min="0" max="1000000000" step="1" value={plan.limits[key] ?? ""} placeholder="Unlimited" onChange={(event) => editPlanLimit(plan.id, key, event.target.value)} /></label>)}</div>
                </article>)}</div>
                <div className="plan-settings-footer"><small>Blank limits mean unlimited. Free Starter can be ₦0 for both terms or priced for both; paid plans require a positive amount or custom pricing. Annual prices are not automatically calculated.</small><div><button className="secondary-button" type="button" disabled={!planSettingsDirty || planSettingsBusy} onClick={() => { setPlanDrafts(planCatalog.map((plan) => ({ ...plan, limits: { ...plan.limits }, features: { ...plan.features }, bullets: [...plan.bullets] }))); setPlanSettingsError(""); setPlanSettingsMessage(""); }}>Discard changes</button><button className="primary-button" type="button" disabled={!planSettingsDirty || planSettingsBusy || planSettingsLoading} onClick={() => void savePlanSettings()}>{planSettingsBusy ? "Saving plan settings…" : "Save plan settings"}</button></div></div>
              </section>}
              {auth.user.role === "super_admin" && <section className="panel billing-assignment-panel"><div className="panel-header"><div><h2>Assign billing plan to a user</h2><p>Assign or clear a plan for any account, regardless of role.</p></div><button type="button" className="secondary-button" onClick={() => void auth.listUsers().then(setAccounts).catch((error: unknown) => setAccountError(error instanceof Error ? error.message : "Could not load accounts."))}>Refresh</button></div>
                {accountError && <div className="reminder-notice" role="alert">{accountError}</div>}{accountMessage && <div className="reminder-notice" role="status">{accountMessage}</div>}
                <div className="table-wrap"><table><thead><tr><th>USER</th><th>ROLE</th><th>ASSIGNED BILLING PLAN &amp; TERM</th><th>PLAN ACCESS / COUNTDOWN</th></tr></thead><tbody>{accounts.map((account) => { const expiry = account.subscriptionExpiresAt ? Date.parse(account.subscriptionExpiresAt) : Number.NaN; const current = Boolean(account.subscriptionPlan === "free_starter" || account.subscriptionPlan && Number.isFinite(expiry) && expiry > clientNow && account.subscriptionStatus !== "suspended"); const privileged = ["super_admin", "platform_admin"].includes(account.role); const selectedDuration = assignmentDurations[account.id] ?? account.subscriptionDurationDays ?? (account.subscriptionInterval === "annually" ? 365 : 30); return <tr key={account.id}><td><strong>{account.name}</strong><br /><small>{account.email}</small></td><td>{roleLabels[account.role]}</td><td><div className="subscription-assignment-controls"><select aria-label={`Billing plan for ${account.name}`} value={account.subscriptionPlan ?? ""} onChange={(event) => void assignSubscriptionPlan(account.id, event.target.value ? event.target.value as SubscriptionPlanId : null, selectedDuration)}><option value="">No plan assigned</option>{planCatalog.map((plan) => <option key={plan.id} value={plan.id} disabled={account.role === "estate_agent" && plan.id === "free_starter"}>{plan.name} — {formatPlanTermPrice(plan, subscriptionInterval)}{account.role === "estate_agent" && plan.id === "free_starter" ? " (not eligible)" : ""}</option>)}</select>{account.subscriptionPlan !== "free_starter" && <select aria-label={`Subscription duration for ${account.name}`} value={selectedDuration} onChange={(event) => { const duration = Number(event.target.value); setAssignmentDurations((current) => ({ ...current, [account.id]: duration })); if (account.subscriptionPlan) void assignSubscriptionPlan(account.id, account.subscriptionPlan, duration); }}><option value={30}>1 Month · 30 days</option><option value={90}>3 Months · 90 days</option><option value={180}>6 Months · 180 days</option><option value={365}>1 Year · 365 days</option></select>}</div></td><td>{!account.active ? "Account disabled" : privileged ? "Administrator access" : account.subscriptionStatus === "suspended" ? "Suspended" : !account.subscriptionPlan ? "No plan assigned · inactive" : current ? !account.subscriptionExpiresAt ? "Active · Free Starter · no expiry" : <><strong>Active · {account.subscriptionDurationDays ?? selectedDuration} days</strong><br />Started {account.subscriptionStartAt ? formatDate(account.subscriptionStartAt.slice(0, 10)) : "—"}<br />Expires {formatDate(account.subscriptionExpiresAt!.slice(0, 10))}<br /><small><SubscriptionCountdown expiresAt={account.subscriptionExpiresAt!} /></small></> : <><strong>Expired · access inactive</strong><br />{account.subscriptionStartAt && <>Started {formatDate(account.subscriptionStartAt.slice(0, 10))}<br /></>}Expires {account.subscriptionExpiresAt ? formatDate(account.subscriptionExpiresAt.slice(0, 10)) : "—"}<br /><small><SubscriptionCountdown expiresAt={account.subscriptionExpiresAt ?? ""} /></small></>}</td></tr>; })}</tbody></table></div>
              </section>}
              {!accessRestricted && <section className="panel plan-usage-panel"><div className="panel-header"><div><h2>Current usage</h2><p>Your portfolio against the current plan.</p></div></div>
                <div className="plan-usage-grid">
                  {([['Properties', billingUsage?.properties ?? properties.length, currentPlan.limits.properties], ['Rental units', billingUsage?.units ?? dashboardUnitTotal, currentPlan.limits.units], ['Tenants', billingUsage?.tenants ?? tenants.length, currentPlan.limits.tenants], ['Staff accounts', billingUsage?.staff ?? 0, currentPlan.limits.staff], ['Document storage', billingUsage ? Math.round(billingUsage.storageBytes / (1024 * 1024)) : 0, currentPlan.limits.storageMb], ['Monthly messages', billingUsage?.notifications ?? 0, currentPlan.limits.monthlyNotifications]] as Array<[string, number, number | null]>).map(([label, used, limit]) => <div className="usage-meter" key={label}><div><span>{label}</span><strong>{used}{limit === null ? " · Unlimited" : ` / ${limit}${label === "Document storage" ? " MB" : ""}`}</strong></div>{limit !== null && <div className="usage-track"><span style={{ width: `${Math.min(100, limit ? used / limit * 100 : 0)}%` }} /></div>}</div>)}
                </div>
              </section>}
              <section className="panel billing-cycle-panel"><div><strong>Billing frequency</strong><p>Monthly and yearly prices are set independently by the Super Administrator.</p></div><div className="billing-cycle-toggle" role="group" aria-label="Subscription billing frequency"><button type="button" className={subscriptionInterval === "monthly" ? "active" : ""} aria-pressed={subscriptionInterval === "monthly"} onClick={() => setSubscriptionInterval("monthly")}>Monthly</button><button type="button" className={subscriptionInterval === "annually" ? "active" : ""} aria-pressed={subscriptionInterval === "annually"} onClick={() => setSubscriptionInterval("annually")}>Yearly</button></div></section>
              {subscriptionMessage && <div className="reminder-notice" role="status">{subscriptionMessage}</div>}
              {billingStatusError && <div className="form-error" role="alert">{billingStatusError}</div>}
              {(["landlord_owner", "property_manager"].includes(auth.user.role) || standaloneEstateAgent) && !billingConfigured && <div className="billing-notice" role="note"><strong>Paystack setup required.</strong> Add your Paystack secret key to <code>PAYSTACK_SECRET_KEY</code> in the server’s <code>.env</code> file, then restart RentWise. For public hosting, set <code>RENTWISE_PUBLIC_URL</code> to the public app URL so Paystack can return the user to the right server. Keep secret values on the server; do not use <code>VITE_</code> variables.</div>}
              {auth.user.role === "super_admin" && <section className="panel paystack-connection-panel"><div><strong>Paystack API connection</strong><p>Check the server credential without starting or charging a payment.</p>{paystackTestMessage && <small role="status">{paystackTestMessage}</small>}{paystackTestError && <small className="form-error" role="alert">{paystackTestError}</small>}</div><button className="secondary-button" type="button" disabled={paystackTestBusy} onClick={() => void testPaystackConnection()}>{paystackTestBusy ? "Checking Paystack…" : "Test Paystack connection"}</button></section>}
              <div className="subscription-plan-grid">{planCatalog.map((plan) => {
                const selectedPrice = getPlanTermPrice(plan, subscriptionInterval);
                const isFreePlan = plan.id === "free_starter" && plan.monthlyPrice === 0 && plan.annualPrice === 0;
                const estateAgentIneligiblePlan = auth.user.role === "estate_agent" && plan.id === "free_starter";
                return <article className={`panel subscription-plan-card ${plan.id === effectivePlan ? "selected-plan" : ""}`} key={plan.id}>
                  {plan.id === "professional" && <span className="plan-popular">RECOMMENDED</span>}
                  <div className="plan-card-heading"><div><h2>{plan.name}</h2><p>{plan.audience}</p></div>{plan.id === effectivePlan && <span className="plan-selected-chip">{subscriptionUsable ? "Current" : "No active plan"}</span>}</div>
                  <div className="plan-price"><strong>{selectedPrice === null ? "Custom" : `₦${selectedPrice.toLocaleString("en-NG")}`}</strong><span>{selectedPrice === null ? " pricing" : `/ ${subscriptionInterval === "monthly" ? "month" : "year"}`}</span></div>
                  {subscriptionInterval === "annually" && plan.monthlyPrice !== null && plan.annualPrice !== null && plan.monthlyPrice * 12 > plan.annualPrice && <p className="plan-savings-note">₦{(plan.monthlyPrice * 12 - plan.annualPrice).toLocaleString("en-NG")} saved per year</p>}
                  <ul className="plan-feature-list">{[...plan.bullets.map((feature) => planLimitBullet(plan, feature)), `Document storage: ${plan.limits.storageMb === null ? "Unlimited" : `${plan.limits.storageMb.toLocaleString("en-NG")} MB`}`, `Monthly notifications: ${plan.limits.monthlyNotifications === null ? "Unlimited" : plan.limits.monthlyNotifications.toLocaleString("en-NG")}`].map((feature) => <li key={feature}><span aria-hidden="true">✓</span>{feature}</li>)}</ul>
                  {["landlord_owner", "property_manager"].includes(auth.user.role) || standaloneEstateAgent ? estateAgentIneligiblePlan ? <span className="secondary-button plan-choice-button plan-contact-note">Basic is the minimum Estate Agent plan</span> : isFreePlan ? <button className="primary-button plan-choice-button" type="button" disabled={billingBusy || plan.id === effectivePlan && subscriptionUsable} onClick={() => void selectFreeStarter()}>{plan.id === effectivePlan && subscriptionUsable ? "Current plan" : "Choose Free Starter"}</button> : selectedPrice === null ? <span className="secondary-button plan-choice-button plan-contact-note">Contact RentWise to discuss custom pricing</span> : <button className="primary-button plan-choice-button" type="button" disabled={billingBusy} onClick={() => void startSubscriptionCheckout(plan.id)}>{billingBusy ? "Opening secure checkout…" : plan.id === effectivePlan && subscriptionCurrent ? "Renew / change plan" : "Subscribe with Paystack"}</button> : <button className={plan.id === effectivePlan ? "secondary-button plan-choice-button" : "primary-button plan-choice-button"} type="button" disabled={auth.user.role !== "super_admin" || plan.id === effectivePlan} onClick={() => void assignSubscriptionPlan(auth.user.id, plan.id)}>{plan.id === effectivePlan ? subscriptionUsable ? "Current account plan" : auth.user.role === "super_admin" ? "Assign a plan" : "Subscription managed by landlord" : auth.user.role === "super_admin" ? "Assign to my account" : "Subscription managed by landlord"}</button>}
                </article>;
              })}</div>
              {billingPayments.length > 0 && <section className="panel properties-page-panel"><div className="panel-header"><div><h2>Subscription payment history</h2><p>Recent RentWise plan payments processed through Paystack</p></div></div><div className="table-wrap"><table><thead><tr><th>DATE</th><th>REFERENCE</th><th>PLAN</th><th>TERM</th><th>AMOUNT</th><th>STATUS</th></tr></thead><tbody>{billingPayments.map((payment) => <tr key={payment.reference}><td>{formatDate((payment.paidAt ?? payment.createdAt).slice(0, 10))}</td><td><small>{payment.reference}</small></td><td>{planCatalog.find((plan) => plan.id === payment.planId)?.name ?? payment.planId}</td><td>{payment.interval === "annually" ? "Yearly" : "Monthly"}</td><td className="amount">₦{payment.amount.toLocaleString("en-NG")}</td><td><span className={`status ${payment.status === "success" ? "paid" : payment.status === "failed" ? "overdue" : "pending"}`}>{payment.status}</span></td></tr>)}</tbody></table></div></section>}
              <div className="plan-feature-note"><strong>Pricing note:</strong> Prices are configured by the Super Administrator. Review payment-provider, messaging, file-storage, and support costs before publishing them commercially. Existing records are retained if an account changes to a plan with lower limits; new records are checked against the selected plan.</div>
            </>
          ) : (
            <>
              <div className="welcome-row"><div><p className="eyebrow">SYSTEM ACCESS</p><h1>Access roles</h1><p className="subtitle">Role descriptions and the modules available to each role.</p></div></div>
              <div className="reminder-notice">{auth.user.role === "platform_admin" ? "Create Landlord, Property Manager, Estate Agent, and Resident / Tenant accounts. Platform Administrators cannot create or assign administrator accounts." : "Create login accounts and assign a role. Each account is authenticated by the RentWise server."}</div>
              <section className="panel properties-page-panel role-account-panel"><div className="panel-header"><div><h2>Create an account</h2><p>Provide a unique email and a temporary password with at least 12 characters.</p></div></div>
                <form className="property-form" onSubmit={(event) => void createRoleAccount(event)}>
                  <div className="form-row"><label>Full name<input name="name" required minLength={2} maxLength={100} /></label><label>Email<input name="email" type="email" required /></label></div>
                  <div className="form-row"><label>Temporary password<input name="password" type="password" minLength={12} required /></label><label>Assigned role<select name="role" value={createAccountRole} onChange={(event) => { const nextRole = event.target.value as RoleId; setCreateAccountRole(nextRole); const field = event.currentTarget.form?.elements.namedItem("tenantId") as HTMLSelectElement | null; if (field) field.required = nextRole === "resident_tenant" && auth.user.role === "super_admin"; const org = event.currentTarget.form?.elements.namedItem("organizationId") as HTMLSelectElement | null; if (org) org.required = !["resident_tenant", "landlord_owner"].includes(nextRole); }} required>{roleDefinitions.filter((role) => auth.user.role === "super_admin" ? true : ["landlord_owner", "property_manager", "estate_agent", "resident_tenant"].includes(role.id)).map((role) => <option key={role.id} value={role.id}>{role.label}</option>)}</select></label></div>
                  {!(auth.user.role === "platform_admin" && createAccountRole === "resident_tenant") && <label>Organization<select name="organizationId" defaultValue={accounts.find((account) => account.role === "landlord_owner")?.organizationId ?? auth.user.organizationId ?? "rentwise-default"}><option value={auth.user.organizationId ?? "rentwise-default"}>System workspace</option>{accounts.filter((account) => account.role === "landlord_owner" && account.organizationId).map((account) => <option key={account.id} value={account.organizationId}>{account.name} — {account.email}</option>)}</select><small>Staff and agent accounts share the selected landlord’s data.</small></label>}
                  {auth.user.role === "platform_admin" && createAccountRole === "resident_tenant" && <><label>Associate with landlord <span className="optional-label">Optional</span><select name="landlordId" defaultValue=""><option value="">Create tenant login without a landlord link</option>{accounts.filter((account) => account.role === "landlord_owner").map((account) => <option key={account.id} value={account.id}>{account.name} — {account.email}</option>)}</select><small>When selected, the landlord will receive this tenant as an application to review.</small></label><label>Tenant phone number <span className="optional-label">Optional</span><input name="phone" type="tel" inputMode="numeric" maxLength={11} pattern="[0-9]{0,11}" placeholder="Up to 11 digits" /></label></>}
                  {!(auth.user.role === "platform_admin" && createAccountRole === "resident_tenant") && <label>Link tenant record<select name="tenantId" defaultValue="" disabled={!tenants.length}><option value="">Choose only for Resident / Tenant</option>{tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</select><small>Resident accounts created by Super Admin must be linked to an existing tenant record.</small></label>}
                  {accountError && <div className="reminder-notice" role="alert">{accountError}</div>}{accountMessage && <div className="reminder-notice" role="status">{accountMessage}</div>}
                  {leaseFormError && <p className="form-error" role="alert">{leaseFormError}</p>}
                <div className="form-actions"><button className="primary-button" disabled={accountBusy}>{accountBusy ? "Creating…" : "Create account"}</button></div>
                </form>
              </section>
              <section className="panel properties-page-panel role-account-panel"><div className="panel-header"><div><h2>{auth.user.role === "platform_admin" ? "Created and managed accounts" : "Accounts and role assignments"}</h2><p>{auth.user.role === "platform_admin" ? "Platform Admin can view account roles here; account changes and administrator assignments remain restricted." : "Modify user details, change roles, reset passwords, disable access, or delete an account."}</p></div><button type="button" className="secondary-button" onClick={() => void auth.listUsers().then(setAccounts).catch((error: unknown) => setAccountError(error instanceof Error ? error.message : "Could not load accounts."))}>Refresh</button></div>
                {accountError && <div className="reminder-notice" role="alert">{accountError}</div>}{accountMessage && <div className="reminder-notice" role="status">{accountMessage}</div>}
                <div className="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Tenant link</th><th>Status</th>{auth.user.role === "super_admin" && <th>Actions</th>}</tr></thead><tbody>{accounts.map((account) => <tr key={account.id}><td>{account.name}</td><td>{account.email}</td><td>{auth.user.role === "platform_admin" ? roleLabels[account.role] : <select aria-label={`Role for ${account.name}`} value={account.role} disabled={account.id === auth.user.id || !account.active} onChange={(event) => { const role = event.target.value as RoleId; void changeAccount(account.id, { role, ...(role === "resident_tenant" ? { tenantId: account.tenantId ?? tenants[0]?.id ?? "" } : {}) }); }}>{roleDefinitions.map((role) => <option key={role.id} value={role.id}>{role.label}</option>)}</select>}</td><td>{account.role === "resident_tenant" ? (auth.user.role === "platform_admin" ? account.tenantId ? "Tenant record linked" : "Awaiting landlord link" : <select aria-label={`Tenant record for ${account.name}`} value={account.tenantId ?? ""} onChange={(event) => void linkTenantAccount(account.id, event.target.value)}><option value="">Choose tenant record</option>{tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</select>) : "—"}</td><td>{!account.active ? "Disabled" : ["super_admin", "platform_admin"].includes(account.role) ? "Administrator access" : account.subscriptionPlan && (!account.subscriptionExpiresAt || Date.parse(account.subscriptionExpiresAt) > Date.now()) ? "Active" : "Inactive · plan required"}</td>{auth.user.role === "super_admin" && <td><div className="account-actions"><button type="button" className="secondary-button" onClick={() => setEditingAccount(account)}>Modify</button><button type="button" className="secondary-button" onClick={() => setResettingAccount(account)}>Reset password</button><button type="button" className="secondary-button" disabled={account.id === auth.user.id || account.role === "super_admin" && account.active && accounts.filter((item) => item.role === "super_admin" && item.active).length <= 1} onClick={() => void changeAccount(account.id, { active: !account.active })}>{account.active ? "Disable" : "Enable"}</button><button type="button" className="danger-button" disabled={account.id === auth.user.id || account.role === "super_admin" && account.active && accounts.filter((item) => item.role === "super_admin" && item.active).length <= 1} onClick={() => void deleteAccount(account)}>{account.active ? "Delete" : "Delete"}</button></div></td>}</tr>)}</tbody></table></div>
              </section>
              <div className="role-cards">{visibleRoleDefinitions.map((role) => <article className="panel role-card" key={role.id}><div className="panel-header"><div><h2>{role.label}</h2><p>{role.description}</p></div></div><div className="role-card-content"><strong>Available modules</strong><p>{role.pages.map((page) => page === "resident" ? "Resident portal" : page === "agent_properties" ? "Properties" : page === "roles" ? "Access roles" : page === "ledger" ? "Property Financial Ledger" : page === "inspections" ? "Inspections" : page === "payments" ? "Payments" : page === "agent_fees" ? "Agent fees" : page.charAt(0).toUpperCase() + page.slice(1)).join(" · ")}</p><strong>Can modify</strong><p>{role.editableModules.length ? role.editableModules.join(" · ") : "Read only"}</p></div></article>)}</div>
            </>
          )}
        </section>
        <footer className="app-owner-footer" aria-label="RentWise ownership and product credit">
          <img src="/minds-technologies-logo.png" alt="MINDS Technologies shield logo" />
          <div className="app-owner-copy"><span>RentWise NG is owned by</span><strong>MINDS Technologies</strong><small>Let’s Solve It.</small></div>
          <span className="app-owner-product">Property management by RentWise NG</span>
        </footer>
      </main>

      {agentPhotoViewer && (() => {
        const listing = agentPropertyListings.find((item) => `${item.organizationId}-${item.id}` === agentPhotoViewer.listingKey);
        const photoUrl = listing?.photoUrls[agentPhotoViewer.index];
        if (!listing || !photoUrl) return null;
        return <div className="agent-photo-viewer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAgentPhotoViewer(null); }}><section className="agent-photo-viewer" role="dialog" aria-modal="true" aria-label={`${listing.name} property photos`}><button className="agent-photo-viewer-close" type="button" aria-label="Close photo viewer" onClick={() => setAgentPhotoViewer(null)}>×</button>{listing.photoUrls.length > 1 && <button className="agent-photo-viewer-nav previous" type="button" aria-label="Previous property photo" onClick={() => setAgentPhotoViewer((current) => current ? { ...current, index: (current.index + listing.photoUrls.length - 1) % listing.photoUrls.length } : current)}>‹</button>}<img className="agent-photo-viewer-image" src={photoUrl} alt={`${listing.name} property photo ${agentPhotoViewer.index + 1}`} /><div className="agent-photo-viewer-caption"><strong>{listing.name}</strong><span>Photo {agentPhotoViewer.index + 1} of {listing.photoUrls.length} · {listing.type}</span></div>{listing.photoUrls.length > 1 && <button className="agent-photo-viewer-nav next" type="button" aria-label="Next property photo" onClick={() => setAgentPhotoViewer((current) => current ? { ...current, index: (current.index + 1) % listing.photoUrls.length } : current)}>›</button>}</section></div>;
      })()}

      {isInspectionFormOpen && (() => {
        const draft = inspections.find((item) => item.id === editingInspectionId);
        return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !inspectionBusy) setIsInspectionFormOpen(false); }}><section className="property-modal" role="dialog" aria-modal="true" aria-labelledby="inspection-form-title"><div className="modal-heading"><div><p className="eyebrow">PROPERTY CONDITION</p><h2 id="inspection-form-title">{draft ? "Modify inspection" : "New inspection & handover"}</h2><p>Record condition, readings, and tenant acknowledgement.</p></div><button className="modal-close" aria-label="Close form" type="button" disabled={inspectionBusy} onClick={() => setIsInspectionFormOpen(false)}>×</button></div>
          <form className="property-form" onSubmit={(event) => void saveInspection(event)}><div className="form-row"><label>Property<select name="propertyId" defaultValue={draft?.propertyId ?? ""} required><option value="" disabled>Select property</option>{properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}</select></label><label>Tenant <span className="optional-label">Optional</span><select name="tenantId" defaultValue={draft?.tenantId ?? ""}><option value="">Not assigned</option>{tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</select></label></div><div className="form-row"><label>Inspection type<select name="kind" defaultValue={draft?.kind ?? "Routine"}><option>Move-in</option><option>Routine</option><option>Move-out</option><option>Handover</option></select></label><label>Inspection date<input name="inspectionDate" type="date" defaultValue={draft?.inspectionDate ?? getTodayKey()} required /></label></div><div className="form-row"><label>Unit / apartment label<input name="unitLabel" defaultValue={draft?.unitLabel ?? ""} placeholder="e.g. Flat 2B" /></label><label>Inspector name<input name="inspectorName" defaultValue={draft?.inspectorName ?? auth.user.name} required /></label></div><div className="panel-header"><div><h3>Condition checklist</h3><p>Select the observed condition for each item.</p></div></div><div className="inspection-checklist">{([["exterior", "Exterior"], ["wallsFloors", "Walls and floors"], ["electrical", "Electrical"], ["plumbing", "Plumbing"], ["doorsWindows", "Doors and windows"], ["fixtures", "Fixtures"]] as Array<[keyof PropertyInspection["checklist"], string]>).map(([key, label]) => <label key={key}>{label}<select name={key} defaultValue={draft?.checklist[key] ?? "Not checked"}><option>Good</option><option>Fair</option><option>Needs repair</option><option>Not checked</option></select></label>)}</div><div className="form-row"><label>Inspection fee (₦)<input name="inspectionFee" type="text" inputMode="numeric" pattern="[0-9,]*" defaultValue={draft?.inspectionFee?.toLocaleString("en-NG") ?? ""} placeholder="e.g. 25,000" onChange={(event) => { const digits = event.target.value.replace(/\D/g, ""); event.target.value = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ","); }} /></label><label>Agent fee (₦)<input name="agentFee" type="text" inputMode="numeric" pattern="[0-9,]*" defaultValue={draft?.agentFee?.toLocaleString("en-NG") ?? ""} placeholder="e.g. 50,000" onChange={(event) => { const digits = event.target.value.replace(/\D/g, ""); event.target.value = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ","); }} /></label></div><div className="form-row"><label>Electricity meter reading<input name="electricity" defaultValue={draft?.meterReadings.electricity ?? ""} /></label><label>Water meter reading<input name="water" defaultValue={draft?.meterReadings.water ?? ""} /></label></div><label>Observations<textarea name="observations" rows={3} defaultValue={draft?.observations ?? ""} placeholder="Condition notes, defects, and follow-up actions" /></label><label>Handover notes<textarea name="handoverNotes" rows={3} defaultValue={draft?.handoverNotes ?? ""} placeholder="Keys, access devices, and items handed over" /></label><div className="form-row"><label>Acknowledged by <span className="optional-label">Tenant / recipient</span><input name="acknowledgementName" defaultValue={draft?.acknowledgementName ?? ""} /></label><label>Acknowledgement date<input name="acknowledgedAt" type="date" defaultValue={draft?.acknowledgedAt ?? ""} /></label></div><label>Attach photos <span className="optional-label">Optional · up to 10 JPG, PNG, or WebP · 8 MB each</span><input name="photos" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" multiple /></label>{draft?.photos.length ? <div className="maintenance-image-list">{draft.photos.map((photo) => <button className="row-modify" type="button" key={photo.id} onClick={() => void downloadInspectionPhoto(photo)}>Existing: {photo.name}</button>)}</div> : null}{inspectionError && <div className="form-error" role="alert">{inspectionError}</div>}<div className="form-actions"><button type="button" className="secondary-button" disabled={inspectionBusy} onClick={() => setIsInspectionFormOpen(false)}>Cancel</button><button className="primary-button" disabled={inspectionBusy}>{inspectionBusy ? "Saving…" : draft ? "Save changes" : "Save inspection"}</button></div></form></section></div>;
      })()}
      {isPropertyFormOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsPropertyFormOpen(false); }}>
          <section className="property-modal" role="dialog" aria-modal="true" aria-labelledby="property-form-title" key={editingPropertyId ?? "new-property"}>
            <div className="modal-heading">
              <div><p className="eyebrow">PROPERTY DETAILS</p><h2 id="property-form-title">{editingPropertyId ? "Modify property" : "Add a property"}</h2><p>Enter the basic details for this property.</p></div>
              <button className="modal-close" aria-label="Close form" onClick={() => setIsPropertyFormOpen(false)}>×</button>
            </div>
            <form className="property-form" onSubmit={addProperty}>
              <label>Property name<input name="name" defaultValue={properties.find((property) => property.id === editingPropertyId)?.name ?? ""} placeholder="e.g. Palm Court Apartments" required autoFocus /></label>
              <div className="property-photo-inputs"><label>Capture a property photo <span className="optional-label">Camera · JPG, PNG, or WebP · 8 MB max each</span><input type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" capture="environment" onChange={(event) => { const chosen = Array.from(event.currentTarget.files ?? []); const savedCount = propertyPhotoNames(properties.find((property) => property.id === editingPropertyId)).length - propertyPhotoRemovals.length; if (propertyPhotoFiles.length + chosen.length + savedCount > 4) setPropertySaveError(`Only ${Math.max(0, 4 - savedCount - propertyPhotoFiles.length)} photo slot(s) remain.`); else { setPropertyPhotoFiles([...propertyPhotoFiles, ...chosen]); setPropertySaveError(""); } event.currentTarget.value = ""; }} /></label><label>Upload property photos <span className="optional-label">Choose multiple files · up to 4 photos total · 8 MB each</span><input type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" multiple onChange={(event) => { const chosen = Array.from(event.currentTarget.files ?? []); const savedCount = propertyPhotoNames(properties.find((property) => property.id === editingPropertyId)).length - propertyPhotoRemovals.length; if (propertyPhotoFiles.length + chosen.length + savedCount > 4) setPropertySaveError(`Only ${Math.max(0, 4 - savedCount - propertyPhotoFiles.length)} photo slot(s) remain.`); else { setPropertyPhotoFiles([...propertyPhotoFiles, ...chosen]); setPropertySaveError(""); } event.currentTarget.value = ""; }} /></label></div><span className="field-hint">Capture photos with your device camera, or upload from your files. New images are added to the saved property gallery. {propertyPhotoNames(properties.find((property) => property.id === editingPropertyId)).length - propertyPhotoRemovals.length + propertyPhotoFiles.length} of 4 photo slots used.</span>
              {propertyPhotoFiles.length > 0 && <div className="property-selected-photo-list" aria-live="polite"><strong>Ready to save</strong>{propertyPhotoFiles.map((photo, index) => <span key={`${photo.name}-${photo.lastModified}-${index}`}>{photo.name}</span>)}</div>}
              {editingPropertyId && propertyPhotoNames(properties.find((property) => property.id === editingPropertyId)).length > 0 && <div className="property-form-photo-gallery">{propertyPhotoNames(properties.find((property) => property.id === editingPropertyId)).map((photoName, index) => { const photoId = propertyPhotoAttachmentId(editingPropertyId, index); const removed = propertyPhotoRemovals.includes(index); return <div className={`property-photo-item ${removed ? "removed" : ""}`} key={photoId}>{profilePhotoUrls[photoId] && <img className="profile-photo-preview" src={profilePhotoUrls[photoId]} alt={`Current property photo ${index + 1}`} />}<span>{propertyPhotoReplacements[index]?.name ?? photoName}</span><div className="property-photo-actions"><label className="property-photo-action">Replace<input type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" capture="environment" disabled={removed || propertySaving} onChange={(event) => { const photo = event.currentTarget.files?.[0]; if (photo) { if (!["image/jpeg", "image/png", "image/webp"].includes(photo.type) || photo.size > 8 * 1024 * 1024) setPropertySaveError("Choose a JPG, PNG, or WebP image no larger than 8 MB."); else { setPropertyPhotoReplacements((current) => ({ ...current, [index]: photo })); setPropertySaveError(""); } } event.currentTarget.value = ""; }} /></label><button type="button" className="property-photo-action delete" disabled={propertySaving} onClick={() => { if (removed) { setPropertyPhotoRemovals((current) => current.filter((item) => item !== index)); } else { setPropertyPhotoRemovals((current) => [...current, index]); setPropertyPhotoReplacements((current) => { const next = { ...current }; delete next[index]; return next; }); } }}>{removed ? "Undo delete" : "Delete"}</button></div></div>; })}</div>}
              <div className="form-row">
                <label>Property type<select name="type" value={selectedPropertyType} onChange={(event) => setSelectedPropertyType(event.target.value)} required><option value="" disabled>Select type</option><option>Apartment</option><option>House</option><option>Duplex</option><option>Shop</option><option>Store</option><option>Office Space</option><option>Filling Station</option><option>Commercial</option><option>Land</option><option>Other</option></select></label>
                <label>Number of units<input name="units" type="number" min="1" step="1" defaultValue={properties.find((property) => property.id === editingPropertyId)?.units ?? ""} placeholder="e.g. 8" required /></label>
              </div>
              {selectedPropertyType === "Apartment" && (
                <label>Apartment type<select name="apartmentType" defaultValue={properties.find((property) => property.id === editingPropertyId)?.apartmentType ?? ""} required><option value="" disabled>Select apartment type</option><option>Studio / Self-contained</option><option>Mini flat</option><option>1-bedroom apartment</option><option>2-bedroom apartment</option><option>3-bedroom apartment</option><option>4-bedroom apartment</option><option>5+ bedroom apartment</option><option>Penthouse</option><option>Other</option></select></label>
              )}
              <label>Street address<input name="address" defaultValue={properties.find((property) => property.id === editingPropertyId)?.address ?? ""} placeholder="Street and house number" required /></label>
              <div className="form-row">
                <label>City<input name="city" defaultValue={properties.find((property) => property.id === editingPropertyId)?.city ?? ""} placeholder="e.g. Ikeja" required /></label>
                <label>State<select name="state" defaultValue={properties.find((property) => property.id === editingPropertyId)?.state ?? ""} required><option value="" disabled>Select state</option>{["Abia","Adamawa","Akwa Ibom","Anambra","Bauchi","Bayelsa","Benue","Borno","Cross River","Delta","Ebonyi","Edo","Ekiti","Enugu","FCT Abuja","Gombe","Imo","Jigawa","Kaduna","Kano","Katsina","Kebbi","Kogi","Kwara","Lagos","Nasarawa","Niger","Ogun","Ondo","Osun","Oyo","Plateau","Rivers","Sokoto","Taraba","Yobe","Zamfara"].map((state) => <option key={state}>{state}</option>)}</select></label>
              </div>
              {propertyPlanError && <div className="plan-limit-error" role="alert">{propertyPlanError}</div>}
              {propertySaveError && <div className="api-status-alert" role="alert"><strong>Property not saved.</strong><span>{propertySaveError}</span></div>}
              <div className="form-actions"><button type="button" className="secondary-button" disabled={propertySaving} onClick={() => setIsPropertyFormOpen(false)}>Cancel</button><button className="primary-button" type="submit" disabled={propertySaving}>{propertySaving ? "Saving…" : editingPropertyId ? "Save changes" : "Save property"}</button></div>
            </form>
          </section>
        </div>
      )}
      {isLeaseFormOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !leaseSaving) setIsLeaseFormOpen(false); }}>
          <section className="property-modal" role="dialog" aria-modal="true" aria-labelledby="lease-form-title" key={editingLeaseId ?? "new-lease"}>
            <div className="modal-heading">
              <div><p className="eyebrow">LEASE AGREEMENT</p><h2 id="lease-form-title">{isLeaseRenewal ? "Renew rent" : editingLeaseId ? "Modify lease agreement" : "Add lease agreement"}</h2><p>{isLeaseRenewal ? "Review the proposed renewal dates and rent before saving the new lease term." : "Record lease dates and payment terms for a tenant."}</p></div>
              <button className="modal-close" aria-label="Close form" disabled={leaseSaving} onClick={() => setIsLeaseFormOpen(false)}>×</button>
            </div>
            {tenants.length === 0 && !editingPaymentId ? (
              <div className="properties-empty"><p>Add a tenant before creating a lease agreement.</p><button className="secondary-button" onClick={() => { setIsLeaseFormOpen(false); setCurrentPage("tenants"); }}>Go to tenants</button></div>
            ) : (
              <form className="property-form" onSubmit={saveLease}>
                <div className="form-row">
                  <label>Tenant<select name="tenantId" value={leaseTenantId} onChange={(event) => {
                    const selectedTenant = tenants.find((tenant) => tenant.id === event.target.value);
                    const selectedProperty = properties.find((property) => property.id === selectedTenant?.propertyId);
                    setLeaseTenantId(event.target.value);
                    setLeaseTenantAddress([selectedProperty?.address, selectedProperty?.city, selectedProperty?.state].filter(Boolean).join(", "));
                  }} required><option value="" disabled>Select a tenant</option>{tenants.map((tenant) => {
                    const property = properties.find((item) => item.id === tenant.propertyId);
                    return <option key={tenant.id} value={tenant.id}>{tenant.name} — {property?.name ?? "Property unavailable"}</option>;
                  })}</select></label>
                  <label>Agreement reference <span className="optional-label">Optional</span><input name="reference" defaultValue={leases.find((lease) => lease.id === editingLeaseId)?.reference ?? ""} placeholder="Generated if left blank" /></label>
                </div>
                <div className="form-row">
                  <label>Landlord / owner name<input name="landlordName" value={leaseLandlordName} onChange={(event) => setLeaseLandlordName(event.target.value)} required /></label>
                  <label>Landlord address <span className="optional-label">Optional</span><input name="landlordAddress" value={leaseLandlordAddress} onChange={(event) => setLeaseLandlordAddress(event.target.value)} placeholder="Owner contact address" /><span className="field-hint">Prefilled from the landlord profile in Bank &amp; landlord details.</span></label>
                </div>
                <label>Tenant address <span className="optional-label">Optional</span><input name="tenantAddress" value={leaseTenantAddress} onChange={(event) => setLeaseTenantAddress(event.target.value)} /><span className="field-hint">Defaults to the assigned property address. Edit it if the tenant uses a different contact address.</span></label>
                <div className="form-row">
                  <label>Lease start date<input name="startDate" type="date" value={leaseStartDate} onChange={(event) => { setLeaseStartDate(event.target.value); setLeaseEndDate(calculateExpirationDate(event.target.value, leaseFrequency)); }} required /></label>
                  <label>Lease expiration date<input name="expirationDate" type="date" value={leaseEndDate} onChange={(event) => setLeaseEndDate(event.target.value)} required /></label>
                </div>
                <div className="form-row">
                  <div className="form-field-stack">
                    <label>Rent amount (₦)<input name="rentAmount" type="text" inputMode="numeric" pattern="[0-9,]*" value={leaseRentAmount} onChange={(event) => {
                      const digits = event.target.value.replace(/\D/g, "");
                      setLeaseRentAmount(digits.replace(/\B(?=(\d{3})+(?!\d))/g, ","));
                    }} required /><span className="field-hint">Amount due for each selected payment period.</span></label>
                    <label>Payment frequency<select name="paymentFrequency" value={leaseFrequency} onChange={(event) => { const nextFrequency = event.target.value as PaymentFrequency; setLeaseFrequency(nextFrequency); setLeaseEndDate(calculateExpirationDate(leaseStartDate, nextFrequency)); }} required>{paymentFrequencyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                  </div>
                  <div className="form-field-stack">
                    <label>Caution fee (₦) <span className="optional-label">Optional</span><input name="securityDeposit" type="text" inputMode="numeric" pattern="[0-9,]*" defaultValue={leases.find((lease) => lease.id === editingLeaseId)?.securityDeposit.toLocaleString("en-NG") ?? (isLeaseRenewal ? leaseCautionFee : "")} placeholder="e.g. 100,000" onChange={(event) => {
                      const digits = event.target.value.replace(/\D/g, "");
                      event.target.value = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
                    }} /></label>
                    <label>Agreement status<select name="status" value={leaseStatus} onChange={(event) => setLeaseStatus(event.target.value as "Draft" | "Active" | "Terminated")} required><option value="Draft">Draft</option><option value="Active">Active</option><option value="Terminated">Terminated</option></select></label>
                  </div>
                </div>
                <div className="lease-generated-document-note"><strong>Completed agreement generated automatically</strong><span>The saved landlord profile and assigned tenant, property, rent, and lease dates are filled in. A unique agreement reference is printed for matching it to the RentWise record. Signature and signing-date lines stay blank for the parties to sign.</span><span>This PDF is not cryptographically signed. A certificate or e-signing service is needed for digital signature verification.</span></div>
                <label>Additional lease document <span className="optional-label">Optional</span><input name="document" type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" /><span className="field-hint">Optional supporting PDF or Word document, up to 10 MB. It will be shared separately with the tenant.</span></label>
                {leases.find((lease) => lease.id === editingLeaseId)?.generatedDocumentName && <div className="document-current">Completed agreement: <strong>{leases.find((lease) => lease.id === editingLeaseId)?.generatedDocumentName}</strong></div>}
                {leases.find((lease) => lease.id === editingLeaseId)?.documentName && <div className="document-current">Current document: <strong>{leases.find((lease) => lease.id === editingLeaseId)?.documentName}</strong></div>}
                <label>Notes <span className="optional-label">Optional</span><textarea name="notes" rows={3} defaultValue={leases.find((lease) => lease.id === editingLeaseId)?.notes ?? ""} placeholder="Add any important terms or notes" /></label>
                <label>Witness name <span className="optional-label">Optional</span><input name="witnessName" defaultValue={leases.find((lease) => lease.id === editingLeaseId)?.witnessName ?? ""} placeholder="Witness full name" /><span className="field-hint">The witness signature and date remain blank for signing.</span></label>
                {leaseFormError && <p className="form-error" role="alert">{leaseFormError}</p>}
                {leaseSavingMessage && <p className="field-hint" role="status" aria-live="polite">{leaseSavingMessage}</p>}
                <div className="form-actions"><button type="button" className="secondary-button" disabled={leaseSaving} onClick={() => { setIsLeaseFormOpen(false); setIsLeaseRenewal(false); }}>Cancel</button><button className="primary-button" type="submit" disabled={leaseSaving}>{leaseSaving ? leaseSavingMessage : isLeaseRenewal ? "Save renewal" : editingLeaseId ? "Save changes" : "Save lease"}</button></div>
              </form>
            )}
          </section>
        </div>
      )}
      {isPaymentFormOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsPaymentFormOpen(false); }}>
          <section className="property-modal" role="dialog" aria-modal="true" aria-labelledby="payment-form-title" key={editingPaymentId ?? "new-payment"}>
            <div className="modal-heading">
              <div><p className="eyebrow">RENT MANAGEMENT</p><h2 id="payment-form-title">{editingPaymentId ? "Modify payment" : "Record payment"}</h2><p>Save a rent payment against a tenant.</p></div>
              <button className="modal-close" aria-label="Close form" onClick={() => setIsPaymentFormOpen(false)}>×</button>
            </div>
                {tenants.length === 0 && !standaloneEstateAgent ? (
              <div className="properties-empty"><p>Add a tenant before recording a payment.</p><button className="secondary-button" onClick={() => { setIsPaymentFormOpen(false); setCurrentPage("tenants"); }}>Go to tenants</button></div>
            ) : (
              <form className="property-form" onSubmit={addPayment}>
                {standaloneEstateAgent ? <><label>Payer / tenant name<input name="tenantName" defaultValue={rentPayments.find((payment) => payment.id === editingPaymentId)?.tenantName ?? ""} placeholder="Name of person who paid" required /></label><label>Property<select name="propertyId" defaultValue={rentPayments.find((payment) => payment.id === editingPaymentId)?.propertyId ?? ""} required><option value="" disabled>Select property</option>{properties.map((property) => <option key={property.id} value={property.id}>{property.name} — {property.city}</option>)}</select></label></> : <label>Tenant<select name="tenantId" defaultValue={rentPayments.find((payment) => payment.id === editingPaymentId)?.tenantId ?? ""} required={!editingPaymentId || Boolean(rentPayments.find((payment) => payment.id === editingPaymentId)?.tenantId)}><option value="" disabled={!editingPaymentId || Boolean(rentPayments.find((payment) => payment.id === editingPaymentId)?.tenantId)}>{editingPaymentId && !rentPayments.find((payment) => payment.id === editingPaymentId)?.tenantId ? "Property fee (no tenant)" : "Select a tenant"}</option>{tenants.map((tenant) => {
                  const property = properties.find((item) => item.id === tenant.propertyId);
                  return <option key={tenant.id} value={tenant.id}>{tenant.name} — {property?.name ?? "Property unavailable"}</option>;
                })}</select></label>}
                <div className="form-row">
                  <label>Payment amount (₦)<input name="amount" type="text" inputMode="numeric" pattern="[0-9,]*" defaultValue={rentPayments.find((payment) => payment.id === editingPaymentId)?.amount.toLocaleString("en-NG") ?? ""} placeholder="e.g. 250,000" onChange={(event) => {
                    const digits = event.target.value.replace(/\D/g, "");
                    event.target.value = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
                  }} required /></label>
                  <label>Date received<input name="paymentDate" type="date" value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} required /></label>
                </div>
                <div className="form-row">
                  <label>Payment method<select name="method" defaultValue={rentPayments.find((payment) => payment.id === editingPaymentId)?.method ?? ""} required><option value="" disabled>Select method</option><option>Not recorded</option><option>Bank transfer</option><option>Cash</option><option>POS</option><option>USSD</option><option>Cheque</option><option>Other</option></select></label>
                  <label>Rent period <span className="optional-label">Optional</span><input name="rentPeriod" defaultValue={rentPayments.find((payment) => payment.id === editingPaymentId)?.rentPeriod ?? ""} placeholder="e.g. Jan–Dec 2026" /></label>
                </div>
                <label>Payment status<select name="status" defaultValue={rentPayments.find((payment) => payment.id === editingPaymentId)?.status || "Pending"} required><option>Pending</option><option>Paid</option></select><span className="field-hint">Confirm payment only after funds are received. Decline renewal requests in Rent Renewals to return the payment as Rejected.</span></label>
                {leaseFormError && <p className="form-error" role="alert">{leaseFormError}</p>}
                <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setIsPaymentFormOpen(false)}>Cancel</button><button className="primary-button" type="submit">{editingPaymentId ? "Save changes" : "Save payment"}</button></div>
              </form>
            )}
          </section>
        </div>
      )}
      {isExpenseFormOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsExpenseFormOpen(false); }}>
          <section className="property-modal expense-modal" role="dialog" aria-modal="true" aria-labelledby="expense-form-title" key={editingExpenseId ?? "new-expense"}>
            <div className="modal-heading">
              <div><p className="eyebrow">PROPERTY COSTS</p><h2 id="expense-form-title">{editingExpenseId ? "Modify expense" : "Add an expense"}</h2><p>Record a cost against one of your properties.</p></div>
              <button className="modal-close" aria-label="Close form" onClick={() => setIsExpenseFormOpen(false)}>×</button>
            </div>
            {properties.length === 0 ? (
              <div className="properties-empty"><p>Add a property before recording an expense.</p><button className="secondary-button" onClick={() => { setIsExpenseFormOpen(false); setCurrentPage("properties"); }}>Go to properties</button></div>
            ) : (
              <form className="property-form" onSubmit={saveExpense}>
                <label>Property<select name="propertyId" defaultValue={properties.find((property) => property.id === editingExpenseId)?.id ?? expenses.find((expense) => expense.id === editingExpenseId)?.propertyId ?? ""} required><option value="" disabled>Select a property</option>{properties.map((property) => <option key={property.id} value={property.id}>{property.name} — {property.city}</option>)}</select></label>
                <div className="form-row">
                  <label>Expense category<select name="category" defaultValue={expenses.find((expense) => expense.id === editingExpenseId)?.category ?? ""} required><option value="" disabled>Select category</option><option>Repairs &amp; maintenance</option><option>Utilities</option><option>Security</option><option>Cleaning</option><option>Transportation</option><option>Fueling</option><option>Property tax / rates</option><option>Insurance</option><option>Management fees</option><option>Other</option></select></label>
                  <label>Expense date<input name="expenseDate" type="date" value={expenseDate} onChange={(event) => setExpenseDate(event.target.value)} required /></label>
                </div>
                <div className="form-row">
                  <label>Amount (₦)<input name="amount" type="text" inputMode="numeric" pattern="[0-9,]*" defaultValue={expenses.find((expense) => expense.id === editingExpenseId)?.amount.toLocaleString("en-NG") ?? ""} placeholder="e.g. 25,000" onChange={(event) => {
                    const digits = event.target.value.replace(/\D/g, "");
                    event.target.value = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
                  }} required /></label>
                  <label>Paid to <span className="optional-label">Optional</span><input name="paidTo" defaultValue={expenses.find((expense) => expense.id === editingExpenseId)?.paidTo ?? ""} placeholder="e.g. Plumber or service provider" /></label>
                </div>
                <label>Description <span className="optional-label">Optional</span><input name="description" defaultValue={expenses.find((expense) => expense.id === editingExpenseId)?.description ?? ""} placeholder="Add a short note about the expense" /></label>
                {leaseFormError && <p className="form-error" role="alert">{leaseFormError}</p>}
                <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setIsExpenseFormOpen(false)}>Cancel</button><button className="primary-button" type="submit">{editingExpenseId ? "Save changes" : "Save expense"}</button></div>
              </form>
            )}
          </section>
        </div>
      )}
      {isTenantFormOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsTenantFormOpen(false); }}>
          <section className="property-modal tenant-kyc-modal" role="dialog" aria-modal="true" aria-labelledby="tenant-form-title" key={editingTenantId ?? selectedTenantSignup?.id ?? "new-tenant"}>
            <div className="modal-heading">
              <div><p className="eyebrow">TENANCY KYC PROFILE</p><h2 id="tenant-form-title">{editingTenantId ? "Modify tenant profile" : selectedTenantSignup ? "Complete tenant signup" : "Add a tenant profile"}</h2><p>{selectedTenantSignup ? "Complete the tenant’s details and assign an available property." : "Capture biodata, identity, residence, work, emergency contact, and tenancy details."}</p></div>
              <button className="modal-close" aria-label="Close form" onClick={() => setIsTenantFormOpen(false)}>×</button>
            </div>
            {properties.length === 0 ? <div className="properties-empty"><p>Add a property before registering a tenant.</p><button className="secondary-button" onClick={() => { setIsTenantFormOpen(false); setCurrentPage("properties"); }}>Go to properties</button></div> : (
              <form className="property-form" noValidate onSubmit={addTenant}>
                {tenantFormError && <p className="form-error tenant-form-error-top" role="alert">{tenantFormError}</p>}
                <label>Tenant profile photo <span className="optional-label">Optional · JPG, PNG, or WebP · up to 8 MB</span><input name="photo" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" capture="user" /><span className="field-hint">Take a photo with the front camera or upload one. It will appear on the tenant profile across your signed-in devices. {tenants.find((tenant) => tenant.id === editingTenantId)?.photoName ? `Current photo: ${tenants.find((tenant) => tenant.id === editingTenantId)?.photoName}` : ""}</span></label>
                {editingTenantId && profilePhotoUrls[`tenant-${editingTenantId}`] && <img className="profile-photo-preview" src={profilePhotoUrls[`tenant-${editingTenantId}`]} alt="Current tenant profile" />}
                <label><span className="required-field-label">Tenant full name <b>*</b></span><input name="name" defaultValue={tenants.find((tenant) => tenant.id === editingTenantId)?.name ?? selectedTenantSignup?.applicantName ?? ""} placeholder="e.g. Amina Bello" required autoFocus /></label>
                <div className="form-row">
                  <label><span className="required-field-label">Phone number <b>*</b></span><input name="phone" type="tel" inputMode="numeric" maxLength={11} pattern="[0-9]{1,11}" defaultValue={tenants.find((tenant) => tenant.id === editingTenantId)?.phone ?? selectedTenantSignup?.phone ?? ""} placeholder="e.g. 08031234567" onChange={(event) => { event.currentTarget.value = event.currentTarget.value.replace(/\D/g, "").slice(0, 11); }} required /><span className="field-hint">Enter up to 11 digits.</span></label>
                  <label>Email address <span className="optional-label">Optional</span><input name="email" type="email" defaultValue={tenants.find((tenant) => tenant.id === editingTenantId)?.email ?? selectedTenantSignup?.email ?? ""} placeholder="name@example.com" readOnly={Boolean(selectedTenantSignup)} /><span className="field-hint">If the tenant will self-link using your landlord code, enter the same email they will use to sign up.</span></label>
                </div>
                {(() => { const tenant = tenants.find((item) => item.id === editingTenantId); return <>
                  <section className="tenant-kyc-section"><div className="tenant-kyc-heading"><span>01</span><div><h3>Personal details</h3><p>Basic biodata for the tenant profile.</p></div></div><div className="form-row"><label><span className="required-field-label">Gender <b>*</b></span><select name="gender" defaultValue={tenant?.gender ?? ""} required><option value="">Select gender</option><option>Female</option><option>Male</option><option>Other</option><option>Prefer not to say</option></select></label><label>Nationality<input name="nationality" defaultValue={tenant?.nationality ?? "Nigerian"} /></label></div><label>Marital status <span className="optional-label">Optional</span><select name="maritalStatus" defaultValue={tenant?.maritalStatus ?? ""}><option value="">Select if provided</option><option>Single</option><option>Married</option><option>Divorced</option><option>Widowed</option><option>Prefer not to say</option></select></label></section>
                  <section className="tenant-kyc-section"><div className="tenant-kyc-heading"><span>02</span><div><h3>Residential address</h3><p>Record the tenant’s current contact address, if different from the rental property.</p></div></div><label>Current residential address <span className="optional-label">Optional</span><input name="residentialAddress" defaultValue={tenant?.residentialAddress ?? ""} autoComplete="street-address" /></label><div className="form-row"><label>City / town<input name="residentialCity" defaultValue={tenant?.residentialCity ?? ""} /></label><label>State<select name="residentialState" defaultValue={tenant?.residentialState ?? ""}><option value="">Select state</option>{["Abia","Adamawa","Akwa Ibom","Anambra","Bauchi","Bayelsa","Benue","Borno","Cross River","Delta","Ebonyi","Edo","Ekiti","Enugu","FCT Abuja","Gombe","Imo","Jigawa","Kaduna","Kano","Katsina","Kebbi","Kogi","Kwara","Lagos","Nasarawa","Niger","Ogun","Ondo","Osun","Oyo","Plateau","Rivers","Sokoto","Taraba","Yobe","Zamfara"].map((state) => <option key={state}>{state}</option>)}</select></label></div></section>
                  <section className="tenant-kyc-section"><div className="tenant-kyc-heading"><span>03</span><div><h3>Employment details</h3><p>Occupation is required; employer details are optional.</p></div></div><div className="form-row"><label><span className="required-field-label">Occupation / job title <b>*</b></span><input name="occupation" defaultValue={tenant?.occupation ?? ""} required /></label><label>Employer / business name<input name="employerName" defaultValue={tenant?.employerName ?? ""} /></label></div><label>Employer / business address<input name="employerAddress" defaultValue={tenant?.employerAddress ?? ""} /></label></section>
                  <section className="tenant-kyc-section"><div className="tenant-kyc-heading"><span>04</span><div><h3>Guarantor</h3><p>Optional reference details for the landlord’s tenancy checks.</p></div></div><div className="form-row"><label>Full name<input name="guarantorName" defaultValue={tenant?.guarantorName ?? ""} /></label><label>Phone number<input name="guarantorPhone" type="tel" defaultValue={tenant?.guarantorPhone ?? ""} /></label></div><div className="form-row"><label>Email address<input name="guarantorEmail" type="email" defaultValue={tenant?.guarantorEmail ?? ""} /></label><label>Residential address<input name="guarantorAddress" defaultValue={tenant?.guarantorAddress ?? ""} /></label></div></section>
                  <div className="tenant-kyc-privacy">KYC information is stored with the tenant record and is available to authorized property staff. Collect only information the tenant has agreed to provide and keep it up to date.</div>
                </>; })()}
                <label>Property<select name="propertyId" defaultValue={tenants.find((tenant) => tenant.id === editingTenantId)?.propertyId ?? ""} onChange={() => setTenantFormError("")} required><option value="" disabled>Select a property</option>{properties.map((property) => {
                  const availableUnits = getAvailableUnits(property, editingTenantId);
                  return <option key={property.id} value={property.id} disabled={availableUnits === 0}>{property.name} — {property.city} ({availableUnits} available)</option>;
                })}</select></label>
                <div className="form-row">
                  <div className="form-field-stack">
                    <label>Rent amount (₦)<input name="monthlyRent" type="text" inputMode="numeric" pattern="[0-9,]*" defaultValue={tenants.find((tenant) => tenant.id === editingTenantId)?.monthlyRent.toLocaleString("en-NG") ?? ""} placeholder="e.g. 250,000" onChange={(event) => {
                      const digits = event.target.value.replace(/\D/g, "");
                      event.target.value = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
                    }} required /><span className="field-hint">Amount due for each selected payment period.</span></label>
                    <label>Payment frequency<select name="paymentFrequency" value={rentalFrequency} onChange={(event) => {
                      const nextFrequency = event.target.value as PaymentFrequency;
                      setRentalFrequency(nextFrequency);
                      setRentalExpirationDate(calculateExpirationDate(rentalStartDate, nextFrequency));
                    }} required>{paymentFrequencyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                  </div>
                  <div className="form-field-stack">
                    <label>Rented date<input name="rentedDate" type="date" value={rentalStartDate} onChange={(event) => {
                      const nextDate = event.target.value;
                      setRentalStartDate(nextDate);
                      setRentalExpirationDate(calculateExpirationDate(nextDate, rentalFrequency));
                    }} required /></label>
                    <label>Expiration date<input name="expirationDate" type="date" value={rentalExpirationDate} onChange={(event) => setRentalExpirationDate(event.target.value)} required /><span className="field-hint">Calculated automatically; you can change it.</span></label>
                  </div>
                </div>
                <label className="whatsapp-consent-field"><span className="whatsapp-consent-control"><input name="whatsappRemindersOptIn" type="checkbox" defaultChecked={tenants.find((tenant) => tenant.id === editingTenantId)?.whatsappRemindersOptIn === true} /><span><strong>Tenant consented to WhatsApp rent reminders</strong><small>Only select this after the tenant has agreed to receive rent expiry reminders on WhatsApp. Portal notifications do not require WhatsApp consent.</small></span></span></label>
                {leaseFormError && <p className="form-error" role="alert">{leaseFormError}</p>}
                <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setIsTenantFormOpen(false)}>Cancel</button><button className="primary-button" type="submit">{editingTenantId ? "Save changes" : "Save tenant"}</button></div>
              </form>
            )}
          </section>
        </div>
      )}
      {editingAccount && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditingAccount(null); }}>
          <section className="property-modal account-modal" role="dialog" aria-modal="true" aria-labelledby="edit-account-title">
            <div className="modal-heading"><div><p className="eyebrow">USER ACCOUNT</p><h2 id="edit-account-title">Modify user</h2><p>Update the account name and sign-in email.</p></div><button className="modal-close" aria-label="Close form" onClick={() => setEditingAccount(null)}>×</button></div>
            <form className="property-form" onSubmit={(event) => void saveAccountDetails(event)}><label>Full name<input name="name" defaultValue={editingAccount.name} required minLength={2} maxLength={100} /></label><label>Email address<input name="email" type="email" defaultValue={editingAccount.email} required /></label>{accountError && <div className="form-error" role="alert">{accountError}</div>}<div className="form-actions"><button type="button" className="secondary-button" onClick={() => setEditingAccount(null)}>Cancel</button><button className="primary-button" disabled={accountBusy}>{accountBusy ? "Saving…" : "Save changes"}</button></div></form>
          </section>
        </div>
      )}
      {resettingAccount && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setResettingAccount(null); }}>
          <section className="property-modal account-modal" role="dialog" aria-modal="true" aria-labelledby="reset-account-title">
            <div className="modal-heading"><div><p className="eyebrow">ACCOUNT SECURITY</p><h2 id="reset-account-title">Reset password</h2><p>Set a new password for {resettingAccount.name}. Use at least 12 characters.</p></div><button className="modal-close" aria-label="Close form" onClick={() => setResettingAccount(null)}>×</button></div>
            <form className="property-form" onSubmit={(event) => void resetAccountPassword(event)}><label>New password<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={200} required autoFocus /></label>{accountError && <div className="form-error" role="alert">{accountError}</div>}<div className="form-actions"><button type="button" className="secondary-button" onClick={() => setResettingAccount(null)}>Cancel</button><button className="primary-button" disabled={accountBusy}>{accountBusy ? "Resetting…" : "Reset password"}</button></div></form>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
