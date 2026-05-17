import type { DocType } from './types'

// Detect document type from filename (matches DiveMetric detection patterns)
export function detectDocType(filename: string): DocType | null {
  const lower = filename.toLowerCase()

  // CSV types — order matters: trailing_six_week must come before dsp_overview_dashboard
  if (lower.includes('trailing_six_week'))                   return 'TRAILING_SIX_WEEK'
  if (lower.includes('dsp_overview_dashboard'))              return 'WEEKLY_OVERVIEW'
  if (lower.includes('customer_delivery_feedback_negative')) return 'CUSTOMER_FEEDBACK'
  if (lower.includes('daily_pps_report'))                    return 'PPS_DAILY'
  if (lower.includes('notification_on_arri'))                return 'PAW_PRINT'
  if (lower.includes('safety_dashboard'))                    return 'SAFETY_DASHBOARD'

  // PDF types
  if (lower.includes('dspscorecard'))   return 'DSP_SCORECARD'
  if (lower.includes('da-pod-details')) return 'POD_DETAILS'

  // XLSX types
  if (lower.includes('dvic_time_last_7_days')) return 'DVIC'

  return null
}

// Extract week number and year from a Cortex filename (e.g. "2025-W48")
export function extractWeekFromFilename(filename: string): { weekNumber: number; year: number } | null {
  const m = filename.match(/(\d{4})-W(\d+)/i)
  if (!m) return null
  return { year: parseInt(m[1]), weekNumber: parseInt(m[2]) }
}
