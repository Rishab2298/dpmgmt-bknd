import { Request, Response } from 'express'
import { getAuth, clerkClient } from '@clerk/express'
import { z } from 'zod'
import { PermissionLevel, EmployeeStatus } from '@prisma/client'
import { prisma } from '../lib/prisma'
import multer from 'multer'
import * as XLSX from 'xlsx'

// ─── Auth helper ─────────────────────────────────────────────────────────────

async function resolveDsp(userId: string): Promise<string | null> {
  const emp = await prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { dspId: true },
  })
  return emp?.dspId ?? null
}

async function resolveEmployeeOwnership(userId: string, employeeId: string) {
  const requester = await prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { dspId: true },
  })
  if (!requester?.dspId) return null
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } })
  if (!employee || employee.dspId !== requester.dspId) return null
  return employee
}

// ─── Shared includes ──────────────────────────────────────────────────────────

const EMPLOYEE_INCLUDE = {
  primaryStation: { select: { id: true, code: true, name: true } },
  supervisor: { select: { id: true, legalFirstName: true, legalLastName: true } },
  emergencyContacts: { orderBy: { sortOrder: 'asc' as const } },
  employeeQualifications: {
    include: { qualification: { select: { id: true, name: true } } },
  },
}

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const emergencyContactSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional().nullable(),
  relationship: z.string().optional().nullable(),
  sortOrder: z.number().int().optional(),
})

const qualificationEntrySchema = z.object({
  qualificationId: z.string(),
  rate: z.number().nonnegative().nullable().optional(),
})

const createEmployeeSchema = z.object({
  legalFirstName: z.string().min(1, 'First name is required'),
  legalMiddleName: z.string().optional().nullable(),
  legalLastName: z.string().min(1, 'Last name is required'),
  nickname: z.string().optional().nullable(),
  title: z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
  birthDate: z.string().optional().nullable(),
  personalMobile: z.string().optional().nullable(),
  personalEmail: z.string().email('Invalid primary email'),
  workEmail: z.string().email('Invalid work email').optional().nullable().or(z.literal('')),
  workPhone: z.string().optional().nullable(),
  workMobile: z.string().optional().nullable(),
  homePhone: z.string().optional().nullable(),
  primaryStationId: z.string().min(1, 'Station is required'),
  permissionLevel: z.nativeEnum(PermissionLevel),
  positions: z.array(z.string()).optional(),
  status: z.nativeEnum(EmployeeStatus).default('ONBOARDING'),
  hireDate: z.string().optional().nullable(),
  supervisorId: z.string().optional().nullable(),
  employeeCode: z.string().optional().nullable(),
  transporterId: z.string().optional().nullable(),
  payrollId: z.string().optional().nullable(),
  gasPin: z.string().optional().nullable(),
  street: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  addressState: z.string().optional().nullable(),
  zipcode: z.string().optional().nullable(),
  maritalStatus: z.string().optional().nullable(),
  veteranStatus: z.boolean().optional(),
  ssnLast4: z.string().max(4).optional().nullable(),
  pantSize: z.string().optional().nullable(),
  shoeSize: z.string().optional().nullable(),
  tShirtSize: z.string().optional().nullable(),
  dlNumber: z.string().optional().nullable(),
  dlState: z.string().optional().nullable(),
  expirationDate: z.string().optional().nullable(),
  terminationDate: z.string().optional().nullable(),
  rehireDate: z.string().optional().nullable(),
  emergencyContacts: z.array(emergencyContactSchema).max(3).optional(),
  qualifications: z.array(qualificationEntrySchema).optional(),
  chatEnabled: z.boolean().optional(),
})

const updateEmployeeSchema = createEmployeeSchema.partial().omit({ primaryStationId: true }).extend({
  primaryStationId: z.string().min(1, 'Station is required').optional(),
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDate(val: string | null | undefined): Date | null {
  if (!val) return null
  const d = new Date(val)
  return isNaN(d.getTime()) ? null : d
}

function normalizeEmpty(val: string | null | undefined): string | null | undefined {
  if (val === '') return null
  return val
}

// ─── List employees ───────────────────────────────────────────────────────────

export async function listEmployees(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ message: 'No DSP found for this user' }); return }

  const { stationId, status, permissionLevel, search, page, limit } = req.query as Record<string, string>

  const pageNum = Math.max(1, parseInt(page ?? '1'))
  const limitNum = Math.min(100, Math.max(1, parseInt(limit ?? '50')))
  const skip = (pageNum - 1) * limitNum

  const where: Record<string, unknown> = { dspId }
  if (stationId) where.primaryStationId = stationId
  if (status) where.status = status
  if (permissionLevel) where.permissionLevel = permissionLevel
  if (search) {
    where.OR = [
      { legalFirstName: { contains: search, mode: 'insensitive' } },
      { legalLastName: { contains: search, mode: 'insensitive' } },
      { workEmail: { contains: search, mode: 'insensitive' } },
      { personalEmail: { contains: search, mode: 'insensitive' } },
      { personalMobile: { contains: search, mode: 'insensitive' } },
      { transporterId: { contains: search, mode: 'insensitive' } },
    ]
  }

  const today = new Date().toISOString().slice(0, 10)
  const [employees, total] = await Promise.all([
    prisma.employee.findMany({
      where,
      include: {
        ...EMPLOYEE_INCLUDE,
        shifts: {
          where: { date: today, status: { not: 'CANCELLED' } },
          include: { shiftType: { select: { name: true, color: true } } },
          take: 1,
        },
      },
      orderBy: [{ legalFirstName: 'asc' }, { legalLastName: 'asc' }],
      skip,
      take: limitNum,
    }),
    prisma.employee.count({ where }),
  ])

  res.json({ employees, total, page: pageNum, limit: limitNum })
}

// ─── Create employee ──────────────────────────────────────────────────────────

export async function createEmployee(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ message: 'No DSP found for this user' }); return }

  const parsed = createEmployeeSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.errors[0]?.message ?? 'Validation error', errors: parsed.error.errors })
    return
  }
  const data = parsed.data

  // Verify station belongs to DSP
  const station = await prisma.station.findUnique({ where: { id: data.primaryStationId } })
  if (!station || station.dspId !== dspId) {
    res.status(400).json({ message: 'Invalid station' }); return
  }

  // Verify supervisor belongs to DSP
  if (data.supervisorId) {
    const sup = await prisma.employee.findUnique({ where: { id: data.supervisorId }, select: { dspId: true } })
    if (!sup || sup.dspId !== dspId) {
      res.status(400).json({ message: 'Invalid supervisor' }); return
    }
  }

  // workEmail uniqueness
  const workEmail = normalizeEmpty(data.workEmail)
  if (workEmail) {
    const existing = await prisma.employee.findUnique({ where: { workEmail } })
    if (existing) { res.status(400).json({ message: 'Work email is already in use' }); return }
  }

  const employee = await prisma.employee.create({
    data: {
      dspId,
      primaryStationId: data.primaryStationId,
      legalFirstName: data.legalFirstName,
      legalMiddleName: data.legalMiddleName ?? null,
      legalLastName: data.legalLastName,
      nickname: data.nickname ?? null,
      title: data.title ?? null,
      gender: data.gender ?? null,
      birthDate: parseDate(data.birthDate),
      personalMobile: data.personalMobile ?? null,
      personalEmail: normalizeEmpty(data.personalEmail) ?? null,
      workEmail: workEmail ?? null,
      workPhone: data.workPhone ?? null,
      workMobile: data.workMobile ?? null,
      homePhone: data.homePhone ?? null,
      permissionLevel: data.permissionLevel,
      positions: data.positions ?? [],
      status: data.status,
      hireDate: parseDate(data.hireDate),
      supervisorId: data.supervisorId ?? null,
      employeeCode: data.employeeCode ?? null,
      transporterId: data.transporterId ?? null,
      payrollId: data.payrollId ?? null,
      gasPin: data.gasPin ?? null,
      street: data.street ?? null,
      city: data.city ?? null,
      addressState: data.addressState ?? null,
      zipcode: data.zipcode ?? null,
      maritalStatus: data.maritalStatus ?? null,
      veteranStatus: data.veteranStatus ?? false,
      chatEnabled: data.chatEnabled ?? true,
      ssnLast4: data.ssnLast4 ?? null,
      pantSize: data.pantSize ?? null,
      shoeSize: data.shoeSize ?? null,
      tShirtSize: data.tShirtSize ?? null,
      dlNumber: data.dlNumber ?? null,
      dlState: data.dlState ?? null,
      expirationDate: parseDate(data.expirationDate),
      terminationDate: parseDate(data.terminationDate),
      rehireDate: parseDate(data.rehireDate),
      emergencyContacts: data.emergencyContacts?.length
        ? { createMany: { data: data.emergencyContacts.map((ec, i) => ({ ...ec, sortOrder: ec.sortOrder ?? i })) } }
        : undefined,
      employeeQualifications: data.qualifications?.length
        ? { createMany: { data: data.qualifications.map((q) => ({ qualificationId: q.qualificationId, rate: q.rate ?? null })) } }
        : undefined,
    },
    include: EMPLOYEE_INCLUDE,
  })

  const performerName = await resolvePerformerName(userId!)
  await writeLog({
    dspId: dspId!, entityId: employee.id, action: 'Employee created',
    performedByClerkId: userId!, performedByName: performerName,
  }).catch(() => {}) // non-critical

  res.status(201).json(employee)
}

// ─── Get employee ─────────────────────────────────────────────────────────────

export async function getEmployee(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const employee = await resolveEmployeeOwnership(userId!, id)
  if (!employee) { res.status(404).json({ message: 'Employee not found' }); return }

  const full = await prisma.employee.findUnique({
    where: { id: employee.id },
    include: EMPLOYEE_INCLUDE,
  })
  res.json(full)
}

// ─── Update employee ──────────────────────────────────────────────────────────

export async function updateEmployee(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ message: 'No DSP found for this user' }); return }

  const employee = await resolveEmployeeOwnership(userId!, id)
  if (!employee) { res.status(404).json({ message: 'Employee not found' }); return }

  const parsed = updateEmployeeSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.errors[0]?.message ?? 'Validation error', errors: parsed.error.errors })
    return
  }
  const data = parsed.data

  // Verify station if provided
  if (data.primaryStationId) {
    const station = await prisma.station.findUnique({ where: { id: data.primaryStationId } })
    if (!station || station.dspId !== dspId) {
      res.status(400).json({ message: 'Invalid station' }); return
    }
  }

  // Verify supervisor if provided
  if (data.supervisorId) {
    const sup = await prisma.employee.findUnique({ where: { id: data.supervisorId }, select: { dspId: true } })
    if (!sup || sup.dspId !== dspId) {
      res.status(400).json({ message: 'Invalid supervisor' }); return
    }
  }

  // workEmail uniqueness
  const workEmail = data.workEmail !== undefined ? normalizeEmpty(data.workEmail) : undefined
  if (workEmail) {
    const existing = await prisma.employee.findUnique({ where: { workEmail } })
    if (existing && existing.id !== employee.id) {
      res.status(400).json({ message: 'Work email is already in use' }); return
    }
  }

  // Build update payload
  const updateData: Record<string, unknown> = {}
  const stringFields = [
    'legalFirstName', 'legalMiddleName', 'legalLastName', 'nickname', 'title', 'gender',
    'personalMobile', 'personalEmail', 'workPhone', 'workMobile', 'homePhone',
    'supervisorId', 'employeeCode', 'transporterId', 'payrollId', 'gasPin',
    'street', 'city', 'addressState', 'zipcode', 'maritalStatus',
    'ssnLast4', 'pantSize', 'shoeSize', 'tShirtSize', 'dlNumber', 'dlState',
  ] as const

  for (const f of stringFields) {
    if (f in data) updateData[f] = data[f] ?? null
  }
  if ('primaryStationId' in data) updateData.primaryStationId = data.primaryStationId
  if ('permissionLevel' in data) updateData.permissionLevel = data.permissionLevel
  if ('positions' in data) updateData.positions = data.positions ?? []
  if ('status' in data) updateData.status = data.status
  if ('veteranStatus' in data) updateData.veteranStatus = data.veteranStatus
  if ('chatEnabled' in data) updateData.chatEnabled = data.chatEnabled
  if ('workEmail' in data) updateData.workEmail = workEmail ?? null
  if ('birthDate' in data) updateData.birthDate = parseDate(data.birthDate)
  if ('hireDate' in data) updateData.hireDate = parseDate(data.hireDate)
  if ('expirationDate' in data) updateData.expirationDate = parseDate(data.expirationDate)
  if ('terminationDate' in data) updateData.terminationDate = parseDate(data.terminationDate)
  if ('rehireDate' in data) updateData.rehireDate = parseDate(data.rehireDate)

  // Emergency contacts: replace all
  if (data.emergencyContacts !== undefined) {
    await prisma.emergencyContact.deleteMany({ where: { employeeId: employee.id } })
    if (data.emergencyContacts.length) {
      await prisma.emergencyContact.createMany({
        data: data.emergencyContacts.map((ec, i) => ({
          employeeId: employee.id,
          name: ec.name,
          phone: ec.phone ?? null,
          relationship: ec.relationship ?? null,
          sortOrder: ec.sortOrder ?? i,
        })),
      })
    }
  }

  // Qualifications: full replace — remove unchecked ones, upsert checked ones
  if (data.qualifications !== undefined) {
    const qualIds = data.qualifications.map((q) => q.qualificationId)
    await prisma.employeeQualification.deleteMany({
      where: { employeeId: employee.id, qualificationId: { notIn: qualIds } },
    })
    for (const q of data.qualifications) {
      await prisma.employeeQualification.upsert({
        where: { employeeId_qualificationId: { employeeId: employee.id, qualificationId: q.qualificationId } },
        create: { employeeId: employee.id, qualificationId: q.qualificationId, rate: q.rate ?? null },
        update: { rate: q.rate ?? null },
      })
    }
  }

  const updated = await prisma.employee.update({
    where: { id: employee.id },
    data: updateData,
    include: EMPLOYEE_INCLUDE,
  })

  if (dspId) {
    const performerName = await resolvePerformerName(userId!)
    await writeLog({
      dspId, entityId: employee.id, action: 'Employee profile updated',
      performedByClerkId: userId!, performedByName: performerName,
    }).catch(() => {})
  }

  res.json(updated)
}

// ─── Delete (soft) employee ───────────────────────────────────────────────────

export async function deleteEmployee(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const employee = await resolveEmployeeOwnership(userId!, id)
  if (!employee) { res.status(404).json({ message: 'Employee not found' }); return }

  const dspId = employee.dspId
  const name = `${employee.legalFirstName} ${employee.legalLastName}`
  await prisma.employee.update({
    where: { id: employee.id },
    data: { status: 'TERMINATED', terminationDate: new Date() },
  })

  if (dspId) {
    const performerName = await resolvePerformerName(userId!)
    await writeLog({
      dspId, entityId: employee.id, action: `Employee terminated: ${name}`,
      performedByClerkId: userId!, performedByName: performerName,
    }).catch(() => {})
  }

  res.status(204).send()
}

// ─── Employee qualifications ──────────────────────────────────────────────────

export async function listEmployeeQualifications(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const employee = await resolveEmployeeOwnership(userId!, id)
  if (!employee) { res.status(404).json({ message: 'Employee not found' }); return }

  const qualifications = await prisma.employeeQualification.findMany({
    where: { employeeId: employee.id },
    include: { qualification: { select: { id: true, name: true } } },
  })
  res.json(qualifications)
}

export async function setEmployeeQualification(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const qualId = req.params.qualId as string
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ message: 'No DSP found for this user' }); return }

  const employee = await resolveEmployeeOwnership(userId!, id)
  if (!employee) { res.status(404).json({ message: 'Employee not found' }); return }

  const qual = await prisma.qualification.findUnique({ where: { id: qualId } })
  if (!qual || qual.dspId !== dspId) {
    res.status(400).json({ message: 'Invalid qualification' }); return
  }

  const schema = z.object({ rate: z.number().nonnegative().nullable().optional() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: 'Invalid rate' }); return }

  const result = await prisma.employeeQualification.upsert({
    where: { employeeId_qualificationId: { employeeId: employee.id, qualificationId: qual.id } },
    create: { employeeId: employee.id, qualificationId: qual.id, rate: parsed.data.rate ?? null },
    update: { rate: parsed.data.rate ?? null },
    include: { qualification: { select: { id: true, name: true } } },
  })
  res.json(result)
}

export async function removeEmployeeQualification(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const qualId = req.params.qualId as string
  const employee = await resolveEmployeeOwnership(userId!, id)
  if (!employee) { res.status(404).json({ message: 'Employee not found' }); return }

  await prisma.employeeQualification.deleteMany({
    where: { employeeId: employee.id, qualificationId: qualId },
  })
  res.status(204).send()
}

// ─── Bulk import ──────────────────────────────────────────────────────────────

export const uploadMiddleware = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }).single('file')

// Status mapping from Excel → EmployeeStatus enum
const STATUS_MAP: Record<string, EmployeeStatus> = {
  active: 'ACTIVE',
  onboarding: 'ONBOARDING',
  inactive: 'INACTIVE',
  offboarded: 'OFFBOARDED',
  terminated: 'TERMINATED',
}

// Permission level mapping
const PERMISSION_MAP: Record<string, PermissionLevel> = {
  owner: 'OWNER',
  'operations account manager': 'OPERATIONS_ACCOUNT_MANAGER',
  'operations manager': 'OPERATIONS_MANAGER',
  dispatcher: 'DISPATCHER',
  da: 'DELIVERY_ASSOCIATE',
  'delivery associate': 'DELIVERY_ASSOCIATE',
  associate: 'DELIVERY_ASSOCIATE',
  driver: 'DELIVERY_ASSOCIATE',
  helper: 'DELIVERY_ASSOCIATE',
  lead: 'DISPATCHER',
}

// Handles both single ("dispatcher") and comma-separated ("Helper, Driver") position values
function parsePermission(raw: string): PermissionLevel {
  if (!raw) return 'DELIVERY_ASSOCIATE'
  for (const part of raw.toLowerCase().split(',').map(s => s.trim())) {
    const mapped = PERMISSION_MAP[part]
    if (mapped) return mapped
  }
  return 'DELIVERY_ASSOCIATE'
}

export async function bulkImportEmployees(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ message: 'No DSP found for this user' }); return }

  if (!req.file) { res.status(400).json({ message: 'No file provided' }); return }

  // Parse workbook
  const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) { res.status(400).json({ message: 'Empty workbook' }); return }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], { defval: '' })

  // Pre-fetch stations and qualifications for this DSP
  const [stations, qualifications, existingEmployees] = await Promise.all([
    prisma.station.findMany({ where: { dspId }, select: { id: true, code: true } }),
    prisma.qualification.findMany({ where: { dspId }, select: { id: true, name: true } }),
    prisma.employee.findMany({ where: { dspId }, select: { id: true, legalFirstName: true, legalLastName: true, transporterId: true, workEmail: true } }),
  ])

  const stationByCode = new Map(stations.map((s) => [s.code.toLowerCase(), s.id]))
  const qualByName = new Map(qualifications.map((q) => [q.name.toLowerCase(), q.id]))
  const employeeByName = new Map(
    existingEmployees.map((e) => [`${e.legalFirstName} ${e.legalLastName}`.toLowerCase(), e.id])
  )
  const existingByTransporterId = new Map(
    existingEmployees
      .filter(e => e.transporterId)
      .map(e => [e.transporterId!.toLowerCase(), e])
  )

  // Fallback station from form body (used when file has no station column)
  const fallbackStationId = req.body?.stationId ? String(req.body.stationId).trim() || null : null
  const fallbackStation = fallbackStationId
    ? stations.find(s => s.id === fallbackStationId) ?? null
    : null

  function str(val: unknown): string { return String(val ?? '').trim() }
  function parseRowDate(val: unknown): Date | null {
    if (!val) return null
    if (val instanceof Date) return val
    const d = new Date(String(val))
    return isNaN(d.getTime()) ? null : d
  }

  const errors: Array<{ row: number; field: string; message: string }> = []
  let created = 0
  let updated = 0
  let skipped = 0

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const rowNum = i + 2 // 1-based + header

    // Name — try separate columns first, then fall back to single "Name and ID" / "Name" column
    let firstName = str(row['Firstname*'] ?? row['FirstName*'] ?? row['First Name'] ?? row['First'])
    let lastName  = str(row['Lastname*']  ?? row['LastName*']  ?? row['Last Name']  ?? row['Last'] ?? row['Surname'])
    let middleName: string | null = str(row['Middle_Name'] ?? row['MiddleName']) || null

    const nameCol = str(row['Name and ID'] ?? row['Name'])
    if ((!firstName || !lastName) && nameCol) {
      const parts = nameCol.split(/\s+/).filter(Boolean)
      if (parts.length >= 2) {
        if (!firstName)  firstName  = parts[0]
        if (!lastName)   lastName   = parts[parts.length - 1]
        if (!middleName && parts.length > 2) middleName = parts.slice(1, -1).join(' ')
      } else if (parts.length === 1 && !firstName) {
        firstName = parts[0]
      }
    }

    if (!firstName || !lastName) {
      errors.push({ row: rowNum, field: 'name', message: 'First name and last name are required' })
      skipped++
      continue
    }

    // Station — row value takes precedence, fall back to dialog selection
    const stationCode = str(
      row['Delivery_Station_Code*'] ?? row['Delivery_Station_Code_Code*'] ??
      row['Station Code'] ?? row['Station']
    )
    const stationId = (stationCode ? stationByCode.get(stationCode.toLowerCase()) : undefined)
      ?? fallbackStation?.id
    if (!stationId) {
      errors.push({ row: rowNum, field: 'station', message: stationCode
        ? `Station code "${stationCode}" not found`
        : 'No station in row and no default station was selected'
      })
      skipped++
      continue
    }

    // Status
    const statusRaw = str(row['Employment_Status*'] ?? row['Employee_Status*'] ?? row['Status']).toLowerCase()
    const status: EmployeeStatus = STATUS_MAP[statusRaw] ?? 'ONBOARDING'

    // Permission — supports comma-separated values e.g. "Helper, Driver"
    const permRaw = str(
      row['Permission_Level*'] ?? row['Permission Level'] ??
      row['Position'] ?? row['Role'] ?? row['Job Title'] ?? row['Job_Title']
    )
    const permissionLevel: PermissionLevel = parsePermission(permRaw)
    const positions = permRaw ? permRaw.split(',').map(s => s.trim()).filter(Boolean) : []

    // Supervisor
    const supervisorName = str(row['Supervisor_Primary*'] ?? row['Supervisor']).toLowerCase()
    const supervisorId = supervisorName ? (employeeByName.get(supervisorName) ?? null) : null

    // Resolve existing employee by TransporterID (for upsert on re-import)
    const rowTransporterId = str(
      row['Transporter_ID'] ?? row['Transporter ID'] ?? row['TransporterId'] ?? row['TransporterID']
        ?? row['Routing ID'] ?? row['Routing_ID']
    ) || null
    const existingEmp = rowTransporterId
      ? (existingByTransporterId.get(rowTransporterId.toLowerCase()) ?? null)
      : null

    // Qualifications — individual Skill1..5 columns
    const empQuals: Array<{ qualificationId: string; rate: number | null }> = []
    for (let q = 1; q <= 5; q++) {
      const skillVal = str(row[`Skill${q > 1 ? q : ''}*`] ?? row[`Skill${q > 1 ? q : ''}`] ?? row[`Qualification${q}`])
      if (!skillVal) continue
      let qualId = qualByName.get(skillVal.toLowerCase())
      if (!qualId) {
        const upserted = await prisma.qualification.upsert({
          where: { dspId_name: { dspId, name: skillVal } },
          create: { dspId, name: skillVal },
          update: {},
          select: { id: true },
        })
        qualId = upserted.id
        qualByName.set(skillVal.toLowerCase(), qualId)
      }
      const rateVal = row[`Rate${q > 1 ? q : ''}`]
      const rate = rateVal !== '' && rateVal != null ? parseFloat(String(rateVal)) : null
      empQuals.push({ qualificationId: qualId, rate: isNaN(rate!) ? null : rate })
    }

    // Qualifications — single comma-separated column (Amazon Associates format)
    // If a qualification name isn't in the DB yet, auto-create it for this DSP
    const qualCol = str(row['Qualifications'])
    if (qualCol) {
      for (const qName of qualCol.split(',').map(s => s.trim()).filter(Boolean)) {
        let qualId = qualByName.get(qName.toLowerCase())
        if (!qualId) {
          const upserted = await prisma.qualification.upsert({
            where: { dspId_name: { dspId, name: qName } },
            create: { dspId, name: qName },
            update: {},
            select: { id: true },
          })
          qualId = upserted.id
          qualByName.set(qName.toLowerCase(), qualId)
        }
        if (!empQuals.some(q => q.qualificationId === qualId)) {
          empQuals.push({ qualificationId: qualId, rate: null })
        }
      }
    }

    // Emergency contacts
    const emergencyContacts: Array<{ name: string; phone: string | null; relationship: string | null; sortOrder: number }> = []
    for (let ec = 1; ec <= 3; ec++) {
      const ecName = str(row[`Emergency_Name${ec}`] ?? row[`Emergency_Contact${ec}_Name`])
      if (!ecName) continue
      emergencyContacts.push({
        name: ecName,
        phone: str(row[`Emergency_Phone${ec}`] ?? row[`Emergency_Contact${ec}_Phone`]) || null,
        relationship: str(row[`Emergency_Relationship${ec}`] ?? row[`Emergency_Contact${ec}_Relationship`]) || null,
        sortOrder: ec - 1,
      })
    }

    // Work email uniqueness check (allow same employee to keep its own email on update)
    const workEmail = str(row['Work_Email'] ?? row['Work Email']) || null
    if (workEmail) {
      const emailConflict = await prisma.employee.findUnique({ where: { workEmail } })
      if (emailConflict && emailConflict.id !== existingEmp?.id) {
        errors.push({ row: rowNum, field: 'Work_Email', message: `Work email "${workEmail}" already in use` })
        skipped++
        continue
      }
    }

    const employeeData = {
      primaryStationId: stationId,
      legalFirstName: firstName,
      legalMiddleName: middleName,
      legalLastName: lastName,
      nickname: str(row['Nickname']) || null,
      title: str(row['Title']) || null,
      gender: str(row['Gender']) || null,
      birthDate: parseRowDate(row['Birth_Date'] ?? row['BirthDate'] ?? row['DOB']),
      personalMobile: str(row['Personal_Mobile'] ?? row['Personal Mobile'] ?? row['Personal Phone Number'] ?? row['Personal_Phone_Number']) || null,
      personalEmail: str(row['Personal_Email'] ?? row['Personal Email'] ?? row['Email']) || null,
      workEmail,
      workPhone: str(row['Work_Phone'] ?? row['Work Phone'] ?? row['Work Phone Number'] ?? row['Work_Phone_Number']) || null,
      workMobile: str(row['Work_Mobile'] ?? row['Work Mobile']) || null,
      homePhone: str(row['Home_Phone'] ?? row['Home Phone']) || null,
      permissionLevel,
      positions,
      status,
      hireDate: parseRowDate(row['Hire_Date'] ?? row['HireDate'] ?? row['Hire Date'] ?? row['Start Date'] ?? row['Start_Date']),
      expirationDate: parseRowDate(row['DL_Expiration'] ?? row['DL Expiration'] ?? row['License_Expiration'] ?? row['ID expiration'] ?? row['ID_expiration']),
      supervisorId,
      employeeCode: str(row['Employee_Code'] ?? row['Employee Code'] ?? row['Associate ID'] ?? row['Associate_ID'] ?? row['Badge ID'] ?? row['Badge_ID'] ?? row['Employee ID'] ?? row['Employee_ID']) || null,
      transporterId: rowTransporterId,
      payrollId: str(row['Payroll_ID'] ?? row['Payroll ID']) || null,
      gasPin: str(row['Gas_Pin'] ?? row['Gas Pin']) || null,
      street: str(row['Street'] ?? row['Address']) || null,
      city: str(row['City']) || null,
      addressState: str(row['State'] ?? row['Address_State']) || null,
      zipcode: str(row['Zip'] ?? row['Zipcode'] ?? row['Zip_Code']) || null,
      maritalStatus: str(row['Marital_Status'] ?? row['Marital Status']) || null,
      veteranStatus: String(row['Veteran_Status'] ?? row['Veteran Status'] ?? '').toLowerCase() === 'yes',
      ssnLast4: str(row['SSN_Last4'] ?? row['SSN Last 4']) || null,
      pantSize: str(row['Pant_Size'] ?? row['Pant Size']) || null,
      shoeSize: str(row['Shoe_Size'] ?? row['Shoe Size']) || null,
      tShirtSize: str(row['TShirt_Size'] ?? row['T-Shirt Size'] ?? row['TShirt Size']) || null,
      dlNumber: str(row['DL_Number'] ?? row['DL Number']) || null,
      dlState: str(row['DL_State'] ?? row['DL State']) || null,
    }

    try {
      if (existingEmp) {
        // UPDATE — employee already exists (matched by transporterId)
        // Prisma checked-update-input rejects scalar FK fields; use relation connect/disconnect instead
        const { primaryStationId: _psId, supervisorId: _supId, ...scalarUpdateData } = employeeData
        await prisma.employee.update({
          where: { id: existingEmp.id },
          data: {
            ...scalarUpdateData,
            primaryStation: stationId ? { connect: { id: stationId } } : { disconnect: true },
            supervisor: supervisorId ? { connect: { id: supervisorId } } : { disconnect: true },
          },
        })
        // Upsert qualifications
        for (const qual of empQuals) {
          await prisma.employeeQualification.upsert({
            where: { employeeId_qualificationId: { employeeId: existingEmp.id, qualificationId: qual.qualificationId } },
            create: { employeeId: existingEmp.id, qualificationId: qual.qualificationId, rate: qual.rate },
            update: { rate: qual.rate },
          })
        }
        updated++
      } else {
        // CREATE — new employee
        await prisma.employee.create({
          data: {
            dspId,
            ...employeeData,
            emergencyContacts: emergencyContacts.length
              ? { createMany: { data: emergencyContacts } }
              : undefined,
            employeeQualifications: empQuals.length
              ? { createMany: { data: empQuals } }
              : undefined,
          },
        })
        created++
      }
    } catch {
      errors.push({ row: rowNum, field: 'unknown', message: 'Failed to save employee' })
      skipped++
    }
  }

  res.json({ created, updated, skipped, errors })
}

// ─── Invite employee (create Clerk account) ───────────────────────────────────

export async function inviteEmployee(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string

  const employee = await resolveEmployeeOwnership(userId!, id)
  if (!employee) { res.status(404).json({ message: 'Employee not found' }); return }

  if (employee.clerkUserId || employee.invitedAt) {
    res.status(409).json({ message: 'Employee has already been invited.' }); return
  }
  if (!employee.personalEmail) {
    res.status(400).json({ message: 'Employee has no primary email' }); return
  }

  // Get sender's dspId from Clerk public metadata
  const senderClerkUser = await clerkClient.users.getUser(userId!)
  const dspId = (senderClerkUser.publicMetadata as Record<string, unknown>)?.dspId as string | undefined
  if (!dspId) { res.status(400).json({ message: 'Could not resolve DSP ID' }); return }

  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:5173'

  // Create a Clerk invitation — this sends an email with a sign-up link.
  // When the employee accepts and creates their account, the user.created webhook
  // fires and links the new Clerk user to this Employee record via employeeId metadata.
  try {
    await clerkClient.invitations.createInvitation({
      emailAddress: employee.personalEmail,
      redirectUrl: `${frontendUrl}/sign-up`,
      publicMetadata: {
        employee_role: 'driver',
        role: 'employee',
        dspId,
        employeeId: employee.id,
      },
    })
  } catch (err: unknown) {
    const clerkErr = err as { clerkError?: boolean; errors?: Array<{ code: string }> }
    if (!clerkErr.clerkError) throw err

    const errCodes = clerkErr.errors?.map((e) => e.code) ?? []

    if (errCodes.includes('duplicate_record')) {
      // A pending invitation already exists in Clerk for this email.
      // Sync our DB so the button disables, then surface it to the caller.
      await prisma.employee.update({ where: { id: employee.id }, data: { invitedAt: new Date() } })
      res.status(409).json({ message: 'A pending invitation already exists for this email.' })
      return
    }

    if (errCodes.includes('invitation_already_accepted')) {
      // The invitation was previously accepted (account may have since been deleted).
      // Clerk permanently blocks re-inviting such emails, so fall back to createUser
      // which bypasses the invitation restriction and still creates the account.
      const clerkUser = await clerkClient.users.createUser({
        emailAddress: [employee.personalEmail],
        skipPasswordChecks: true,
        publicMetadata: { employee_role: 'driver', role: 'employee', dspId },
      })
      await prisma.employee.update({
        where: { id: employee.id },
        data: { clerkUserId: clerkUser.id, invitedAt: null },
      })
      res.json({ message: 'Account created directly (prior invitation was already accepted).' })
      return
    }

    throw err
  }

  await prisma.employee.update({
    where: { id: employee.id },
    data: { invitedAt: new Date() },
  })

  res.json({ message: 'Invitation email sent.' })
}

// ─── Reset employee password ──────────────────────────────────────────────────

export async function resetEmployeePassword(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string

  const employee = await resolveEmployeeOwnership(userId!, id)
  if (!employee) { res.status(404).json({ message: 'Employee not found' }); return }

  if (!employee.clerkUserId) {
    res.status(400).json({ message: 'Employee does not have a Clerk account yet' }); return
  }

  // Force password reset on next sign-in by setting a random password they won't know
  // Clerk doesn't have a direct "send reset email" backend API; we clear their sessions instead
  await clerkClient.users.updateUser(employee.clerkUserId, {
    skipPasswordChecks: false,
  })

  // Revoke all active sessions so they're forced to log in again
  const sessions = await clerkClient.sessions.getSessionList({ userId: employee.clerkUserId })
  await Promise.all(
    sessions.data.map((s) => clerkClient.sessions.revokeSession(s.id))
  )

  res.json({ message: 'Sessions revoked. Employee will need to sign in again.' })
}

// ─── List employee's future shifts ───────────────────────────────────────────

export async function listEmployeeFutureShifts(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string

  const employee = await resolveEmployeeOwnership(userId!, id)
  if (!employee) { res.status(404).json({ message: 'Employee not found' }); return }

  const today = new Date().toISOString().slice(0, 10) // "YYYY-MM-DD"

  const shifts = await prisma.shift.findMany({
    where: {
      employeeId: employee.id,
      date: { gte: today },
      status: { not: 'CANCELLED' },
    },
    include: {
      shiftType: { select: { name: true, color: true } },
      station: { select: { code: true, name: true } },
    },
    orderBy: { date: 'asc' },
  })

  res.json(shifts)
}

// ─── Activity log helper ──────────────────────────────────────────────────────

async function writeLog(opts: {
  dspId: string
  entityId: string
  action: string
  performedByClerkId?: string
  performedByName?: string
}) {
  await prisma.activityLog.create({
    data: {
      dspId: opts.dspId,
      entityType: 'EMPLOYEE',
      entityId: opts.entityId,
      action: opts.action,
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

// ─── List employee activity logs ──────────────────────────────────────────────

export async function listEmployeeLogs(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const employee = await resolveEmployeeOwnership(userId!, id)
  if (!employee) { res.status(404).json({ message: 'Employee not found' }); return }

  const logs = await prisma.activityLog.findMany({
    where: { entityType: 'EMPLOYEE', entityId: id },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  res.json(logs)
}

// ─── Cancel a specific shift ──────────────────────────────────────────────────

export async function cancelShift(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const shiftId = req.params.shiftId as string

  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ message: 'No DSP found' }); return }

  const shift = await prisma.shift.findUnique({ where: { id: shiftId } })
  if (!shift || shift.dspId !== dspId) {
    res.status(404).json({ message: 'Shift not found' }); return
  }

  const today = new Date().toISOString().slice(0, 10)
  if (shift.date < today) {
    res.status(400).json({ message: 'Cannot cancel a past shift' }); return
  }

  await prisma.shift.update({ where: { id: shiftId }, data: { status: 'CANCELLED' } })
  res.status(204).send()
}
