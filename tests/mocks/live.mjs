// A local stand-in for Gemini Live (the BidiGenerateContent WebSocket), on
// the Gemini mock's port (tests/mocks/gemini.mjs), so voice E2E tests never
// call Google. Like the real one it reads the key from x-goog-api-key, sends
// JSON in binary frames, and closes with 1007 for a bad key (one starting
// "bad-"). After about a second of mic audio it answers one turn: the
// person's words "Hello Wren", a second of a 440 Hz tone as Wren's voice, and
// "Hi, I'm the mock Wren." A typed message gets "You typed: <text>" back;
// "mock:drop" closes the connection as if Gemini had gone away. Answers go
// one at a time, in order, and once something is typed the mock stops
// answering the mic, so a typed conversation isn't cut into by the fake mic.
// Memory, when the setup declares the tools: "remember that <x>" calls
// save_to_memory with <x> and answers "Saved: <x>." (or that it couldn't);
// a typed question (ending in "?") calls search_memory with it and adds
// "From your notes: <first match>." to the answer. When the setup's system
// instruction carries Wren's facts, every answer ends "Keeping in mind: <the
// first fact>", so the "facts used" check finds it.
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
  let tools = new Set()
  let fact = null
  let calls = 0
  let typedOnce = false
  /** One answer at a time, in order. */
  let turns = Promise.resolve()
  /** Tool calls waiting for the relay's answer, by id. */
  const waiting = new Map()

  const callTool = (name, args) =>
    new Promise((resolve) => {
      const id = `call-${++calls}`
      waiting.set(id, resolve)
      send({ toolCall: { functionCalls: [{ id, name, args }] } })
    })

  /** A typed message, with the memory tools when the session has them. */
  const typed = async (text) => {
    const remember = /remember that (.+?)[.!]?$/i.exec(text)
    if (remember && tools.has('save_to_memory')) {
      const result = await callTool('save_to_memory', { text: remember[1] })
      return answer(null, result.output?.saved ? `Saved: ${remember[1]}.` : 'Sorry, I could not save that.')
    }
    let found = ''
    if (text.trim().endsWith('?') && tools.has('search_memory')) {
      const result = await callTool('search_memory', { query: text })
      const first = result.output?.memories?.[0]
      if (first) found = ` From your notes: ${first.text}`
    }
    return answer(null, `You typed: ${text}${found}`)
  }

  const answer = async (said, words) => {
    answering = true
    const reply = fact ? `${words} Keeping in mind: ${fact}` : words
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
      tools = new Set((message.setup.tools ?? []).flatMap((t) => (t.functionDeclarations ?? []).map((f) => f.name)))
      const system = (message.setup.systemInstruction?.parts ?? []).map((p) => p.text).join('\n')
      fact = /<<<BEGIN FACTS [0-9a-f]+>>>\n- (.+)/.exec(system)?.[1] ?? null
      return send({ setupComplete: {} })
    }
    for (const response of message.toolResponse?.functionResponses ?? []) {
      waiting.get(response.id)?.(response.response ?? {})
      waiting.delete(response.id)
    }
    const input = message.realtimeInput
    if (input?.text) {
      if (input.text.startsWith('mock:drop')) return ws.terminate()
      typedOnce = true
      turns = turns.then(() => typed(input.text))
    } else if (input?.audio?.data) {
      heard += Buffer.from(input.audio.data, 'base64').length
      if (heard >= AUDIO_BYTES_PER_TURN && !answering && !typedOnce) {
        answering = true
        turns = turns.then(() => answer('Hello Wren', 'Hi, I’m the mock Wren.'))
      }
    }
  })
}
