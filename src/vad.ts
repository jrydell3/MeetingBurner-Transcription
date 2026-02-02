/**
 * Voice Activity Detection (VAD)
 *
 * Simple RMS-based VAD to detect when someone is speaking.
 * This saves money by not sending silent audio to AssemblyAI.
 */

// Default threshold - audio below this RMS level is considered silence
const DEFAULT_THRESHOLD = 0.01

/**
 * Calculate RMS (Root Mean Square) volume level
 * Returns value between 0 and 1
 */
export function calculateRMS(audio: Float32Array): number {
  if (audio.length === 0) return 0

  let sum = 0
  for (let i = 0; i < audio.length; i++) {
    sum += audio[i] * audio[i]
  }

  return Math.sqrt(sum / audio.length)
}

/**
 * Convert RMS to decibels
 */
export function rmsToDb(rms: number): number {
  if (rms === 0) return -Infinity
  return 20 * Math.log10(rms)
}

/**
 * Simple Voice Activity Detection based on volume threshold
 * Returns true if audio contains speech (above threshold)
 */
export function detectVoiceActivity(
  audio: Float32Array,
  threshold: number = DEFAULT_THRESHOLD
): boolean {
  const rms = calculateRMS(audio)
  return rms > threshold
}

/**
 * Convert Float32Array audio to Int16Array for AssemblyAI
 */
export function float32ToInt16(float32Array: Float32Array): Int16Array {
  const int16Array = new Int16Array(float32Array.length)

  for (let i = 0; i < float32Array.length; i++) {
    // Clamp to [-1, 1] range
    const s = Math.max(-1, Math.min(1, float32Array[i]))
    // Convert to 16-bit integer
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
  }

  return int16Array
}

/**
 * Audio buffer that accumulates samples and emits chunks
 */
export class AudioBuffer {
  private buffer: Float32Array
  private writeIndex: number = 0
  private readonly chunkSize: number

  constructor(chunkSize: number = 4800) { // 300ms at 16kHz
    this.chunkSize = chunkSize
    this.buffer = new Float32Array(chunkSize)
  }

  /**
   * Add samples to buffer, returns chunks when full
   */
  addSamples(samples: Float32Array): Float32Array[] {
    const chunks: Float32Array[] = []
    let sampleIndex = 0

    while (sampleIndex < samples.length) {
      const remaining = this.chunkSize - this.writeIndex
      const toCopy = Math.min(remaining, samples.length - sampleIndex)

      this.buffer.set(
        samples.subarray(sampleIndex, sampleIndex + toCopy),
        this.writeIndex
      )

      this.writeIndex += toCopy
      sampleIndex += toCopy

      if (this.writeIndex >= this.chunkSize) {
        chunks.push(new Float32Array(this.buffer))
        this.writeIndex = 0
      }
    }

    return chunks
  }

  /**
   * Get any remaining samples in buffer
   */
  flush(): Float32Array | null {
    if (this.writeIndex === 0) return null

    const remaining = new Float32Array(this.writeIndex)
    remaining.set(this.buffer.subarray(0, this.writeIndex))
    this.writeIndex = 0

    return remaining
  }

  /**
   * Reset the buffer
   */
  reset(): void {
    this.writeIndex = 0
  }
}
