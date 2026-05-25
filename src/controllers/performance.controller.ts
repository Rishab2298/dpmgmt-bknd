import { Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { z } from 'zod'
import multer from 'multer'
import * as XLSX from 'xlsx'
import { prisma } from '../lib/prisma'

// ─── Auth helper ──────────────────────────────────────────────────────────────

function getDspId(req: Request): Promise<string | null> {
  if (req.extensionDspId) return Promise.resolve(req.extensionDspId)
  const { userId } = getAuth(req)
  if (!userId) return Promise.resolve(null)
  return prisma.employee
    .findUnique({ where: { clerkUserId: userId }, select: { dspId: true } })
    .then((emp) => emp?.dspId ?? null)
}

// ─── Multer (single CSV, 10 MB) ──────────────────────────────────────────────

export const rtsUploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
}).single('file')

// ─── CSV parsing helper ──────────────────────────────────────────────────────

interface RtsCsvRow {
  deliveryAssociate: string
  trackingId: string
  transporterId: string
  impactDcr: boolean
  rtsCode: string
  additionalInfo: string | null
  exemptionReason: string
  plannedDeliveryDate: string // YYYY-MM-DD
  serviceArea: string
}

function parseRtsCsv(buffer: Buffer): RtsCsvRow[] {
  const workbook = XLSX.read(buffer, { type: 'buffer', raw: true })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const raw = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '', raw: true })

  return raw.map((row) => {
    // Headers may have trailing spaces — trim all keys and values
    const r: Record<string, string> = {}
    for (const [k, v] of Object.entries(row)) {
      r[k.trim()] = typeof v === 'string' ? v.trim() : String(v)
    }

    return {
      deliveryAssociate: r['Delivery Associate'] ?? '',
      trackingId: r['Tracking ID'] ?? '',
      transporterId: r['Transporter ID'] ?? '',
      impactDcr: (r['Impact DCR'] ?? '').toUpperCase() === 'Y',
      rtsCode: r['DA Selected RTS Code'] ?? '',
      additionalInfo: r['Additional Information'] || null,
      exemptionReason: r['Exemption Reason'] ?? '',
      plannedDeliveryDate: r['Planned Delivery Date'] ?? '',
      serviceArea: r['Service Area'] ?? '',
    }
  })
}

// ─── POST /api/performance/import/rts — Upload & upsert RTS CSV ─────────────

const importRtsSchema = z.object({}).passthrough() // file comes via multer

export async function importRts(req: Request, res: Response) {
  const dspId = await getDspId(req)
  if (!dspId) { res.status(401).json({ message: 'Unauthorized' }); return }

  if (!req.file) { res.status(400).json({ message: 'No file uploaded' }); return }

  const rows = parseRtsCsv(req.file.buffer)
  if (rows.length === 0) {
    res.status(422).json({ message: 'CSV contains no data rows' })
    return
  }

  // Validate all rows have tracking IDs
  const invalid = rows.filter((r) => !r.trackingId || !r.transporterId)
  if (invalid.length > 0) {
    res.status(422).json({
      message: `${invalid.length} row(s) missing Tracking ID or Transporter ID`,
    })
    return
  }

  // Look up employees by transporter ID for linking
  const transporterIds = [...new Set(rows.map((r) => r.transporterId))]
  const employees = await prisma.employee.findMany({
    where: { dspId, transporterId: { in: transporterIds } },
    select: { id: true, transporterId: true },
  })
  const empMap = new Map(employees.map((e) => [e.transporterId!, e.id]))

  // Upsert each row by trackingId+dspId
  let upserted = 0
  for (const row of rows) {
    // Parse date — handle both ISO string ("2026-05-22") and Excel serial number
    let parsedDate: Date
    const asNum = Number(row.plannedDeliveryDate)
    if (!isNaN(asNum) && asNum > 30000) {
      // Excel serial date: days since 1900-01-01 (with the 1900 leap year bug)
      parsedDate = new Date(Date.UTC(1899, 11, 30 + asNum))
    } else {
      // ISO date string — append T00:00:00 to avoid timezone shift
      parsedDate = new Date(row.plannedDeliveryDate + 'T00:00:00')
    }
    if (isNaN(parsedDate.getTime())) continue // skip invalid dates

    await prisma.rtsEntry.upsert({
      where: { dspId_trackingId: { dspId, trackingId: row.trackingId } },
      update: {
        transporterId: row.transporterId,
        deliveryAssociate: row.deliveryAssociate,
        employeeId: empMap.get(row.transporterId) ?? null,
        impactDcr: row.impactDcr,
        rtsCode: row.rtsCode,
        additionalInfo: row.additionalInfo,
        exemptionReason: row.exemptionReason,
        plannedDeliveryDate: parsedDate,
        serviceArea: row.serviceArea,
      },
      create: {
        dspId,
        trackingId: row.trackingId,
        transporterId: row.transporterId,
        deliveryAssociate: row.deliveryAssociate,
        employeeId: empMap.get(row.transporterId) ?? null,
        impactDcr: row.impactDcr,
        rtsCode: row.rtsCode,
        additionalInfo: row.additionalInfo,
        exemptionReason: row.exemptionReason,
        plannedDeliveryDate: parsedDate,
        serviceArea: row.serviceArea,
      },
    })
    upserted++
  }

  res.json({
    imported: upserted,
    matched: employees.length,
    unmatched: transporterIds.length - employees.length,
  })
}

// ─── GET /api/performance/rts — List RTS entries (operator) ──────────────────

export async function listRts(req: Request, res: Response) {
  const dspId = await getDspId(req)
  if (!dspId) { res.status(401).json({ message: 'Unauthorized' }); return }

  const dateStr = req.query.date as string | undefined // YYYY-MM-DD

  const where: Record<string, unknown> = { dspId }
  if (dateStr) {
    const d = new Date(dateStr)
    const next = new Date(d)
    next.setDate(next.getDate() + 1)
    where.plannedDeliveryDate = { gte: d, lt: next }
  }

  const entries = await prisma.rtsEntry.findMany({
    where,
    orderBy: [{ plannedDeliveryDate: 'desc' }, { deliveryAssociate: 'asc' }],
    include: {
      employee: {
        select: { id: true, legalFirstName: true, legalLastName: true, primaryStationId: true },
      },
    },
  })

  res.json({ entries })
}

// ─── GET /api/performance/rts/my — Driver's own RTS entries ──────────────────

export async function getMyRts(req: Request, res: Response) {
  const { userId } = getAuth(req)
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return }

  const employee = await prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { transporterId: true, dspId: true },
  })
  if (!employee) { res.status(403).json({ message: 'Forbidden' }); return }
  if (!employee.transporterId || !employee.dspId) { res.json({ entries: [] }); return }

  const entries = await prisma.rtsEntry.findMany({
    where: {
      transporterId: { equals: employee.transporterId, mode: 'insensitive' },
      dspId: employee.dspId,
    },
    orderBy: { plannedDeliveryDate: 'desc' },
  })

  res.json({ entries })
}

// ─── GET /api/performance/rts/dates — Available dates with entry counts ──────

export async function listRtsDates(req: Request, res: Response) {
  const dspId = await getDspId(req)
  if (!dspId) { res.status(401).json({ message: 'Unauthorized' }); return }

  const results = await prisma.rtsEntry.groupBy({
    by: ['plannedDeliveryDate'],
    where: { dspId },
    _count: { id: true },
    orderBy: { plannedDeliveryDate: 'desc' },
  })

  const dates = results.map((r) => ({
    date: r.plannedDeliveryDate,
    count: r._count.id,
  }))

  res.json({ dates })
}
