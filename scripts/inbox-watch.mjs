#!/usr/bin/env node
/**
 * Wait for the next `peer_notify` message in the inbox thread, print it, and exit.
 *
 * Meant for an external delegator (for example Claude Code) that runs this as a
 * background command and is woken when it exits. The read cursor is persisted in
 * `$PEER_HOME/inbox-cursor.json`, so restarting the watcher never reports a
 * message twice and never skips one. Zero dependencies; Node >= 20.
 *
 *   node scripts/inbox-watch.mjs            # block until a new inbox message
 *   node scripts/inbox-watch.mjs --peek     # print unread messages, do not wait or advance
 *
 * Exit codes: 0 message(s) printed or nothing unread (--peek), 1 other error,
 * 3 unauthorized. An unreachable bridge is retried, not reported, so the
 * watcher survives a DSH restart.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const INBOX_TITLE = process.env.PEER_INBOX_TITLE || 'architect-inbox'
const peerHome = process.env.DSH_PEER_HOME || join(homedir(), '.dsh-peer')
const cursorFile = join(peerHome, 'inbox-cursor.json')
const peek = process.argv.includes('--peek')

/** Thrown to finish with an exit code; process.exit() with a closing socket aborts libuv on Windows. */
class Exit extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** @returns {Promise<{url: string, token: string}|null>} discovery record, or null while DSH is down */
async function discover() {
  const raw = await readFile(join(peerHome, 'bridge.json'), 'utf8').catch(() => null)
  return raw ? JSON.parse(raw) : null
}

/**
 * GET a bridge path. Returns null when the bridge cannot be reached.
 * @param {string} path request path
 */
async function call(path) {
  const bridge = await discover()
  if (!bridge) return null
  let res
  try {
    // connection: close leaves no keep-alive socket behind when the watcher finishes.
    res = await fetch(bridge.url + path, { headers: { authorization: 'Bearer ' + bridge.token, connection: 'close' } })
  } catch {
    return null
  }
  if (res.status === 401) throw new Exit(3, 'unauthorized; restart DSH or check bridge.json')
  const body = await res.json()
  if (!res.ok) throw new Exit(1, (body?.error?.code ?? res.status) + ': ' + (body?.error?.message ?? 'request failed'))
  return body
}

async function loadCursor(threadId) {
  const raw = await readFile(cursorFile, 'utf8').catch(() => null)
  const saved = raw ? JSON.parse(raw) : {}
  return saved.threadId === threadId && Number.isInteger(saved.after) ? saved.after : 0
}

function render(thread, message) {
  const kind = message.meta?.kind ?? 'report'
  const session = message.meta?.sessionId ? ' session=' + message.meta.sessionId : ''
  return `[inbox ${thread.id} seq=${message.seq} kind=${kind}${session} at=${message.createdAt}]\n${message.text}\n`
}

async function main() {
  for (let misses = 0; ; ) {
    const listing = await call('/v1/threads?limit=200')
    const thread = (listing?.threads ?? []).find((entry) => entry.title === INBOX_TITLE && entry.status === 'open')
    if (!thread) {
      if (peek) throw new Exit(0, listing ? 'no inbox thread yet' : 'bridge unreachable')
      // No inbox yet, or DSH is restarting: back off without spinning.
      misses += 1
      await sleep(Math.min(60_000, 5_000 * misses))
      continue
    }
    misses = 0

    const after = await loadCursor(thread.id)
    const body = await call(`/v1/threads/${thread.id}?after=${after}&wait_seconds=${peek ? 0 : 300}`)
    if (!body) {
      await sleep(10_000)
      continue
    }
    const all = body.messages ?? []
    const fromLead = all.filter((message) => message.from?.harness === 'dsh')
    if (fromLead.length > 0) {
      for (const message of fromLead) process.stdout.write(render(thread, message))
    }
    if (!peek && all.length > 0) {
      const next = Math.max(...all.map((message) => message.seq)) + 1
      await writeFile(cursorFile, JSON.stringify({ threadId: thread.id, after: next }) + '\n', { mode: 0o600 })
    }
    if (peek || fromLead.length > 0) return 0
  }
}

try {
  process.exitCode = await main()
} catch (error) {
  if (!(error instanceof Exit)) throw error
  if (error.message) process.stderr.write('inbox-watch: ' + error.message + '\n')
  process.exitCode = error.code
}
