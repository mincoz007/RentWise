import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { rentwiseAuthPlugin } from './server/auth.ts'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'DATABASE_URL', 'PGSSLMODE', 'PAYSTACK_SECRET_KEY', 'PAYSTACK_WEBHOOK_SECRET', 'RENTWISE_PUBLIC_URL', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_GRAPH_API_VERSION', 'WHATSAPP_TEST_TEMPLATE_NAME', 'WHATSAPP_TEST_TEMPLATE_LANGUAGE', 'WHATSAPP_REMINDER_TEMPLATE_NAME', 'WHATSAPP_REMINDER_TEMPLATE_LANGUAGE', 'RENTWISE_REMINDER_TIMEZONE']) {
    if (!process.env[key] && env[key]) process.env[key] = env[key]
  }
  return {
    plugins: [react(), rentwiseAuthPlugin()],
  }
})
