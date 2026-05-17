import { Router, Request, Response, NextFunction } from 'express'
import { handleClerkWebhook } from '../controllers/webhook.controller'

const router = Router()

// Raw body needed for Svix signature verification — do NOT use express.json() here
router.post('/clerk', handleClerkWebhook)

export default router
