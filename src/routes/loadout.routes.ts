import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import {
  createSection,
  updateSection,
  deleteSection,
  reorderSections,
  createTask,
  updateTask,
  deleteTask,
  reorderTasks,
  getDriverLoadOut,
  uploadLoadOutPhoto,
  submitLoadOut,
  photoUploadMiddleware,
} from '../controllers/loadout.controller'

const router = Router()
router.use(requireAuth())

// Admin section endpoints
router.post('/sections', createSection)
router.patch('/sections/reorder', reorderSections)
router.patch('/sections/:id', updateSection)
router.delete('/sections/:id', deleteSection)

// Admin task endpoints
router.post('/tasks', createTask)
router.patch('/tasks/reorder', reorderTasks)
router.patch('/tasks/:id', updateTask)
router.delete('/tasks/:id', deleteTask)

// Driver endpoints
router.get('/driver', getDriverLoadOut)
router.post('/driver/upload-photo', photoUploadMiddleware, uploadLoadOutPhoto)
router.post('/driver/submit', submitLoadOut)

export default router
