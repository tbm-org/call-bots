#!/usr/bin/env node
// Chrome native messaging <-> the bot's private Unix socket. Never log stdout.
import { createConnection } from 'node:net'

const MAX = 1024 * 1024
const socketPath = process.env.CALL_BOTS_MEET_SOCKET
const token = process.env.CALL_BOTS_MEET_TOKEN
if (!socketPath || !token) process.exit(1)
const socket = createConnection(socketPath)
let input = Buffer.alloc(0)
let commands = Buffer.alloc(0)
let stopped = false
const stop = () => {
  if (stopped) return
  stopped = true
  socket.destroy()
  process.exit(0)
}
socket.on('connect', () => socket.write(`${JSON.stringify({ hello: token })}\n`))
socket.on('data', (chunk) => {
  commands = Buffer.concat([commands, chunk])
  for (;;) {
    const end = commands.indexOf(10)
    if (end < 0) break
    if (end > MAX) return stop()
    const body = commands.subarray(0, end)
    commands = commands.subarray(end + 1)
    const header = Buffer.alloc(4)
    header.writeUInt32LE(body.length)
    if (!process.stdout.write(Buffer.concat([header, body]))) socket.pause()
  }
  if (commands.length > MAX) stop()
})
process.stdout.on('drain', () => socket.resume())
process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk])
  while (input.length >= 4) {
    const size = input.readUInt32LE(0)
    if (size > MAX) return stop()
    if (input.length < size + 4) break
    const message = input.subarray(4, size + 4)
    input = input.subarray(size + 4)
    try {
      const parsed = JSON.parse(message.toString('utf8'))
      if (!socket.write(`${JSON.stringify(parsed)}\n`)) process.stdin.pause()
    } catch { return stop() }
  }
})
socket.on('drain', () => process.stdin.resume())
socket.on('error', stop)
socket.on('close', stop)
process.stdin.on('end', stop)
process.stdin.on('error', stop)
process.stdout.on('error', stop)
