import { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import { Prisma } from '@prisma/client'
import * as Sentry from '@sentry/node'

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  // Zod validation errors
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation failed',
      message: err.errors[0]?.message ?? 'Validation failed',
      issues: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
    })
    return
  }

  // Prisma known errors
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = (err.meta?.target as string[])?.join(', ') ?? 'value'
      res.status(409).json({ error: 'A record with that value already exists', message: `A record with that ${target} already exists` })
      return
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: 'Record not found', message: 'Record not found' })
      return
    }
  }

  // Unknown — capture to Sentry and log
  Sentry.captureException(err)
  console.error(err)
  const message = err instanceof Error ? err.message : 'Internal server error'
  res.status(500).json({ error: message, message })
}
