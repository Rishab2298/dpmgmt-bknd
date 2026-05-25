import { Router } from 'express'
import { requireAuth, requireAuthOrExtensionToken } from '../middleware/auth'
import { getDspStations, getShiftTypes, getDspSkills, getExtensionToken } from '../controllers/dsp.controller'
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
import {
  listDocuments,
  createDocument,
  documentUploadMiddleware,
} from '../controllers/documents.controller'
import {
  listIncidents,
  createIncident,
  listIncidentCategories,
  createIncidentCategory,
} from '../controllers/incidents.controller'
import {
  listFuelLogs,
  createFuelLog,
  getFuelLogStats,
} from '../controllers/fuel-logs.controller'

const router = Router()

// Extension-token-compatible routes (must be before router.use(requireAuth()))
router.post('/employees/bulk-import', requireAuthOrExtensionToken(), uploadMiddleware, bulkImportEmployees)
router.post('/vehicles/bulk-import', requireAuthOrExtensionToken(), vehicleUploadMiddleware, bulkImportVehicles)

router.use(requireAuth())

router.get('/stations', getDspStations)
router.post('/stations', createStation)
router.post('/extension-token', getExtensionToken)
router.get('/shift-types', getShiftTypes)
router.get('/skills', getDspSkills)

router.get('/qualifications', listDspQualifications)
router.post('/qualifications', createDspQualification)
router.patch('/qualifications/:qualId', updateDspQualification)
router.delete('/qualifications/:qualId', deleteDspQualification)

router.get('/employees', listEmployees)
router.post('/employees', createEmployee)

router.get('/devices', listDevices)
router.post('/devices', createDevice)
router.post('/devices/bulk-import', deviceUploadMiddleware, bulkImportDevices)

router.get('/vehicles', listVehicles)
router.post('/vehicles', createVehicle)

router.get('/maintenance-records', listMaintenanceRecords)
router.post('/maintenance-records', createMaintenanceRecord)

router.get('/scheduled-maintenance', listScheduled)
router.post('/scheduled-maintenance', createScheduled)

router.get('/maintenance-checklists', listChecklists)
router.post('/maintenance-checklists', createChecklist)

router.get('/documents', listDocuments)
router.post('/documents', documentUploadMiddleware, createDocument)

router.get('/incidents', listIncidents)
router.post('/incidents', createIncident)
router.get('/incident-categories', listIncidentCategories)
router.post('/incident-categories', createIncidentCategory)

router.get('/fuel-logs', listFuelLogs)
router.get('/fuel-logs/stats', getFuelLogStats)
router.post('/fuel-logs', createFuelLog)

export default router
