import * as Sentry from '@sentry/node'
import 'dotenv/config'

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? 'development',
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
  enabled: !!process.env.SENTRY_DSN,
})

import { createServer } from 'http'
import app from './app'
import { setupSocketServer } from './lib/socket'
import { startServiceStatusSyncJob } from './jobs/serviceStatusSync'
import { startLicenseExpiryJob } from './jobs/licenseExpiryNotifications'
import { startMaintenanceNotificationJob } from './jobs/maintenanceNotifications'
import { startShiftReminderJob } from './jobs/shiftReminderNotifications'
import { startBroadcastInstanceJob } from './jobs/broadcastInstances'
import { startDocumentExpiryJob } from './jobs/documentExpiryNotifications'

const PORT = process.env.PORT ?? 3000

const httpServer = createServer(app)
setupSocketServer(httpServer)

httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
  startServiceStatusSyncJob()
  startLicenseExpiryJob()
  startMaintenanceNotificationJob()
  startShiftReminderJob()
  startBroadcastInstanceJob()
  startDocumentExpiryJob()
})

// Graceful shutdown — release port so tsx watch restarts cleanly
for (const sig of ['SIGTERM', 'SIGINT', 'SIGUSR2'] as const) {
  process.on(sig, () => {
    httpServer.close(() => process.exit(0))
  })
}
