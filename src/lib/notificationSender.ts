import { Resend } from 'resend'
import { Telnyx } from 'telnyx'
import { prisma } from './prisma'
import { getIO } from './socket'
import type { NotificationChannel, NotificationType } from '@prisma/client'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NotificationPayload {
  dspId: string
  recipientEmployeeId: string
  recipientEmail?: string | null
  recipientPhone?: string | null
  type: NotificationType
  channel: NotificationChannel
  title: string
  message: string
  severity: 'INFO' | 'WARNING' | 'CRITICAL'
  metadata?: Record<string, unknown>
}

interface SendResult {
  success: boolean
  error?: string
}

// ─── Lazy-initialised provider clients ───────────────────────────────────────

let _resend: Resend | null = null
function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY)
  return _resend
}

let _telnyx: Telnyx | null = null
function getTelnyxClient(): Telnyx | null {
  if (!process.env.TELNYX_API_KEY) return null
  if (!_telnyx) _telnyx = new Telnyx({ apiKey: process.env.TELNYX_API_KEY })
  return _telnyx
}

// ─── Channel handlers ────────────────────────────────────────────────────────

async function sendEmail(payload: NotificationPayload): Promise<SendResult> {
  const resend = getResend()
  if (!resend) {
    console.warn('[Notification/Email] RESEND_API_KEY not configured — skipping email delivery')
    return { success: false, error: 'Email not configured. Please add RESEND_API_KEY to your environment.' }
  }

  if (!payload.recipientEmail) {
    return { success: false, error: 'No email address for recipient' }
  }

  const fromAddress = process.env.RESEND_FROM_EMAIL ?? 'notifications@yourdomain.com'

  try {
    await resend.emails.send({
      from: fromAddress,
      to: payload.recipientEmail,
      subject: payload.title,
      html: buildEmailHtml(payload),
    })
    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown email error'
    console.error('[Notification/Email] send failed:', message)
    return { success: false, error: message }
  }
}

async function sendSms(payload: NotificationPayload): Promise<SendResult> {
  const telnyx = getTelnyxClient()
  if (!telnyx) {
    console.warn('[Notification/SMS] TELNYX_API_KEY not configured — skipping SMS delivery')
    return { success: false, error: 'SMS not configured. Please add TELNYX_API_KEY to your environment.' }
  }

  if (!process.env.TELNYX_FROM_NUMBER) {
    console.warn('[Notification/SMS] TELNYX_FROM_NUMBER not configured — skipping SMS delivery')
    return { success: false, error: 'SMS not configured. Please add TELNYX_FROM_NUMBER to your environment.' }
  }

  if (!payload.recipientPhone) {
    return { success: false, error: 'No phone number for recipient' }
  }

  try {
    await telnyx.messages.send({
      from: process.env.TELNYX_FROM_NUMBER!,
      to: payload.recipientPhone,
      text: `${payload.title}\n\n${payload.message}`,
    })
    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown SMS error'
    console.error('[Notification/SMS] send failed:', message)
    return { success: false, error: message }
  }
}

async function sendInApp(payload: NotificationPayload): Promise<SendResult> {
  try {
    const notification = await prisma.notification.create({
      data: {
        dspId: payload.dspId,
        employeeId: payload.recipientEmployeeId,
        type: payload.type,
        title: payload.title,
        message: payload.message,
        severity: payload.severity,
        metadata: payload.metadata ? JSON.parse(JSON.stringify(payload.metadata)) : undefined,
      },
    })

    // Push real-time event via Socket.io
    const io = getIO()
    if (io) {
      io.to(`emp:${payload.recipientEmployeeId}`).emit('notification:new', {
        id: notification.id,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        severity: notification.severity,
        createdAt: notification.createdAt.toISOString(),
      })
    }

    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown in-app notification error'
    console.error('[Notification/InApp] create failed:', message)
    return { success: false, error: message }
  }
}

async function sendPush(_payload: NotificationPayload): Promise<SendResult> {
  // Stubbed — ready for FCM integration when a mobile app is built
  console.info('[Notification/Push] Mobile push not implemented — skipping')
  return { success: false, error: 'Mobile push not implemented yet' }
}

// ─── Main dispatcher ─────────────────────────────────────────────────────────

export async function sendNotification(payload: NotificationPayload): Promise<SendResult> {
  switch (payload.channel) {
    case 'EMAIL':       return sendEmail(payload)
    case 'SMS':         return sendSms(payload)
    case 'IN_APP':      return sendInApp(payload)
    case 'MOBILE_PUSH': return sendPush(payload)
    default:
      return { success: false, error: `Unknown channel: ${payload.channel}` }
  }
}

// ─── Email template ──────────────────────────────────────────────────────────

function buildEmailHtml(payload: NotificationPayload): string {
  const severityColor =
    payload.severity === 'CRITICAL' ? '#dc2626'
    : payload.severity === 'WARNING' ? '#d97706'
    : '#2563eb'

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;border:1px solid #e4e4e7;overflow:hidden;">
        <tr><td style="padding:4px 24px 0;background:${severityColor};">
          <span style="font-size:11px;font-weight:600;color:#ffffff;text-transform:uppercase;letter-spacing:0.05em;">
            ${payload.severity === 'CRITICAL' ? 'Urgent' : payload.severity === 'WARNING' ? 'Attention Required' : 'Information'}
          </span>
        </td></tr>
        <tr><td style="padding:24px;">
          <h2 style="margin:0 0 12px;font-size:18px;font-weight:700;color:#18181b;">${escapeHtml(payload.title)}</h2>
          <p style="margin:0;font-size:14px;line-height:1.6;color:#3f3f46;">${escapeHtml(payload.message)}</p>
        </td></tr>
        <tr><td style="padding:0 24px 24px;">
          <p style="margin:0;font-size:12px;color:#a1a1aa;">This is an automated notification from DSP Management.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
