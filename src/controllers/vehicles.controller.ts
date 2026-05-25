import { Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { z } from 'zod'
import { Prisma, VehicleStatus, OwnershipType, ActivityEntityType, VehicleImageCategory } from '@prisma/client'
import { prisma } from '../lib/prisma'
import multer from 'multer'
import * as XLSX from 'xlsx'
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

function getDspId(req: Request): Promise<string | null> {
  if (req.extensionDspId) return Promise.resolve(req.extensionDspId)
  const { userId } = getAuth(req)
  if (!userId) return Promise.resolve(null)
  return resolveDsp(userId)
}

async function resolveVehicleOwnership(userId: string, vehicleId: string) {
  const dspId = await resolveDsp(userId)
  if (!dspId) return null
  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } })
  if (!vehicle || vehicle.dspId !== dspId) return null
  return { vehicle, dspId }
}

async function resolvePerformerName(userId: string): Promise<string> {
  const emp = await prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { legalFirstName: true, legalLastName: true },
  })
  return emp ? `${emp.legalFirstName} ${emp.legalLastName}` : 'Unknown'
}

// ─── Shared include ───────────────────────────────────────────────────────────

const VEHICLE_INCLUDE = {
  station: { select: { id: true, code: true, name: true } },
  stationVehicleType: { select: { id: true, name: true } },
  requiredQualification: { select: { id: true, name: true } },
  lastUsedByEmployee: { select: { id: true, legalFirstName: true, legalLastName: true } },
  servicePeriods: { orderBy: { startDate: 'desc' as const } },
  scheduledMaintenances: {
    where: { isCompleted: false },
    select: { id: true, scheduledAt: true, title: true },
    orderBy: { scheduledAt: 'asc' as const },
    take: 3,
  },
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

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const createVehicleSchema = z.object({
  stationId:    z.string().min(1, 'Station is required'),
  vehicleId:    z.string().min(1, 'Vehicle ID is required'),
  status:       z.nativeEnum(VehicleStatus).default('ACTIVE'),
  stationVehicleTypeId: z.string().optional().nullable(),
  serviceTypeName:      z.string().optional().nullable(),
  ownershipType: z.nativeEnum(OwnershipType),
  make:         z.string().min(1, 'Make is required'),
  model:        z.string().min(1, 'Model is required'),
  year:         z.number().int({ message: 'Year is required' }),
  notes:        z.string().optional().nullable(),
  heightInches: z.number().optional().nullable(),
  requiredQualificationId: z.string().min(1, 'Qualification is required'),
  overnightParkingLocation: z.string().optional().nullable(),
  tollCardId:   z.string().optional().nullable(),
  vin:              z.string().regex(/^[A-Z0-9]{17}$/i, 'VIN must be exactly 17 letters or numbers'),
  licensePlate:     z.string().min(1, 'License plate is required'),
  licensePlateState: z.string().optional().nullable(),
  licensePlateExpiration: z.string().optional().nullable(),
  eldUnitCode:  z.string().optional().nullable(),
  gasolineType: z.string().optional().nullable(),
  tankCapacityGallons: z.number().optional().nullable(),
  fuelCardNumber: z.string().optional().nullable(),
  currentMileage: z.number().optional().nullable(),
  amazonBranded:  z.boolean().optional(),
  cubicFeetStorage: z.number().optional().nullable(),
  insuranceCompany: z.string().optional().nullable(),
  policyNumber:     z.string().optional().nullable(),
  policyExpiration: z.string().optional().nullable(),
  // Lease
  leaseCompany:          z.string().optional().nullable(),
  leaseAgreementNumber:  z.string().optional().nullable(),
  leasePricePerMonth:    z.number().optional().nullable(),
  leaseDeposit:          z.number().optional().nullable(),
  leaseStart:            z.string().optional().nullable(),
  leaseEnd:              z.string().optional().nullable(),
  leaseInitialOdometer:  z.number().optional().nullable(),
  leaseInitialDate:      z.string().optional().nullable(),
  leaseReturnOdometer:   z.number().optional().nullable(),
  leaseReturnDate:       z.string().optional().nullable(),
  // Rental
  rentalCompany:         z.string().optional().nullable(),
  rentalAgreementNumber: z.string().optional().nullable(),
  rentalPricePerMonth:   z.number().optional().nullable(),
  rentalDeposit:         z.number().optional().nullable(),
  rentalRecurringPeriod: z.string().optional().nullable(),
  rentalStart:           z.string().optional().nullable(),
  rentalEnd:             z.string().optional().nullable(),
  rentalInitialOdometer: z.number().optional().nullable(),
  rentalInitialDate:     z.string().optional().nullable(),
  rentalReturnOdometer:  z.number().optional().nullable(),
  rentalReturnDate:      z.string().optional().nullable(),
  // Owned
  purchasePrice:    z.number().optional().nullable(),
  purchaseOdometer: z.number().optional().nullable(),
  purchaseDate:     z.string().optional().nullable(),
  soldPrice:        z.number().optional().nullable(),
  soldOdometer:     z.number().optional().nullable(),
  soldDate:         z.string().optional().nullable(),
})

const updateVehicleSchema = createVehicleSchema.partial().extend({
  stationId: z.string().min(1).optional(),
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toDate(s: string | null | undefined): Date | null {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

function buildVehicleData(data: z.infer<typeof createVehicleSchema>, dspId: string, resolvedStationVehicleTypeId?: string | null) {
  return {
    dspId,
    stationId: data.stationId,
    vehicleId: data.vehicleId ?? null,
    status: data.status,
    stationVehicleTypeId: resolvedStationVehicleTypeId ?? data.stationVehicleTypeId ?? null,
    ownershipType: data.ownershipType,
    make: data.make,
    model: data.model,
    year: data.year,
    notes: data.notes ?? null,
    heightInches: data.heightInches ?? null,
    requiredQualificationId: data.requiredQualificationId || null,
    overnightParkingLocation: data.overnightParkingLocation ?? null,
    tollCardId: data.tollCardId ?? null,
    vin: data.vin,
    licensePlate: data.licensePlate,
    licensePlateState: data.licensePlateState ?? null,
    licensePlateExpiration: toDate(data.licensePlateExpiration),
    eldUnitCode: data.eldUnitCode ?? null,
    gasolineType: data.gasolineType ?? null,
    tankCapacityGallons: data.tankCapacityGallons ?? null,
    fuelCardNumber: data.fuelCardNumber ?? null,
    currentMileage: data.currentMileage ?? null,
    amazonBranded: data.amazonBranded ?? false,
    cubicFeetStorage: data.cubicFeetStorage ?? null,
    insuranceCompany: data.insuranceCompany ?? null,
    policyNumber: data.policyNumber ?? null,
    policyExpiration: toDate(data.policyExpiration),
    leaseCompany: data.leaseCompany ?? null,
    leaseAgreementNumber: data.leaseAgreementNumber ?? null,
    leasePricePerMonth: data.leasePricePerMonth ?? null,
    leaseDeposit: data.leaseDeposit ?? null,
    leaseStart: toDate(data.leaseStart),
    leaseEnd: toDate(data.leaseEnd),
    leaseInitialOdometer: data.leaseInitialOdometer ?? null,
    leaseInitialDate: toDate(data.leaseInitialDate),
    leaseReturnOdometer: data.leaseReturnOdometer ?? null,
    leaseReturnDate: toDate(data.leaseReturnDate),
    rentalCompany: data.rentalCompany ?? null,
    rentalAgreementNumber: data.rentalAgreementNumber ?? null,
    rentalPricePerMonth: data.rentalPricePerMonth ?? null,
    rentalDeposit: data.rentalDeposit ?? null,
    rentalRecurringPeriod: data.rentalRecurringPeriod ?? null,
    rentalStart: toDate(data.rentalStart),
    rentalEnd: toDate(data.rentalEnd),
    rentalInitialOdometer: data.rentalInitialOdometer ?? null,
    rentalInitialDate: toDate(data.rentalInitialDate),
    rentalReturnOdometer: data.rentalReturnOdometer ?? null,
    rentalReturnDate: toDate(data.rentalReturnDate),
    purchasePrice: data.purchasePrice ?? null,
    purchaseOdometer: data.purchaseOdometer ?? null,
    purchaseDate: toDate(data.purchaseDate),
    soldPrice: data.soldPrice ?? null,
    soldOdometer: data.soldOdometer ?? null,
    soldDate: toDate(data.soldDate),
  }
}

// ─── List vehicles ────────────────────────────────────────────────────────────

export async function listVehicles(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ message: 'DSP not found' }); return }

  const { stationId, status, serviceType, search, page = '1', limit = '100' } = req.query as Record<string, string>
  const where: Record<string, unknown> = { dspId }
  if (stationId) where.stationId = stationId
  if (status) where.status = status
  if (serviceType) where.stationVehicleTypeId = serviceType
  if (search) {
    where.OR = [
      { vehicleId: { contains: search, mode: 'insensitive' } },
      { make: { contains: search, mode: 'insensitive' } },
      { model: { contains: search, mode: 'insensitive' } },
      { vin: { contains: search, mode: 'insensitive' } },
      { licensePlate: { contains: search, mode: 'insensitive' } },
    ]
  }

  const skip = (parseInt(page) - 1) * parseInt(limit)
  const [vehicles, total] = await Promise.all([
    prisma.vehicle.findMany({ where, include: VEHICLE_INCLUDE, skip, take: parseInt(limit), orderBy: { createdAt: 'desc' } }),
    prisma.vehicle.count({ where }),
  ])

  res.json({ vehicles, total, page: parseInt(page), limit: parseInt(limit) })
}

// ─── Create vehicle ───────────────────────────────────────────────────────────

export async function createVehicle(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ message: 'DSP not found' }); return }

  const parsed = createVehicleSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }
  const data = parsed.data

  // Verify station belongs to DSP
  const station = await prisma.station.findFirst({ where: { id: data.stationId, dspId } })
  if (!station) { res.status(400).json({ message: 'Station not found' }); return }

  // Enforce vehicleId uniqueness within DSP
  if (data.vehicleId) {
    const existing = await prisma.vehicle.findFirst({ where: { dspId, vehicleId: data.vehicleId } })
    if (existing) { res.status(400).json({ message: `Vehicle ID "${data.vehicleId}" already exists in this DSP` }); return }
  }

  // Resolve stationVehicleTypeId — prefer explicit ID; fall back to upsert by name
  let resolvedStationVehicleTypeId = data.stationVehicleTypeId ?? null
  if (!resolvedStationVehicleTypeId && data.serviceTypeName) {
    const svt = await prisma.stationVehicleType.upsert({
      where: { stationId_name: { stationId: data.stationId, name: data.serviceTypeName } },
      update: {},
      create: { stationId: data.stationId, name: data.serviceTypeName },
    })
    resolvedStationVehicleTypeId = svt.id
  }

  try {
    const vehicle = await prisma.vehicle.create({ data: buildVehicleData(data, dspId, resolvedStationVehicleTypeId), include: VEHICLE_INCLUDE })

    const performerName = await resolvePerformerName(userId!)
    await writeLog({
      dspId, entityType: 'VEHICLE', entityId: vehicle.id,
      action: 'Vehicle created',
      performedByClerkId: userId!, performedByName: performerName,
    })

    res.status(201).json(vehicle)
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const target = (err.meta?.target as string[])?.join(', ') ?? 'value'
      res.status(409).json({ message: `A vehicle with that ${target} already exists` })
      return
    }
    throw err
  }
}

// ─── Get vehicle ──────────────────────────────────────────────────────────────

export async function getVehicle(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const result = await resolveVehicleOwnership(userId!, id)
  if (!result) { res.status(404).json({ message: 'Vehicle not found' }); return }
  const vehicle = await prisma.vehicle.findUnique({ where: { id }, include: VEHICLE_INCLUDE })
  res.json(vehicle)
}

// ─── Update vehicle ───────────────────────────────────────────────────────────

export async function updateVehicle(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const result = await resolveVehicleOwnership(userId!, id)
  if (!result) { res.status(404).json({ message: 'Vehicle not found' }); return }

  const parsed = updateVehicleSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }
  const data = parsed.data

  // Check vehicleId uniqueness if being changed
  if (data.vehicleId && data.vehicleId !== result.vehicle.vehicleId) {
    const existing = await prisma.vehicle.findFirst({ where: { dspId: result.dspId, vehicleId: data.vehicleId } })
    if (existing) { res.status(400).json({ message: `Vehicle ID "${data.vehicleId}" already exists in this DSP` }); return }
  }

  const old = result.vehicle
  const updateData: Record<string, unknown> = {}
  const logParts: string[] = []

  const scalarFields: Array<[keyof typeof data, string]> = [
    ['vehicleId', 'Vehicle ID'], ['status', 'Status'], ['make', 'Make'], ['model', 'Model'],
    ['stationVehicleTypeId', 'Service Type'], ['year', 'Year'], ['notes', 'Notes'],
    ['heightInches', 'Height'], ['overnightParkingLocation', 'Overnight parking'],
    ['tollCardId', 'Toll card ID'], ['vin', 'VIN'],
    ['licensePlate', 'License plate'], ['licensePlateState', 'Plate state'],
    ['eldUnitCode', 'ELD unit code'], ['gasolineType', 'Gasoline type'],
    ['tankCapacityGallons', 'Tank capacity'], ['fuelCardNumber', 'Fuel card #'],
    ['currentMileage', 'Mileage'], ['amazonBranded', 'Amazon branded'],
    ['cubicFeetStorage', 'Cubic feet'], ['insuranceCompany', 'Insurance company'],
    ['policyNumber', 'Policy number'], ['ownershipType', 'Ownership type'],
    ['leaseCompany', 'Lease company'], ['leaseAgreementNumber', 'Lease agreement #'],
    ['leasePricePerMonth', 'Lease price/mo'], ['leaseDeposit', 'Lease deposit'],
    ['leaseInitialOdometer', 'Lease initial odometer'], ['leaseReturnOdometer', 'Lease return odometer'],
    ['rentalCompany', 'Rental company'], ['rentalAgreementNumber', 'Rental agreement #'],
    ['rentalPricePerMonth', 'Rental price/mo'], ['rentalDeposit', 'Rental deposit'],
    ['rentalRecurringPeriod', 'Rental period'],
    ['rentalInitialOdometer', 'Rental initial odometer'], ['rentalReturnOdometer', 'Rental return odometer'],
    ['purchasePrice', 'Purchase price'], ['purchaseOdometer', 'Purchase odometer'],
    ['soldPrice', 'Sold price'], ['soldOdometer', 'Sold odometer'],
    ['stationId', 'Station'], ['requiredQualificationId', 'Required qualification'],
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

  // Date fields
  const dateFields: Array<[keyof typeof data, string]> = [
    ['licensePlateExpiration', 'Plate expiry'], ['policyExpiration', 'Policy expiry'],
    ['leaseStart', 'Lease start'], ['leaseEnd', 'Lease end'],
    ['leaseInitialDate', 'Lease initial date'], ['leaseReturnDate', 'Lease return date'],
    ['rentalStart', 'Rental start'], ['rentalEnd', 'Rental end'],
    ['rentalInitialDate', 'Rental initial date'], ['rentalReturnDate', 'Rental return date'],
    ['purchaseDate', 'Purchase date'], ['soldDate', 'Sold date'],
  ]

  for (const [field, label] of dateFields) {
    if (field in data) {
      const newVal = data[field] as string | null | undefined
      const oldDateVal = (old as Record<string, unknown>)[field]
      const newDate = toDate(newVal)
      updateData[field] = newDate
      const oldStr = oldDateVal ? new Date(oldDateVal as string).toISOString().split('T')[0] : '—'
      const newStr = newDate ? newDate.toISOString().split('T')[0] : '—'
      if (oldStr !== newStr) logParts.push(`${label}: ${oldStr} → ${newStr}`)
    }
  }

  // If serviceTypeName is provided (and no stationVehicleTypeId), upsert StationVehicleType
  if (data.serviceTypeName && !data.stationVehicleTypeId) {
    const targetStationId = (updateData.stationId as string | undefined) ?? result.vehicle.stationId
    const svt = await prisma.stationVehicleType.upsert({
      where: { stationId_name: { stationId: targetStationId, name: data.serviceTypeName } },
      update: {},
      create: { stationId: targetStationId, name: data.serviceTypeName },
    })
    updateData.stationVehicleTypeId = svt.id
    if (String(result.vehicle.stationVehicleTypeId ?? '') !== svt.id) {
      logParts.push(`Service Type: — → ${data.serviceTypeName}`)
    }
  }

  const vehicle = await prisma.vehicle.update({ where: { id }, data: updateData, include: VEHICLE_INCLUDE })

  if (logParts.length > 0) {
    const performerName = await resolvePerformerName(userId!)
    await writeLog({
      dspId: result.dspId, entityType: 'VEHICLE', entityId: id,
      action: logParts.join('; '),
      performedByClerkId: userId!, performedByName: performerName,
    })
  }

  res.json(vehicle)
}

// ─── Delete vehicle ───────────────────────────────────────────────────────────

export async function deleteVehicle(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const result = await resolveVehicleOwnership(userId!, id)
  if (!result) { res.status(404).json({ message: 'Vehicle not found' }); return }

  const performerName = await resolvePerformerName(userId!)
  await writeLog({
    dspId: result.dspId, entityType: 'VEHICLE', entityId: id,
    action: `Vehicle deleted: ${result.vehicle.vehicleId ?? result.vehicle.make + ' ' + result.vehicle.model}`,
    performedByClerkId: userId!, performedByName: performerName,
  })

  await prisma.vehicle.delete({ where: { id } })
  res.status(204).send()
}

// ─── Get vehicle logs ─────────────────────────────────────────────────────────

export async function listVehicleLogs(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const result = await resolveVehicleOwnership(userId!, id)
  if (!result) { res.status(404).json({ message: 'Vehicle not found' }); return }

  const logs = await prisma.activityLog.findMany({
    where: { entityType: 'VEHICLE', entityId: id },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  res.json(logs)
}

// ─── Vehicle images ───────────────────────────────────────────────────────────

export async function listVehicleImages(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const result = await resolveVehicleOwnership(userId!, id)
  if (!result) { res.status(404).json({ message: 'Vehicle not found' }); return }

  const images = await prisma.vehicleImage.findMany({
    where: { vehicleId: id },
    orderBy: { takenAt: 'desc' },
    include: { uploadedBy: { select: { id: true, legalFirstName: true, legalLastName: true } } },
  })
  res.json(images)
}

export async function listVehicleInspections(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const result = await resolveVehicleOwnership(userId!, id)
  if (!result) { res.status(404).json({ message: 'Vehicle not found' }); return }

  const inspections = await prisma.vehicleInspection.findMany({
    where: { vehicleId: id },
    orderBy: { completedAt: 'desc' },
    include: {
      employee: { select: { id: true, legalFirstName: true, legalLastName: true } },
      images: { orderBy: { createdAt: 'asc' } },
    },
  })
  res.json(inspections)
}

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(process.cwd(), 'uploads', 'vehicles')
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })

export const imageUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`),
  }),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true)
    else cb(new Error('Only image files are allowed'))
  },
}).single('file')

export async function uploadVehicleImage(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const result = await resolveVehicleOwnership(userId!, id)
  if (!result) { res.status(404).json({ message: 'Vehicle not found' }); return }
  if (!req.file) { res.status(400).json({ message: 'No file uploaded' }); return }

  const category = (req.body.category as VehicleImageCategory) ?? 'OTHER'
  const url = `/uploads/vehicles/${req.file.filename}`

  const dspId = result.dspId
  const emp = await prisma.employee.findUnique({ where: { clerkUserId: userId! }, select: { id: true } })

  const image = await prisma.vehicleImage.create({
    data: {
      vehicleId: id, dspId, category, url,
      uploadedByEmployeeId: emp?.id ?? null,
      takenAt: new Date(),
      notes: (req.body.notes as string) || null,
    },
    include: { uploadedBy: { select: { id: true, legalFirstName: true, legalLastName: true } } },
  })

  const performerName = await resolvePerformerName(userId!)
  await writeLog({
    dspId, entityType: 'VEHICLE', entityId: id,
    action: `Image uploaded (${category.replace(/_/g, ' ').toLowerCase()})`,
    performedByClerkId: userId!, performedByName: performerName,
  })

  res.status(201).json(image)
}

export async function deleteVehicleImage(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const imageId = req.params.imageId as string
  const result = await resolveVehicleOwnership(userId!, id)
  if (!result) { res.status(404).json({ message: 'Vehicle not found' }); return }

  const image = await prisma.vehicleImage.findUnique({ where: { id: imageId } })
  if (!image || image.vehicleId !== id) { res.status(404).json({ message: 'Image not found' }); return }

  // Delete file from disk
  const filePath = path.join(process.cwd(), image.url)
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)

  await prisma.vehicleImage.delete({ where: { id: imageId } })
  res.status(204).send()
}

// ─── Bulk import ──────────────────────────────────────────────────────────────

export const uploadMiddleware = multer({ storage: multer.memoryStorage() }).single('file')

const OWNERSHIP_MAP: Record<string, OwnershipType> = {
  amazon_rental: 'AMAZON_RENTAL',
  amazon_owned:  'AMAZON_OWNED',
  lease:         'LEASE',
  rental:        'RENTAL',
}

const STATUS_MAP: Record<string, VehicleStatus> = {
  active: 'ACTIVE',
  'in repair': 'IN_REPAIR',
  inactive: 'INACTIVE',
  retired: 'RETIRED',
  sold: 'RETIRED',
}

function col(row: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) { if (row[k] !== undefined && row[k] !== null && row[k] !== '') return String(row[k]).trim() }
  return ''
}

function colFloat(row: Record<string, string>, ...keys: string[]): number | null {
  const v = col(row, ...keys)
  const n = parseFloat(v)
  return isNaN(n) ? null : n
}

function colDate(row: Record<string, string>, ...keys: string[]): Date | null {
  const v = col(row, ...keys)
  if (!v) return null
  // Excel serial number
  const serial = parseInt(v)
  if (!isNaN(serial) && serial > 1000) {
    const d = XLSX.SSF.parse_date_code(serial)
    if (d) return new Date(d.y, d.m - 1, d.d)
  }
  const d = new Date(v)
  return isNaN(d.getTime()) ? null : d
}

export async function bulkImportVehicles(req: Request, res: Response) {
  const dspId = await getDspId(req)
  if (!dspId) { res.status(404).json({ message: 'DSP not found' }); return }
  if (!req.file) { res.status(400).json({ message: 'No file uploaded' }); return }

  const { userId } = getAuth(req)
  const performerName = userId ? await resolvePerformerName(userId) : 'Extension Sync'

  const workbook = XLSX.read(req.file.buffer, { type: 'buffer' })
  // prefer the Vehicle_Template sheet
  const sheetName = workbook.SheetNames.find((n) => n.toLowerCase().includes('vehicle_template')) ?? workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '', raw: false })

  const stations = await prisma.station.findMany({ where: { dspId }, select: { id: true, code: true } })
  const stationByCode = new Map(stations.map((s) => [s.code.toLowerCase(), s.id]))

  const qualifications = await prisma.qualification.findMany({ where: { dspId }, select: { id: true, name: true } })
  const qualByName = new Map(qualifications.map((q) => [q.name.toLowerCase(), q.id]))

  let created = 0
  let updated = 0
  const errors: string[] = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const rowNum = i + 2

    // Support both the Amazon export columns and the legacy template columns
    const stationCode = col(row, 'stationCode', 'Station*', 'Station').toLowerCase()
    const vehicleIdRaw = col(row, 'vehicleName', 'Vehicle ID*', 'Vehicle ID')
    const makeRaw = col(row, 'make', 'Make*', 'Make')
    const modelRaw = col(row, 'model', 'Model*', 'Model')
    // Preserve original case for StationVehicleType display name; fall back to serviceTier
    const serviceTypeName = col(row, 'serviceType', 'Service Type*', 'Service Type') || col(row, 'serviceTier')
    const ownershipRaw = col(row, 'ownershipType', 'Ownership Type').toLowerCase()

    if (!stationCode || !vehicleIdRaw || !makeRaw || !modelRaw) {
      errors.push(`Row ${rowNum}: Missing required fields (stationCode, vehicleName, make, or model)`)
      continue
    }

    const stationId = stationByCode.get(stationCode)
    if (!stationId) { errors.push(`Row ${rowNum}: Unknown station code "${stationCode}"`); continue }

    const ownershipType = OWNERSHIP_MAP[ownershipRaw] ?? 'AMAZON_RENTAL'
    const status = STATUS_MAP[col(row, 'status', 'Status*', 'Status').toLowerCase()] ?? 'ACTIVE'

    const qualName = col(row, 'Required Qualification*', 'Required Qualification').toLowerCase()
    const requiredQualificationId = qualName ? (qualByName.get(qualName) ?? null) : null

    // amazonBranded: true when the 'type' column contains the word "Amazon"
    const typeField = col(row, 'type')
    const amazonBranded = typeField.toLowerCase().includes('amazon')

    try {
      // Auto-upsert StationVehicleType and capture its ID
      let stationVehicleTypeId: string | null = null
      if (serviceTypeName) {
        const svt = await prisma.stationVehicleType.upsert({
          where: { stationId_name: { stationId, name: serviceTypeName } },
          update: {},
          create: { stationId, name: serviceTypeName },
        })
        stationVehicleTypeId = svt.id
      }

      const vinValue = col(row, 'vin', 'VIN*', 'VIN') || null
      const vehicleData = {
          stationId, status, stationVehicleTypeId, ownershipType,
          make: makeRaw, model: modelRaw,
          year: col(row, 'year', 'Year*', 'Year') ? parseInt(col(row, 'year', 'Year*', 'Year')) : null,
          notes: col(row, 'Notes') || null,
          heightInches: colFloat(row, 'Height (inches)'),
          requiredQualificationId,
          overnightParkingLocation: col(row, 'Current Overnight Parking Location') || null,
          licensePlateState: col(row, 'registeredState', 'License Plate State') || null,
          licensePlate: col(row, 'licensePlateNumber', 'License Plate*', 'License Plate') || null,
          licensePlateExpiration: colDate(row, 'registrationExpiryDate', 'License Plate Exp_(Y-M-D)'),
          tollCardId: col(row, 'Toll Card ID') || null,
          tankCapacityGallons: colFloat(row, 'Tank Capacity (gallons)'),
          gasolineType: col(row, 'Gasoline Type') || null,
          fuelCardNumber: col(row, 'Fuel Card #') || null,
          insuranceCompany: col(row, 'Insurance Company') || null,
          policyNumber: col(row, 'Policy Number') || null,
          policyExpiration: colDate(row, 'Policy Expiration_(Y-M-D)'),
          eldUnitCode: col(row, 'ELD Unit Code') || null,
          amazonBranded,
          cubicFeetStorage: colFloat(row, 'cubicCapacity', 'Cubic feet of storage'),
          currentMileage: colFloat(row, 'Current Mileage of Vehicle'),
          leaseCompany: col(row, 'Leasing Company') || null,
          leaseAgreementNumber: col(row, 'Agreement #') || null,
          leasePricePerMonth: colFloat(row, 'Price/mo'),
          leaseDeposit: colFloat(row, 'Deposit'),
          leaseStart: colDate(row, 'ownershipStartDate', 'Start Date_(Y-M-D)'),
          leaseEnd: colDate(row, 'ownershipEndDate', 'End Date_(Y-M-D)'),
          rentalCompany: col(row, 'vehicleProvider', 'Rental Company') || null,
          rentalAgreementNumber: col(row, 'Rental Agreement #') || null,
          rentalRecurringPeriod: col(row, 'Recurring Period') || null,
          rentalStart: colDate(row, 'ownershipStartDate', 'Contract Start Date_(Y-M-D)'),
          rentalEnd: colDate(row, 'ownershipEndDate', 'Contract End Date_(Y-M-D)'),
      }

      // Find existing vehicle by vehicleId or VIN
      let existing = await prisma.vehicle.findUnique({
        where: { dspId_vehicleId: { dspId, vehicleId: vehicleIdRaw } },
      })
      if (!existing && vinValue) {
        existing = await prisma.vehicle.findUnique({ where: { vin: vinValue } })
      }

      let vehicle
      let isNew: boolean
      if (existing) {
        vehicle = await prisma.vehicle.update({
          where: { id: existing.id },
          data: { vehicleId: vehicleIdRaw, ...vehicleData },
        })
        isNew = false
      } else {
        vehicle = await prisma.vehicle.create({
          data: { dspId, vehicleId: vehicleIdRaw, vin: vinValue, ...vehicleData },
        })
        isNew = true
      }
      await writeLog({
        dspId, entityType: 'VEHICLE', entityId: vehicle.id,
        action: isNew ? 'Vehicle imported via bulk import' : 'Vehicle updated via bulk import',
        performedByClerkId: userId ?? 'extension', performedByName: performerName,
      })

      if (isNew) created++; else updated++
    } catch (err) {
      errors.push(`Row ${rowNum}: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  res.json({ created, updated, errors })
}

// ─── Vehicle service periods ──────────────────────────────────────────────────

const servicePeriodSchema = z.object({
  startDate: z.string().min(1, 'Start date is required'),
  endDate:   z.string().optional().nullable(),
  notes:     z.string().optional().nullable(),
})

export async function createServicePeriod(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const vehicleId = req.params.id as string
  const result = await resolveVehicleOwnership(userId!, vehicleId)
  if (!result) { res.status(404).json({ message: 'Vehicle not found' }); return }

  const parsed = servicePeriodSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }
  const { startDate, endDate, notes } = parsed.data

  const period = await prisma.vehicleServicePeriod.create({
    data: {
      vehicleId,
      dspId: result.dspId,
      startDate: new Date(startDate),
      endDate: endDate ? new Date(endDate) : null,
      notes: notes ?? null,
    },
  })

  const performerName = await resolvePerformerName(userId!)
  await writeLog({
    dspId: result.dspId, entityType: 'VEHICLE', entityId: vehicleId,
    action: `Service period added: ${startDate}${endDate ? ` → ${endDate}` : ' (ongoing)'}`,
    performedByClerkId: userId!, performedByName: performerName,
  })

  res.status(201).json(period)
}

export async function deleteServicePeriod(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const vehicleId = req.params.id as string
  const periodId  = req.params.periodId as string
  const result = await resolveVehicleOwnership(userId!, vehicleId)
  if (!result) { res.status(404).json({ message: 'Vehicle not found' }); return }

  const period = await prisma.vehicleServicePeriod.findUnique({ where: { id: periodId } })
  if (!period || period.vehicleId !== vehicleId) { res.status(404).json({ message: 'Service period not found' }); return }

  await prisma.vehicleServicePeriod.delete({ where: { id: periodId } })

  const performerName = await resolvePerformerName(userId!)
  await writeLog({
    dspId: result.dspId, entityType: 'VEHICLE', entityId: vehicleId,
    action: `Service period removed: ${period.startDate.toISOString().split('T')[0]}${period.endDate ? ` → ${period.endDate.toISOString().split('T')[0]}` : ' (ongoing)'}`,
    performedByClerkId: userId!, performedByName: performerName,
  })

  res.status(204).send()
}
