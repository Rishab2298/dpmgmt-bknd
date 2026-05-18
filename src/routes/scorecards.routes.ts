import { Router } from 'express'
import { requireAuthOrExtensionToken } from '../middleware/auth'
import {
  uploadMiddleware,
  processDocuments,
  saveScorecard,
  listWeeks,
  getWeek,
  deleteWeek,
  compareWeeks,
  getMyScorecard,
} from '../controllers/scorecards.controller'

const router = Router()
router.use(requireAuthOrExtensionToken())

// Driver-facing: get my scorecards (must be before /weeks/:weekId)
router.get('/my', getMyScorecard)

// Upload + parse documents (returns merged driver preview)
router.post('/process', uploadMiddleware, processDocuments)

// Save processed week to DB
router.post('/save', saveScorecard)

// List all processed weeks
router.get('/weeks', listWeeks)

// Get week detail with all driver entries
router.get('/weeks/:weekId', getWeek)

// Multi-week comparison (anchor week + 3 prior)
router.get('/weeks/:weekId/compare', compareWeeks)

// Delete a week
router.delete('/weeks/:weekId', deleteWeek)

export default router
