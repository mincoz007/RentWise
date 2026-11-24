export type PlanLimitKey = "properties" | "units" | "tenants" | "staff" | "storageMb" | "monthlyNotifications";
export type SubscriptionPlanConfig = {
  id: "free_starter" | "basic" | "professional" | "business" | "enterprise";
  name: string;
  label: string;
  monthlyPrice: number | null;
  annualPrice: number | null;
  audience: string;
  limits: Record<PlanLimitKey, number | null>;
  features: {
    tenantPortal: boolean;
    reminders: "none" | "basic" | "advanced" | "custom";
    expenses: "none" | "basic" | "yes" | "advanced";
    maintenance: "basic" | "advanced";
    reports: "basic" | "advanced" | "custom";
    documents: "basic" | "yes";
    auditLogs: "none" | "basic" | "advanced";
    apiAccess: boolean;
  };
  bullets: string[];
};

export const subscriptionPlans = [
  {
    id: "free_starter", name: "Free Starter", label: "Entry plan", monthlyPrice: 0, annualPrice: 0,
    audience: "For individuals testing RentWise NG or managing a small rental portfolio.",
    limits: { properties: 1, units: 3, tenants: 3, staff: 0, storageMb: 100, monthlyNotifications: 50 },
    features: { tenantPortal: false, reminders: "none", expenses: "none", maintenance: "basic", reports: "basic", documents: "basic", auditLogs: "none", apiAccess: false },
    bullets: ["1 property", "Up to 3 rental units", "Up to 3 tenants", "Basic tenant records", "Manual rent payment recording", "Basic rent status dashboard", "Basic maintenance records", "Standard support"],
  },
  {
    id: "basic", name: "Basic", label: "For small landlords", monthlyPrice: 3500, annualPrice: 35000,
    audience: "For small landlords getting their rental records organized.",
    limits: { properties: 3, units: 15, tenants: 15, staff: 0, storageMb: 1024, monthlyNotifications: 500 },
    features: { tenantPortal: false, reminders: "basic", expenses: "basic", maintenance: "basic", reports: "basic", documents: "basic", auditLogs: "none", apiAccess: false },
    bullets: ["Up to 3 properties", "Up to 15 rental units", "Up to 15 tenants", "Tenant profiles and tenancy records", "Rent collection tracking", "Payment history and receipts", "Rent due and overdue tracking", "Maintenance requests", "Basic financial reports", "1 account administrator"],
  },
  {
    id: "professional", name: "Professional", label: "Recommended", monthlyPrice: 8500, annualPrice: 85000,
    audience: "For growing landlords who need tenant self-service and richer reporting.",
    limits: { properties: 10, units: 60, tenants: 60, staff: 3, storageMb: 5120, monthlyNotifications: 3000 },
    features: { tenantPortal: true, reminders: "advanced", expenses: "yes", maintenance: "advanced", reports: "advanced", documents: "yes", auditLogs: "basic", apiAccess: false },
    bullets: ["Up to 10 properties", "Up to 60 rental units", "Up to 60 tenants", "Everything in Basic", "Tenant portal access", "Automated rent reminders", "Lease and document management", "Expense tracking", "Advanced financial reports", "Maintenance assignment and tracking", "Up to 3 staff accounts", "Property performance overview"],
  },
  {
    id: "business", name: "Business", label: "For agencies", monthlyPrice: 18500, annualPrice: 185000,
    audience: "For agencies coordinating multiple owners and property teams.",
    limits: { properties: 30, units: 200, tenants: 200, staff: 10, storageMb: 20480, monthlyNotifications: 15000 },
    features: { tenantPortal: true, reminders: "advanced", expenses: "advanced", maintenance: "advanced", reports: "advanced", documents: "yes", auditLogs: "advanced", apiAccess: false },
    bullets: ["Up to 30 properties", "Up to 200 rental units", "Up to 200 tenants", "Everything in Professional", "Up to 10 staff accounts", "Role-based staff permissions", "Agent and landlord management", "Multiple property owners", "Consolidated financial reporting", "Customizable rent reminders", "Tenant communication records", "Audit trail and activity logs", "Priority support"],
  },
  {
    id: "enterprise", name: "Enterprise", label: "Premium", monthlyPrice: null, annualPrice: null,
    audience: "For large property management firms and institutional property owners.",
    limits: { properties: null, units: null, tenants: null, staff: null, storageMb: null, monthlyNotifications: null },
    features: { tenantPortal: true, reminders: "custom", expenses: "advanced", maintenance: "advanced", reports: "custom", documents: "yes", auditLogs: "advanced", apiAccess: true },
    bullets: ["Custom pricing", "Unlimited portfolio under fair-use policy", "Everything in Business", "Custom staff and role permissions", "Multiple branches or offices", "Advanced financial analytics", "Custom reporting", "API and integration access", "Dedicated account management", "Priority technical support", "Custom onboarding and training"],
  },
] as const satisfies readonly SubscriptionPlanConfig[];

export type PlanId = (typeof subscriptionPlans)[number]["id"];
export type LegacyPlanId = "landlord_plus" | "manager_pro";
export type StoredPlanId = PlanId | LegacyPlanId;
export type SubscriptionInterval = "monthly" | "annually";

const legacyPlanMap: Record<LegacyPlanId, PlanId> = { landlord_plus: "professional", manager_pro: "enterprise" };

export function normalizePlanId(planId: StoredPlanId | string | undefined): PlanId | undefined {
  if (!planId) return undefined;
  if (planId === "landlord_plus" || planId === "manager_pro") return legacyPlanMap[planId];
  return subscriptionPlans.find((plan) => plan.id === planId)?.id;
}

export function getSubscriptionPlan(planId: StoredPlanId | string | undefined) {
  const normalized = normalizePlanId(planId);
  return subscriptionPlans.find((plan) => plan.id === normalized);
}
