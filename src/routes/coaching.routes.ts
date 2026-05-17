import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import {
  listRules,
  loadDefaults,
  updateRule,
  addTip,
  updateTip,
  deleteTip,
  getOverrides,
  setOverride,
  deleteOverride,
} from '../controllers/coaching.controller'

const router = Router()
router.use(requireAuth())

// Rules
router.get('/rules', listRules)
router.post('/rules/load-defaults', loadDefaults)
router.put('/rules/:id', updateRule)

// Tips
router.post('/rules/:id/tips', addTip)
router.put('/tips/:id', updateTip)
router.delete('/tips/:id', deleteTip)

// Per-driver overrides
router.get('/overrides', getOverrides)
router.put('/overrides/:ruleId/:transporterId', setOverride)
router.delete('/overrides/:ruleId/:transporterId', deleteOverride)

export default router
