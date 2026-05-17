import { Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { prisma } from '../lib/prisma'

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function resolveEmployee(userId: string) {
  return prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: {
      id: true,
      dspId: true,
      legalFirstName: true,
      legalLastName: true,
      nickname: true,
    },
  })
}

// ─── GET /api/shifts/driver ───────────────────────────────────────────────────

export async function getDriverShifts(req: Request, res: Response) {
  const { userId } = getAuth(req)

  const emp = await resolveEmployee(userId!)
  if (!emp?.dspId) { res.status(403).json({ message: 'No employee record found' }); return }

  // Include yesterday as a 1-day timezone buffer (server UTC vs local timezone edge cases)
  const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA')

  const shifts = await prisma.shift.findMany({
    where: {
      employeeId: emp.id,
      date: { gte: yesterday },
      status: { in: ['PUBLISHED', 'CONFIRMED'] },
    },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    include: {
      shiftType: { select: { name: true, color: true, startTime: true, endTime: true } },
      vehicle: { select: { id: true, make: true, model: true, year: true, licensePlate: true } },
      station: { select: { id: true, name: true, code: true } },
    },
  })

  res.json(shifts)
}

// ─── POST /api/shifts/:shiftId/confirm ───────────────────────────────────────

export async function confirmShift(req: Request, res: Response) {
  const { userId } = getAuth(req)

  const emp = await resolveEmployee(userId!)
  if (!emp?.dspId) { res.status(403).json({ message: 'No employee record found' }); return }

  const shiftId = req.params.shiftId as string
  if (!shiftId) { res.status(400).json({ message: 'Missing shift ID' }); return }

  const shift = await prisma.shift.findUnique({ where: { id: shiftId } })
  if (!shift) { res.status(404).json({ message: 'Shift not found' }); return }
  if (shift.employeeId !== emp.id) { res.status(403).json({ message: 'Not your shift' }); return }
  if (shift.status !== 'PUBLISHED') {
    res.status(400).json({ message: `Cannot confirm a shift with status ${shift.status}` })
    return
  }

  const driverName = [emp.nickname ?? emp.legalFirstName, emp.legalLastName].filter(Boolean).join(' ')

  const [updated] = await prisma.$transaction([
    prisma.shift.update({
      where: { id: shiftId },
      data: { status: 'CONFIRMED' },
    }),
    prisma.shiftLog.create({
      data: {
        shiftId,
        dspId: shift.dspId,
        action: `Shift confirmed by driver (${driverName})`,
        performedByClerkId: userId ?? undefined,
        performedByName: driverName || undefined,
      },
    }),
  ])

  res.json(updated)
}
