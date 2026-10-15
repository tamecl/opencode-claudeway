import * as fs from "node:fs/promises"
import { failure } from "./errors.js"
import { CredentialStore, fingerprint, hash, parseCredentials, record, withFileLock } from "./storage.js"

export const TOKEN_URL = "https://claude.ai/v1/oauth/token"
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const flights = new Map()
// shortcut: failure cooldown is process-local; persist it if multiple hosts hit refresh rate limits together.
const failures = new Map()
const pending = new Map()
const sourceID = stored => hash(JSON.stringify(stored.source))
const needsRefresh = credentials => credentials.expiresAt <= Date.now() + 300_000
const receipt = state => ({ version: 1, phase: "receipt", source: state.source, previous: state.previous, refresh: state.refresh, next: state.next })

export function parseOAuthResponse(data, refreshToken, now = Date.now()) {
  if (!record(data)) throw failure("refresh-uncertain")
  const absolute = Number.isSafeInteger(data.expires_at) && data.expires_at > now ? data.expires_at : undefined
  const expiresAt = absolute ?? (typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0 ? now + Math.trunc(data.expires_in * 1000) : NaN)
  try {
    const credentials = parseCredentials(JSON.stringify({ accessToken: data.access_token, refreshToken: Object.hasOwn(data, "refresh_token") ? data.refresh_token : refreshToken, expiresAt }))
    if (credentials.expiresAt <= now + 60_000) throw failure("invalid")
    return credentials
  } catch { throw failure("refresh-uncertain") }
}

async function responseJSON(response) {
  if (!response.body) throw failure("refresh-uncertain")
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 1_048_576) throw failure("refresh-uncertain")
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch { throw failure("refresh-uncertain") } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function recover(store, current, state) {
  if (!state || state.phase === "receipt") return current
  if (state.phase === "inflight") {
    // An interrupted request might have rotated this refresh token even if its access token changed.
    if (state.refresh === hash(current.credentials.refreshToken)) throw failure("refresh-uncertain")
    if (current.credentials.expiresAt <= Date.now() + 60_000) throw failure("source-changed")
    await store.clearState()
    return current
  }
  if (state.source !== sourceID(current)) throw failure("source-changed")
  const credentials = parseCredentials(JSON.stringify(state.credentials))
  if (fingerprint(current.credentials) === state.previous) current = await store.write(current, credentials)
  else if (fingerprint(current.credentials) !== state.next) throw failure("source-changed")
  await store.writeState(receipt(state))
  pending.delete(store.lockPath)
  return current
}

async function refreshLocked(store, initial) {
  let current = await store.read()
  let state = await store.readState()
  const knownChange = state?.source === sourceID(current) && state.previous === fingerprint(initial.credentials) && state.next === fingerprint(current.credentials)
  if (sourceID(current) !== sourceID(initial) || fingerprint(current.credentials) !== fingerprint(initial.credentials) && !knownChange) throw failure("source-changed")
  if (pending.has(store.lockPath)) {
    state = pending.get(store.lockPath)
    try { await store.writeState(state) } catch { throw failure("recovery-pending") }
  }
  current = await recover(store, current, state)
  if (!needsRefresh(current.credentials)) return current.credentials
  const refreshHash = hash(current.credentials.refreshToken)
  const priorFailure = failures.get(store.lockPath)
  if (priorFailure?.refresh === refreshHash && priorFailure.until > Date.now()) throw failure(priorFailure.code)
  store.preflight(current)
  state = { version: 1, phase: "inflight", source: sourceID(current), previous: fingerprint(current.credentials), refresh: refreshHash }
  await store.writeState(state)
  let response
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: current.credentials.refreshToken }),
    })
  } catch { throw failure("refresh-uncertain") }
  const data = await responseJSON(response)
  if (!response.ok) {
    const code = typeof data?.error === "string" ? data.error : ""
    const transient = response.status === 429 || ["temporarily_unavailable", "server_error"].includes(code)
    const terminal = response.status >= 400 && response.status < 500 && !transient
    if (!transient && !terminal) throw failure("refresh-uncertain")
    await store.clearState()
    const retry = Number(response.headers.get("retry-after")) * 1000
    const failureCode = transient ? "refresh-unavailable" : "refresh-rejected"
    failures.set(store.lockPath, { refresh: refreshHash, code: failureCode, until: transient ? Date.now() + Math.min(300_000, Math.max(30_000, Number.isFinite(retry) ? retry : 0)) : Infinity })
    throw failure(failureCode)
  }
  const credentials = parseOAuthResponse(data, current.credentials.refreshToken)
  state = { ...state, phase: "pending", next: fingerprint(credentials), credentials }
  pending.set(store.lockPath, state)
  try {
    await store.writeState(state)
    const persisted = await recover(store, current, state)
    failures.delete(store.lockPath)
    return persisted.credentials
  } catch (error) {
    if (error.code === "source-changed") throw error
    throw failure("recovery-pending")
  }
}

export async function readCredentials(store, { renew = true } = {}) {
  const fixed = await store.readStatic()
  if (fixed) return fixed
  const initial = await store.read()
  if (!renew) {
    if (initial.credentials.expiresAt <= Date.now() + 60_000) throw failure("expired")
    return initial.credentials
  }
  const state = await store.readState()
  if (!pending.has(store.lockPath) && (!state || state.phase === "receipt") && !needsRefresh(initial.credentials)) return initial.credentials
  const active = flights.get(store.lockPath)
  if (active) {
    if (active.source !== sourceID(initial)) throw failure("source-changed")
    return active.promise
  }
  const run = (async () => {
    // shortcut: Windows needs verified private-file ACLs before storing recovery tokens.
    if (process.platform === "win32") throw failure("unsupported-platform")
    await fs.mkdir(store.configDir, { recursive: true, mode: 0o700 })
    const directory = await fs.stat(store.configDir)
    if (!directory.isDirectory() || directory.mode & 0o022 || process.getuid && directory.uid !== process.getuid()) throw failure("permission")
    return withFileLock(store.lockPath, () => refreshLocked(store, initial))
  })().catch(error => { throw failure(error?.code) })
  flights.set(store.lockPath, { source: sourceID(initial), promise: run })
  try { return await run } finally { flights.delete(store.lockPath) }
}

export const credentialReader = {
  async read(env = process.env, options) { return readCredentials(new CredentialStore({ env }), options) },
}
