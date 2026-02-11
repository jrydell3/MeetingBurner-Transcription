/**
 * Room Manager
 *
 * Manages transcription sessions for multiple rooms.
 * Handles starting/stopping bots and coordinating with Supabase.
 */

import { LiveKitBot } from './livekit-bot'
import { TranscriptEvent } from './types'
import {
  getRoomSettings,
  createTranscriptionSession,
  completeTranscriptionSession,
  publishTranscript,
  removeChannel
} from './supabase'

// SkillsKit configuration
const SKILLSKIT_URL = process.env.SKILLSKIT_SESSION_URL || 'http://localhost:3100'

// JR Agent configuration
const JR_SERVICE_URL = process.env.JR_SERVICE_URL || 'http://localhost:3102'

interface ActiveRoom {
  roomId: string
  bot: LiveKitBot
  sessionId: string
  mode: 'live' | 'post-call'
  startedAt: Date
  skillsKitSessionId?: string
}

class RoomManager {
  private activeRooms: Map<string, ActiveRoom> = new Map()
  private joiningRooms: Set<string> = new Set()
  private stoppingRooms: Set<string> = new Set()

  /**
   * Forward a final transcript to an external service.
   * Failures are logged but never propagated — forwarding is best-effort.
   */
  private async forwardTranscript(
    url: string,
    label: string,
    body: object
  ): Promise<void> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!response.ok) {
        console.log(`[RoomManager] ${label} response: ${response.status}`)
      }
    } catch {
      // External service may not be running — that's fine
    }
  }

  /**
   * Handle a final transcript: forward to JR Agent and SkillsKit
   */
  private async handleFinalTranscript(event: TranscriptEvent): Promise<void> {
    this.forwardTranscript(
      `${JR_SERVICE_URL}/transcript`,
      'JR agent',
      {
        roomId: event.roomId,
        transcript: {
          text: event.text,
          speaker: event.participantName,
          confidence: event.confidence,
          isFinal: true
        }
      }
    )

    const activeRoom = this.activeRooms.get(event.roomId)
    if (activeRoom?.skillsKitSessionId) {
      this.forwardTranscript(
        `${SKILLSKIT_URL}/v1/sessions/${activeRoom.skillsKitSessionId}/signals`,
        'SkillsKit',
        {
          type: 'transcript',
          data: {
            text: event.text,
            speaker: event.participantName,
            confidence: event.confidence,
            isFinal: true
          }
        }
      )
    }
  }

  /**
   * Start transcription for a room
   */
  async startRoom(roomId: string): Promise<boolean> {
    // Check if already active
    if (this.activeRooms.has(roomId)) {
      console.log(`[RoomManager] Room ${roomId} already has active transcription`)
      return true
    }

    // Check if currently joining
    if (this.joiningRooms.has(roomId)) {
      console.log(`[RoomManager] Room ${roomId} is already being joined, skipping duplicate`)
      return true
    }

    // Mark as joining
    this.joiningRooms.add(roomId)

    // Get room settings
    const settings = await getRoomSettings(roomId)
    if (!settings) {
      console.error(`[RoomManager] Could not get settings for room ${roomId}`)
      this.joiningRooms.delete(roomId)
      return false
    }

    // Check if transcription is enabled
    if (settings.transcriptionMode === 'off') {
      console.log(`[RoomManager] Transcription is off for room ${roomId}`)
      this.joiningRooms.delete(roomId)
      return false
    }

    // For post-call mode, we still join and transcribe live, but could handle differently
    const mode = settings.transcriptionMode === 'post-call' ? 'post-call' : 'live'

    // Create session record
    const sessionId = await createTranscriptionSession(roomId, mode)
    if (!sessionId) {
      console.error(`[RoomManager] Could not create session for room ${roomId}`)
      this.joiningRooms.delete(roomId)
      return false
    }

    // Create and start the bot
    const bot = new LiveKitBot(roomId)

    bot.on('transcript', async (event: TranscriptEvent) => {
      await publishTranscript(event)
      console.log(`[RoomManager] ${event.participantName}: "${event.text}"${event.isFinal ? ' (final)' : ''}`)

      if (event.isFinal) {
        await this.handleFinalTranscript(event)
      }
    })

    bot.on('disconnected', () => {
      console.log(`[RoomManager] Bot disconnected from room ${roomId}`)
      // Only call stopRoom if the room was fully registered (avoids race during join)
      if (this.activeRooms.has(roomId)) {
        this.stopRoom(roomId)
      } else {
        console.log(`[RoomManager] Ignoring disconnect for room ${roomId} (not yet active, still joining)`)
      }
    })

    try {
      await bot.join()

      this.activeRooms.set(roomId, {
        roomId,
        bot,
        sessionId,
        mode,
        startedAt: new Date(),
        skillsKitSessionId: settings.skillsKitSessionId
      })

      this.joiningRooms.delete(roomId)
      console.log(`[RoomManager] Started transcription for room ${roomId} (mode: ${mode})`)
      return true
    } catch (error) {
      this.joiningRooms.delete(roomId)
      // Clean up the bot if join failed
      try { await bot.leave() } catch { /* ignore cleanup errors */ }
      console.error(`[RoomManager] Failed to start bot for room ${roomId}:`, error)
      return false
    }
  }

  /**
   * Stop transcription for a room
   */
  async stopRoom(roomId: string): Promise<void> {
    const activeRoom = this.activeRooms.get(roomId)
    if (!activeRoom) return

    // Prevent concurrent stop calls from double-leaving/double-completing
    if (this.stoppingRooms.has(roomId)) return
    this.stoppingRooms.add(roomId)

    try {
      this.activeRooms.delete(roomId)

      const { durationMs, speechDurationMs } = await activeRoom.bot.leave()

      await completeTranscriptionSession(
        activeRoom.sessionId,
        durationMs,
        speechDurationMs
      )

      removeChannel(roomId)
      console.log(`[RoomManager] Stopped transcription for room ${roomId}`)
    } finally {
      this.stoppingRooms.delete(roomId)
    }
  }

  /**
   * Check if a room has active transcription
   */
  isRoomActive(roomId: string): boolean {
    return this.activeRooms.has(roomId)
  }

  /**
   * Get all active rooms
   */
  getActiveRooms(): string[] {
    return Array.from(this.activeRooms.keys())
  }

  /**
   * Get stats for a room
   */
  getRoomStats(roomId: string): { startedAt: Date; mode: string } | null {
    const activeRoom = this.activeRooms.get(roomId)
    if (!activeRoom) return null

    return {
      startedAt: activeRoom.startedAt,
      mode: activeRoom.mode
    }
  }

  /**
   * Stop all rooms (for graceful shutdown)
   */
  async stopAll(): Promise<void> {
    const roomIds = Array.from(this.activeRooms.keys())

    for (const roomId of roomIds) {
      await this.stopRoom(roomId)
    }

    console.log(`[RoomManager] Stopped all ${roomIds.length} rooms`)
  }
}

// Singleton instance
export const roomManager = new RoomManager()
