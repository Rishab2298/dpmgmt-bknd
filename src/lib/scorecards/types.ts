// Shared types for scorecard document parsing

export type DocType =
  | 'WEEKLY_OVERVIEW'
  | 'TRAILING_SIX_WEEK'
  | 'CUSTOMER_FEEDBACK'
  | 'PPS_DAILY'
  | 'PAW_PRINT'
  | 'SAFETY_DASHBOARD'
  | 'DSP_SCORECARD'
  | 'POD_DETAILS'
  | 'DVIC'

// Per-driver record returned by each parser
export interface ParsedDriver {
  transporterId: string
  firstName?: string
  lastName?: string
  metrics: Record<string, unknown>
}

// Result returned by each individual parser
export interface ParsedDocumentResult {
  docType: DocType
  drivers: ParsedDriver[]
  metadata: {
    weekNumber?: number
    year?: number
    totalRecords?: number
    [key: string]: unknown
  }
}

// Final merged driver record (all docs combined)
export interface MergedDriver {
  transporterId: string
  firstName?: string
  lastName?: string
  metrics: Record<string, unknown>
  rank?: number
  score?: number      // 0–100 linear scale (rank 1 = 100, last = 0)
  rankedCount?: number
}
