import { Router } from 'express'
import { requireAuthOrExtensionToken } from '../middleware/auth'
import {
  rtsUploadMiddleware,
  importRts,
  listRts,
  getMyRts,
  listRtsDates,
} from '../controllers/performance.controller'

const router = Router()
router.use(requireAuthOrExtensionToken())

// Driver-facing: get my RTS entries (must be before /rts/:id)
router.get('/rts/my', getMyRts)

// Available dates with counts
router.get('/rts/dates', listRtsDates)

// Upload & upsert RTS CSV
router.post('/import/rts', rtsUploadMiddleware, importRts)

// List RTS entries (with optional ?date=YYYY-MM-DD filter)
router.get('/rts', listRts)

export default router
