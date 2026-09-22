import { timingSafeEqual } from 'node:crypto'
import { chmod } from 'node:fs/promises'
import { createServer } from 'node:net'

const MAX = 1024 * 1024

export class MeetBridge {
  constructor(path, token, readVolume) {
    this.readVolume = readVolume
    this.audioReady = false
    this.path = path
    this.token = Buffer.from(token)
    this.sequence = 0
    this.pending = new Map()
    this.socket = null
    this.closed = false
    this.connections = new Set()
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    this.ready.catch(() => {})
    this.server = createServer((socket) => this.accept(socket))
    this.server.on('error', (error) => this.close(error))
  }

  async listen() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.path, resolve)
    })
    await chmod(this.path, 0o600)
  }

  accept(socket) {
    this.connections.add(socket)
    let buffer = Buffer.alloc(0)
    let authorized = false
    const timer = setTimeout(() => { if (!authorized) socket.destroy() }, 5000)
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(timer)
      this.connections.delete(socket)
      if (socket === this.socket) {
        this.socket = null
        const error = new Error('The Meet browser connection stopped')
        this.close(error)
        this.onDisconnect?.(error)
      }
    })
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const end = buffer.indexOf(10)
        if (end < 0) break
        if (end > MAX) return socket.destroy()
        let message
        try { message = JSON.parse(buffer.subarray(0, end).toString('utf8')) } catch { return socket.destroy() }
        buffer = buffer.subarray(end + 1)
        if (!message || typeof message !== 'object' || Array.isArray(message)) return socket.destroy()
        if (!authorized) {
          const candidate = Buffer.from(typeof message.hello === 'string' ? message.hello : '')
          if (this.closed || this.socket || candidate.length !== this.token.length || !timingSafeEqual(candidate, this.token)) return socket.destroy()
          authorized = true
          clearTimeout(timer)
          this.socket = socket
          this.resolveReady()
          continue
        }
        if (message.op === 'read-volume' && Number.isSafeInteger(message.requestId)) {
          try {
            const value = this.readVolume()
            socket.write(`${JSON.stringify({ replyTo: message.requestId, value })}\n`)
          } catch (error) {
            socket.write(`${JSON.stringify({ replyTo: message.requestId, error: error.message })}\n`)
          }
          continue
        }
        if (message.event === 'audio-ready') { this.audioReady = true; continue }
        if (message.event === 'audio-loading') { this.audioReady = false; continue }
        if (message.event === 'window-opened') { this.onWindowCreated?.(); continue }
        if (message.event === 'meet-closed') { this.onDisconnect?.(new Error('The Meet tab was closed')); continue }
        const pending = this.pending.get(message.id)
        if (!pending) continue
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(String(message.error)))
        else pending.resolve(message.value)
      }
      if (buffer.length > MAX) socket.destroy()
    })
  }

  request(op, args = {}) {
    if (this.closed || !this.socket) return Promise.reject(new Error('The Meet browser connection is closed'))
    const id = ++this.sequence
    const body = JSON.stringify({ id, op, args })
    if (Buffer.byteLength(body) > MAX) return Promise.reject(new Error('Meet command is too large'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Meet browser did not answer ${op} in time`))
      }, 10000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.write(`${body}\n`, (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  close(error = new Error('The Meet browser is closed')) {
    if (this.closed) return
    this.closed = true
    this.audioReady = false
    this.rejectReady(error)
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    for (const socket of this.connections) socket.destroy()
    this.server.close()
  }
}
