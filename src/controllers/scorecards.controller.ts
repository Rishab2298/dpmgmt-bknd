import { Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { z } from 'zod'
import multer from 'multer'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { evaluateCoaching } from '../lib/coaching/evaluate'
import { detectDocType } from '../lib/scorecards/detect'
import { mergeDocuments } from '../lib/scorecards/merge'
import type { ParsedDocumentResult } from '../lib/scorecards/types'
import { parseWeeklyOverview }   from '../lib/scorecards/parsers/csv-weekly-overview'
import { parseTrailingSixWeek }  from '../lib/scorecards/parsers/csv-trailing-six-week'
import { parseCustomerFeedback } from '../lib/scorecards/parsers/csv-customer-feedback'
import { parsePpsDaily }         from '../lib/scorecards/parsers/csv-pps-daily'
import { parsePawPrint }         from '../lib/scorecards/parsers/csv-paw-print'
import { parseSafetyDashboard }  from '../lib/scorecards/parsers/csv-safety-dashboard'
import { parseDspScorecard }     from '../lib/scorecards/parsers/pdf-dsp-scorecard'
import { parsePodDetails }       from '../lib/scorecards/parsers/pdf-pod-details'
import { parseDvic }             from '../lib/scorecards/parsers/xlsx-dvic'

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function resolveDsp(userId: string): Promise<string | null> {
  const emp = await prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { dspId: true },
  })
  return emp?.dspId ?? null
}

// ─── Multer upload (up to 9 files, 50 MB each) ────────────────────────────────

export const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
}).array('files', 9)

// ─── Parse documents ──────────────────────────────────────────────────────────

export async function processDocuments(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  const files = req.files as Express.Multer.File[] | undefined
  if (!files || files.length === 0) {
    res.status(400).json({ message: 'No files uploaded' }); return
  }

  const results: ParsedDocumentResult[] = []
  const errors: Array<{ filename: string; message: string }> = []

  for (const file of files) {
    const docType = detectDocType(file.originalname)
    if (!docType) {
      errors.push({ filename: file.originalname, message: 'Unrecognised document — filename does not match any expected Cortex report pattern.' })
      continue
    }

    try {
      let result: ParsedDocumentResult
      switch (docType) {
        case 'WEEKLY_OVERVIEW':    result = parseWeeklyOverview(file.buffer, file.originalname); break
        case 'TRAILING_SIX_WEEK':  result = parseTrailingSixWeek(file.buffer, file.originalname); break
        case 'CUSTOMER_FEEDBACK':  result = parseCustomerFeedback(file.buffer, file.originalname); break
        case 'PPS_DAILY':          result = parsePpsDaily(file.buffer, file.originalname); break
        case 'PAW_PRINT':          result = parsePawPrint(file.buffer, file.originalname); break
        case 'SAFETY_DASHBOARD':   result = parseSafetyDashboard(file.buffer, file.originalname); break
        case 'DSP_SCORECARD':      result = await parseDspScorecard(file.buffer, file.originalname); break
        case 'POD_DETAILS':        result = await parsePodDetails(file.buffer, file.originalname); break
        case 'DVIC':               result = parseDvic(file.buffer, file.originalname); break
      }
      results.push(result)
    } catch (err) {
      console.error(`[scorecard] Failed to parse ${file.originalname}:`, err)
      errors.push({ filename: file.originalname, message: 'Failed to parse file.' })
    }
  }

  if (results.length === 0) {
    res.status(422).json({ message: 'No documents could be parsed.', errors }); return
  }

  // Log what was parsed for debugging
  const docsInfo = results.map(r => ({
    docType: r.docType,
    drivers: r.drivers.length,
    metricKeys: r.drivers[0] ? Object.keys(r.drivers[0].metrics) : [],
  }))
  console.log('[scorecard] Parsed documents:', JSON.stringify(docsInfo, null, 2))

  const merged = mergeDocuments(results)

  // Log a sample merged driver to verify all metrics made it
  if (merged.length > 0) {
    console.log('[scorecard] Sample merged driver metric keys:', Object.keys(merged[0].metrics))
  }

  // Determine week metadata from parsed results
  const weekMeta = results.find(r => r.metadata.weekNumber)?.metadata ?? {}

  res.json({
    drivers: merged,
    weekNumber: weekMeta.weekNumber,
    year: weekMeta.year,
    totalDrivers: merged.length,
    docsProcessed: results.length,
    docsInfo,
    errors,
  })
}

// ─── Save scorecard week ───────────────────────────────────────────────────────

const saveSchema = z.object({
  weekNumber: z.number().int().min(1).max(53),
  year:       z.number().int().min(2020).max(2100),
  weekStart:  z.string().datetime(),
  weekEnd:    z.string().datetime(),
  drivers:    z.array(z.object({
    transporterId: z.string().min(1),
    firstName:     z.string().optional(),
    lastName:      z.string().optional(),
    metrics:       z.record(z.unknown()),
    rank:          z.number().int().optional(),
    score:         z.number().optional(),
    rankedCount:   z.number().int().optional(),
  })).min(1),
})

export async function saveScorecard(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  const parsed = saveSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.errors[0]?.message ?? 'Invalid request' }); return
  }

  const { weekNumber, year, weekStart, weekEnd, drivers } = parsed.data

  // Build Employee lookup: transporterId → employeeId
  const employees = await prisma.employee.findMany({
    where: { dspId, transporterId: { not: null } },
    select: { id: true, transporterId: true },
  })
  const employeeMap = new Map(
    employees.map(e => [e.transporterId!.toUpperCase(), e.id])
  )

  // Upsert the week record
  const week = await prisma.scorecardWeek.upsert({
    where: { dspId_weekNumber_year: { dspId, weekNumber, year } },
    create: {
      dspId, weekNumber, year,
      weekStart: new Date(weekStart),
      weekEnd:   new Date(weekEnd),
      totalDrivers: drivers.length,
    },
    update: {
      weekStart: new Date(weekStart),
      weekEnd:   new Date(weekEnd),
      totalDrivers: drivers.length,
    },
  })

  // Delete old entries for this week, then recreate
  await prisma.scorecardEntry.deleteMany({ where: { weekId: week.id } })

  const unmatchedTransporterIds: string[] = []

  await prisma.scorecardEntry.createMany({
    data: drivers.map(d => {
      const empId = employeeMap.get(d.transporterId.toUpperCase()) ?? null
      if (!empId) unmatchedTransporterIds.push(d.transporterId)
      return {
        dspId,
        weekId:        week.id,
        employeeId:    empId,
        transporterId: d.transporterId,
        firstName:     d.firstName,
        lastName:      d.lastName,
        metrics:       d.metrics as Prisma.InputJsonValue,
        rank:          d.rank,
        score:         d.score,
        rankedCount:   d.rankedCount,
      }
    }),
  })

  res.json({
    week,
    totalDrivers: drivers.length,
    matchedDrivers: drivers.length - unmatchedTransporterIds.length,
    unmatchedTransporterIds,
  })

  // Fire-and-forget: evaluate coaching rules and create announcements
  evaluateCoaching(dspId, week.id, drivers).catch(err =>
    console.error('[coaching] Evaluation failed:', err)
  )
}

// ─── List weeks ───────────────────────────────────────────────────────────────

export async function listWeeks(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  const weeks = await prisma.scorecardWeek.findMany({
    where: { dspId },
    orderBy: [{ year: 'desc' }, { weekNumber: 'desc' }],
    select: {
      id: true,
      weekNumber: true,
      year: true,
      weekStart: true,
      weekEnd: true,
      totalDrivers: true,
      createdAt: true,
    },
  })

  res.json({ weeks })
}

// ─── Get week detail ──────────────────────────────────────────────────────────

export async function getWeek(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  const weekId = String(req.params.weekId)
  const week = await prisma.scorecardWeek.findFirst({
    where: { id: weekId, dspId },
    include: {
      entries: {
        orderBy: { rank: 'asc' },
        select: {
          id: true,
          transporterId: true,
          firstName: true,
          lastName: true,
          metrics: true,
          rank: true,
          score: true,
          rankedCount: true,
          employeeId: true,
        },
      },
    },
  })

  if (!week) { res.status(404).json({ message: 'Week not found' }); return }
  res.json({ week })
}

// ─── Delete week ──────────────────────────────────────────────────────────────

export async function deleteWeek(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  const weekId2 = String(req.params.weekId)
  const week = await prisma.scorecardWeek.findFirst({
    where: { id: weekId2, dspId },
    select: { id: true },
  })
  if (!week) { res.status(404).json({ message: 'Week not found' }); return }

  await prisma.scorecardWeek.delete({ where: { id: week.id } })
  res.status(204).send()
}

// ─── Multi-week comparison ───────────────────────────────────────────────────

export async function compareWeeks(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  const weekId = String(req.params.weekId)
  const anchor = await prisma.scorecardWeek.findFirst({
    where: { id: weekId, dspId },
    select: { weekNumber: true, year: true },
  })
  if (!anchor) { res.status(404).json({ message: 'Week not found' }); return }

  // Find up to 4 weeks including and before the anchor, ordered newest→oldest
  const weeks = await prisma.scorecardWeek.findMany({
    where: {
      dspId,
      OR: [
        { year: anchor.year, weekNumber: { lte: anchor.weekNumber } },
        { year: { lt: anchor.year } },
      ],
    },
    orderBy: [{ year: 'desc' }, { weekNumber: 'desc' }],
    take: 4,
    include: {
      entries: {
        select: {
          transporterId: true,
          firstName: true,
          lastName: true,
          metrics: true,
          rank: true,
          score: true,
          employeeId: true,
        },
      },
    },
  })

  res.json({ weeks })
}

// ─── Driver-facing: get my scorecards ─────────────────────────────────────────

export async function getMyScorecard(req: Request, res: Response) {
  const { userId } = getAuth(req)
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return }

  const employee = await prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { transporterId: true, dspId: true },
  })
  if (!employee) { res.status(403).json({ message: 'Forbidden' }); return }
  if (!employee.transporterId || !employee.dspId) { res.json({ entries: [] }); return }

  const entries = await prisma.scorecardEntry.findMany({
    where: {
      transporterId: { equals: employee.transporterId, mode: 'insensitive' },
      dspId: employee.dspId,
    },
    orderBy: [{ week: { year: 'desc' } }, { week: { weekNumber: 'desc' } }],
    include: {
      week: {
        select: {
          weekNumber: true,
          year: true,
          weekStart: true,
          weekEnd: true,
          totalDrivers: true,
        },
      },
    },
  })

  res.json({ entries })
}
