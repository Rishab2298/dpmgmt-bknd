import cron from 'node-cron'
import { prisma } from '../lib/prisma'
import { sendNotification } from '../lib/notificationSender'
import type { NotificationChannel } from '@prisma/client'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Get "today" in a station's timezone as YYYY-MM-DD */
function todayInTimezone(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    return parts // en-CA already returns YYYY-MM-DD
  } catch {
    // Fall back to UTC if timezone is invalid
    return new Date().toISOString().slice(0, 10)
  }
}

/** Add days to a YYYY-MM-DD string → new YYYY-MM-DD */
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Compute days between two YYYY-MM-DD strings (target - today) */
function daysBetween(todayStr: string, targetStr: string): number {
  const a = new Date(todayStr + 'T00:00:00Z')
  const b = new Date(targetStr + 'T00:00:00Z')
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24))
}

const MANAGER_ROLES = ['OWNER', 'OPERATIONS_ACCOUNT_MANAGER', 'OPERATIONS_MANAGER', 'DISPATCHER']

// ─── Main job ─────────────────────────────────────────────────────────────────

export function startLicenseExpiryJob() {
  // Runs daily at 8:00 AM UTC
  cron.schedule('0 8 * * *', async () => {
    console.log('[LicenseExpiryJob] Starting daily check...')

    try {
      // 1. Fetch all active license expiry configs
      const configs = await prisma.notificationConfig.findMany({
        where: {
          type: 'LICENSE_EXPIRY',
          OR: [{ driverEnabled: true }, { dspEnabled: true }],
        },
        include: {
          station: { select: { id: true, dspId: true, timezone: true, code: true, name: true } },
        },
      })

      if (configs.length === 0) {
        console.log('[LicenseExpiryJob] No active configs found, skipping.')
        return
      }

      let totalSent = 0

      for (const config of configs) {
        const { station } = config
        const today = todayInTimezone(station.timezone)

        // 2. Collect all unique reminder days
        const allDays = new Set<number>()
        if (config.driverEnabled) config.driverReminderDays.forEach((d) => allDays.add(d))
        if (config.dspEnabled) config.dspReminderDays.forEach((d) => allDays.add(d))

        // 3. For each reminder day, find matching employees
        for (const reminderDay of allDays) {
          const targetDate = addDays(today, reminderDay)

          // Find employees at this station whose license expires on the target date
          const employees = await prisma.employee.findMany({
            where: {
              primaryStationId: station.id,
              status: { in: ['ACTIVE', 'ONBOARDING'] },
              expirationDate: {
                gte: new Date(targetDate + 'T00:00:00.000Z'),
                lt: new Date(addDays(targetDate, 1) + 'T00:00:00.000Z'),
              },
            },
            select: {
              id: true,
              dspId: true,
              legalFirstName: true,
              legalLastName: true,
              expirationDate: true,
              personalEmail: true,
              workEmail: true,
              personalMobile: true,
              workMobile: true,
            },
          })

          for (const emp of employees) {
            const dspId = emp.dspId ?? station.dspId
            const empName = `${emp.legalFirstName} ${emp.legalLastName}`
            const expiryStr = emp.expirationDate!.toISOString().slice(0, 10)

            // ── Driver notifications ──
            if (config.driverEnabled && config.driverReminderDays.includes(reminderDay)) {
              for (const channel of config.driverChannels) {
                const sent = await trySend({
                  dspId,
                  type: 'LICENSE_EXPIRY',
                  channel,
                  recipientId: emp.id,
                  subjectId: emp.id,
                  triggerDate: today,
                  reminderDay,
                  recipientEmail: emp.workEmail ?? emp.personalEmail,
                  recipientPhone: emp.workMobile ?? emp.personalMobile,
                  title: `License Expiring in ${reminderDay} Days`,
                  message: `Your driver's license expires on ${expiryStr}. Please renew it before the expiration date to avoid service interruptions.`,
                  severity: reminderDay <= 5 ? 'CRITICAL' : reminderDay <= 15 ? 'WARNING' : 'INFO',
                })
                if (sent) totalSent++
              }
            }

            // ── DSP manager notifications ──
            if (config.dspEnabled && config.dspReminderDays.includes(reminderDay)) {
              const managers = await prisma.employee.findMany({
                where: {
                  primaryStationId: station.id,
                  status: 'ACTIVE',
                  permissionLevel: { in: MANAGER_ROLES as any },
                },
                select: {
                  id: true,
                  workEmail: true,
                  personalEmail: true,
                  workMobile: true,
                  personalMobile: true,
                },
              })

              const stationName = station.name ?? station.code
              for (const mgr of managers) {
                for (const channel of config.dspChannels) {
                  const sent = await trySend({
                    dspId,
                    type: 'LICENSE_EXPIRY',
                    channel,
                    recipientId: mgr.id,
                    subjectId: emp.id,
                    triggerDate: today,
                    reminderDay,
                    recipientEmail: mgr.workEmail ?? mgr.personalEmail,
                    recipientPhone: mgr.workMobile ?? mgr.personalMobile,
                    title: `Driver License Expiring — ${empName}`,
                    message: `${empName} at ${stationName}'s driver's license expires on ${expiryStr} (${reminderDay} days from now). Please ensure timely renewal.`,
                    severity: reminderDay <= 5 ? 'CRITICAL' : reminderDay <= 15 ? 'WARNING' : 'INFO',
                  })
                  if (sent) totalSent++
                }
              }
            }
          }
        }

        // 4. Check for already-expired licenses (reminderDay = 0, one-time alert)
        const expiredEmployees = await prisma.employee.findMany({
          where: {
            primaryStationId: station.id,
            status: { in: ['ACTIVE', 'ONBOARDING'] },
            expirationDate: { lt: new Date(todayInTimezone(station.timezone) + 'T00:00:00.000Z') },
          },
          select: {
            id: true,
            dspId: true,
            legalFirstName: true,
            legalLastName: true,
            expirationDate: true,
            personalEmail: true,
            workEmail: true,
            personalMobile: true,
            workMobile: true,
          },
        })

        for (const emp of expiredEmployees) {
          const dspId = emp.dspId ?? station.dspId
          const empName = `${emp.legalFirstName} ${emp.legalLastName}`
          const expiryStr = emp.expirationDate!.toISOString().slice(0, 10)

          // Notify driver once about expiration
          if (config.driverEnabled) {
            for (const channel of config.driverChannels) {
              const sent = await trySend({
                dspId,
                type: 'LICENSE_EXPIRY',
                channel,
                recipientId: emp.id,
                subjectId: emp.id,
                triggerDate: today,
                reminderDay: 0,
                recipientEmail: emp.workEmail ?? emp.personalEmail,
                recipientPhone: emp.workMobile ?? emp.personalMobile,
                title: 'License Expired',
                message: `Your driver's license expired on ${expiryStr}. Please renew it immediately to continue delivery operations.`,
                severity: 'CRITICAL',
              })
              if (sent) totalSent++
            }
          }

          // Notify DSP managers once about expiration
          if (config.dspEnabled) {
            const managers = await prisma.employee.findMany({
              where: {
                primaryStationId: station.id,
                status: 'ACTIVE',
                permissionLevel: { in: MANAGER_ROLES as any },
              },
              select: {
                id: true,
                workEmail: true,
                personalEmail: true,
                workMobile: true,
                personalMobile: true,
              },
            })

            const stationName = station.name ?? station.code
            for (const mgr of managers) {
              for (const channel of config.dspChannels) {
                const sent = await trySend({
                  dspId,
                  type: 'LICENSE_EXPIRY',
                  channel,
                  recipientId: mgr.id,
                  subjectId: emp.id,
                  triggerDate: today,
                  reminderDay: 0,
                  recipientEmail: mgr.workEmail ?? mgr.personalEmail,
                  recipientPhone: mgr.workMobile ?? mgr.personalMobile,
                  title: `Driver License Expired — ${empName}`,
                  message: `${empName} at ${stationName}'s driver's license expired on ${expiryStr}. Immediate action required.`,
                  severity: 'CRITICAL',
                })
                if (sent) totalSent++
              }
            }
          }
        }
      }

      console.log(`[LicenseExpiryJob] Completed. ${totalSent} notification(s) sent.`)
    } catch (err) {
      console.error('[LicenseExpiryJob] Fatal error:', err)
    }
  })
}

// ─── Send with deduplication ──────────────────────────────────────────────────

interface TrySendParams {
  dspId: string
  type: 'LICENSE_EXPIRY'
  channel: NotificationChannel
  recipientId: string
  subjectId: string
  triggerDate: string
  reminderDay: number
  recipientEmail: string | null | undefined
  recipientPhone: string | null | undefined
  title: string
  message: string
  severity: 'INFO' | 'WARNING' | 'CRITICAL'
}

async function trySend(params: TrySendParams): Promise<boolean> {
  // Check deduplication — if a log entry already exists, skip
  const existing = await prisma.notificationLog.findUnique({
    where: {
      type_channel_recipientId_subjectId_reminderDay_triggerDate: {
        type: params.type,
        channel: params.channel,
        recipientId: params.recipientId,
        subjectId: params.subjectId,
        reminderDay: params.reminderDay,
        triggerDate: params.triggerDate,
      },
    },
  })
  if (existing) return false

  const result = await sendNotification({
    dspId: params.dspId,
    recipientEmployeeId: params.recipientId,
    recipientEmail: params.recipientEmail,
    recipientPhone: params.recipientPhone,
    type: params.type,
    channel: params.channel,
    title: params.title,
    message: params.message,
    severity: params.severity,
    metadata: {
      subjectEmployeeId: params.subjectId,
      reminderDay: params.reminderDay,
    },
  })

  // Log the send attempt (success or failure)
  await prisma.notificationLog.create({
    data: {
      dspId: params.dspId,
      type: params.type,
      channel: params.channel,
      recipientId: params.recipientId,
      subjectId: params.subjectId,
      triggerDate: params.triggerDate,
      reminderDay: params.reminderDay,
      success: result.success,
      errorMessage: result.error ?? null,
    },
  })

  return result.success
}
