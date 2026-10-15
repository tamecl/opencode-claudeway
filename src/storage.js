import childProcess from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { failure } from "./errors.js"

const LIMIT = 1_048_576
export const record = value => value !== null && typeof value === "object" && !Array.isArray(value)
export const hash = value => createHash("sha256").update(value).digest("hex")
export const fingerprint = credentials => hash(JSON.stringify([credentials.accessToken, credentials.refreshToken, credentials.expiresAt]))

export function parseCredentials(raw) {
  try {
    const root = JSON.parse(raw)
    if (!record(root)) throw failure("invalid")
    const value = Object.hasOwn(root, "claudeAiOauth") ? root.claudeAiOauth : root
    if (!record(value) || ![value.accessToken, value.refreshToken].every(token => typeof token === "string" && /^[\x21-\x7e]+$/u.test(token)) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) throw failure("invalid")
    return { accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt: value.expiresAt }
  } catch { throw failure("invalid") }
}

export async function security(args, input) {
  try {
    const result = await new Promise(resolve => {
      const child = childProcess.execFile("/usr/bin/security", args, { encoding: "utf8", timeout: 2_000, maxBuffer: LIMIT }, (error, stdout) => resolve({ error, stdout }))
      if (input !== undefined) {
        child.stdin.on("error", () => {})
        child.stdin.end(input)
      }
    })
    if (result.error) throw Object.assign(failure("keychain"), { code: result.error.code === 44 ? 44 : "keychain" })
    return result.stdout.trim()
  } catch (error) {
    if (error?.code === 44) throw error
    throw failure("keychain")
  }
}

export function keychainCommand(source, raw) {
  const args = ["add-generic-password", "-U", "-s", source.service, "-a", source.account, "-w", raw]
  if (args.some(arg => typeof arg !== "string" || /\p{Cc}/u.test(arg))) throw failure("keychain")
  const command = args.map(arg => '"' + arg.replace(/[\\"]/gu, "\\$&") + '"').join(" ") + "\n"
  // shortcut: security -i has a 4096-byte line buffer; use a native backend if larger blobs become necessary.
  if (Buffer.byteLength(command) > 4094) throw failure("keychain-limit")
  return command
}

export async function readBounded(path, privateOnly = false) {
  let file
  try {
    const before = await fs.lstat(path)
    if (!before.isFile() || before.isSymbolicLink()) throw failure("permission")
    file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const info = await file.stat()
    if (before.ino !== info.ino || before.dev !== info.dev || info.size > LIMIT) throw failure("invalid")
    if (privateOnly && ((info.mode & 0o077) || info.nlink !== 1 || process.getuid && info.uid !== process.getuid())) throw failure("permission")
    const buffer = Buffer.alloc(LIMIT + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > LIMIT) throw failure("invalid")
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)) } catch { throw failure("invalid") }
  } finally { await file?.close() }
}

async function syncDirectory(path) {
  if (process.platform === "win32") return
  const directory = await fs.open(dirname(path), "r")
  try { await directory.sync() } finally { await directory.close() }
}

export async function atomicJSON(path, value) {
  const raw = JSON.stringify(value)
  if (Buffer.byteLength(raw) > LIMIT) throw failure("invalid")
  const temporary = path + "." + randomUUID() + ".tmp"
  let file
  try {
    const existing = await fs.lstat(path).catch(error => { if (error.code !== "ENOENT") throw error })
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw failure("permission")
    file = await fs.open(temporary, "wx", 0o600)
    await file.writeFile(raw)
    await file.sync()
    await file.close()
    file = undefined
    await fs.rename(temporary, path)
    await syncDirectory(path)
  } catch (error) {
    throw failure(error?.code === "permission" || ["EACCES", "EPERM"].includes(error?.code) ? "permission" : "io")
  } finally {
    await file?.close().catch(() => {})
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
}

export async function withFileLock(path, run, waitMs = 20_000) {
  const deadline = performance.now() + waitMs
  let file
  let owner
  while (!file) {
    try {
      file = await fs.open(path, "wx", 0o600)
      owner = await file.stat()
      await file.writeFile(JSON.stringify({ pid: process.pid }))
      await file.sync()
    } catch (error) {
      if (file) { await file.close(); await fs.unlink(path).catch(() => {}); throw failure("io") }
      if (error.code !== "EEXIST") throw failure("permission")
      const info = await fs.lstat(path).catch(() => null)
      const data = await readBounded(path, true).then(JSON.parse).catch(() => null)
      if (info && Number.isSafeInteger(data?.pid) && data.pid > 0) {
        let dead = false
        try { process.kill(data.pid, 0) } catch (cause) { dead = cause.code === "ESRCH" }
        const current = await fs.lstat(path).catch(() => null)
        if (dead && current?.ino === info.ino && current?.dev === info.dev) {
          await fs.unlink(path).catch(() => {})
          continue
        }
      }
      if (performance.now() >= deadline) throw failure("refresh-busy")
      await delay(50)
    }
  }
  try { return await run() } finally {
    await file.close()
    const current = await fs.lstat(path).catch(() => null)
    if (current?.ino === owner.ino && current?.dev === owner.dev) await fs.unlink(path)
  }
}

export class CredentialStore {
  constructor({ env = process.env, platform = process.platform, security: run = security } = {}) {
    this.configDir = env.CLAUDE_CONFIG_DIR ?? join((platform === "win32" ? env.USERPROFILE : env.HOME) || homedir(), ".claude")
    this.platform = platform
    this.security = run
    this.service = "Claude Code-credentials" + (env.CLAUDE_CONFIG_DIR !== undefined ? "-" + hash(this.configDir).slice(0, 8) : "")
    this.tokenPath = join(this.configDir, ".claudeway-token")
    this.statePath = join(this.configDir, ".claudeway-refresh.json")
    this.lockPath = join(this.configDir, ".claudeway-refresh.lock")
  }

  async read() {
    let raw
    let source
    if (this.platform === "darwin") {
      try { raw = await this.security(["find-generic-password", "-s", this.service, "-w"]) } catch (error) {
        if (error?.code !== 44) throw failure("keychain")
      }
      if (raw !== undefined) {
        parseCredentials(raw)
        try {
          const info = await this.security(["find-generic-password", "-s", this.service])
          const match = /"acct"<blob>="((?:\\.|[^"\\])*)"/u.exec(info)
          const account = match && JSON.parse('"' + match[1] + '"')
          if (typeof account !== "string" || !account || /\p{Cc}/u.test(account)) throw failure("keychain")
          source = { kind: "keychain", service: this.service, account }
        } catch { throw failure("keychain") }
      }
    }
    if (raw === undefined) {
      source = { kind: "file", path: join(this.configDir, ".credentials.json") }
      try { raw = await readBounded(source.path) } catch (error) {
        if (error?.code === "ENOENT") throw failure("missing")
        throw failure(error?.code === "invalid" ? "invalid" : ["permission", "EACCES", "EPERM"].includes(error?.code) ? "permission" : "io")
      }
    }
    return { source, credentials: parseCredentials(raw), raw }
  }

  // A `claude setup-token` token owned by Claudeway: never renewed, never shares Claude Code's rotating refresh token.
  async readStatic() {
    let raw
    if (this.platform === "darwin") {
      try { raw = await this.security(["find-generic-password", "-s", "Claudeway-token", "-w"]) } catch (error) {
        if (error?.code !== 44) throw failure("keychain")
      }
    } else if (this.platform !== "win32") {
      try { raw = (await readBounded(this.tokenPath, true)).trim() } catch (error) {
        if (error?.code !== "ENOENT") throw failure(error?.code === "invalid" ? "invalid" : ["permission", "EACCES", "EPERM"].includes(error?.code) ? "permission" : "io")
      }
    }
    if (raw === undefined) return null
    if (!/^[\x21-\x7e]+$/u.test(raw)) throw failure("invalid")
    return { accessToken: raw, refreshToken: raw, expiresAt: Date.now() + 3_600_000, fixed: true }
  }

  async readState() {
    try {
      const state = JSON.parse(await readBounded(this.statePath, true))
      if (!record(state) || state.version !== 1 || !["receipt", "inflight", "pending"].includes(state.phase) || ![state.source, state.previous, state.refresh].every(value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value))) throw failure("invalid")
      if (state.phase !== "inflight" && (typeof state.next !== "string" || !/^[a-f0-9]{64}$/u.test(state.next))) throw failure("invalid")
      if (state.phase === "pending" && fingerprint(parseCredentials(JSON.stringify(state.credentials))) !== state.next) throw failure("invalid")
      return state
    } catch (error) {
      if (error.code === "ENOENT") return null
      throw failure(error.code === "permission" ? "permission" : "io")
    }
  }

  async writeState(state) { await atomicJSON(this.statePath, state) }
  async clearState() { await fs.unlink(this.statePath); await syncDirectory(this.statePath) }

  preflight(stored) {
    if (stored.source.kind === "keychain") keychainCommand(stored.source, stored.raw)
  }

  async write(expected, credentials) {
    const current = await this.read()
    if (JSON.stringify(current.source) !== JSON.stringify(expected.source) || fingerprint(current.credentials) !== fingerprint(expected.credentials)) throw failure("source-changed")
    const root = JSON.parse(current.raw)
    Object.assign(Object.hasOwn(root, "claudeAiOauth") ? root.claudeAiOauth : root, parseCredentials(JSON.stringify(credentials)))
    if (current.source.kind === "file") await atomicJSON(current.source.path, root)
    else await this.security(["-i"], keychainCommand(current.source, JSON.stringify(root)))
    const verified = await this.read()
    if (JSON.stringify(verified.source) !== JSON.stringify(current.source) || fingerprint(verified.credentials) !== fingerprint(credentials)) throw failure("source-changed")
    return verified
  }
}
