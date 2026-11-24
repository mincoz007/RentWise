# RentWise NG

## Connect PostgreSQL with pgAdmin 4

1. Open pgAdmin 4 and connect to your local PostgreSQL server. Create a database named `rentwise` (or choose another name). For an app-specific login, create a Login/Group Role with **Can login** enabled, set a strong password, then create the database with that role as its owner.
2. In the project folder, copy `.env.example` to `.env` and set `DATABASE_URL` to your local connection. For example:

   ```text
   DATABASE_URL=postgresql://rentwise_app:your_password@localhost:5432/rentwise
   ```

   Percent-encode reserved characters in the password. Keep `.env` private; it is ignored by Git.
3. In PowerShell, run:

   ```powershell
   npm.cmd run db:check
   npm.cmd run dev -- --port 5173 --strictPort
   ```

   The first API request creates the application tables. To create them manually, open the `rentwise` database in pgAdmin 4, open **Tools → Query Tool**, and run [`database/schema.sql`](database/schema.sql).
4. Sign in. Existing accounts in `data/rentwise-users.json` are imported once into PostgreSQL, preserving their password hashes. When the Super Admin signs in for the first time, the app imports the current browser’s RentWise records and stored lease documents, receipts, and maintenance images. Keep your old JSON backup and browser data until you confirm the records are visible.

RentWise stores accounts in `rentwise_users`, organization-scoped application collections in `rentwise_app_data`, and uploaded files in `rentwise_attachments`. The server checks each role’s collection write access and restricts tenant data to the linked tenant record. Use pgAdmin’s **Backup…** action on the `rentwise` database for a full PostgreSQL backup. The app’s backup module remains useful for exporting a portable JSON copy.

PostgreSQL must be installed and running locally, and `.env` must contain a valid connection before sign-in can load. During development, Vite provides the API and runs its local reminder scheduler; use `npm.cmd run dev` as before.

## Production API and background worker

Production uses a standalone Node API process and a separately managed worker. Vite is only used to build the browser app. Use Node.js 22.12 or newer, configure the private `.env`, and set OAuth callback/public URLs to the HTTPS production domain. Keep database and provider secrets out of `VITE_` variables.

From the project folder, build and launch the API and worker in separate terminals:

```powershell
npm ci
npm run build
npm run start
```

In a second terminal, from the same project folder:

```powershell
npm run start:worker
```

The API serves the built web app from `dist` and handles `/api/*`. It binds to `127.0.0.1:3000` by default. Put it behind an HTTPS reverse proxy for internet use. For a trusted local network deployment, set `HOST=0.0.0.0` and `PORT=3000` in the server environment and allow the port only on the intended private network. Production cookies are marked `Secure`, so serve the app over HTTPS.

The worker runs rent reminders and subscription expiry checks every minute. Run exactly one worker instance for this deployment. Both processes write structured JSON logs to stdout/stderr; a process manager should capture and rotate those logs.

Health checks (no sign-in required):

- `GET /health/live` checks that the API process responds.
- `GET /health/ready` checks the PostgreSQL connection and returns `503` if the database is unavailable.
- Equivalent API paths are available at `/api/health/live` and `/api/health/ready`.

For automatic restarts, the included [`ecosystem.config.cjs`](ecosystem.config.cjs) configures PM2 to manage the API and worker as separate single-instance processes. Install PM2 for the deployment account, then run:

```powershell
npm install --global pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 status
```

On Windows, use Task Scheduler to run `pm2 resurrect` at system startup under the same Windows account that owns the project and `.env`. Set the task to restart on failure and avoid starting a second copy when it is already running. After changing code, rebuild and reload both processes with `npm run build`, `pm2 reload ecosystem.config.cjs`, then verify `/health/ready` and `pm2 status`.

## Google sign-in

Google sign-in uses a Google OAuth Web application client. Add this exact local callback URL as an authorized redirect URI and fill in the Google values in `.env`:

```text
http://localhost:5173/api/auth/google/callback
```

For production, use `https://your-domain.example/api/auth/google/callback` and register the same URL in Google Cloud. After changing `.env`, restart Vite during development or restart the API process in production. Initial Super Administrator setup must be completed before public Landlord or Resident/Tenant sign-up is enabled.

## Email verification and account recovery

Public password-based signup requires email delivery. RentWise sends verification and password-reset messages through Resend; configure these values in the private server `.env` and restart the API:

```dotenv
RESEND_API_KEY=re_...
RENTWISE_EMAIL_FROM=RentWise NG <accounts@your-verified-domain.example>
RENTWISE_PUBLIC_URL=https://your-public-domain.example
```

Verify the sender domain in Resend and use the same public HTTPS site URL users open. The first Super Administrator setup and accounts created by an administrator are treated as verified. New public password signups must verify their email before signing in. Google sign-in relies on Google's verified email claim.

Verification links expire after 24 hours; password-reset links expire after 30 minutes. Both are single-use, stored only as SHA-256 token hashes, and superseded links are invalidated when a replacement is sent. Resetting a password revokes all existing sessions for that account. The forgot-password response does not disclose whether an email is registered. On the sign-in page, users can request a reset link or resend verification. If server email is not configured, self-service signup and recovery are unavailable; an administrator must configure the provider or reset an existing account through account management.

Before onboarding users, test signup delivery, link expiry, expired and reused links, password confirmation, login blocking before verification, and session revocation after reset. Keep `RESEND_API_KEY` private and never expose it through a `VITE_` variable.

## RentWise subscriptions and Paystack

Plans are priced in NGN: Landlord Plus is ₦2,500 monthly or ₦25,000 yearly; Property Manager Pro is ₦7,500 monthly or ₦75,000 yearly. Annual billing is priced at ten monthly payments (two months' savings). These are RentWise launch prices, not a direct currency conversion of international products.

To enable checkout, set these values in the server's private `.env`, starting with Paystack test credentials, then restart the API and worker:

```dotenv
PAYSTACK_SECRET_KEY=your_test_secret_key
PAYSTACK_WEBHOOK_SECRET=your_webhook_signing_secret
RENTWISE_PUBLIC_URL=https://your-public-domain.example
```

Never put secrets in a `VITE_` variable, source control, or a message. A landlord can choose a plan and billing period under **Plans & Usage**. RentWise initializes checkout server-side and verifies the reference, status, amount, and currency with Paystack before updating the subscription. A redirect to the app by itself does not activate a plan. The signed `charge.success` webhook at `/api/billing/paystack/webhook` is durably queued and acknowledged before verification work; the API worker retries temporary verification failures. In the Paystack dashboard, set the webhook to `https://your-public-domain.example/api/billing/paystack/webhook`. Both the webhook and browser callback need a public HTTPS host for production. A private LAN address or `localhost` is not reachable by Paystack. In local development, the browser callback can verify the payment, but webhooks will not arrive until you expose a secure public HTTPS endpoint.

Use **Test Paystack connection** in the Super Administrator account to confirm server authentication; it does not charge a payment. Then use Paystack test mode to verify success, declined/failed checkout, callback verification, duplicate webhook delivery, and recovery after temporary Paystack/API downtime. Confirm that a valid paid transaction activates one subscription only. Do not switch to live credentials until the test scenarios pass.

The current checkout charges one billing period at a time and the landlord renews manually. Automatic card or direct-debit renewal requires additional Paystack plan and subscription setup and is not enabled by this integration.
