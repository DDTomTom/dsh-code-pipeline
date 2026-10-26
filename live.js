// Turn the child agent's assistant stream into one compact "what is it doing right now"
// line for the floating panel. The stream is high frequency; the panel only needs the tail.

const TAIL = 320
const ARG_TAIL = 180

/** One mutable buffer per phase child. */
export function createLiveBuffer() {
  return { kind: 'thinking', reasoning: '', reply: '', tool: '', args: '' }
}

export function resetLive(buf) {
  buf.kind = 'thinking'
  buf.reasoning = ''
  buf.reply = ''
  buf.tool = ''
  buf.args = ''
}

/** Apply one StreamChunk; returns true when the visible snapshot changed. */
export function reduceLive(buf, chunk) {
  if (!chunk || typeof chunk !== 'object') return false
  if (chunk.type === 'reasoning-delta') {
    if (!chunk.text) return false
    buf.reasoning += chunk.text
    buf.kind = 'thinking'
    return true
  }
  if (chunk.type === 'text-delta') {
    if (!chunk.text) return false
    buf.reply += chunk.text
    buf.kind = 'reply'
    return true
  }
  if (chunk.type === 'tool-call-delta') {
    if (chunk.name && chunk.name !== buf.tool) { buf.tool = chunk.name; buf.args = '' }
    buf.args += chunk.argumentsDelta || ''
    buf.kind = 'tool'
    return true
  }
  if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
    buf.tool = chunk.block.name || buf.tool
    buf.args = chunk.block.arguments || buf.args
    buf.kind = 'tool'
    return true
  }
  return false
}

const tail = (value, n) => String(value ?? '').replace(/\r/g, '').trim().slice(-n)

/** The most useful one-liner for the current tool call: its argument, not its JSON. */
export function describeArgs(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  try {
    const parsed = JSON.parse(text)
    const pick = ['command', 'path', 'file_path', 'filePath', 'pattern', 'query', 'task', 'name', 'url']
    for (const key of pick) if (typeof parsed?.[key] === 'string' && parsed[key]) return tail(parsed[key], ARG_TAIL)
    for (const value of Object.values(parsed || {})) if (typeof value === 'string' && value) return tail(value, ARG_TAIL)
  } catch { /* partial JSON while streaming: show the raw tail */ }
  return tail(text, ARG_TAIL)
}

/** Snapshot for the panel; undefined when nothing to show yet. */
export function liveSnapshot(buf) {
  if (!buf) return undefined
  if (buf.kind === 'tool') {
    const arg = describeArgs(buf.args)
    if (!buf.tool && !arg) return undefined
    return { kind: 'tool', tool: String(buf.tool || ''), text: arg }
  }
  if (buf.kind === 'reply') {
    const body = tail(buf.reply, TAIL)
    return body ? { kind: 'reply', tool: '', text: body } : undefined
  }
  const body = tail(buf.reasoning, TAIL)
  return body ? { kind: 'thinking', tool: '', text: body } : undefined
}
