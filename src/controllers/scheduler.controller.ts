import { Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import multer from 'multer'
import * as XLSX from 'xlsx'

// ─── helpers ──────────────────────────────────────────────────────────────────

function getInitials(first: string, last: string) {
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase()
}

/** Returns "YYYY-MM-DD" strings for Sun–Sat of the week containing weekStart.
 *  Uses noon to avoid DST/timezone-offset issues where midnight UTC ≠ midnight local. */
function getWeekDates(weekStart: string): string[] {
  const base = new Date(weekStart + 'T12:00:00')
  base.setDate(base.getDate() - base.getDay()) // rewind to Sunday
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base)
    d.setDate(d.getDate() + i)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  })
}

async function getCallerEmployee(userId: string) {
  return prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { id: true, dspId: true, legalFirstName: true, legalLastName: true },
  })
}

async function resolveShift(shiftId: string, dspId: string) {
  const shift = await prisma.shift.findUnique({ where: { id: shiftId } })
  if (!shift || shift.dspId !== dspId) return null
  return shift
}

function performerName(me: { legalFirstName: string; legalLastName: string } | null) {
  return me ? `${me.legalFirstName} ${me.legalLastName}` : 'Unknown'
}

async function writeShiftLog(opts: {
  shiftId: string
  dspId: string
  action: string
  performedByClerkId?: string
  performedByName?: string
}) {
  await prisma.shiftLog.create({
    data: {
      shiftId: opts.shiftId,
      dspId: opts.dspId,
      action: opts.action,
      performedByClerkId: opts.performedByClerkId,
      performedByName: opts.performedByName,
    },
  })
}

/** HH:MM string comparison — returns true if two time ranges overlap */
function timesOverlap(s1: string, e1: string, s2: string, e2: string) {
  return s1 < e2 && e1 > s2
}

// ─── GET /api/scheduler/grid ──────────────────────────────────────────────────

export async function getGrid(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const { stationId, weekStart } = req.query as Record<string, string>

  if (!stationId || !weekStart) {
    res.status(400).json({ message: 'stationId and weekStart are required' })
    return
  }

  const me = await getCallerEmployee(userId!)
  if (!me?.dspId) { res.status(404).json({ error: 'No DSP found' }); return }

  const dates = getWeekDates(weekStart)

  const [drivers, shifts, commitments, availabilitySlots] = await Promise.all([
    prisma.employee.findMany({
      where: {
        dspId: me.dspId,
        primaryStationId: stationId,
        status: 'ACTIVE',
        permissionLevel: 'DELIVERY_ASSOCIATE',
      },
      select: { id: true, legalFirstName: true, legalLastName: true },
      orderBy: [{ legalLastName: 'asc' }, { legalFirstName: 'asc' }],
    }),
    prisma.shift.findMany({
      where: { stationId, dspId: me.dspId, date: { in: dates } },
      select: {
        id: true, employeeId: true, date: true,
        startTime: true, endTime: true, notes: true, status: true,
        routes: true, isTrainer: true, isLightDuty: true, isRescue: true,
        shiftType: { select: { id: true, name: true, color: true, startTime: true, endTime: true, durationMinutes: true } },
        _count: { select: { devices: true } },
      },
    }),
    prisma.routeCommitment.findMany({
      where: { stationId, weekStart: dates[0] },
      select: { sun: true, mon: true, tue: true, wed: true, thu: true, fri: true, sat: true },
    }),
    prisma.availabilitySlot.findMany({
      where: {
        date: { in: dates },
        availability: { dspId: me.dspId, stationId, weekStartDate: dates[0] },
      },
      select: {
        date: true,
        startTime: true,
        endTime: true,
        availability: { select: { employeeId: true } },
      },
    }),
  ])

  const RC_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
  const rcByDay = RC_KEYS.map((key) => commitments.reduce((sum, c) => sum + (c[key] ?? 0), 0))

  const crossStationEmployeeIds = [
    ...new Set(shifts.map((s) => s.employeeId).filter((id) => !drivers.find((d) => d.id === id))),
  ]

  const crossStationDrivers =
    crossStationEmployeeIds.length > 0
      ? await prisma.employee.findMany({
          where: { id: { in: crossStationEmployeeIds } },
          select: { id: true, legalFirstName: true, legalLastName: true },
        })
      : []

  const allDrivers = [
    ...drivers.map((d) => ({
      id: d.id, name: `${d.legalFirstName} ${d.legalLastName}`,
      initials: getInitials(d.legalFirstName, d.legalLastName), isHomeStation: true,
    })),
    ...crossStationDrivers.map((d) => ({
      id: d.id, name: `${d.legalFirstName} ${d.legalLastName}`,
      initials: getInitials(d.legalFirstName, d.legalLastName), isHomeStation: false,
    })),
  ]

  const formattedShifts = shifts.map((s) => ({
    id: s.id, employeeId: s.employeeId, date: s.date,
    startTime: s.startTime ?? s.shiftType?.startTime ?? null,
    endTime: s.endTime ?? s.shiftType?.endTime ?? null,
    notes: s.notes, status: s.status,
    shiftTypeId: s.shiftType?.id ?? null,
    shiftTypeName: s.shiftType?.name ?? null,
    shiftTypeDurationMinutes: s.shiftType?.durationMinutes ?? null,
    color: s.shiftType?.color ?? null,
    routes: s.routes,
    isTrainer: s.isTrainer, isLightDuty: s.isLightDuty, isRescue: s.isRescue,
    deviceCount: s._count.devices,
  }))

  const formattedAvailability = availabilitySlots.map((s) => ({
    employeeId: s.availability.employeeId,
    date: s.date,
    startTime: s.startTime,
    endTime: s.endTime,
  }))

  res.json({ weekStart: dates[0], drivers: allDrivers, shifts: formattedShifts, rcByDay, availabilitySlots: formattedAvailability })
}

// ─── GET /api/scheduler/drivers ───────────────────────────────────────────────

export async function getAvailableDrivers(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const { stationId, date } = req.query as Record<string, string>

  if (!stationId || !date) { res.status(400).json({ message: 'stationId and date are required' }); return }

  const me = await getCallerEmployee(userId!)
  if (!me?.dspId) { res.status(404).json({ error: 'No DSP found' }); return }

  const busyIds = await prisma.shift
    .findMany({ where: { dspId: me.dspId, date }, select: { employeeId: true } })
    .then((rows) => rows.map((r) => r.employeeId))

  const drivers = await prisma.employee.findMany({
    where: {
      dspId: me.dspId,
      primaryStationId: { not: stationId },
      status: 'ACTIVE',
      permissionLevel: 'DELIVERY_ASSOCIATE',
      id: { notIn: busyIds },
    },
    select: { id: true, legalFirstName: true, legalLastName: true },
    orderBy: [{ legalLastName: 'asc' }, { legalFirstName: 'asc' }],
  })

  res.json(drivers.map((d) => ({
    id: d.id, name: `${d.legalFirstName} ${d.legalLastName}`,
    initials: getInitials(d.legalFirstName, d.legalLastName),
  })))
}

// ─── POST /api/scheduler/shifts ───────────────────────────────────────────────

const createShiftSchema = z.object({
  employeeId:  z.string().min(1),
  stationId:   z.string().min(1),
  date:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shiftTypeId: z.string().optional(),
  startTime:   z.string().regex(/^\d{2}:\d{2}$/).optional(),
  endTime:     z.string().regex(/^\d{2}:\d{2}$/).optional(),
  notes:       z.string().optional(),
  routes:      z.array(z.string()).optional(),
  status:      z.enum(['DRAFT', 'PUBLISHED']).default('DRAFT'),
})

export async function createShift(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const parsed = createShiftSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }

  const me = await getCallerEmployee(userId!)
  if (!me?.dspId) { res.status(404).json({ error: 'No DSP found' }); return }

  const { employeeId, stationId, date, shiftTypeId, startTime, endTime, notes, routes, status } = parsed.data

  const employee = await prisma.employee.findFirst({ where: { id: employeeId, dspId: me.dspId }, select: { id: true } })
  if (!employee) { res.status(404).json({ message: 'Employee not found' }); return }

  // Time overlap check — only if both new shift and existing shift have full times
  if (startTime && endTime) {
    const existingOnDate = await prisma.shift.findMany({
      where: { employeeId, date },
      select: { startTime: true, endTime: true },
    })
    const overlapping = existingOnDate.filter((ex) => {
      if (!ex.startTime || !ex.endTime) return false
      return timesOverlap(startTime, endTime, ex.startTime, ex.endTime)
    })
    if (overlapping.length > 0) {
      res.status(409).json({ message: 'This work block overlaps with an existing block for this driver' })
      return
    }
  }

  const shift = await prisma.shift.create({
    data: {
      dspId: me.dspId, stationId, employeeId,
      shiftTypeId: shiftTypeId ?? null,
      date, startTime: startTime ?? null, endTime: endTime ?? null,
      notes: notes ?? null, routes: routes ?? [],
      status,
    },
    select: {
      id: true, employeeId: true, date: true,
      startTime: true, endTime: true, notes: true, status: true,
      routes: true, isTrainer: true, isLightDuty: true, isRescue: true,
      shiftType: { select: { id: true, name: true, color: true, startTime: true, endTime: true } },
    },
  })

  await writeShiftLog({
    shiftId: shift.id, dspId: me.dspId,
    action: `Work block created (${status === 'DRAFT' ? 'draft' : 'published'})`,
    performedByClerkId: userId!, performedByName: performerName(me),
  })

  res.status(201).json({
    id: shift.id, employeeId: shift.employeeId, date: shift.date,
    startTime: shift.startTime ?? shift.shiftType?.startTime ?? null,
    endTime: shift.endTime ?? shift.shiftType?.endTime ?? null,
    notes: shift.notes, status: shift.status,
    shiftTypeId: shift.shiftType?.id ?? null,
    shiftTypeName: shift.shiftType?.name ?? null,
    color: shift.shiftType?.color ?? null,
    routes: shift.routes, isTrainer: shift.isTrainer,
    isLightDuty: shift.isLightDuty, isRescue: shift.isRescue,
    deviceCount: 0,
  })
}

// ─── GET /api/scheduler/shifts/:shiftId ──────────────────────────────────────

export async function getWorkBlock(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await getCallerEmployee(userId!)
  if (!me?.dspId) { res.status(404).json({ error: 'No DSP found' }); return }

  const shift = await prisma.shift.findUnique({
    where: { id: req.params.shiftId as string },
    include: {
      shiftType: { select: { id: true, name: true, color: true, startTime: true, endTime: true, breakMinutes: true, invoiceType: { select: { id: true, name: true, billableHours: true } } } },
      vehicle: { select: { id: true, vehicleId: true, make: true, model: true } },
      devices: { include: { device: { select: { id: true, deviceName: true, phoneNumber: true } } } },
      logs: { orderBy: { createdAt: 'desc' } },
    },
  })

  if (!shift || shift.dspId !== me.dspId) { res.status(404).json({ message: 'Work block not found' }); return }

  res.json(shift)
}

// ─── PATCH /api/scheduler/shifts/:shiftId ─────────────────────────────────────

const updateShiftSchema = z.object({
  startTime:     z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  endTime:       z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  notes:         z.string().optional().nullable(),
  routes:        z.array(z.string()).optional(),
  vehicleId:     z.string().optional().nullable(),
  status:        z.enum(['DRAFT', 'PUBLISHED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_CALL_NO_SHOW']).optional(),
  isTrainer:     z.boolean().optional(),
  isLightDuty:   z.boolean().optional(),
  refusedRescue: z.boolean().optional(),
})

export async function updateWorkBlock(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await getCallerEmployee(userId!)
  if (!me?.dspId) { res.status(404).json({ error: 'No DSP found' }); return }

  const existing = await resolveShift(req.params.shiftId as string, me.dspId)
  if (!existing) { res.status(404).json({ message: 'Work block not found' }); return }

  const parsed = updateShiftSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }
  const data = parsed.data

  const updateData: Record<string, unknown> = {}
  const logParts: string[] = []

  if ('startTime' in data) {
    updateData.startTime = data.startTime ?? null
    if ((existing.startTime ?? '') !== (data.startTime ?? '')) logParts.push(`Start time: ${existing.startTime ?? '—'} → ${data.startTime ?? '—'}`)
  }
  if ('endTime' in data) {
    updateData.endTime = data.endTime ?? null
    if ((existing.endTime ?? '') !== (data.endTime ?? '')) logParts.push(`End time: ${existing.endTime ?? '—'} → ${data.endTime ?? '—'}`)
  }
  if ('notes' in data) {
    updateData.notes = data.notes ?? null
  }
  if ('routes' in data && data.routes !== undefined) {
    updateData.routes = data.routes
    const added = data.routes.filter((r) => !existing.routes.includes(r))
    const removed = existing.routes.filter((r) => !data.routes!.includes(r))
    if (added.length) logParts.push(`Routes added: ${added.join(', ')}`)
    if (removed.length) logParts.push(`Routes removed: ${removed.join(', ')}`)
  }
  if ('vehicleId' in data) {
    updateData.vehicleId = data.vehicleId ?? null
    if ((existing.vehicleId ?? '') !== (data.vehicleId ?? '')) logParts.push(`Vehicle updated`)
  }
  if ('status' in data && data.status) {
    updateData.status = data.status
    if (existing.status !== data.status) logParts.push(`Status: ${existing.status} → ${data.status}`)
  }
  if ('isTrainer' in data && data.isTrainer !== undefined) {
    updateData.isTrainer = data.isTrainer
    if (existing.isTrainer !== data.isTrainer) logParts.push(data.isTrainer ? 'Marked as Trainer' : 'Trainer flag removed')
  }
  if ('isLightDuty' in data && data.isLightDuty !== undefined) {
    updateData.isLightDuty = data.isLightDuty
    if (existing.isLightDuty !== data.isLightDuty) logParts.push(data.isLightDuty ? 'Marked as Light Duty' : 'Light Duty flag removed')
  }
  if ('refusedRescue' in data && data.refusedRescue !== undefined) {
    updateData.refusedRescue = data.refusedRescue
    if (data.refusedRescue && !existing.refusedRescue) logParts.push('Refused rescue')
  }

  const shift = await prisma.shift.update({
    where: { id: existing.id as string },
    data: updateData,
    include: {
      shiftType: { select: { id: true, name: true, color: true, startTime: true, endTime: true, breakMinutes: true, invoiceType: { select: { id: true, name: true, billableHours: true } } } },
      vehicle: { select: { id: true, vehicleId: true, make: true, model: true } },
      devices: { include: { device: { select: { id: true, deviceName: true, phoneNumber: true } } } },
      logs: { orderBy: { createdAt: 'desc' } },
    },
  })

  if (logParts.length > 0) {
    await writeShiftLog({
      shiftId: existing.id as string, dspId: me.dspId,
      action: logParts.join('; '),
      performedByClerkId: userId!, performedByName: performerName(me),
    })
  }

  res.json(shift)
}

// ─── POST /api/scheduler/shifts/:shiftId/devices/:deviceId ───────────────────

export async function addDevice(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await getCallerEmployee(userId!)
  if (!me?.dspId) { res.status(404).json({ error: 'No DSP found' }); return }

  const shiftId = req.params.shiftId as string
  const deviceId = req.params.deviceId as string

  const existing = await resolveShift(shiftId, me.dspId)
  if (!existing) { res.status(404).json({ message: 'Work block not found' }); return }

  const device = await prisma.device.findFirst({ where: { id: deviceId, dspId: me.dspId } })
  if (!device) { res.status(404).json({ message: 'Device not found' }); return }

  await prisma.shiftDevice.upsert({
    where: { shiftId_deviceId: { shiftId, deviceId } },
    create: { shiftId, deviceId },
    update: {},
  })

  await writeShiftLog({
    shiftId, dspId: me.dspId,
    action: `Device added: ${device.deviceName}`,
    performedByClerkId: userId!, performedByName: performerName(me),
  })

  res.status(201).json({ shiftId, deviceId, deviceName: device.deviceName })
}

// ─── DELETE /api/scheduler/shifts/:shiftId/devices/:deviceId ─────────────────

export async function removeDevice(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await getCallerEmployee(userId!)
  if (!me?.dspId) { res.status(404).json({ error: 'No DSP found' }); return }

  const shiftId = req.params.shiftId as string
  const deviceId = req.params.deviceId as string

  const existing = await resolveShift(shiftId, me.dspId)
  if (!existing) { res.status(404).json({ message: 'Work block not found' }); return }

  const device = await prisma.device.findFirst({ where: { id: deviceId, dspId: me.dspId } })

  await prisma.shiftDevice.deleteMany({ where: { shiftId, deviceId } })

  await writeShiftLog({
    shiftId, dspId: me.dspId,
    action: `Device removed: ${device?.deviceName ?? deviceId}`,
    performedByClerkId: userId!, performedByName: performerName(me),
  })

  res.status(204).send()
}

// ─── POST /api/scheduler/shifts/:shiftId/rescue ───────────────────────────────

const rescueSchema = z.object({ rescueEmployeeId: z.string().min(1) })

export async function createRescueShift(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await getCallerEmployee(userId!)
  if (!me?.dspId) { res.status(404).json({ error: 'No DSP found' }); return }

  const original = await resolveShift(req.params.shiftId as string, me.dspId)
  if (!original) { res.status(404).json({ message: 'Work block not found' }); return }

  const parsed = rescueSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }

  const rescueEmployee = await prisma.employee.findFirst({
    where: { id: parsed.data.rescueEmployeeId, dspId: me.dspId },
    select: { id: true, legalFirstName: true, legalLastName: true },
  })
  if (!rescueEmployee) { res.status(404).json({ message: 'Rescue employee not found' }); return }

  const rescueShift = await prisma.shift.create({
    data: {
      dspId: me.dspId,
      stationId: original.stationId,
      employeeId: rescueEmployee.id,
      date: original.date,
      shiftTypeId: original.shiftTypeId,
      startTime: original.startTime,
      endTime: original.endTime,
      status: 'PUBLISHED',
      isRescue: true,
      rescuedShiftId: original.id,
    },
    select: {
      id: true, employeeId: true, date: true,
      startTime: true, endTime: true, status: true,
      shiftType: { select: { id: true, name: true, color: true, startTime: true, endTime: true } },
    },
  })

  const rescueName = `${rescueEmployee.legalFirstName} ${rescueEmployee.legalLastName}`

  await Promise.all([
    writeShiftLog({
      shiftId: original.id, dspId: me.dspId,
      action: `Rescue sent: ${rescueName}`,
      performedByClerkId: userId!, performedByName: performerName(me),
    }),
    writeShiftLog({
      shiftId: rescueShift.id, dspId: me.dspId,
      action: `Rescue shift created for this driver`,
      performedByClerkId: userId!, performedByName: performerName(me),
    }),
  ])

  res.status(201).json({
    id: rescueShift.id, employeeId: rescueShift.employeeId, date: rescueShift.date,
    startTime: rescueShift.startTime ?? rescueShift.shiftType?.startTime ?? null,
    endTime: rescueShift.endTime ?? rescueShift.shiftType?.endTime ?? null,
    status: rescueShift.status,
    shiftTypeId: rescueShift.shiftType?.id ?? null,
    shiftTypeName: rescueShift.shiftType?.name ?? null,
    color: rescueShift.shiftType?.color ?? null,
    isRescue: true, deviceCount: 0, routes: [], isTrainer: false, isLightDuty: false,
  })
}

// ─── POST /api/scheduler/shifts/:shiftId/send-home ───────────────────────────

export async function sendHome(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await getCallerEmployee(userId!)
  if (!me?.dspId) { res.status(404).json({ error: 'No DSP found' }); return }

  const existing = await resolveShift(req.params.shiftId as string, me.dspId)
  if (!existing) { res.status(404).json({ message: 'Work block not found' }); return }

  const shift = await prisma.shift.update({
    where: { id: existing.id as string },
    data: { status: 'COMPLETED' },
  })

  await writeShiftLog({
    shiftId: existing.id as string, dspId: me.dspId,
    action: 'Driver sent home — shift marked completed',
    performedByClerkId: userId!, performedByName: performerName(me),
  })

  res.json({ id: shift.id, status: shift.status })
}

// ─── DELETE /api/scheduler/shifts/:shiftId ───────────────────────────────────

export async function deleteShift(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await getCallerEmployee(userId!)
  if (!me?.dspId) { res.status(404).json({ error: 'No DSP found' }); return }

  const shift = await resolveShift(req.params.shiftId as string, me.dspId)
  if (!shift) { res.status(404).json({ message: 'Work block not found' }); return }

  await prisma.shift.delete({ where: { id: shift.id } })
  res.status(204).end()
}

// ─── GET /api/scheduler/shifts/:shiftId/logs ─────────────────────────────────

export async function getShiftLogs(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await getCallerEmployee(userId!)
  if (!me?.dspId) { res.status(404).json({ error: 'No DSP found' }); return }

  const shift = await resolveShift(req.params.shiftId as string, me.dspId)
  if (!shift) { res.status(404).json({ message: 'Work block not found' }); return }

  const logs = await prisma.shiftLog.findMany({
    where: { shiftId: shift.id as string },
    orderBy: { createdAt: 'desc' },
  })

  res.json(logs)
}

// ─── Excel import helpers ─────────────────────────────────────────────────────

export const importUploadMiddleware = multer({ storage: multer.memoryStorage() }).single('file')

const MONTH_ABBR: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

/** Parse Amazon schedule date header like "Sun, 17/May" into "YYYY-MM-DD" */
function parseAmazonDateHeader(header: string, year: number): string | null {
  // "Sun, 17/May" — day-of-week prefix is optional
  const m = header.match(/(\d{1,2})\/([A-Za-z]{3})/)
  if (!m) return null
  const day = parseInt(m[1])
  const month = MONTH_ABBR[m[2].toLowerCase()]
  if (!month || isNaN(day)) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Extract 4-digit year from Amazon export timestamp like "5/17/26, 11:15:17 AM" */
function parseExportYear(ts: string): number {
  const m = ts.match(/\d{1,2}\/\d{1,2}\/(\d{2,4})/)
  if (!m) return new Date().getFullYear()
  const yr = parseInt(m[1])
  return yr < 100 ? 2000 + yr : yr
}

function importParseTimeStr(raw: string): string | null {
  const m = raw.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i)
  if (!m) return null
  let h = parseInt(m[1])
  const min = parseInt(m[2])
  const ampm = m[3].toLowerCase()
  if (ampm === 'pm' && h !== 12) h += 12
  if (ampm === 'am' && h === 12) h = 0
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

function addMinutesToHHMM(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(':').map(Number)
  const total = h * 60 + m + mins
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function parseShiftCell(raw: string): {
  shiftTypeName: string; startTime: string; endTime: string; durationMinutes: number
} | null {
  const trimmed = raw.trim()
  if (!trimmed || /^(off|day off)$/i.test(trimmed)) return null
  const lines = trimmed.split('\n').map(s => s.trim()).filter(Boolean)
  if (lines.length < 2) return null
  const shiftTypeName = lines[0]
  // "10:30am • 10 hrs" or "10:20am • 10.5 hrs"
  const m = lines[1].match(/^(\d{1,2}:\d{2}\s*(?:am|pm))\s*[•·]\s*(\d+(?:\.\d+)?)\s*hrs?/i)
  if (!m) return null
  const startTime = importParseTimeStr(m[1].replace(/\s/g, ''))
  if (!startTime) return null
  const durationMinutes = Math.round(parseFloat(m[2]) * 60)
  const endTime = addMinutesToHHMM(startTime, durationMinutes)
  return { shiftTypeName, startTime, endTime, durationMinutes }
}

interface ImportParsedEntry {
  transporterId: string
  employeeId: string
  employeeName: string
  date: string
  shiftTypeName: string
  startTime: string
  endTime: string
  durationMinutes: number
}

interface ImportConflict {
  key: string
  employeeName: string
  date: string
  existingShifts: Array<{ id: string; shiftTypeName: string; startTime: string; endTime: string }>
  incoming: { shiftTypeName: string; startTime: string; endTime: string }
}

// ─── POST /api/scheduler/import/parse ────────────────────────────────────────

export async function importParse(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await getCallerEmployee(userId!)
  if (!me?.dspId) { res.status(404).json({ message: 'DSP not found' }); return }
  if (!req.file) { res.status(400).json({ message: 'No file uploaded' }); return }

  const { stationId } = req.body as { stationId?: string }
  if (!stationId) { res.status(400).json({ message: 'stationId is required' }); return }

  const station = await prisma.station.findFirst({ where: { id: stationId, dspId: me.dspId } })
  if (!station) { res.status(404).json({ message: 'Station not found' }); return }

  // Parse workbook — prefer "Rostered Work Blocks" sheet
  const workbook = XLSX.read(req.file.buffer, { type: 'buffer' })
  const sheetName = workbook.SheetNames.find(n => /roster/i.test(n)) ?? workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '', raw: false })

  // Auto-detect file type: Routes file has "Route code" + "Transporter Id" in first row
  if (rows.length > 0 && 'Route code' in rows[0] && 'Transporter Id' in rows[0]) {
    return handleRoutesParse(req, res, rows, me, stationId)
  }

  // Amazon DSP format:
  // rows[0] = metadata (timestamp in "Time Stamp" col)
  // rows[1] = column headers: { "Time Stamp": "Associate Name", "Company": "Transporter ID", "Station": "Sun, 17/May", ... }
  // rows[2] = "Total Rostered" counts (skip)
  // rows[3+] = driver data
  if (rows.length < 4) {
    res.status(400).json({ message: 'File format not recognized. Expected Amazon DSP schedule.' })
    return
  }

  const metaRow = rows[0]
  const headerRow = rows[1]
  const year = parseExportYear(String(metaRow['Time Stamp'] ?? ''))

  // Identify column keys for name, transporter ID, and day columns
  let nameCol: string | null = null
  let transporterCol: string | null = null
  const dayColumns: Array<{ key: string; date: string }> = []

  for (const [key, value] of Object.entries(headerRow)) {
    const v = String(value).trim()
    if (/associate\s*name/i.test(v)) nameCol = key
    else if (/transporter\s*id/i.test(v)) transporterCol = key
    else {
      const date = parseAmazonDateHeader(v, year)
      if (date) dayColumns.push({ key, date })
    }
  }

  if (!nameCol || !transporterCol || dayColumns.length === 0) {
    res.status(400).json({ message: 'Could not parse file headers. Expected Amazon DSP schedule format.' })
    return
  }

  const weekStart = dayColumns.map(d => d.date).sort()[0]

  // Collect raw entries from rows[3+]
  const seenTransporterIds = new Set<string>()
  interface RawEntry {
    transporterId: string
    date: string
    shiftTypeName: string
    startTime: string
    endTime: string
    durationMinutes: number
  }
  const rawEntries: RawEntry[] = []

  for (let i = 3; i < rows.length; i++) {
    const row = rows[i]
    const transporterId = String(row[transporterCol] ?? '').trim()
    if (!transporterId) continue
    seenTransporterIds.add(transporterId)

    for (const { key, date } of dayColumns) {
      const cell = String(row[key] ?? '').trim()
      const parsed = parseShiftCell(cell)
      if (parsed) {
        rawEntries.push({ transporterId, date, ...parsed })
      }
    }
  }

  // Resolve employees by transporterId
  const employees = await prisma.employee.findMany({
    where: { dspId: me.dspId, transporterId: { in: [...seenTransporterIds] } },
    select: { id: true, legalFirstName: true, legalLastName: true, transporterId: true },
  })
  const empByTransporter = new Map(employees.map(e => [e.transporterId!, e]))
  const unmatchedTransporterIds = [...seenTransporterIds].filter(tid => !empByTransporter.has(tid))

  // Build matched entries
  const entries: ImportParsedEntry[] = []
  for (const raw of rawEntries) {
    const emp = empByTransporter.get(raw.transporterId)
    if (!emp) continue
    entries.push({
      transporterId: raw.transporterId,
      employeeId: emp.id,
      employeeName: `${emp.legalFirstName} ${emp.legalLastName}`,
      date: raw.date,
      shiftTypeName: raw.shiftTypeName,
      startTime: raw.startTime,
      endTime: raw.endTime,
      durationMinutes: raw.durationMinutes,
    })
  }

  // Find shift type names not yet in DB for this station
  const allShiftTypeNames = [...new Set(entries.map(e => e.shiftTypeName))]
  const existingTypes = await prisma.shiftType.findMany({
    where: { stationId, name: { in: allShiftTypeNames } },
    select: { name: true },
  })
  const existingTypeNames = new Set(existingTypes.map(t => t.name))
  const newShiftTypeNames = allShiftTypeNames.filter(n => !existingTypeNames.has(n))

  // Find conflicts (employee already has a shift on that day at this station)
  const allDates = [...new Set(entries.map(e => e.date))]
  const allEmpIds = [...new Set(entries.map(e => e.employeeId))]

  const existingShifts = await prisma.shift.findMany({
    where: { stationId, dspId: me.dspId, employeeId: { in: allEmpIds }, date: { in: allDates } },
    select: {
      id: true, employeeId: true, date: true, startTime: true, endTime: true,
      shiftType: { select: { name: true } },
    },
  })

  const shiftsByKey = new Map<string, typeof existingShifts>()
  for (const s of existingShifts) {
    const key = `${s.employeeId}:${s.date}`
    if (!shiftsByKey.has(key)) shiftsByKey.set(key, [])
    shiftsByKey.get(key)!.push(s)
  }

  const conflicts: ImportConflict[] = []
  const seenConflictKeys = new Set<string>()
  for (const entry of entries) {
    const key = `${entry.employeeId}:${entry.date}`
    const existing = shiftsByKey.get(key)
    if (existing && existing.length > 0 && !seenConflictKeys.has(key)) {
      seenConflictKeys.add(key)
      conflicts.push({
        key,
        employeeName: entry.employeeName,
        date: entry.date,
        existingShifts: existing.map(s => ({
          id: s.id,
          shiftTypeName: s.shiftType?.name ?? 'Ad-hoc',
          startTime: s.startTime ?? '',
          endTime: s.endTime ?? '',
        })),
        incoming: {
          shiftTypeName: entry.shiftTypeName,
          startTime: entry.startTime,
          endTime: entry.endTime,
        },
      })
    }
  }

  res.json({ type: 'schedule' as const, weekStart, entries, unmatchedTransporterIds, newShiftTypeNames, conflicts })
}

// ─── Routes file parse (called from importParse when auto-detected) ──────────

async function handleRoutesParse(
  req: Request, res: Response,
  rows: Record<string, string>[],
  me: { id: string; dspId: string | null },
  stationId: string,
) {
  // Extract date from filename: "Routes_DIN6_2026-05-17_00_47 (GMT+5_30).xlsx"
  const filename = req.file?.originalname ?? ''
  const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/)
  if (!dateMatch) {
    res.status(400).json({ message: 'Could not detect date from filename. Expected format: Routes_*_YYYY-MM-DD_*' })
    return
  }
  const date = dateMatch[1]

  // Collect route rows, expanding pipe-separated transporter IDs
  interface RouteRow { routeCode: string; transporterIds: string[] }
  const routeRows: RouteRow[] = []
  const allTransporterIds = new Set<string>()

  for (const row of rows) {
    const routeCode = (row['Route code'] ?? '').trim()
    const rawTid = (row['Transporter Id'] ?? '').trim()
    if (!routeCode || !rawTid) continue
    const transporterIds = rawTid.split('|').map(t => t.trim()).filter(Boolean)
    transporterIds.forEach(t => allTransporterIds.add(t))
    routeRows.push({ routeCode, transporterIds })
  }

  // Resolve employees by transporterId
  const employees = await prisma.employee.findMany({
    where: { dspId: me.dspId!, transporterId: { in: [...allTransporterIds] } },
    select: { id: true, legalFirstName: true, legalLastName: true, transporterId: true },
  })
  const empByTid = new Map(employees.map(e => [e.transporterId!, e]))
  const unmatchedTransporterIds = [...allTransporterIds].filter(t => !empByTid.has(t))

  // Find existing shifts on this date for matched employees
  const matchedEmpIds = employees.map(e => e.id)
  const existingShifts = await prisma.shift.findMany({
    where: { stationId, dspId: me.dspId!, date, employeeId: { in: matchedEmpIds } },
    select: { id: true, employeeId: true, routes: true },
  })
  const shiftByEmpId = new Map(existingShifts.map(s => [s.employeeId, s]))

  // Build assignments
  interface RouteAssignment {
    routeCode: string
    transporterId: string
    employeeId: string
    employeeName: string
    shiftId: string
    alreadyAssigned: boolean
  }
  const matched: RouteAssignment[] = []
  const noWorkBlock: Array<{ routeCode: string; transporterId: string; employeeName: string }> = []

  for (const { routeCode, transporterIds } of routeRows) {
    for (const tid of transporterIds) {
      const emp = empByTid.get(tid)
      if (!emp) continue
      const shift = shiftByEmpId.get(emp.id)
      const name = `${emp.legalFirstName} ${emp.legalLastName}`
      if (!shift) {
        noWorkBlock.push({ routeCode, transporterId: tid, employeeName: name })
      } else {
        matched.push({
          routeCode, transporterId: tid, employeeId: emp.id, employeeName: name,
          shiftId: shift.id,
          alreadyAssigned: shift.routes.includes(routeCode),
        })
      }
    }
  }

  res.json({
    type: 'routes' as const,
    date,
    matched,
    noWorkBlock,
    unmatchedTransporterIds,
  })
}

// ─── POST /api/scheduler/import/routes-execute ───────────────────────────────

const routesExecuteSchema = z.object({
  assignments: z.array(z.object({
    shiftId: z.string(),
    routeCode: z.string(),
  })),
})

export async function importRoutesExecute(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await getCallerEmployee(userId!)
  if (!me?.dspId) { res.status(404).json({ message: 'DSP not found' }); return }

  const parsed = routesExecuteSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }

  const { assignments } = parsed.data

  // Group by shiftId (multiple routes can go to same shift)
  const byShift = new Map<string, string[]>()
  for (const { shiftId, routeCode } of assignments) {
    if (!byShift.has(shiftId)) byShift.set(shiftId, [])
    byShift.get(shiftId)!.push(routeCode)
  }

  let updated = 0
  for (const [shiftId, routeCodes] of byShift) {
    const shift = await prisma.shift.findUnique({ where: { id: shiftId }, select: { id: true, dspId: true, routes: true } })
    if (!shift || shift.dspId !== me.dspId) continue
    const merged = [...new Set([...shift.routes, ...routeCodes])]
    await prisma.shift.update({ where: { id: shiftId }, data: { routes: merged } })
    updated++
  }

  res.json({ updated })
}

// ─── POST /api/scheduler/import/execute ──────────────────────────────────────

const importExecuteSchema = z.object({
  stationId: z.string().min(1),
  entries: z.array(z.object({
    transporterId: z.string(),
    employeeId: z.string(),
    employeeName: z.string(),
    date: z.string(),
    shiftTypeName: z.string(),
    startTime: z.string(),
    endTime: z.string(),
    durationMinutes: z.number(),
  })),
  conflictChoices: z.record(z.string(), z.enum(['replace', 'add', 'skip'])),
  /** Colors for newly created shift types, keyed by shift type name */
  newShiftTypeColors: z.record(z.string(), z.string().regex(/^#[0-9a-fA-F]{6}$/)).optional(),
})

export async function importExecute(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await getCallerEmployee(userId!)
  if (!me?.dspId) { res.status(404).json({ message: 'DSP not found' }); return }

  const parsed = importExecuteSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }

  const { stationId, entries, conflictChoices, newShiftTypeColors } = parsed.data

  const station = await prisma.station.findFirst({ where: { id: stationId, dspId: me.dspId } })
  if (!station) { res.status(404).json({ message: 'Station not found' }); return }

  // Resolve / auto-create shift types
  const allNames = [...new Set(entries.map(e => e.shiftTypeName))]
  const existingTypes = await prisma.shiftType.findMany({
    where: { stationId, name: { in: allNames } },
    select: { id: true, name: true },
  })
  const nameToId = new Map(existingTypes.map(t => [t.name, t.id]))
  const createdShiftTypes: Array<{ id: string; name: string }> = []

  for (const name of allNames) {
    if (!nameToId.has(name)) {
      const sample = entries.find(e => e.shiftTypeName === name)!
      try {
        const newSt = await prisma.shiftType.create({
          data: {
            stationId,
            name,
            startTime: sample.startTime,
            endTime: sample.endTime,
            durationMinutes: sample.durationMinutes,
            color: newShiftTypeColors?.[name] ?? null,
          },
        })
        nameToId.set(name, newSt.id)
        createdShiftTypes.push({ id: newSt.id, name })
      } catch {
        // Race condition: another request created it — fetch and use existing
        const existing = await prisma.shiftType.findUnique({
          where: { stationId_name: { stationId, name } },
          select: { id: true, name: true },
        })
        if (existing) {
          nameToId.set(name, existing.id)
        }
      }
    }
  }

  // Fetch existing shifts for conflict resolution
  const allDates = [...new Set(entries.map(e => e.date))]
  const allEmpIds = [...new Set(entries.map(e => e.employeeId))]
  const existingShifts = await prisma.shift.findMany({
    where: { stationId, dspId: me.dspId, employeeId: { in: allEmpIds }, date: { in: allDates } },
    select: { id: true, employeeId: true, date: true },
  })

  const existingByKey = new Map<string, string[]>()
  for (const s of existingShifts) {
    const key = `${s.employeeId}:${s.date}`
    if (!existingByKey.has(key)) existingByKey.set(key, [])
    existingByKey.get(key)!.push(s.id)
  }

  let created = 0, replaced = 0, skipped = 0
  const idsToDelete: string[] = []
  const toCreate: typeof entries = []

  for (const entry of entries) {
    const key = `${entry.employeeId}:${entry.date}`
    const existing = existingByKey.get(key) ?? []

    if (existing.length > 0) {
      const choice = conflictChoices[key] ?? 'replace'
      if (choice === 'skip') { skipped++; continue }
      if (choice === 'replace') {
        idsToDelete.push(...existing)
        replaced++
      } else {
        // 'add' — create alongside existing
        created++
      }
    } else {
      created++
    }
    toCreate.push(entry)
  }

  if (idsToDelete.length > 0) {
    await prisma.shift.deleteMany({ where: { id: { in: idsToDelete } } })
  }

  if (toCreate.length > 0) {
    await prisma.shift.createMany({
      data: toCreate.map(e => ({
        dspId: me.dspId!,
        stationId,
        employeeId: e.employeeId,
        shiftTypeId: nameToId.get(e.shiftTypeName) ?? null,
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime,
        status: 'PUBLISHED' as const,
      })),
    })
  }

  res.json({ created, replaced, skipped, createdShiftTypes })
}
