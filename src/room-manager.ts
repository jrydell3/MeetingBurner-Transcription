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
  publishTranscript
} from './supabase'

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
      return false
    }

    // Create and start the bot
    const bot = new LiveKitBot(roomId)

    // Handle transcript events
    bot.on('transcript', async (event: TranscriptEvent) => {
      // Publish to Supabase (store + broadcast)
      await publishTranscript(event)

      console.log(`[RoomManager] ${event.participantName}: "${event.text}"${event.isFinal ? ' (final)' : ''}`)

      // Forward final transcripts to JR agent and SkillsKit
      if (event.isFinal) {
        // Forward to JR Agent
        try {
          const response = await fetch('http://localhost:3001/transcript', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              roomId: event.roomId,
              transcript: {
                text: event.text,
                speaker: event.participantName,
                confidence: event.confidence,
                isFinal: true
              }
            })
          })
          if (!response.ok) {
            console.log(`[RoomManager] JR agent response: ${response.status}`)
          }
        } catch (error) {
          // JR agent may not be running, that's fine
        }

        // Forward to SkillsKit
        const activeRoom = this.activeRooms.get(event.roomId)
        console.log(`[RoomManager] Active room for ${event.roomId}:`, activeRoom ? `has skillsKitSessionId=${activeRoom.skillsKitSessionId}` : 'NOT FOUND')
        if (activeRoom?.skillsKitSessionId) {
          try {
            console.log(`[RoomManager] Forwarding to SkillsKit session ${activeRoom.skillsKitSessionId}`)
            const skillsKitResponse = await fetch(
              `http://localhost:3100/v1/sessions/${activeRoom.skillsKitSessionId}/signals`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  type: 'transcript',
                  data: {
                    text: event.text,
                    speaker: event.participantName,
                    confidence: event.confidence,
                    isFinal: true
                  }
                })
              }
            )
            if (!skillsKitResponse.ok) {
              console.log(`[RoomManager] SkillsKit response: ${skillsKitResponse.status}`)
            } else {
              console.log(`[RoomManager] SkillsKit accepted transcript`)
            }
          } catch (error) {
            console.error(`[RoomManager] SkillsKit error:`, error)
          }
        } else {
          console.log(`[RoomManager] No SkillsKit session for room ${event.roomId}, skipping forward`)
        }
      }
    })

    bot.on('disconnected', () => {
      console.log(`[RoomManager] Bot disconnected from room ${roomId}`)
      this.stopRoom(roomId)
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
      console.error(`[RoomManager] Failed to start bot for room ${roomId}:`, error)
      return false
    }
  }

  /**
   * Stop transcription for a room
   */
  async stopRoom(roomId: string): Promise<void> {
    const activeRoom = this.activeRooms.get(roomId)
    if (!activeRoom) {
      console.log(`[RoomManager] No active transcription for room ${roomId}`)
      return
    }

    // Leave the room and get duration stats
    const { durationMs, speechDurationMs } = await activeRoom.bot.leave()

    // Complete the session record
    await completeTranscriptionSession(
      activeRoom.sessionId,
      durationMs,
      speechDurationMs
    )

    this.activeRooms.delete(roomId)

    console.log(`[RoomManager] Stopped transcription for room ${roomId}`)
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
