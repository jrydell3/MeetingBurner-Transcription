/**
 * Supabase client for storing transcripts and broadcasting events
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { TranscriptEvent } from './types'

let supabase: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (!supabase) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_KEY

    if (!url || !key) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY')
    }

    supabase = createClient(url, key)
  }

  return supabase
}

/**
 * Get room settings including transcription mode
 */
export async function getRoomSettings(roomId: string): Promise<{
  transcriptionMode: 'off' | 'post-call' | 'live'
  hostId: string
  skillsKitSessionId?: string
} | null> {
  const { data, error } = await getSupabase()
    .from('rooms')
    .select('settings, host_id, skillskit_session_id')
    .eq('id', roomId)
    .single()

  if (error || !data) {
    console.error('[Supabase] Error fetching room settings:', error)
    return null
  }

  const result = {
    transcriptionMode: data.settings?.transcription_mode || 'off',
    hostId: data.host_id,
    skillsKitSessionId: data.skillskit_session_id
  }

  console.log('[Supabase] Room settings for', roomId, ':', result)
  return result
}

/**
 * Create a transcription session record
 */
export async function createTranscriptionSession(
  roomId: string,
  mode: 'post-call' | 'live'
): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from('live_transcription_sessions')
    .insert({
      room_id: roomId,
      mode,
      status: 'active',
      started_at: new Date().toISOString()
    })
    .select('id')
    .single()

  if (error) {
    console.error('[Supabase] Error creating session:', error)
    return null
  }

  return data.id
}

/**
 * Complete a transcription session and calculate costs
 */
export async function completeTranscriptionSession(
  sessionId: string,
  durationMs: number,
  speechDurationMs: number
): Promise<void> {
  const durationSeconds = Math.ceil(durationMs / 1000)
  const speechSeconds = Math.ceil(speechDurationMs / 1000)

  // Calculate token cost based on actual speech duration (VAD savings!)
  // Using 8 tokens/hr for live transcription
  const speechHours = speechSeconds / 3600
  const tokenCost = Math.ceil(speechHours * 8)

  const { error } = await getSupabase()
    .from('live_transcription_sessions')
    .update({
      status: 'completed',
      ended_at: new Date().toISOString(),
      duration: durationSeconds,
      token_cost: tokenCost
    })
    .eq('id', sessionId)

  if (error) {
    console.error('[Supabase] Error completing session:', error)
  }

  console.log(`[Supabase] Session ${sessionId} completed:`, {
    totalDuration: `${Math.round(durationSeconds / 60)}min`,
    speechDuration: `${Math.round(speechSeconds / 60)}min`,
    vadSavings: `${Math.round((1 - speechSeconds / durationSeconds) * 100)}%`,
    tokenCost
  })
}

/**
 * Store a transcript event in the database
 */
export async function storeTranscriptEvent(event: TranscriptEvent): Promise<void> {
  const { error } = await getSupabase()
    .from('live_transcript_events')
    .insert({
      room_id: event.roomId,
      speaker_id: event.participantId,
      speaker_name: event.participantName,
      text: event.text,
      is_final: event.isFinal,
      confidence: event.confidence,
      created_at: event.timestamp.toISOString()
    })

  if (error) {
    console.error('[Supabase] Error storing transcript event:', error)
  }
}

/**
 * Broadcast a transcript event via Supabase Realtime
 * This is what the UI and agents subscribe to
 */
export async function broadcastTranscript(event: TranscriptEvent): Promise<void> {
  const channel = getSupabase().channel(`room:${event.roomId}:transcript`)

  await channel.send({
    type: 'broadcast',
    event: 'transcript',
    payload: {
      speaker: event.participantName,
      speakerId: event.participantId,
      text: event.text,
      isFinal: event.isFinal,
      confidence: event.confidence,
      timestamp: event.timestamp.toISOString()
    }
  })
}

/**
 * Store and broadcast a transcript event
 */
export async function publishTranscript(event: TranscriptEvent): Promise<void> {
  // Store in database for persistence
  await storeTranscriptEvent(event)

  // Broadcast via Realtime for live consumers (UI, agents)
  await broadcastTranscript(event)
}
