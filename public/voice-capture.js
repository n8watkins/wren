/* global AudioWorkletProcessor, registerProcessor, sampleRate */
/**
 * The mic side of voice (lib/client/voice.ts): runs on the audio thread,
 * turns the mic's samples (whatever rate the device uses) into 16 kHz 16-bit
 * PCM for Gemini Live, and posts 100 ms at a time with how loud it was.
 */
const TARGET_RATE = 16000
const CHUNK = 1600

class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.step = sampleRate / TARGET_RATE
    this.position = 0
    this.out = new Int16Array(CHUNK)
    this.filled = 0
    this.energy = 0
    this.previous = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    // Linear interpolation between neighbouring samples; the browser's own
    // echo cancellation and noise suppression already ran on this input.
    let position = this.position
    while (position < channel.length) {
      const index = Math.floor(position)
      const fraction = position - index
      const before = index === 0 ? this.previous : channel[index - 1]
      const at = channel[index]
      const sample = Math.max(-1, Math.min(1, before + (at - before) * fraction))
      this.out[this.filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      this.energy += sample * sample
      if (this.filled === CHUNK) {
        const level = Math.sqrt(this.energy / CHUNK)
        this.port.postMessage({ pcm: this.out.buffer, level }, [this.out.buffer])
        this.out = new Int16Array(CHUNK)
        this.filled = 0
        this.energy = 0
      }
      position += this.step
    }
    this.position = position - channel.length
    this.previous = channel[channel.length - 1]
    return true
  }
}

registerProcessor('voice-capture', VoiceCapture)
