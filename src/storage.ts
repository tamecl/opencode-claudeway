import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export interface Credentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export type CredentialSource =
  | { kind: "file"; path: string }
  | { kind: "keychain"; service: string; account: string }

export interface StoredCredentials {
  source: CredentialSource
  credentials: Credentials
}

export class StorageError extends Error {
  constructor(readonly code: "missing" | "invalid" | "permission" | "io" | "keychain", message: string) {
    super(message)
    this.name = "StorageError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function parseCredentials(raw: string): Credentials {
  try {
    const root: unknown = JSON.parse(raw)
    if (!isRecord(root)) throw new Error()
    const value = Object.hasOwn(root, "claudeAiOauth") ? root.claudeAiOauth : root
    if (!isRecord(value)) throw new Error()
    const { accessToken, refreshToken, expiresAt } = value
    if (
      typeof accessToken !== "string" || !accessToken || /[^\x21-\x7e]/u.test(accessToken) ||
      typeof refreshToken !== "string" || !refreshToken || /[^\x21-\x7e]/u.test(refreshToken) ||
      typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0
    ) throw new Error()
    return { accessToken, refreshToken, expiresAt }
  } catch {
    throw new StorageError("invalid", "Invalid Claude Code credentials; the source was not modified.")
  }
}

function security(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/security", args, { encoding: "utf8", timeout: 2_000, maxBuffer: 1_048_576 }, (error, stdout) => {
      // Never propagate subprocess stdout/stderr: either may contain credentials.
      if (error) reject({ code: error.code })
      else resolve(stdout.trim())
    })
  })
}

interface StoreOptions {
  configDir?: string
  platform?: NodeJS.Platform
  customConfigDir?: boolean
  security?: (args: string[]) => Promise<string>
  readFile?: (path: string) => Promise<string>
}

export class CredentialStore {
  private readonly configDir: string
  private readonly platform: NodeJS.Platform
  private readonly service: string
  private readonly security: (args: string[]) => Promise<string>
  private readonly readFile: (path: string) => Promise<string>

  constructor(options: StoreOptions = {}) {
    this.configDir = options.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
    this.platform = options.platform ?? process.platform
    const custom = options.customConfigDir ?? process.env.CLAUDE_CONFIG_DIR !== undefined
    this.service = "Claude Code-credentials" + (custom ? `-${createHash("sha256").update(this.configDir).digest("hex").slice(0, 8)}` : "")
    this.security = options.security ?? security
    this.readFile = options.readFile ?? (path => readFile(path, "utf8"))
  }

  async read(): Promise<StoredCredentials> {
    if (this.platform === "darwin") {
      let raw: string | undefined
      try {
        raw = await this.security(["find-generic-password", "-s", this.service, "-w"])
      } catch (error) {
        if ((error as { code?: unknown })?.code !== 44) {
          throw new StorageError("keychain", "Cannot access the Claude Code Keychain item; unlock it or check its permissions.")
        }
      }
      if (raw !== undefined) {
        const credentials = parseCredentials(raw)
        let account: string
        try {
          const info = await this.security(["find-generic-password", "-s", this.service])
          const match = /"acct"<blob>="((?:\\.|[^"\\])*)"/u.exec(info)
          if (!match) throw new Error()
          account = JSON.parse(`"${match[1]}"`) as string
          if (!account) throw new Error()
        } catch {
          throw new StorageError("keychain", "Cannot identify the Claude Code Keychain account.")
        }
        return { source: { kind: "keychain", service: this.service, account }, credentials }
      }
    }

    const path = join(this.configDir, ".credentials.json")
    let raw: string
    try {
      raw = await this.readFile(path)
    } catch (error) {
      const code = (error as { code?: unknown })?.code
      if (code === "ENOENT") throw new StorageError("missing", "Claude Code credentials not found; sign in with Claude Code first.")
      if (code === "EACCES" || code === "EPERM") throw new StorageError("permission", "Permission denied reading Claude Code credentials.")
      throw new StorageError("io", "Cannot read Claude Code credentials.")
    }
    return { source: { kind: "file", path }, credentials: parseCredentials(raw) }
  }
}
