import { clerkMiddleware, requireAuth, getAuth } from '@clerk/express'
import { Request, Response, NextFunction } from 'express'
import { prisma } from '../lib/prisma'

export { clerkMiddleware, requireAuth }

declare global {
  namespace Express {
    interface Request {
      identity?:
        | { type: 'employee'; id: string; dspId: string | null; permissionLevel: string; clerkUserId: string }
        | { type: 'superAdmin'; id: string; role: string; clerkUserId: string }
      extensionDspId?: string // Set by requireExtensionAuth when using X-Extension-Token
    }
  }
}

/**
 * Middleware that accepts either Clerk auth OR X-Extension-Token header.
 * If extension token is present and valid, sets req.extensionDspId and skips Clerk.
 * Otherwise falls through to Clerk's requireAuth().
 */
export function requireAuthOrExtensionToken() {
  const clerkAuth = requireAuth()

  return async (req: Request, res: Response, next: NextFunction) => {
    const extToken = req.headers['x-extension-token'] as string | undefined

    if (extToken) {
      const dsp = await prisma.dsp.findUnique({
        where: { extensionToken: extToken },
        select: { id: true },
      })
      if (!dsp) {
        res.status(401).json({ error: 'Invalid extension token' })
        return
      }
      req.extensionDspId = dsp.id
      return next()
    }

    // No extension token — fall through to Clerk
    clerkAuth(req, res, next)
  }
}

// Resolves Clerk user to either a SuperAdmin or Employee record
// based on publicMetadata.role set in Clerk dashboard
export async function resolveIdentity(req: Request, res: Response, next: NextFunction) {
  const auth = getAuth(req)
  if (!auth.userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const clerkRole = (auth.sessionClaims?.metadata as Record<string, string> | undefined)?.role

  if (clerkRole === 'SUPER_ADMIN') {
    const superAdmin = await prisma.superAdmin.findUnique({
      where: { clerkUserId: auth.userId },
      select: { id: true, role: true, clerkUserId: true },
    })
    if (!superAdmin) {
      res.status(403).json({ error: 'No super admin record found' })
      return
    }
    req.identity = { type: 'superAdmin', ...superAdmin }
  } else {
    const employee = await prisma.employee.findUnique({
      where: { clerkUserId: auth.userId },
      select: { id: true, dspId: true, permissionLevel: true, clerkUserId: true },
    })
    if (!employee) {
      res.status(403).json({ error: 'No employee record found for this user' })
      return
    }
    req.identity = { type: 'employee', ...employee, clerkUserId: employee.clerkUserId! }
  }

  next()
}
