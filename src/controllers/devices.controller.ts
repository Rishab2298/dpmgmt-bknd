import { Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { z } from 'zod'
import { DeviceCondition, DeviceStatus, ActivityEntityType } from '@prisma/client'
import { prisma } from '../lib/prisma'
import multer from 'multer'
import * as XLSX from 'xlsx'

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function resolveDsp(userId: string): Promise<string | null> {
  const emp = await prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { dspId: true },
  })
  return emp?.dspId ?? null
}

async function resolveDeviceOwnership(userId: string, deviceId: string) {
  const dspId = await resolveDsp(userId)
  if (!dspId) return null
  const device = await prisma.device.findUnique({ where: { id: deviceId } })
  if (!device || device.dspId !== dspId) return null
  return { device, dspId }
}

// ─── Shared include ───────────────────────────────────────────────────────────

const DEVICE_INCLUDE = {
  station: { select: { id: true, code: true, name: true } },
  assignedEmployee: { select: { id: true, legalFirstName: true, legalLastName: true } },
  lastUsedByEmployee: { select: { id: true, legalFirstName: true, legalLastName: true } },
}

// ─── Activity log helper ──────────────────────────────────────────────────────

async function writeLog(opts: {
  dspId: string
  entityType: ActivityEntityType
  entityId: string
  action: string
  metadata?: Record<string, unknown>
  performedByClerkId?: string
  performedByName?: string
}) {
  await prisma.activityLog.create({
    data: {
      dspId: opts.dspId,
      entityType: opts.entityType,
      entityId: opts.entityId,
      action: opts.action,
      metadata: opts.metadata ? (opts.metadata as object) : undefined,
      performedByClerkId: opts.performedByClerkId,
      performedByName: opts.performedByName,
    },
  })
}

async function resolvePerformerName(userId: string): Promise<string> {
  const emp = await prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { legalFirstName: true, legalLastName: true },
  })
  return emp ? `${emp.legalFirstName} ${emp.legalLastName}` : 'Unknown'
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const createDeviceSchema = z.object({
  stationId:        z.string().min(1, 'Station is required'),
  deviceName:       z.string().min(1, 'Device name is required'),
  phoneNumber:      z.string().optional().nullable(),
  status:           z.nativeEnum(DeviceStatus).default('ACTIVE'),
  condition:        z.nativeEnum(DeviceCondition).optional().nullable(),
  carrier:          z.string().optional().nullable(),
  username:         z.string().optional().nullable(),
  platform:         z.string().optional().nullable(),
  manufacturer:     z.string().optional().nullable(),
  model:            z.string().optional().nullable(),
  osVersion:        z.string().optional().nullable(),
  mdmClient:        z.boolean().optional(),
  assetTagId:       z.string().optional().nullable(),
  serialNumber:     z.string().optional().nullable(),
  uid:              z.string().optional().nullable(),
  imei:             z.string().optional().nullable(),
  isPersonalDevice: z.boolean().optional(),
  canRunLoadOut:    z.boolean().optional(),
  statusDate:       z.string().optional().nullable(),
})

const updateDeviceSchema = createDeviceSchema.partial().extend({
  stationId: z.string().min(1).optional(),
})

// ─── List devices ─────────────────────────────────────────────────────────────

export async function listDevices(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ message: 'DSP not found' }); return }

  const { stationId, status, condition, search, page = '1', limit = '100' } = req.query as Record<string, string>
  const where: Record<string, unknown> = { dspId }
  if (stationId) where.stationId = stationId
  if (status) where.status = status
  if (condition) where.condition = condition
  if (search) {
    where.OR = [
      { deviceName: { contains: search, mode: 'insensitive' } },
      { phoneNumber: { contains: search } },
      { model: { contains: search, mode: 'insensitive' } },
      { assetTagId: { contains: search, mode: 'insensitive' } },
      { imei: { contains: search } },
    ]
  }

  const skip = (parseInt(page) - 1) * parseInt(limit)
  const [devices, total] = await Promise.all([
    prisma.device.findMany({ where, include: DEVICE_INCLUDE, skip, take: parseInt(limit), orderBy: { createdAt: 'desc' } }),
    prisma.device.count({ where }),
  ])

  res.json({ devices, total, page: parseInt(page), limit: parseInt(limit) })
}

// ─── Create device ────────────────────────────────────────────────────────────

export async function createDevice(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ message: 'DSP not found' }); return }

  const parsed = createDeviceSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }
  const data = parsed.data

  // Verify station belongs to DSP
  const station = await prisma.station.findFirst({ where: { id: data.stationId, dspId } })
  if (!station) { res.status(400).json({ message: 'Station not found' }); return }

  const device = await prisma.device.create({
    data: {
      dspId,
      stationId: data.stationId,
      deviceName: data.deviceName,
      phoneNumber: data.phoneNumber ?? null,
      status: data.status,
      condition: data.condition ?? null,
      carrier: data.carrier ?? null,
      username: data.username ?? null,
      platform: data.platform ?? null,
      manufacturer: data.manufacturer ?? null,
      model: data.model ?? null,
      osVersion: data.osVersion ?? null,
      mdmClient: data.mdmClient ?? false,
      assetTagId: data.assetTagId ?? null,
      serialNumber: data.serialNumber ?? null,
      uid: data.uid ?? null,
      imei: data.imei ?? null,
      isPersonalDevice: data.isPersonalDevice ?? false,
      canRunLoadOut: data.canRunLoadOut ?? false,
      statusDate: data.statusDate ? new Date(data.statusDate) : null,
    },
    include: DEVICE_INCLUDE,
  })

  const performerName = await resolvePerformerName(userId!)
  await writeLog({
    dspId, entityType: 'DEVICE', entityId: device.id,
    action: 'Device created',
    performedByClerkId: userId!, performedByName: performerName,
  })

  res.status(201).json(device)
}

// ─── Get device ───────────────────────────────────────────────────────────────

export async function getDevice(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const result = await resolveDeviceOwnership(userId!, id)
  if (!result) { res.status(404).json({ message: 'Device not found' }); return }

  const device = await prisma.device.findUnique({ where: { id }, include: DEVICE_INCLUDE })
  res.json(device)
}

// ─── Update device ────────────────────────────────────────────────────────────

export async function updateDevice(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const result = await resolveDeviceOwnership(userId!, id)
  if (!result) { res.status(404).json({ message: 'Device not found' }); return }

  const parsed = updateDeviceSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }
  const data = parsed.data

  const old = result.device
  const updateData: Record<string, unknown> = {}
  const logParts: string[] = []

  // Build diff-aware update
  const fields: Array<[keyof typeof data, string]> = [
    ['deviceName', 'Device name'], ['phoneNumber', 'Phone number'], ['status', 'Status'],
    ['condition', 'Condition'], ['carrier', 'Carrier'], ['username', 'Username'],
    ['platform', 'Platform'], ['manufacturer', 'Manufacturer'], ['model', 'Model'],
    ['osVersion', 'OS version'], ['mdmClient', 'MDM client'], ['assetTagId', 'Asset tag ID'],
    ['serialNumber', 'Serial number'], ['uid', 'UID'], ['imei', 'IMEI'],
    ['isPersonalDevice', 'Personal device'], ['canRunLoadOut', 'Allow load out'],
    ['stationId', 'Station'],
  ]

  for (const [field, label] of fields) {
    if (field in data) {
      const newVal = data[field]
      const oldVal = (old as Record<string, unknown>)[field]
      updateData[field] = newVal ?? null
      if (String(oldVal ?? '') !== String(newVal ?? '')) {
        logParts.push(`${label} changed: ${oldVal ?? '—'} → ${newVal ?? '—'}`)
      }
    }
  }

  if (data.statusDate !== undefined) {
    updateData.statusDate = data.statusDate ? new Date(data.statusDate) : null
  }

  const device = await prisma.device.update({ where: { id }, data: updateData, include: DEVICE_INCLUDE })

  if (logParts.length > 0) {
    const performerName = await resolvePerformerName(userId!)
    await writeLog({
      dspId: result.dspId, entityType: 'DEVICE', entityId: id,
      action: logParts.join('; '),
      performedByClerkId: userId!, performedByName: performerName,
    })
  }

  res.json(device)
}

// ─── Delete device ────────────────────────────────────────────────────────────

export async function deleteDevice(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const result = await resolveDeviceOwnership(userId!, id)
  if (!result) { res.status(404).json({ message: 'Device not found' }); return }

  const performerName = await resolvePerformerName(userId!)
  await writeLog({
    dspId: result.dspId, entityType: 'DEVICE', entityId: id,
    action: `Device deleted: ${result.device.deviceName}`,
    performedByClerkId: userId!, performedByName: performerName,
  })

  await prisma.device.delete({ where: { id } })
  res.status(204).send()
}

// ─── Get device logs ──────────────────────────────────────────────────────────

export async function listDeviceLogs(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const result = await resolveDeviceOwnership(userId!, id)
  if (!result) { res.status(404).json({ message: 'Device not found' }); return }

  const logs = await prisma.activityLog.findMany({
    where: { entityType: 'DEVICE', entityId: id },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  res.json(logs)
}

// ─── Bulk import ──────────────────────────────────────────────────────────────

export const uploadMiddleware = multer({ storage: multer.memoryStorage() }).single('file')

const CONDITION_MAP: Record<string, DeviceCondition> = {
  good: 'GOOD',
  'cracked screen': 'CRACKED_SCREEN',
  'short battery': 'SHORT_BATTERY',
}

const STATUS_MAP: Record<string, DeviceStatus> = {
  active: 'ACTIVE',
  inactive: 'INACTIVE',
}

export async function bulkImportDevices(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ message: 'DSP not found' }); return }

  if (!req.file) { res.status(400).json({ message: 'No file uploaded' }); return }

  const workbook = XLSX.read(req.file.buffer, { type: 'buffer' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '' })

  // Pre-load stations for code lookup
  const stations = await prisma.station.findMany({ where: { dspId }, select: { id: true, code: true } })
  const stationByCode = new Map(stations.map((s) => [s.code.toLowerCase(), s.id]))

  let created = 0
  const errors: string[] = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const rowNum = i + 2

    const stationCode = (row['Station*'] || row['Station'] || '').trim().toLowerCase()
    const deviceName = (row['Device Name (Name)*'] || row['Device Name'] || '').trim()

    if (!stationCode || !deviceName) {
      errors.push(`Row ${rowNum}: Missing station or device name`)
      continue
    }

    const stationId = stationByCode.get(stationCode)
    if (!stationId) {
      errors.push(`Row ${rowNum}: Unknown station code "${stationCode}"`)
      continue
    }

    const rawCondition = (row['Condition'] || '').trim().toLowerCase()
    const condition = CONDITION_MAP[rawCondition] ?? null

    const rawStatus = (row['Status*'] || row['Status'] || '').trim().toLowerCase()
    const status = STATUS_MAP[rawStatus] ?? 'ACTIVE'

    const rawStatusDate = row['Status_date(Y-M-D)'] || ''
    const statusDate = rawStatusDate ? new Date(rawStatusDate) : null

    try {
      await prisma.device.create({
        data: {
          dspId,
          stationId,
          deviceName,
          phoneNumber: row['Phone Number*'] || row['Phone Number'] || null,
          status,
          condition,
          carrier: row['Carrier'] || null,
          username: row['Username'] || null,
          platform: row['Platform'] || null,
          manufacturer: row['Manufacturer'] || null,
          model: row['Model'] || null,
          osVersion: row['OS Version'] || null,
          mdmClient: (row['MDM Client'] || '').toLowerCase() === 'yes',
          assetTagId: row['Asset Tag ID'] || null,
          imei: row['IMEI/MEID (Internal Device ID)'] || row['IMEI/MEID'] || null,
          uid: row['UID'] || null,
          isPersonalDevice: (row['Personal Device*'] || row['Personal Device'] || '').toLowerCase() === 'yes',
          canRunLoadOut: (row['Run Loadout*'] || row['Run Loadout'] || '').toLowerCase() === 'yes',
          statusDate: statusDate && !isNaN(statusDate.getTime()) ? statusDate : null,
        },
      })
      created++
    } catch (err) {
      errors.push(`Row ${rowNum}: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  res.json({ created, errors })
}
