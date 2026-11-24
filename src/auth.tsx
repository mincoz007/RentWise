import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { RoleId } from "../server/auth";
import type { StoredPlanId } from "./plan-catalog";
import "./Auth.css";

export type { RoleId };
export type SubscriptionPlanId = StoredPlanId;
export type AuthUser = { id: string; name: string; email: string; role: RoleId; tenantId?: string; organizationId?: string; landlordId?: string; landlordCode?: string; subscriptionPlan?: SubscriptionPlanId; subscriptionInterval?: "monthly" | "annually"; subscriptionStartAt?: string; subscriptionDurationDays?: number; subscriptionExpiresAt?: string; subscriptionStatus?: "active" | "expired" | "suspended"; subscriptionLastNotifiedAt?: string; subscriptionRemainingDays?: number | null; active: boolean; createdAt: string };
type AccountUpdate = Partial<Pick<AuthUser, "name" | "email" | "role" | "tenantId" | "organizationId" | "active">> & { password?: string; subscriptionPlan?: SubscriptionPlanId | null; subscriptionDurationDays?: number };
type AuthContextValue = { user: AuthUser; logout: () => Promise<void>; listUsers: () => Promise<AuthUser[]>; createAccount: (input: { name: string; email: string; password: string; role: RoleId; tenantId?: string; organizationId?: string; landlordId?: string; phone?: string }) => Promise<AuthUser>; updateAccount: (id: string, input: AccountUpdate) => Promise<AuthUser>; deleteAccount: (id: string) => Promise<void>; linkLandlord: (landlordCode: string, phone?: string) => Promise<{ user: AuthUser; tenantRecordLinked: boolean }> };
const AuthContext = createContext<AuthContextValue | null>(null);
export function useAuth() { const value = useContext(AuthContext); if (!value) throw new Error("useAuth must be used inside AuthGate."); return value; }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...init?.headers } });
  } catch {
    throw new Error("Cannot connect to RentWise. Check your network and make sure the host computer is running the app.");
  }
  let payload: (T & { error?: string }) | undefined;
  try { payload = await response.json() as T & { error?: string }; }
  catch { payload = undefined; }
  if (!response.ok) throw new Error(payload?.error ?? (response.status >= 500 ? `RentWise server error (${response.status}). Please retry or contact your administrator.` : "The request could not be completed."));
  if (!payload) throw new Error("RentWise received an unreadable response from the server. Please retry.");
  return payload;
}

const roleLabels: Record<RoleId, string> = { super_admin: "Super Administrator", platform_admin: "Platform Administrator", landlord_owner: "Landlord / Organization Owner", property_manager: "Property Manager", estate_agent: "Estate Agent", resident_tenant: "Resident / Tenant" };

export function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [isSignup, setIsSignup] = useState(false);
  const [signupRole, setSignupRole] = useState<"landlord_owner" | "resident_tenant" | "estate_agent">("landlord_owner");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [accountEmailEnabled, setAccountEmailEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState<"forgot" | "reset" | null>(null);
  const [recoveryToken, setRecoveryToken] = useState("");
  const [showResendVerification, setShowResendVerification] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const authAction = fragment.get("authAction") ?? query.get("authAction");
    const actionToken = fragment.get("token") ?? query.get("token") ?? "";
    if (authAction === "reset-password" && actionToken) {
      setRecoveryMode("reset"); setRecoveryToken(actionToken);
      window.history.replaceState({}, "", window.location.pathname);
    } else if (authAction === "verify-email" && actionToken) {
      void api<{ message: string }>("/api/auth/email/verify", { method: "POST", body: JSON.stringify({ token: actionToken }) })
        .then((result) => setSuccess(result.message))
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Email verification could not be completed."));
      window.history.replaceState({}, "", window.location.pathname);
    }
    const errorCode = query.get("authError");
    if (errorCode) {
      const messages: Record<string, string> = { google_state_invalid: "Google sign-in expired. Please try again.", google_cancelled: "Google sign-in was cancelled.", google_callback_failed: "Google sign-in could not be completed. Please try again.", google_not_configured: "Google sign-in needs to be configured by the system administrator.", google_email_unverified: "Google did not confirm this email address.", google_signup_required: "No RentWise account uses that Google email yet. Choose Create account to register.", google_account_disabled: "This RentWise account is disabled. Contact your administrator.", landlord_code_invalid: "The landlord code was not found. Check it with your landlord and try again." };
      setError(messages[errorCode] ?? "Google sign-in could not be completed.");
      if (errorCode === "google_signup_required") setIsSignup(true);
      window.history.replaceState({}, "", window.location.pathname);
    }
    void api<{ user: AuthUser | null; needsSetup: boolean; googleEnabled: boolean; accountEmailEnabled: boolean }>("/api/auth/session").then((session) => { setUser(session.user); setNeedsSetup(session.needsSetup); setGoogleEnabled(session.googleEnabled); setAccountEmailEnabled(session.accountEmailEnabled); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not connect to the sign-in service.")).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!user || user.role !== "resident_tenant" || user.tenantId) return;
    const timer = window.setInterval(() => {
      void api<{ user: AuthUser | null }>("/api/auth/session").then((session) => {
        if (session.user?.tenantId && (session.user.tenantId !== user.tenantId || session.user.organizationId !== user.organizationId)) setUser(session.user);
      }).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const timeoutMs = 5 * 60 * 1000;
    let lastActivity = Date.now();
    let ended = false;
    let heartbeat = 0;
    let timer = 0;
    const expireSession = () => {
      if (ended) return;
      ended = true;
      window.clearInterval(timer);
      window.clearInterval(heartbeat);
      void api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => undefined);
      setUser(null);
      setError("Your session ended after 5 minutes of inactivity. Sign in again to continue.");
    };
    const markActivity = () => {
      if (Date.now() - lastActivity >= timeoutMs) { expireSession(); return; }
      lastActivity = Date.now();
    };
    heartbeat = window.setInterval(() => {
      void api<{ user: AuthUser | null }>("/api/auth/session").then((session) => {
        if (!session.user) { expireSession(); return; }
        const latest = session.user;
        if (latest.subscriptionPlan !== user.subscriptionPlan || latest.subscriptionInterval !== user.subscriptionInterval || latest.subscriptionExpiresAt !== user.subscriptionExpiresAt || latest.organizationId !== user.organizationId || latest.tenantId !== user.tenantId) setUser(latest);
      }).catch(() => undefined);
    }, 60_000);
    timer = window.setInterval(() => { if (Date.now() - lastActivity >= timeoutMs) expireSession(); }, 1000);
    const events: Array<keyof WindowEventMap> = ["pointerdown", "pointermove", "keydown", "touchstart", "wheel"];
    for (const eventName of events) window.addEventListener(eventName, markActivity, { passive: true });
    return () => {
      window.clearInterval(heartbeat);
      window.clearInterval(timer);
      for (const eventName of events) window.removeEventListener(eventName, markActivity);
    };
  }, [user]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const password = String(form.get("password") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");
    if ((needsSetup || isSignup || recoveryMode === "reset") && password !== confirmPassword) { setError("Password and confirmation do not match."); return; }
    setError(""); setBusy(true);
    try {
      if (recoveryMode === "forgot") {
        const result = await api<{ message: string }>("/api/auth/password/forgot", { method: "POST", body: JSON.stringify({ email: form.get("email") }) });
        setSuccess(result.message); return;
      }
      if (recoveryMode === "reset") {
        const result = await api<{ message: string }>("/api/auth/password/reset", { method: "POST", body: JSON.stringify({ token: recoveryToken, password, confirmPassword }) });
        setRecoveryMode(null); setRecoveryToken(""); setSuccess(result.message); formElement.reset(); return;
      }
      const endpoint = needsSetup ? "/api/auth/setup" : isSignup ? "/api/auth/signup" : "/api/auth/login";
      const result = await api<{ user: AuthUser; needsTenantLink?: boolean; landlordMapped?: boolean; tenantRecordLinked?: boolean; verificationEmailSent?: boolean }>(endpoint, { method: "POST", body: JSON.stringify({ name: form.get("name"), email: form.get("email"), password, ...((needsSetup || isSignup) ? { confirmPassword } : {}), ...(isSignup ? { role: signupRole, ...(signupRole === "resident_tenant" ? { landlordCode: form.get("landlordCode"), phone: form.get("phone") } : {}) } : {}) }) });
      if (isSignup) {
        setIsSignup(false);
        setSuccess(result.verificationEmailSent ? "Account created. Check your inbox for a 24-hour email verification link. Verify your address before signing in." : "Account created, but RentWise could not send the verification email. Use Resend verification after the email service is fixed.");
        formElement.reset();
        return;
      }
      setUser(result.user); setNeedsSetup(false);
    } catch (reason) { const message = reason instanceof Error ? reason.message : "Sign in failed."; setError(message); setShowResendVerification(message.startsWith("Verify your email")); }
    finally { setBusy(false); }
  }
  async function resendVerification() {
    const form = document.querySelector<HTMLFormElement>(".auth-card");
    const email = String(new FormData(form ?? undefined).get("email") ?? "");
    setError(""); setBusy(true);
    try { const result = await api<{ message: string }>("/api/auth/email/resend", { method: "POST", body: JSON.stringify({ email }) }); setSuccess(result.message); setShowResendVerification(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not resend the verification email."); }
    finally { setBusy(false); }
  }
  const isForgotPassword = recoveryMode === "forgot";
  const isPasswordReset = recoveryMode === "reset";
  async function logout() { try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } finally { setUser(null); } }
  const value: AuthContextValue | null = user ? {
    user, logout,
    async listUsers() { return (await api<{ users: AuthUser[] }>("/api/users")).users; },
    async createAccount(input) { return (await api<{ user: AuthUser }>("/api/users", { method: "POST", body: JSON.stringify(input) })).user; },
    async updateAccount(id, input) { const updated = (await api<{ user: AuthUser }>(`/api/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) })).user; if (updated.id === user.id) setUser(updated); return updated; },
    async deleteAccount(id) { await api(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" }); },
    async linkLandlord(landlordCode, phone) { const result = await api<{ user: AuthUser; tenantRecordLinked: boolean }>("/api/auth/link-landlord", { method: "POST", body: JSON.stringify({ landlordCode, phone }) }); setUser(result.user); return result; },
  } : null;

  if (loading) return <div className="auth-loading">Loading RentWise…</div>;
  if (!user) return <main className="auth-screen"><div className="auth-background-carousel" aria-hidden="true"><span style={{ backgroundImage: "url('/auth-minds-headquarters.png')" }} /><span style={{ backgroundImage: "url('/auth-property-building.jpeg')" }} /><span style={{ backgroundImage: "url('/auth-modern-home.jpg')" }} /></div><div className="auth-background-shade" aria-hidden="true" /><form className="auth-card" onSubmit={(event) => void submit(event)}>
    <div className="auth-brand"><span className="auth-mark">R</span><div><strong>RentWise NG</strong><span>PROPERTY MANAGEMENT</span></div></div>
    <p className="auth-eyebrow">{needsSetup ? "FIRST TIME SETUP" : isSignup ? "CREATE AN ACCOUNT" : isForgotPassword || isPasswordReset ? "ACCOUNT RECOVERY" : "SECURE SIGN IN"}</p>
    <h1>{needsSetup ? "Create your Super Admin account" : isSignup ? "Get started with RentWise" : isForgotPassword ? "Reset your password" : isPasswordReset ? "Choose a new password" : "Welcome back"}</h1>
    <p className="auth-subtitle">{needsSetup ? "This first account has full system access and controls role assignments." : isSignup ? "Landlords, tenants, and estate agents can register here. Other roles are assigned by an administrator." : isForgotPassword ? "Enter your account email and we’ll send a secure reset link if the account is active." : isPasswordReset ? "Choose a new password. This reset link expires after 30 minutes and can only be used once." : "Sign in with the email and password assigned to your role."}</p>
    <p className="auth-session-note">For security, you’ll be signed out after 5 minutes without activity.</p>
    {(needsSetup || isSignup) && <label>Full name<input name="name" autoComplete="name" required minLength={2} maxLength={100} /></label>}
    {isSignup && <label>Register as<select value={signupRole} onChange={(event) => setSignupRole(event.target.value as "landlord_owner" | "resident_tenant" | "estate_agent")}><option value="landlord_owner">Landlord / Organization Owner</option><option value="resident_tenant">Resident / Tenant</option><option value="estate_agent">Estate Agent</option></select></label>}
    <label>Email address<input name="email" type="email" autoComplete="email" required /></label>
    {!isForgotPassword && <label>{isPasswordReset ? "New password" : "Password"}<div className="auth-password-control"><input name="password" type={showPassword ? "text" : "password"} autoComplete={needsSetup || isSignup || isPasswordReset ? "new-password" : "current-password"} minLength={needsSetup || isSignup || isPasswordReset ? 12 : 1} required /><button type="button" className="auth-password-toggle" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? "Hide" : "Show"}</button></div>{(needsSetup || isSignup || isPasswordReset) && <small>Use at least 12 characters.</small>}</label>}
    {(needsSetup || isSignup || isPasswordReset) && <label>Confirm password<div className="auth-password-control"><input name="confirmPassword" type={showConfirmPassword ? "text" : "password"} autoComplete="new-password" minLength={12} required /><button type="button" className="auth-password-toggle" onClick={() => setShowConfirmPassword((visible) => !visible)} aria-label={showConfirmPassword ? "Hide confirmation" : "Show confirmation"}>{showConfirmPassword ? "Hide" : "Show"}</button></div></label>}
    {isSignup && signupRole === "resident_tenant" && <><label>Landlord code <span className="optional-label">Optional</span><input name="landlordCode" autoCapitalize="characters" autoComplete="off" placeholder="e.g. RW-AB12CD34" /></label><label>Phone on your tenant record <span className="optional-label">Optional if your email matches</span><input name="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="Enter the phone number your landlord has on file" /></label><div className="auth-note">Ask your landlord for this code. RentWise matches your signup email first, then the phone number above, to connect your tenant record.</div></>}
    {error && <div className="auth-error" role="alert">{error}</div>}
    {success && <div className="auth-success" role="status">{success}</div>}
    {showResendVerification && <button className="auth-mode-toggle" type="button" disabled={busy} onClick={() => void resendVerification()}>Resend verification email</button>}
    {isSignup && !accountEmailEnabled && <p className="google-setup-hint">Email verification is not configured. Ask the administrator to set up server email before creating accounts.</p>}
    <button className="auth-submit" disabled={busy || isSignup && !accountEmailEnabled}>{busy ? "Please wait…" : needsSetup ? "Create Super Admin account" : isSignup ? "Create account" : isForgotPassword ? "Send reset link" : isPasswordReset ? "Update password" : "Sign in"}</button>
    {!needsSetup && <>{!isForgotPassword && !isPasswordReset && <>{!isSignup && <button className="auth-mode-toggle" type="button" onClick={() => { setRecoveryMode("forgot"); setError(""); setSuccess(""); setShowResendVerification(false); }}>Forgot password?</button>}<div className="auth-divider"><span>or</span></div><button className="google-button" type="button" disabled={!googleEnabled} onClick={() => { const code = new FormData(document.querySelector<HTMLFormElement>(".auth-card") ?? undefined).get("landlordCode"); const query = new URLSearchParams({ mode: isSignup ? "signup" : "login", ...(isSignup ? { role: signupRole } : {}), ...(isSignup && signupRole === "resident_tenant" && code ? { landlordCode: String(code) } : {}) }); window.location.href = `/api/auth/google?${query.toString()}`; }}><span className="google-g">G</span>{isSignup ? "Sign up" : "Continue"} with Google</button>{!googleEnabled && <p className="google-setup-hint">Google sign-in is not configured yet. The administrator needs to add Google OAuth credentials.</p>}</> }<button className="auth-mode-toggle" type="button" onClick={() => { if (recoveryMode) setRecoveryMode(null); else setIsSignup((current) => !current); setError(""); setSuccess(""); setShowResendVerification(false); }}>{recoveryMode ? "Back to sign in" : isSignup ? "Already have an account? Sign in" : "New to RentWise? Create an account"}</button></>}
    <div className="auth-owner-brand"><img src="/minds-technologies-logo.png" alt="MINDS Technologies — Let’s Solve It." /><span>RentWise is owned by MINDS Technologies</span></div>
  </form></main>;
  return <AuthContext.Provider value={value!}>{children}</AuthContext.Provider>;
}

export { roleLabels };
