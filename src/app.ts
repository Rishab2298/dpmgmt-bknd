import 'express-async-errors'
import * as Sentry from '@sentry/node'
import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import path from 'path'
import { clerkMiddleware } from './middleware/auth'
import { errorHandler } from './middleware/error'
import webhookRoutes from './routes/webhook.routes'
import onboardingRoutes from './routes/onboarding.routes'
import dspRoutes from './routes/dsp.routes'
import schedulerRoutes from './routes/scheduler.routes'
import stationsRoutes from './routes/stations.routes'
import employeesRoutes from './routes/employees.routes'
import shiftsRoutes from './routes/shifts.routes'
import devicesRoutes from './routes/devices.routes'
import vehiclesRoutes from './routes/vehicles.routes'
import maintenanceRoutes from './routes/maintenance.routes'
import scheduledMaintenanceRoutes from './routes/scheduled-maintenance.routes'
import checklistsRoutes from './routes/checklists.routes'
import checklistItemsRoutes from './routes/checklist-items.routes'
import routesRoutes from './routes/routes.routes'
import loadoutRoutes from './routes/loadout.routes'
import rtsRoutes from './routes/rts.routes'
import chatRoutes from './routes/chat.routes'
import availabilityRoutes from './routes/availability.routes'
import scorecardRoutes from './routes/scorecards.routes'
import coachingRoutes from './routes/coaching.routes'
import announcementRoutes from './routes/announcements.routes'
import broadcastRoutes from './routes/broadcasts.routes'
import notificationRoutes from './routes/notifications.routes'
import documentsRoutes from './routes/documents.routes'
import shiftActionsRoutes from './routes/shift-actions.routes'
import incidentsRoutes from './routes/incidents.routes'
import fuelLogsRoutes from './routes/fuel-logs.routes'
import dispatchReportsRoutes from './routes/dispatch-reports.routes'
import routesReportsRoutes from './routes/routes-reports.routes'
import atsRoutes from './routes/ats.routes'
import performanceRoutes from './routes/performance.routes'

const app = express()

app.use(helmet())
app.use(cors())

// Serve uploaded files (vehicle images, loadout photos, maintenance attachments)
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')))

// Webhook route needs raw body for Svix signature verification — must come before express.json()
app.use('/webhooks', express.raw({ type: 'application/json' }), webhookRoutes)

app.use(express.json({ limit: '10mb' }))
app.use(clerkMiddleware())

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// API routes
app.use('/api/onboarding', onboardingRoutes)
app.use('/api/dsp', dspRoutes)
app.use('/api/scheduler', schedulerRoutes)
app.use('/api/stations', stationsRoutes)
app.use('/api/employees', employeesRoutes)
app.use('/api/shifts', shiftsRoutes)
app.use('/api/devices', devicesRoutes)
app.use('/api/vehicles', vehiclesRoutes)
app.use('/api/maintenance-records', maintenanceRoutes)
app.use('/api/scheduled-maintenance', scheduledMaintenanceRoutes)
app.use('/api/maintenance-checklists', checklistsRoutes)
app.use('/api/maintenance-checklist-items', checklistItemsRoutes)
app.use('/api/routes', routesRoutes)
app.use('/api/loadout', loadoutRoutes)
app.use('/api/rts', rtsRoutes)
app.use('/api/chat', chatRoutes)
app.use('/api/availability', availabilityRoutes)
app.use('/api/scorecards', scorecardRoutes)
app.use('/api/coaching', coachingRoutes)
app.use('/api/announcements', announcementRoutes)
app.use('/api/broadcasts', broadcastRoutes)
app.use('/api/notifications', notificationRoutes)
app.use('/api/documents', documentsRoutes)
app.use('/api/shift-actions', shiftActionsRoutes)
app.use('/api/incidents', incidentsRoutes)
app.use('/api/fuel-logs', fuelLogsRoutes)
app.use('/api/dispatch-reports', dispatchReportsRoutes)
app.use('/api/routes-reports', routesReportsRoutes)
app.use('/api/ats', atsRoutes)
app.use('/api/performance', performanceRoutes)

Sentry.setupExpressErrorHandler(app)
app.use(errorHandler)

export default app
