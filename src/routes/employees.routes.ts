import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import {
  getEmployee,
  updateEmployee,
  deleteEmployee,
  listEmployeeQualifications,
  setEmployeeQualification,
  removeEmployeeQualification,
  inviteEmployee,
  resetEmployeePassword,
  listEmployeeFutureShifts,
  listEmployeeLogs,
} from '../controllers/employees.controller'

const router = Router()

router.use(requireAuth())

router.get('/:id', getEmployee)
router.patch('/:id', updateEmployee)
router.delete('/:id', deleteEmployee)
router.get('/:id/qualifications', listEmployeeQualifications)
router.put('/:id/qualifications/:qualId', setEmployeeQualification)
router.delete('/:id/qualifications/:qualId', removeEmployeeQualification)
router.post('/:id/invite', inviteEmployee)
router.post('/:id/reset-password', resetEmployeePassword)
router.get('/:id/future-shifts', listEmployeeFutureShifts)
router.get('/:id/logs', listEmployeeLogs)

export default router
