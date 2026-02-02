/**
 * AssemblyAI Real-time Transcription Stream
 *
 * Manages a real-time transcription session for a single participant.
 * Updated to use NEW Streaming STT API (/v3/ws endpoint)
 */

import { AssemblyAI, StreamingTranscriber } from 'assemblyai'
import { EventEmitter } from 'events'

let client: AssemblyAI | null = null

function getClient(): AssemblyAI {
  if (!client) {
    const apiKey = process.env.ASSEMBLYAI_API_KEY
    if (!apiKey) {
      throw new Error('Missing ASSEMBLYAI_API_KEY')
    }
    client = new AssemblyAI({ apiKey })
  }
  return client
}

export interface TranscriptResult {
  text: string
  isFinal: boolean
  confidence: number
}

export class AssemblyAIStream extends EventEmitter {
  private transcriber: StreamingTranscriber | null = null
  private isConnected = false
  private participantId: string
  private participantName: string

  constructor(participantId: string, participantName: string) {
    super()
    this.participantId = participantId
    this.participantName = participantName
  }

  /**
   * Connect to AssemblyAI real-time transcription (NEW /v3/ws API)
   */
  async connect(): Promise<void> {
    if (this.isConnected) return

    try {
      // Generate temporary token for streaming (NEW API requirement)
      const token = await getClient().realtime.createTemporaryToken({ expires_in: 3600 })

      this.transcriber = new StreamingTranscriber({
        token,
        sampleRate: 16000,
        encoding: 'pcm_s16le',
      })

      this.transcriber.on('open', ({ id, expires_at }) => {
        console.log(`[AssemblyAI] Connected for ${this.participantName}:`, id, 'expires:', expires_at)
        this.isConnected = true
        this.emit('connected', id)
      })

      // NEW API uses 'turn' event instead of 'transcript'
      // Note: turn.transcript is a simple string, not an object
      this.transcriber.on('turn', (turn: any) => {
        if (!turn.transcript || typeof turn.transcript !== 'string') return
        if (turn.transcript.trim() === '') return

        const result: TranscriptResult = {
          text: turn.transcript,
          isFinal: true, // Turn events are always final
          confidence: turn.confidence || 0.9
        }

        this.emit('transcript', result)
      })

      this.transcriber.on('error', (error) => {
        console.error(`[AssemblyAI] Error for ${this.participantName}:`, error)
        this.emit('error', error)
      })

      this.transcriber.on('close', (code, reason) => {
        console.log(`[AssemblyAI] Closed for ${this.participantName}:`, code, reason)
        this.isConnected = false
        this.emit('closed')
      })

      await this.transcriber.connect()
    } catch (error) {
      console.error(`[AssemblyAI] Failed to connect for ${this.participantName}:`, error)
      throw error
    }
  }

  /**
   * Send audio data to AssemblyAI
   * Expects Int16Array in PCM format at 16kHz
   */
  sendAudio(audioData: Int16Array): void {
    if (!this.isConnected || !this.transcriber) {
      return
    }

    try {
      // Convert Int16Array to ArrayBuffer for AssemblyAI
      this.transcriber.sendAudio(audioData.buffer)
    } catch (error) {
      console.error(`[AssemblyAI] Error sending audio for ${this.participantName}:`, error)
    }
  }

  /**
   * Check if connected
   */
  isActive(): boolean {
    return this.isConnected
  }

  /**
   * Close the transcription stream
   */
  async close(): Promise<void> {
    if (this.transcriber) {
      try {
        await this.transcriber.close()
      } catch (error) {
        console.error(`[AssemblyAI] Error closing for ${this.participantName}:`, error)
      }
      this.transcriber = null
    }
    this.isConnected = false
  }

  /**
   * Get participant info
   */
  getParticipantId(): string {
    return this.participantId
  }

  getParticipantName(): string {
    return this.participantName
  }
}
