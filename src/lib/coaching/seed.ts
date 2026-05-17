/**
 * Default coaching metric definitions with pre-configured tips.
 * Seeded per-DSP on first access of the coaching page.
 * Based on dspworkplace coaching reference.
 */

export interface DefaultTip {
  rangeMin: number | null
  rangeMax: number | null
  message: string
  severity: string
  sortOrder: number
}

export interface MetricDef {
  metricKey: string
  category: string
  label: string
  unit?: string
  sortOrder: number
  defaultGoal?: number
  defaultTrigger?: number
  defaultTips?: DefaultTip[]
}

export const DEFAULT_METRICS: MetricDef[] = [
  // ── Safety ──
  {
    metricKey: 'ficoScore', category: 'Safety', label: 'FICO Score', unit: 'points', sortOrder: 0,
    defaultGoal: 800, defaultTrigger: 710,
    defaultTips: [
      { rangeMin: null, rangeMax: 779, message: 'This is not acceptable. Please dig in and review the coaching!', severity: 'RED', sortOrder: 0 },
      { rangeMin: 780, rangeMax: 809, message: 'Getting close but there is work to be done.', severity: 'ORANGE', sortOrder: 1 },
      { rangeMin: 810, rangeMax: null, message: 'Amazing work! We love the effort.', severity: 'GREEN', sortOrder: 2 },
    ],
  },
  {
    metricKey: 'seatbeltOffRate', category: 'Safety', label: 'Seatbelt-Off Rate', unit: 'events', sortOrder: 1,
    defaultGoal: 0, defaultTrigger: 2,
    defaultTips: [
      { rangeMin: 0, rangeMax: 0, message: 'Thank you for buckling up!', severity: 'GREEN', sortOrder: 0 },
      { rangeMin: 1, rangeMax: null, message: 'Wearing your seat belt will keep you safe and it\'s the law!', severity: 'RED', sortOrder: 1 },
    ],
  },
  {
    metricKey: 'speedingEventRate', category: 'Safety', label: 'Speeding Event Rate', unit: 'events', sortOrder: 2,
    defaultGoal: 0, defaultTrigger: 2,
    defaultTips: [
      { rangeMin: 0, rangeMax: 0, message: 'Way to stay safe!', severity: 'GREEN', sortOrder: 0 },
      { rangeMin: 1, rangeMax: null, message: 'Speeding is not acceptable. Please pay more attention.', severity: 'RED', sortOrder: 1 },
    ],
  },
  {
    metricKey: 'distractionsRate', category: 'Safety', label: 'Distractions Rate', unit: 'events', sortOrder: 3,
    defaultGoal: 0, defaultTrigger: 2,
    defaultTips: [
      { rangeMin: 0, rangeMax: 0, message: 'Goal Met. Excellent work leaving the distractions for the appropriate time.', severity: 'GREEN', sortOrder: 0 },
      { rangeMin: 1, rangeMax: null, message: 'This is easy and life-saving! Keep your eyes on the road!', severity: 'RED', sortOrder: 1 },
    ],
  },
  {
    metricKey: 'followingDistanceRate', category: 'Safety', label: 'Following Distance Rate', unit: 'events', sortOrder: 4,
    defaultGoal: 0, defaultTrigger: 1,
    defaultTips: [
      { rangeMin: 0, rangeMax: 0, message: 'Excellent job maintaining the proper distance. This is not easy and we appreciate it!', severity: 'GREEN', sortOrder: 0 },
      { rangeMin: 1, rangeMax: null, message: 'Needs improvement. Pay attention to your 3 seconds of needed space!', severity: 'RED', sortOrder: 1 },
    ],
  },
  {
    metricKey: 'signalViolationsRate', category: 'Safety', label: 'Sign/Signal Violations', unit: 'events', sortOrder: 5,
    defaultGoal: 0, defaultTrigger: 1,
    defaultTips: [
      { rangeMin: 0, rangeMax: 0, message: 'Nice work on the clean sheet. Way to follow the rules of the road!', severity: 'GREEN', sortOrder: 0 },
      { rangeMin: 1, rangeMax: 1, message: 'Let\'s not create an unsafe habit — review the provided coaching to clean this up.', severity: 'YELLOW', sortOrder: 1 },
      { rangeMin: 2, rangeMax: 2, message: 'Let\'s not create an unsafe habit — review the provided coaching to clean this up.', severity: 'ORANGE', sortOrder: 2 },
      { rangeMin: 3, rangeMax: null, message: 'This is too many. You need to be more careful!', severity: 'RED', sortOrder: 3 },
    ],
  },

  // ── Delivery ──
  {
    metricKey: 'deliveryCompletionRate', category: 'Delivery', label: 'DCR', unit: '%', sortOrder: 0,
    defaultGoal: 99, defaultTrigger: 98.7,
    defaultTips: [
      { rangeMin: null, rangeMax: 98.9, message: 'You need to work on your pace. Please review the coaching or reach out for help.', severity: 'RED', sortOrder: 0 },
      { rangeMin: 99, rangeMax: null, message: 'You met the goal... excellent, efficient work!', severity: 'GREEN', sortOrder: 1 },
    ],
  },
  {
    metricKey: 'packagesDelivered', category: 'Delivery', label: 'Packages Delivered', unit: 'packages', sortOrder: 1,
  },
  {
    metricKey: 'deliverySuccessBehaviors', category: 'Delivery', label: 'DSB', unit: 'behaviors', sortOrder: 2,
    defaultGoal: 850,
    defaultTips: [
      { rangeMin: null, rangeMax: 476.75, message: 'This needs work. Please review the coaching.', severity: 'RED', sortOrder: 0 },
      { rangeMin: 476.76, rangeMax: null, message: 'You met the goal. Your attention to detail is KEY METRIC. Magnificent!', severity: 'GREEN', sortOrder: 1 },
    ],
  },
  {
    metricKey: 'cdfDpmo', category: 'Delivery', label: 'CDF DPMO', unit: 'DPMO', sortOrder: 3,
    defaultGoal: 0, defaultTrigger: 2700,
    defaultTips: [
      { rangeMin: null, rangeMax: 1100, message: 'Great work! That smile must be working for you!', severity: 'GREEN', sortOrder: 0 },
      { rangeMin: 1101, rangeMax: 1700, message: 'Getting close but there is work to be done.', severity: 'YELLOW', sortOrder: 1 },
      { rangeMin: 1701, rangeMax: null, message: 'This score needs improvement. Please read the coaching provided.', severity: 'RED', sortOrder: 2 },
    ],
  },
  {
    metricKey: 'customerEscalationDefect', category: 'Delivery', label: 'CED', unit: 'defects', sortOrder: 4,
    defaultGoal: 0, defaultTrigger: 1,
    defaultTips: [
      { rangeMin: 0, rangeMax: 0, message: 'Goal met. Thank you!', severity: 'GREEN', sortOrder: 0 },
      { rangeMin: 1, rangeMax: null, message: 'Work on your Customer Delivery Feedback (CDF) score, follow your customer\'s delivery instructions, and wear your smile!', severity: 'RED', sortOrder: 1 },
    ],
  },

  // ── POD ──
  {
    metricKey: 'podAcceptanceRate', category: 'POD', label: 'POD Acceptance Rate', unit: '%', sortOrder: 0,
    defaultGoal: 100,
    defaultTips: [
      { rangeMin: null, rangeMax: 99.8, message: 'Always scan your package at the delivery point.', severity: 'RED', sortOrder: 0 },
      { rangeMin: 99.9, rangeMax: null, message: 'Goal met.', severity: 'GREEN', sortOrder: 1 },
    ],
  },
  {
    metricKey: 'podQualityScore', category: 'POD', label: 'POD Quality Score', unit: '%', sortOrder: 1,
    defaultGoal: 97, defaultTrigger: 96,
    defaultTips: [
      { rangeMin: null, rangeMax: 96, message: 'This is about the quality of your photo. Please check the coaching for a review.', severity: 'RED', sortOrder: 0 },
      { rangeMin: 96.01, rangeMax: null, message: 'Goal reached! Excellent... do you have a master\'s degree in photography?', severity: 'GREEN', sortOrder: 1 },
    ],
  },
  {
    metricKey: 'podRejects', category: 'POD', label: 'POD Rejects', unit: 'rejects', sortOrder: 2,
  },

  // ── Customer Feedback ──
  {
    metricKey: 'totalFeedback', category: 'Customer Feedback', label: 'Total Negative Feedback', unit: 'feedbacks', sortOrder: 0,
    defaultGoal: 0,
    defaultTips: [
      { rangeMin: 0, rangeMax: 0, message: 'No negative feedback. Great customer service!', severity: 'GREEN', sortOrder: 0 },
      { rangeMin: 1, rangeMax: null, message: 'You have received negative feedback. Please review and improve your customer interactions.', severity: 'RED', sortOrder: 1 },
    ],
  },

  // ── PPS ──
  {
    metricKey: 'ppsCompliancePercent', category: 'PPS', label: 'PPS Compliance', unit: '%', sortOrder: 0,
    defaultGoal: 90, defaultTrigger: 79.9,
    defaultTips: [
      { rangeMin: null, rangeMax: 84.999, message: 'You need to work on your pace. Please review the coaching or reach out for help.', severity: 'RED', sortOrder: 0 },
      { rangeMin: 85, rangeMax: 89.999, message: 'Practice makes perfect. Please review the coaching or reach out for help.', severity: 'ORANGE', sortOrder: 1 },
      { rangeMin: 90, rangeMax: null, message: 'You met the goal, efficient work!', severity: 'GREEN', sortOrder: 2 },
    ],
  },

  // ── Paw Print ──
  {
    metricKey: 'pawPrintComplianceRate', category: 'Paw Print', label: 'Paw Print Compliance', unit: '%', sortOrder: 0,
    defaultGoal: 100,
    defaultTips: [
      { rangeMin: null, rangeMax: 99, message: 'Please ensure you send paw print texts for every eligible stop.', severity: 'RED', sortOrder: 0 },
      { rangeMin: 99.01, rangeMax: null, message: 'Goal met. Thank you!', severity: 'GREEN', sortOrder: 1 },
    ],
  },

  // ── DVIC ──
  {
    metricKey: 'rushedInspections', category: 'DVIC', label: 'Rushed Inspections', unit: 'inspections', sortOrder: 0,
    defaultGoal: 0,
    defaultTips: [
      { rangeMin: 0, rangeMax: 0, message: 'Great job taking your time on vehicle inspections!', severity: 'GREEN', sortOrder: 0 },
      { rangeMin: 1, rangeMax: null, message: 'Please take your time during vehicle inspections. Safety first!', severity: 'RED', sortOrder: 1 },
    ],
  },
  {
    metricKey: 'criticalInspections', category: 'DVIC', label: 'Critical Inspections', unit: 'inspections', sortOrder: 1,
    defaultGoal: 0,
    defaultTips: [
      { rangeMin: 0, rangeMax: 0, message: 'No critical inspections. Well done!', severity: 'GREEN', sortOrder: 0 },
      { rangeMin: 1, rangeMax: null, message: 'Critical inspection detected (<10s). Vehicle inspections must be thorough.', severity: 'RED', sortOrder: 1 },
    ],
  },

  // ── Overall ──
  {
    metricKey: 'score', category: 'Overall', label: 'Overall Score', unit: 'points', sortOrder: 0,
    defaultGoal: 92.5,
    defaultTips: [
      { rangeMin: null, rangeMax: 92.4, message: 'This needs work. Please review the coaching.', severity: 'RED', sortOrder: 0 },
      { rangeMin: 92.5, rangeMax: null, message: 'You met the goal. Your attention to detail is magnificent!', severity: 'GREEN', sortOrder: 1 },
    ],
  },
  { metricKey: 'overallStanding', category: 'Overall', label: 'Overall Tier', sortOrder: 1 },
]
