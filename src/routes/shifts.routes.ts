import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { cancelShift } from '../controllers/employees.controller'
import { getDriverShifts, confirmShift } from '../controllers/shifts.controller'

const router = Router()

router.use(requireAuth())

router.get('/driver', getDriverShifts)
router.post('/:shiftId/confirm', confirmShift)
router.patch('/:shiftId/cancel', cancelShift)

export default router
