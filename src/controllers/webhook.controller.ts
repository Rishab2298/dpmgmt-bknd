import { Request, Response } from 'express'
import { Webhook } from 'svix'
import { clerkClient } from '@clerk/express'
import { prisma } from '../lib/prisma'

export async function handleClerkWebhook(req: Request, res: Response) {
  const secret = process.env.CLERK_WEBHOOK_SECRET
  if (!secret) {
    console.error('CLERK_WEBHOOK_SECRET is not set')
    res.status(500).json({ error: 'Webhook secret not configured' })
    return
  }

  // Verify Svix signature
  const wh = new Webhook(secret)
  let event: { type: string; data: Record<string, unknown> }

  try {
    event = wh.verify(req.body, {
      'svix-id': req.headers['svix-id'] as string,
      'svix-timestamp': req.headers['svix-timestamp'] as string,
      'svix-signature': req.headers['svix-signature'] as string,
    }) as typeof event
  } catch {
    res.status(400).json({ error: 'Invalid webhook signature' })
    return
  }

  switch (event.type) {
    case 'user.created': {
      const data = event.data as {
        id: string
        first_name: string | null
        last_name: string | null
        email_addresses: Array<{ email_address: string; id: string }>
        primary_email_address_id: string
        public_metadata: Record<string, unknown>
      }

      const primaryEmail = data.email_addresses.find(
        (e) => e.id === data.primary_email_address_id
      )?.email_address

      const employeeId = data.public_metadata?.employeeId as string | undefined

      if (employeeId) {
        // Case A: invited employee accepted their invitation.
        // Link the new Clerk user to the pre-existing Employee record.
        await prisma.employee.update({
          where: { id: employeeId },
          data: {
            clerkUserId: data.id,
            invitedAt: null, // clear pending flag now that they've accepted
            ...(data.first_name ? { legalFirstName: data.first_name } : {}),
            ...(data.last_name ? { legalLastName: data.last_name } : {}),
          },
        })

        // Carry invitation metadata forward to the user's Clerk publicMetadata
        await clerkClient.users.updateUserMetadata(data.id, {
          publicMetadata: {
            role: data.public_metadata.role ?? 'employee',
            employee_role: data.public_metadata.employee_role ?? 'driver',
            dspId: data.public_metadata.dspId,
          },
        })
      } else {
        // Case B: self-registered DSP owner.
        // Upsert on workEmail: if the same email re-registers after account deletion,
        // reclaim the existing row instead of creating a duplicate.
        await prisma.employee.upsert({
          where: { workEmail: primaryEmail ?? '' },
          create: {
            clerkUserId: data.id,
            legalFirstName: data.first_name ?? '',
            legalLastName: data.last_name ?? '',
            workEmail: primaryEmail,
            status: 'ONBOARDING',
            permissionLevel: 'DELIVERY_ASSOCIATE',
          },
          update: {
            clerkUserId: data.id,
            legalFirstName: data.first_name ?? '',
            legalLastName: data.last_name ?? '',
            status: 'ONBOARDING',
            dspId: null,
            primaryStationId: null,
            permissionLevel: 'DELIVERY_ASSOCIATE',
          },
        })

        await clerkClient.users.updateUserMetadata(data.id, {
          publicMetadata: { role: 'EMPLOYEE' },
        })
      }
      break
    }

    case 'user.deleted': {
      const data = event.data as { id?: string }
      if (!data.id) break

      const employee = await prisma.employee.findUnique({
        where: { clerkUserId: data.id },
        select: { id: true, dspId: true },
      })

      if (!employee) break

      await prisma.$transaction(async (tx) => {
        // Delete employee first (references dspId + stationId)
        await tx.employee.delete({ where: { id: employee.id } })

        // If this employee owned a DSP, tear it down too
        if (employee.dspId) {
          await tx.station.deleteMany({ where: { dspId: employee.dspId } })
          await tx.dsp.delete({ where: { id: employee.dspId } })
        }
      })
      break
    }
  }

  res.json({ received: true })
}
