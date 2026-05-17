import { Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { prisma } from '../lib/prisma'

// GET /api/dsp/stations
export async function getDspStations(req: Request, res: Response) {
  const { userId } = getAuth(req)

  const employee = await prisma.employee.findUnique({
    where: { clerkUserId: userId! },
    select: { dspId: true, primaryStationId: true },
  })

  if (!employee?.dspId) {
    res.status(404).json({ error: 'No DSP found for this user' })
    return
  }

  const stations = await prisma.station.findMany({
    where: { dspId: employee.dspId },
    select: { id: true, code: true, name: true, isPrimary: true, address: true, timezone: true },
    orderBy: { isPrimary: 'desc' },
  })

  res.json({ stations, primaryStationId: employee.primaryStationId })
}

// GET /api/dsp/skills
export async function getDspSkills(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const employee = await prisma.employee.findUnique({
    where: { clerkUserId: userId! },
    select: { dspId: true },
  })
  if (!employee?.dspId) { res.status(404).json({ error: 'No DSP found for this user' }); return }
  const skills = await prisma.skill.findMany({
    where: { dspId: employee.dspId },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
  res.json(skills)
}

// GET /api/dsp/shift-types?stationId=
export async function getShiftTypes(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const { stationId } = req.query as Record<string, string>

  if (!stationId) {
    res.status(400).json({ message: 'stationId is required' })
    return
  }

  const employee = await prisma.employee.findUnique({
    where: { clerkUserId: userId! },
    select: { dspId: true },
  })

  if (!employee?.dspId) {
    res.status(404).json({ error: 'No DSP found' })
    return
  }

  const shiftTypes = await prisma.shiftType.findMany({
    where: { stationId },
    select: {
      id: true, name: true, color: true, durationMinutes: true, breakMinutes: true,
      invoiceType: { select: { id: true, name: true, billableHours: true } },
      vehicleGroup: {
        select: {
          id: true,
          vehicleTypes: { select: { stationVehicleTypeId: true } },
        },
      },
    },
    orderBy: { name: 'asc' },
  })

  res.json(shiftTypes)
}
