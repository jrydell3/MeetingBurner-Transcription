/**
 * Transcription Service Types
 */

export type TranscriptionMode = 'off' | 'post-call' | 'live'

export interface RoomSession {
  roomId: string
  mode: TranscriptionMode
  startedAt: Date
  participantStreams: Map<string, ParticipantStream>
  isActive: boolean
}

export interface ParticipantStream {
  participantId: string
  participantName: string
  assemblyAiSessionId?: string
  isTranscribing: boolean
  lastActivityAt: Date
  speechDurationMs: number
}

export interface TranscriptEvent {
  roomId: string
  participantId: string
  participantName: string
  text: string
  isFinal: boolean
  confidence: number
  timestamp: Date
}

export interface WebhookPayload {
  event: string
  room?: {
    name: string
    sid: string
  }
  participant?: {
    identity: string
    name: string
    sid: string
  }
}
