import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import {
  getGrid, getAvailableDrivers, createShift,
  getWorkBlock, updateWorkBlock, deleteShift,
  addDevice, removeDevice,
  createRescueShift, sendHome,
  getShiftLogs,
  importParse, importExecute, importRoutesExecute, importUploadMiddleware,
} from '../controllers/scheduler.controller'

const router = Router()

router.use(requireAuth())

router.get('/grid', getGrid)
router.get('/drivers', getAvailableDrivers)
router.post('/shifts', createShift)

router.get('/shifts/:shiftId', getWorkBlock)
router.patch('/shifts/:shiftId', updateWorkBlock)
router.delete('/shifts/:shiftId', deleteShift)
router.post('/shifts/:shiftId/devices/:deviceId', addDevice)
router.delete('/shifts/:shiftId/devices/:deviceId', removeDevice)
router.post('/shifts/:shiftId/rescue', createRescueShift)
router.post('/shifts/:shiftId/send-home', sendHome)
router.get('/shifts/:shiftId/logs', getShiftLogs)

router.post('/import/parse', importUploadMiddleware, importParse)
router.post('/import/execute', importExecute)
router.post('/import/routes-execute', importRoutesExecute)

export default router
