/**
 * MeetingBurner Transcription Service
 *
 * Handles LiveKit webhooks to start/stop transcription for rooms.
 * Joins rooms as a bot, captures per-speaker audio, applies VAD,
 * and sends to AssemblyAI for real-time transcription.
 */

import express from 'express'
import { roomManager } from './room-manager'
import { WebhookPayload } from './types'

// Load environment variables
require('dotenv').config()

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3002

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    activeRooms: roomManager.getActiveRooms().length,
    uptime: process.uptime()
  })
})

/**
 * Get status of all active rooms
 */
app.get('/rooms', (req, res) => {
  const rooms = roomManager.getActiveRooms().map(roomId => ({
    roomId,
    ...roomManager.getRoomStats(roomId)
  }))

  res.json({ rooms })
})

/**
 * Manually start transcription for a room
 * POST /rooms/:roomId/start
 */
app.post('/rooms/:roomId/start', async (req, res) => {
  const { roomId } = req.params

  // Return immediately and start in background
  res.json({ success: true, message: `Starting transcription for room ${roomId}`, status: 'starting' })

  // Start transcription in background
  roomManager.startRoom(roomId).then(success => {
    if (!success) {
      console.error(`[API] Failed to start transcription for room ${roomId}`)
    }
  }).catch(error => {
    console.error(`[API] Error starting transcription for room ${roomId}:`, error)
  })
})

/**
 * Manually stop transcription for a room
 * POST /rooms/:roomId/stop
 */
app.post('/rooms/:roomId/stop', async (req, res) => {
  const { roomId } = req.params

  await roomManager.stopRoom(roomId)

  res.json({ success: true, message: `Stopped transcription for room ${roomId}` })
})

/**
 * LiveKit Webhook Handler
 * POST /webhook/livekit
 *
 * Receives events from LiveKit:
 * - room_started: Start transcription bot
 * - room_finished: Stop transcription bot
 * - participant_joined: Could use for per-participant logic
 * - participant_left: Could use for cleanup
 */
app.post('/webhook/livekit', async (req, res) => {
  const payload: WebhookPayload = req.body

  console.log(`[Webhook] Received event: ${payload.event}`, {
    room: payload.room?.name,
    participant: payload.participant?.name || payload.participant?.identity
  })

  try {
    switch (payload.event) {
      case 'room_started':
        if (payload.room?.name) {
          // Room started, join with transcription bot
          await roomManager.startRoom(payload.room.name)
        }
        break

      case 'room_finished':
        if (payload.room?.name) {
          // Room finished, stop transcription
          await roomManager.stopRoom(payload.room.name)
        }
        break

      case 'participant_joined':
        // Could handle per-participant logic here
        console.log(`[Webhook] Participant joined: ${payload.participant?.name || payload.participant?.identity}`)
        break

      case 'participant_left':
        // Could handle cleanup here
        console.log(`[Webhook] Participant left: ${payload.participant?.name || payload.participant?.identity}`)
        break

      default:
        console.log(`[Webhook] Unhandled event: ${payload.event}`)
    }

    res.json({ received: true })
  } catch (error) {
    console.error(`[Webhook] Error handling ${payload.event}:`, error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * MeetingBurner Integration Webhook
 * POST /webhook/meetingburner
 *
 * Alternative to LiveKit webhooks - called by MeetingBurner directly
 * when rooms are created/ended
 */
app.post('/webhook/meetingburner', async (req, res) => {
  const { event, roomId, data } = req.body

  console.log(`[MB Webhook] Received event: ${event}`, { roomId })

  try {
    switch (event) {
      case 'room.started':
      case 'room.created':
        if (roomId) {
          await roomManager.startRoom(roomId)
        }
        break

      case 'room.ended':
      case 'room.finished':
        if (roomId) {
          await roomManager.stopRoom(roomId)
        }
        break

      default:
        console.log(`[MB Webhook] Unhandled event: ${event}`)
    }

    res.json({ received: true })
  } catch (error) {
    console.error(`[MB Webhook] Error handling ${event}:`, error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * Graceful shutdown
 */
async function shutdown() {
  console.log('\n[Server] Shutting down...')
  await roomManager.stopAll()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

/**
 * Start server
 */
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║     MeetingBurner Transcription Service                       ║
║                                                               ║
║     Listening on port ${PORT}                                    ║
║                                                               ║
║     Endpoints:                                                ║
║     - GET  /health              Health check                  ║
║     - GET  /rooms               List active rooms             ║
║     - POST /rooms/:id/start     Start transcription           ║
║     - POST /rooms/:id/stop      Stop transcription            ║
║     - POST /webhook/livekit     LiveKit webhook               ║
║     - POST /webhook/meetingburner  MeetingBurner webhook      ║
╚═══════════════════════════════════════════════════════════════╝
  `)
})
