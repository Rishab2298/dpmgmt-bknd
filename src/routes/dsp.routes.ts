import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { getDspStations, getShiftTypes, getDspSkills } from '../controllers/dsp.controller'
import { createStation } from '../controllers/stations.controller'
import {
  listDspQualifications,
  createDspQualification,
  updateDspQualification,
  deleteDspQualification,
} from '../controllers/station-resources.controller'
import {
  listEmployees,
  createEmployee,
  bulkImportEmployees,
  uploadMiddleware,
} from '../controllers/employees.controller'
import {
  listDevices,
  createDevice,
  bulkImportDevices,
  uploadMiddleware as deviceUploadMiddleware,
} from '../controllers/devices.controller'
import {
  listVehicles,
  createVehicle,
  bulkImportVehicles,
  uploadMiddleware as vehicleUploadMiddleware,
} from '../controllers/vehicles.controller'
import {
  listMaintenanceRecords,
  createMaintenanceRecord,
} from '../controllers/maintenance.controller'
import { listScheduled, createScheduled } from '../controllers/scheduled-maintenance.controller'
import { listChecklists, createChecklist } from '../controllers/checklists.controller'

const router = Router()

router.use(requireAuth())

router.get('/stations', getDspStations)
router.post('/stations', createStation)
router.get('/shift-types', getShiftTypes)
router.get('/skills', getDspSkills)

router.get('/qualifications', listDspQualifications)
router.post('/qualifications', createDspQualification)
router.patch('/qualifications/:qualId', updateDspQualification)
router.delete('/qualifications/:qualId', deleteDspQualification)

router.get('/employees', listEmployees)
router.post('/employees', createEmployee)
router.post('/employees/bulk-import', uploadMiddleware, bulkImportEmployees)

router.get('/devices', listDevices)
router.post('/devices', createDevice)
router.post('/devices/bulk-import', deviceUploadMiddleware, bulkImportDevices)

router.get('/vehicles', listVehicles)
router.post('/vehicles', createVehicle)
router.post('/vehicles/bulk-import', vehicleUploadMiddleware, bulkImportVehicles)

router.get('/maintenance-records', listMaintenanceRecords)
router.post('/maintenance-records', createMaintenanceRecord)

router.get('/scheduled-maintenance', listScheduled)
router.post('/scheduled-maintenance', createScheduled)

router.get('/maintenance-checklists', listChecklists)
router.post('/maintenance-checklists', createChecklist)

export default router
