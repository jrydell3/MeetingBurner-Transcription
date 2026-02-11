/**
 * LiveKit Bot
 *
 * Joins a LiveKit room as a hidden participant and subscribes to all audio tracks.
 * Processes audio through VAD and forwards to AssemblyAI for transcription.
 *
 * Uses @livekit/rtc-node for Node.js server-side compatibility.
 */

import { Room, RoomEvent, RemoteParticipant, RemoteTrack, RemoteTrackPublication, AudioStream, TrackKind, dispose } from '@livekit/rtc-node'
import { AccessToken } from 'livekit-server-sdk'
import { EventEmitter } from 'events'
import { detectVoiceActivity, float32ToInt16, AudioBuffer } from './vad'
import { AssemblyAIStream, TranscriptResult } from './assemblyai-stream'
import { TranscriptEvent } from './types'

const BOT_IDENTITY = 'transcription-bot'
const BOT_NAME = 'Transcription Service'

interface ParticipantHandler {
  participantId: string
  participantName: string
  stream: AssemblyAIStream
  audioBuffer: AudioBuffer
  speechDurationMs: number
  lastSpeechAt: number
  audioStreamAbort?: AbortController
}

export class LiveKitBot extends EventEmitter {
  private room: Room | null = null
  private roomId: string
  private participants: Map<string, ParticipantHandler> = new Map()
  private startedAt: Date
  private totalSpeechDurationMs: number = 0

  constructor(roomId: string) {
    super()
    this.roomId = roomId
    this.startedAt = new Date()
  }

  /**
   * Generate a token for the bot to join the room
   */
  private async generateToken(): Promise<string> {
    const apiKey = process.env.LIVEKIT_API_KEY
    const apiSecret = process.env.LIVEKIT_API_SECRET

    if (!apiKey || !apiSecret) {
      throw new Error('Missing LIVEKIT_API_KEY or LIVEKIT_API_SECRET')
    }

    const token = new AccessToken(apiKey, apiSecret, {
      identity: BOT_IDENTITY,
      name: BOT_NAME,
    })

    token.addGrant({
      room: this.roomId,
      roomJoin: true,
      canSubscribe: true,
      canPublish: false, // Bot doesn't publish anything
      canPublishData: false,
    })

    return await token.toJwt()
  }

  /**
   * Join the LiveKit room with retry logic
   */
  async join(): Promise<void> {
    const livekitUrl = process.env.LIVEKIT_URL
    if (!livekitUrl) {
      throw new Error('Missing LIVEKIT_URL')
    }

    const token = await this.generateToken()
    const maxRetries = 3

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      this.room = new Room()
      this.setupRoomEvents()

      console.log(`[LiveKitBot] Joining room ${this.roomId} (attempt ${attempt}/${maxRetries})...`)

      try {
        await this.room.connect(livekitUrl, token, {
          autoSubscribe: true,
          dynacast: false,
        })

        console.log(`[LiveKitBot] Connected to room ${this.roomId}`)
        break
      } catch (error) {
        console.error(`[LiveKitBot] Connection attempt ${attempt} failed:`, error)

        // Clean up failed room
        try { await this.room.disconnect() } catch { /* ignore */ }
        this.room = null

        if (attempt === maxRetries) {
          throw new Error(`Failed to connect to room ${this.roomId} after ${maxRetries} attempts`)
        }

        // Wait before retry with exponential backoff
        const delay = attempt * 2000
        console.log(`[LiveKitBot] Retrying in ${delay}ms...`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }

    if (!this.room) {
      throw new Error(`Room connection lost for ${this.roomId}`)
    }

    console.log(`[LiveKitBot] Joined room ${this.roomId} (connected: ${this.room.isConnected})`)

    // Log room state
    const participantCount = this.room.remoteParticipants.size
    console.log(`[LiveKitBot] Found ${participantCount} existing participants`)

    // Handle existing participants
    for (const participant of this.room.remoteParticipants.values()) {
      console.log(`[LiveKitBot] Processing existing participant: ${participant.identity} (${participant.name})`)
      await this.handleParticipantJoined(participant)
    }
  }

  /**
   * Set up room event handlers
   */
  private setupRoomEvents(): void {
    if (!this.room) return

    this.room.on(RoomEvent.ParticipantConnected, async (participant: RemoteParticipant) => {
      console.log(`[LiveKitBot] Participant joined: ${participant.name || participant.identity}`)
      await this.handleParticipantJoined(participant)
    })

    this.room.on(RoomEvent.ParticipantDisconnected, async (participant: RemoteParticipant) => {
      console.log(`[LiveKitBot] Participant left: ${participant.name || participant.identity}`)
      await this.handleParticipantLeft(participant)
    })

    this.room.on(RoomEvent.TrackSubscribed, (
      track: RemoteTrack,
      _publication: RemoteTrackPublication,
      participant: RemoteParticipant
    ) => {
      if (track.kind === TrackKind.KIND_AUDIO) {
        console.log(`[LiveKitBot] Subscribed to audio track from ${participant.name || participant.identity}`)
        this.handleAudioTrack(track, participant)
      }
    })

    this.room.on(RoomEvent.TrackUnsubscribed, (
      track: RemoteTrack,
      _publication: RemoteTrackPublication,
      participant: RemoteParticipant
    ) => {
      if (track.kind === TrackKind.KIND_AUDIO) {
        console.log(`[LiveKitBot] Unsubscribed from audio track from ${participant.name || participant.identity}`)
      }
    })

    this.room.on(RoomEvent.Disconnected, () => {
      console.log(`[LiveKitBot] Disconnected from room ${this.roomId}`)
      this.emit('disconnected')
    })
  }

  /**
   * Handle a new participant joining
   */
  private async handleParticipantJoined(participant: RemoteParticipant): Promise<void> {
    // Skip if this is another bot
    if (participant.identity === BOT_IDENTITY) return

    const participantId = participant.identity
    const participantName = participant.name || participant.identity

    // Create AssemblyAI stream for this participant
    const stream = new AssemblyAIStream(participantId, participantName)

    stream.on('transcript', (result: TranscriptResult) => {
      const event: TranscriptEvent = {
        roomId: this.roomId,
        participantId,
        participantName,
        text: result.text,
        isFinal: result.isFinal,
        confidence: result.confidence,
        timestamp: new Date()
      }

      this.emit('transcript', event)
    })

    stream.on('error', (error) => {
      console.error(`[LiveKitBot] AssemblyAI error for ${participantName}:`, error)
    })

    stream.on('closed', async () => {
      console.log(`[LiveKitBot] AssemblyAI closed for ${participantName}, will reconnect on next audio`)
      // Mark stream as inactive, will reconnect when audio is received
      const handler = this.participants.get(participantId)
      if (handler) {
        handler.stream = stream // Keep reference for potential reconnection
      }
    })

    try {
      await stream.connect()

      const handler: ParticipantHandler = {
        participantId,
        participantName,
        stream,
        audioBuffer: new AudioBuffer(4800), // 300ms chunks at 16kHz
        speechDurationMs: 0,
        lastSpeechAt: 0
      }

      this.participants.set(participantId, handler)
      console.log(`[LiveKitBot] Set up transcription for ${participantName}`)

      // Handle any existing audio tracks
      for (const publication of participant.trackPublications.values()) {
        if (publication.kind === TrackKind.KIND_AUDIO && publication.track) {
          console.log(`[LiveKitBot] Found existing audio track from ${participantName}`)
          this.handleAudioTrack(publication.track as RemoteTrack, participant)
        }
      }
    } catch (error) {
      console.error(`[LiveKitBot] Failed to set up transcription for ${participantName}:`, error)
    }
  }

  /**
   * Handle a participant leaving
   */
  private async handleParticipantLeft(participant: RemoteParticipant): Promise<void> {
    const participantId = participant.identity
    const handler = this.participants.get(participantId)

    if (handler) {
      // Abort the audio stream processing
      handler.audioStreamAbort?.abort()
      await handler.stream.close()
      this.totalSpeechDurationMs += handler.speechDurationMs
      this.participants.delete(participantId)
      console.log(`[LiveKitBot] Cleaned up transcription for ${handler.participantName}`)
    }
  }

  /**
   * Handle an audio track - this is where the magic happens
   */
  private async handleAudioTrack(track: RemoteTrack, participant: RemoteParticipant): Promise<void> {
    const participantId = participant.identity
    const handler = this.participants.get(participantId)

    if (!handler) {
      console.warn(`[LiveKitBot] No handler for participant ${participantId}`)
      return
    }

    // Create an AbortController to stop processing when participant leaves
    const abortController = new AbortController()
    handler.audioStreamAbort = abortController

    try {
      // Create AudioStream from the track to receive audio frames
      // AudioStream extends ReadableStream<AudioFrame>
      const audioStream = new AudioStream(track, 16000, 1) // 16kHz mono for AssemblyAI

      console.log(`[LiveKitBot] Started audio stream for ${handler.participantName}`)

      let frameCount = 0
      // Process audio frames using async iteration
      for await (const audioFrame of audioStream) {
        // Check if we should stop processing
        if (abortController.signal.aborted) {
          break
        }

        frameCount++
        if (frameCount % 100 === 1) {
          console.log(`[LiveKitBot] Received audio frame ${frameCount} from ${handler.participantName}, samples: ${audioFrame.data.length}`)
        }

        // AudioFrame has a data property with Int16Array audio samples
        await this.processAudioFrame(handler, audioFrame.data, audioFrame.sampleRate)
      }
    } catch (error) {
      if (error instanceof Error && error.name !== 'AbortError') {
        console.error(`[LiveKitBot] Error processing audio for ${handler.participantName}:`, error)
      }
    }
  }

  /**
   * Process an audio frame through VAD and send to AssemblyAI if speech detected
   */
  private async processAudioFrame(handler: ParticipantHandler, audioData: Int16Array, sampleRate: number): Promise<void> {
    // Convert Int16 to Float32 for VAD analysis
    const float32 = new Float32Array(audioData.length)
    for (let i = 0; i < audioData.length; i++) {
      float32[i] = audioData[i] / 32768
    }

    // Add to buffer and get complete chunks
    const chunks = handler.audioBuffer.addSamples(float32)

    for (const chunk of chunks) {
      // Check VAD - only send if speech detected
      // Using very low threshold (0.001) to catch quiet audio
      const hasSpeech = detectVoiceActivity(chunk, 0.001)

      if (hasSpeech) {
        // Reconnect AssemblyAI if connection was closed due to idle
        if (!handler.stream.isActive()) {
          console.log(`[LiveKitBot] Reconnecting AssemblyAI for ${handler.participantName}`)
          try {
            await handler.stream.connect()
          } catch (error) {
            console.error(`[LiveKitBot] Failed to reconnect AssemblyAI for ${handler.participantName}:`, error)
            return // Skip this chunk if reconnection failed
          }
        }

        // Convert back to Int16 for AssemblyAI
        const int16Chunk = float32ToInt16(chunk)
        handler.stream.sendAudio(int16Chunk)

        // Track speech duration for billing
        const chunkDurationMs = (chunk.length / sampleRate) * 1000
        handler.speechDurationMs += chunkDurationMs
        handler.lastSpeechAt = Date.now()
      }
    }
  }

  /**
   * Leave the room and clean up
   */
  async leave(): Promise<{ durationMs: number; speechDurationMs: number }> {
    // Close all participant streams
    for (const handler of this.participants.values()) {
      handler.audioStreamAbort?.abort()
      await handler.stream.close()
      this.totalSpeechDurationMs += handler.speechDurationMs
    }
    this.participants.clear()

    // Disconnect from room
    if (this.room) {
      await this.room.disconnect()
      this.room = null
    }

    // Cleanup LiveKit RTC resources
    await dispose()

    const durationMs = Date.now() - this.startedAt.getTime()

    console.log(`[LiveKitBot] Left room ${this.roomId}:`, {
      duration: `${Math.round(durationMs / 60000)}min`,
      speechDuration: `${Math.round(this.totalSpeechDurationMs / 60000)}min`,
      vadSavings: `${Math.round((1 - this.totalSpeechDurationMs / durationMs) * 100)}%`
    })

    return {
      durationMs,
      speechDurationMs: this.totalSpeechDurationMs
    }
  }

  /**
   * Get room ID
   */
  getRoomId(): string {
    return this.roomId
  }
}
