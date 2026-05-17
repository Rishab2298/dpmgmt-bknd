import { Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { z } from 'zod'
import { MaintenanceCategory, MaintenanceStatus, ActivityEntityType } from '@prisma/client'
import { prisma } from '../lib/prisma'
import multer from 'multer'
import path from 'path'
import fs from 'fs'

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function resolveDsp(userId: string): Promise<string | null> {
  const emp = await prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { dspId: true },
  })
  return emp?.dspId ?? null
}

async function resolveRecordOwnership(userId: string, recordId: string) {
  const dspId = await resolveDsp(userId)
  if (!dspId) return null
  const record = await prisma.vehicleMaintenanceRecord.findUnique({ where: { id: recordId } })
  if (!record || record.dspId !== dspId) return null
  return { record, dspId }
}

async function resolvePerformerName(userId: string): Promise<string> {
  const emp = await prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { legalFirstName: true, legalLastName: true },
  })
  return emp ? `${emp.legalFirstName} ${emp.legalLastName}` : 'Unknown'
}

// ─── Shared include ───────────────────────────────────────────────────────────

const MAINTENANCE_INCLUDE = {
  vehicle: {
    select: {
      id: true, vehicleId: true, make: true, model: true, year: true,
      station: { select: { id: true, code: true } },
    },
  },
}

// ─── Activity log helper ──────────────────────────────────────────────────────

async function writeLog(opts: {
  dspId: string
  entityType: ActivityEntityType
  entityId: string
  action: string
  performedByClerkId?: string
  performedByName?: string
}) {
  await prisma.activityLog.create({
    data: {
      dspId: opts.dspId,
      entityType: opts.entityType,
      entityId: opts.entityId,
      action: opts.action,
      performedByClerkId: opts.performedByClerkId,
      performedByName: opts.performedByName,
    },
  })
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const createMaintenanceSchema = z.object({
  vehicleId:     z.string().min(1, 'Vehicle is required'),
  category:      z.nativeEnum(MaintenanceCategory),
  status:        z.nativeEnum(MaintenanceStatus).optional(),
  description:   z.string().optional().nullable(),
  serviceDate:   z.string().optional().nullable(),
  mileage:       z.number().optional().nullable(),
  estimatedCost: z.number().optional().nullable(),
  actualCost:    z.number().optional().nullable(),
  vendorName:    z.string().optional().nullable(),
  vendorAddress: z.string().optional().nullable(),
  invoiceNumber: z.string().optional().nullable(),
  notes:         z.string().optional().nullable(),
})

const updateMaintenanceSchema = createMaintenanceSchema.partial().omit({ vehicleId: true })

function toDate(s: string | null | undefined): Date | null {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

// ─── Vehicle status sync ──────────────────────────────────────────────────────

async function syncVehicleStatus(vehicleId: string, dspId: string, performedByName: string) {
  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { status: true } })
  if (!vehicle) return

  const now = new Date()
  const hasActiveRecord = await prisma.vehicleMaintenanceRecord.findFirst({
    where: {
      vehicleId,
      status: { in: ['OPEN', 'IN_PROGRESS'] },
      OR: [{ serviceDate: null }, { serviceDate: { gte: now } }],
    },
  })

  if (hasActiveRecord && vehicle.status === 'ACTIVE') {
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: 'IN_REPAIR' } })
    await writeLog({
      dspId, entityType: 'VEHICLE', entityId: vehicleId,
      action: 'Status: ACTIVE → IN_REPAIR (active service record)',
      performedByName,
    })
  } else if (!hasActiveRecord && vehicle.status === 'IN_REPAIR') {
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: 'ACTIVE' } })
    await writeLog({
      dspId, entityType: 'VEHICLE', entityId: vehicleId,
      action: 'Status: IN_REPAIR → ACTIVE (no active service records)',
      performedByName,
    })
  }
}

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listMaintenanceRecords(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ message: 'DSP not found' }); return }

  const { vehicleId, status, category, search, page = '1', limit = '100' } = req.query as Record<string, string>

  const where: Record<string, unknown> = { dspId }
  if (vehicleId) where.vehicleId = vehicleId
  if (status) where.status = status
  if (category) where.category = category
  if (search) {
    where.vehicle = {
      OR: [
        { vehicleId: { contains: search, mode: 'insensitive' } },
        { make: { contains: search, mode: 'insensitive' } },
        { model: { contains: search, mode: 'insensitive' } },
      ],
    }
  }

  const skip = (parseInt(page) - 1) * parseInt(limit)
  const [records, total] = await Promise.all([
    prisma.vehicleMaintenanceRecord.findMany({
      where, include: MAINTENANCE_INCLUDE,
      skip, take: parseInt(limit),
      orderBy: { createdAt: 'desc' },
    }),
    prisma.vehicleMaintenanceRecord.count({ where }),
  ])

  res.json({ records, total })
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createMaintenanceRecord(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ message: 'DSP not found' }); return }

  const parsed = createMaintenanceSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }
  const data = parsed.data

  // Verify vehicle belongs to this DSP
  const vehicle = await prisma.vehicle.findFirst({ where: { id: data.vehicleId, dspId } })
  if (!vehicle) { res.status(400).json({ message: 'Vehicle not found in this DSP' }); return }

  const record = await prisma.vehicleMaintenanceRecord.create({
    data: {
      dspId,
      vehicleId: data.vehicleId,
      category: data.category,
      status: data.status ?? 'OPEN',
      description: data.description ?? null,
      serviceDate: toDate(data.serviceDate),
      mileage: data.mileage ?? null,
      estimatedCost: data.estimatedCost ?? null,
      actualCost: data.actualCost ?? null,
      vendorName: data.vendorName ?? null,
      vendorAddress: data.vendorAddress ?? null,
      invoiceNumber: data.invoiceNumber ?? null,
      notes: data.notes ?? null,
    },
    include: MAINTENANCE_INCLUDE,
  })

  const performerName = await resolvePerformerName(userId!)
  await writeLog({
    dspId, entityType: 'VEHICLE', entityId: data.vehicleId,
    action: `Maintenance record created: ${data.category.replace(/_/g, ' ').toLowerCase()}`,
    performedByClerkId: userId!, performedByName: performerName,
  })

  await syncVehicleStatus(data.vehicleId, dspId, performerName)

  res.status(201).json(record)
}

// ─── Get ──────────────────────────────────────────────────────────────────────

export async function getMaintenanceRecord(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const result = await resolveRecordOwnership(userId!, id)
  if (!result) { res.status(404).json({ message: 'Record not found' }); return }
  const record = await prisma.vehicleMaintenanceRecord.findUnique({ where: { id }, include: MAINTENANCE_INCLUDE })
  res.json(record)
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function updateMaintenanceRecord(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const result = await resolveRecordOwnership(userId!, id)
  if (!result) { res.status(404).json({ message: 'Record not found' }); return }

  const parsed = updateMaintenanceSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }
  const data = parsed.data

  const old = result.record
  const updateData: Record<string, unknown> = {}
  const logParts: string[] = []

  const scalarFields: Array<[keyof typeof data, string]> = [
    ['category', 'Category'], ['status', 'Status'], ['description', 'Description'],
    ['mileage', 'Mileage'], ['estimatedCost', 'Estimated cost'], ['actualCost', 'Actual cost'],
    ['vendorName', 'Vendor name'], ['vendorAddress', 'Vendor address'],
    ['invoiceNumber', 'Invoice #'], ['notes', 'Notes'],
  ]
  for (const [field, label] of scalarFields) {
    if (field in data) {
      const newVal = data[field]
      const oldVal = (old as Record<string, unknown>)[field]
      updateData[field] = newVal ?? null
      if (String(oldVal ?? '') !== String(newVal ?? '')) {
        logParts.push(`${label}: ${oldVal ?? '—'} → ${newVal ?? '—'}`)
      }
    }
  }
  if ('serviceDate' in data) {
    const newDate = toDate(data.serviceDate)
    updateData.serviceDate = newDate
    const oldStr = old.serviceDate ? new Date(old.serviceDate).toISOString().split('T')[0] : '—'
    const newStr = newDate ? newDate.toISOString().split('T')[0] : '—'
    if (oldStr !== newStr) logParts.push(`Service date: ${oldStr} → ${newStr}`)
  }

  const record = await prisma.vehicleMaintenanceRecord.update({
    where: { id },
    data: updateData,
    include: MAINTENANCE_INCLUDE,
  })

  const performerName = await resolvePerformerName(userId!)
  if (logParts.length > 0) {
    await writeLog({
      dspId: result.dspId, entityType: 'VEHICLE', entityId: old.vehicleId,
      action: `Maintenance updated: ${logParts.join('; ')}`,
      performedByClerkId: userId!, performedByName: performerName,
    })
  }

  await syncVehicleStatus(old.vehicleId, result.dspId, performerName)

  res.json(record)
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteMaintenanceRecord(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const result = await resolveRecordOwnership(userId!, id)
  if (!result) { res.status(404).json({ message: 'Record not found' }); return }

  // Delete attachment file if present
  if (result.record.attachmentUrl) {
    const filePath = path.join(process.cwd(), result.record.attachmentUrl)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  }

  await prisma.vehicleMaintenanceRecord.delete({ where: { id } })

  const performerName = await resolvePerformerName(userId!)
  await writeLog({
    dspId: result.dspId, entityType: 'VEHICLE', entityId: result.record.vehicleId,
    action: `Maintenance record deleted: ${result.record.category.replace(/_/g, ' ').toLowerCase()}`,
    performedByClerkId: userId!, performedByName: performerName,
  })

  await syncVehicleStatus(result.record.vehicleId, result.dspId, performerName)

  res.status(204).send()
}

// ─── File attachment ──────────────────────────────────────────────────────────

const UPLOADS_DIR = path.join(process.cwd(), 'uploads', 'maintenance')
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })

export const maintenanceUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) =>
      cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
}).single('file')

export async function uploadMaintenanceAttachment(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const result = await resolveRecordOwnership(userId!, id)
  if (!result) { res.status(404).json({ message: 'Record not found' }); return }
  if (!req.file) { res.status(400).json({ message: 'No file uploaded' }); return }

  // Delete old file if replacing
  if (result.record.attachmentUrl) {
    const oldPath = path.join(process.cwd(), result.record.attachmentUrl)
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath)
  }

  const attachmentUrl = `/uploads/maintenance/${req.file.filename}`
  const record = await prisma.vehicleMaintenanceRecord.update({
    where: { id },
    data: { attachmentUrl },
    include: MAINTENANCE_INCLUDE,
  })

  res.json(record)
}
