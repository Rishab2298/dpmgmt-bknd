import { Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import type { NotificationType } from '@prisma/client'

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function resolveStationOwnership(userId: string, stationId: string) {
  const employee = await prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { dspId: true },
  })
  if (!employee?.dspId) return null

  const station = await prisma.station.findUnique({
    where: { id: stationId },
  })
  if (!station || station.dspId !== employee.dspId) return null

  return station
}

// ─── GET /api/stations/:id/notification-config ───────────────────────────────

export async function getNotificationConfig(req: Request, res: Response) {
  const { userId } = getAuth(req)
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return }

  const station = await resolveStationOwnership(userId, String(req.params.id))
  if (!station) { res.status(404).json({ message: 'Station not found' }); return }

  const configs = await prisma.notificationConfig.findMany({
    where: { stationId: station.id },
  })

  res.json({ configs })
}

// ─── PUT /api/stations/:id/notification-config/:type ─────────────────────────

const VALID_TYPES: NotificationType[] = ['LICENSE_EXPIRY', 'VEHICLE_MAINTENANCE', 'SHIFT_REMINDER']

const upsertConfigSchema = z.object({
  driverEnabled:      z.boolean(),
  driverReminderDays: z.array(z.number().int().min(1).max(365)).max(3),
  driverChannels:     z.array(z.enum(['EMAIL', 'SMS', 'IN_APP', 'MOBILE_PUSH'])),
  dspEnabled:         z.boolean(),
  dspReminderDays:    z.array(z.number().int().min(1).max(365)).max(1),
  dspChannels:        z.array(z.enum(['EMAIL', 'SMS', 'IN_APP', 'MOBILE_PUSH'])),
})

const shiftReminderSchema = z.object({
  driverEnabled:   z.boolean(),
  driverChannels:  z.array(z.enum(['EMAIL', 'SMS', 'IN_APP', 'MOBILE_PUSH'])),
  reminderHours:   z.array(z.number().int().min(1).max(72)).max(5),
  messageTemplate: z.string().max(1000).optional().nullable(),
})

export async function upsertNotificationConfig(req: Request, res: Response) {
  const { userId } = getAuth(req)
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return }

  const station = await resolveStationOwnership(userId, String(req.params.id))
  if (!station) { res.status(404).json({ message: 'Station not found' }); return }

  const type = req.params.type as NotificationType
  if (!VALID_TYPES.includes(type)) {
    res.status(400).json({ message: `Invalid notification type: ${type}` })
    return
  }

  if (type === 'SHIFT_REMINDER') {
    const parsed = shiftReminderSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0].message })
      return
    }
    const data = parsed.data
    const config = await prisma.notificationConfig.upsert({
      where: { stationId_type: { stationId: station.id, type } },
      create: {
        stationId: station.id,
        type,
        driverEnabled:      data.driverEnabled,
        driverReminderDays: [],
        driverChannels:     data.driverChannels,
        dspEnabled:         false,
        dspReminderDays:    [],
        dspChannels:        [],
        reminderHours:      data.reminderHours,
        messageTemplate:    data.messageTemplate ?? null,
      },
      update: {
        driverEnabled:      data.driverEnabled,
        driverChannels:     data.driverChannels,
        reminderHours:      data.reminderHours,
        messageTemplate:    data.messageTemplate ?? null,
      },
    })
    res.json(config)
    return
  }

  const parsed = upsertConfigSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.issues[0].message })
    return
  }

  const data = parsed.data

  const config = await prisma.notificationConfig.upsert({
    where: { stationId_type: { stationId: station.id, type } },
    create: {
      stationId: station.id,
      type,
      driverEnabled:      data.driverEnabled,
      driverReminderDays: data.driverReminderDays,
      driverChannels:     data.driverChannels,
      dspEnabled:         data.dspEnabled,
      dspReminderDays:    data.dspReminderDays,
      dspChannels:        data.dspChannels,
    },
    update: {
      driverEnabled:      data.driverEnabled,
      driverReminderDays: data.driverReminderDays,
      driverChannels:     data.driverChannels,
      dspEnabled:         data.dspEnabled,
      dspReminderDays:    data.dspReminderDays,
      dspChannels:        data.dspChannels,
    },
  })

  res.json(config)
}
