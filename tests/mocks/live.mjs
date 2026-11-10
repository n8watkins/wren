// A local stand-in for Gemini Live (the BidiGenerateContent WebSocket), on
// the Gemini mock's port (tests/mocks/gemini.mjs), so voice E2E tests never
// call Google. Like the real one it reads the key from x-goog-api-key, sends
// JSON in binary frames, and closes with 1007 for a bad key (one starting
// "bad-"). After about a second of mic audio it answers one turn: the
// person's words "Hello Wren", a second of a 440 Hz tone as Wren's voice, and
// "Hi, I'm the mock Wren.", once per session, however long the mic stays
// open (so a slow test run never hears a second turn). A typed message gets "You typed: <text>" back;
// "mock:drop" closes the connection as if Gemini had gone away.
import { WebSocketServer } from 'ws'

const PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
const AUDIO_BYTES_PER_TURN = 32000

/** 24 kHz 16-bit PCM of a soft tone, in 200 ms chunks, base64. */
function tone(seconds) {
  const rate = 24000
  const chunks = []
  for (let start = 0; start < rate * seconds; start += rate / 5) {
    const pcm = Buffer.alloc((rate / 5) * 2)
    for (let i = 0; i < rate / 5; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * (start + i)) / rate) * 3000), i * 2)
    chunks.push(pcm.toString('base64'))
  }
  return chunks
}

export function attachLive(server) {
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith(PATH)) return socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => session(ws, String(req.headers['x-goog-api-key'] ?? '')))
  })
}

function session(ws, key) {
  const send = (message) => ws.send(Buffer.from(JSON.stringify(message)), { binary: true })
  let heard = 0
  let answering = false
  let spoken = false

  const answer = async (said, reply) => {
    answering = true
    if (said) send({ serverContent: { inputTranscription: { text: said } } })
    const audio = tone(1)
    for (let i = 0; i < audio.length; i++) {
      if (ws.readyState !== ws.OPEN) return
      send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: audio[i] } }] } } })
      if (i === 1) send({ serverContent: { outputTranscription: { text: reply } } })
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
    send({ serverContent: { generationComplete: true } })
    send({ serverContent: { turnComplete: true } })
    heard = 0
    answering = false
  }

  ws.on('message', (data) => {
    let message
    try {
      message = JSON.parse(data.toString())
    } catch {
      return
    }
    if (message.setup) {
      if (key.startsWith('bad-') || !key) return ws.close(1007, 'API key not valid. Please pass a valid API key.')
      return send({ setupComplete: {} })
    }
    const input = message.realtimeInput
    if (input?.text) {
      if (input.text.startsWith('mock:drop')) return ws.terminate()
      if (!answering) void answer(null, `You typed: ${input.text}`)
    } else if (input?.audio?.data) {
      heard += Buffer.from(input.audio.data, 'base64').length
      if (heard >= AUDIO_BYTES_PER_TURN && !answering && !spoken) {
        spoken = true
        void answer('Hello Wren', 'Hi, I’m the mock Wren.')
      }
    }
  })
}
