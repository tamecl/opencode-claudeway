import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { credentialReader } from "../src/index.js"
import { compatibilityProbe, waitForOAuth, installTransportBudget } from "./diagnostics.mjs"

const budgets = process.argv.slice(2).filter(value => value.startsWith("--max-requests"))
const maximum = budgets.length === 0 ? 1 : budgets.length === 1 && /^--max-requests=[1-3]$/u.test(budgets[0]) ? Number(budgets[0].at(-1)) : 0

if (!process.argv.includes("--confirm")) {
  console.error("Requires --confirm: reads Claude Code credentials and sends a minimal Anthropic request; --max-requests=1..3 bounds all attempts. Never refreshes or writes the credential source.")
  process.exitCode = 2
} else if (!maximum) {
  console.error("Invalid request budget; use --max-requests=1, 2 or 3.")
  process.exitCode = 2
} else {
  const sandbox = await mkdtemp(join(tmpdir(), "claudeway-live-"))
  const originalEnvironment = { ...process.env }
  const read = credentialReader.read
  // The host is sandboxed, but the explicitly authorized reader needs the original credential environment.
  credentialReader.read = () => read(originalEnvironment, { renew: false })
  const keep = new Set(["path", "systemroot", "windir", "comspec", "pathext", "tmp", "temp", "tmpdir"])
  for (const key of Object.keys(process.env)) if (!keep.has(key.toLowerCase())) delete process.env[key]
  Object.assign(process.env, {
    HOME: sandbox, USERPROFILE: sandbox,
    XDG_CONFIG_HOME: join(sandbox, "config"), XDG_DATA_HOME: join(sandbox, "data"),
    XDG_CACHE_HOME: join(sandbox, "cache"), XDG_STATE_HOME: join(sandbox, "state"),
  })
  const result = { version: "2.0.29", stage: "initialize", success: false, requests: 0, status: null, category: null, hint: null, request: null, sourceModified: false, database: "memory" }
  let host
  let restoreTransport = () => {}
  try {
    restoreTransport = installTransportBudget(result, maximum)
    const { OpenCode } = await import("@opencode/sdk")
    host = await OpenCode.create({
      database: { path: ":memory:" },
      config: { directory: sandbox, project: false, content: JSON.stringify({ model: "anthropic/claude-haiku-4-5", providers: { anthropic: { settings: { timeout: 15_000, headerTimeout: 10_000, chunkTimeout: 10_000 } } } }) },
      models: { fetch: false, snapshot: true }, fs: { filewatcher: false, fff: false },
      plugins: [plugin, compatibilityProbe(result)], log: { level: "fatal", emit() {} },
    })
    const location = { directory: sandbox }
    const session = await host.sessions.create({ location })
    await host.sessions.generate({ sessionID: session.id, prompt: "Initialize without a connected account." }).catch(() => {})
    if (result.requests !== 0) throw new Error("Unexpected preflight request")
    result.request = null
    result.stage = "credentials"
    const attempt = await host.integration.oauth.connect({ location, integrationID: "anthropic", methodID: "claudeway" })
    await waitForOAuth(host.integration, { location, integrationID: "anthropic", attemptID: attempt.data.attemptID })
    result.stage = "request"
    await host.sessions.switchModel({ sessionID: session.id, model: { providerID: "anthropic", id: "claude-haiku-4-5" } })
    const response = await host.sessions.generate({ sessionID: session.id, prompt: "Reply with exactly OK." }, { signal: AbortSignal.timeout(60_000) })
    result.success = response.text.trim().toUpperCase() === "OK" && result.status === 200
  } catch (error) {
    // Never print host exceptions: they can carry a request, response or OAuth grant.
    result.category ??= ["missing", "invalid", "permission", "io", "keychain", "expired", "reader", "invalid-request", "request-limit", "missing-bearer", "unexpected-api-key", "oauth-incomplete", "oauth-timeout", "probe-budget", "probe-destination", "probe-auth-or-tokens"].includes(error?.code) ? error.code : `probe-${result.stage}-failed`
  } finally {
    await host?.close().catch(() => {})
    restoreTransport()
    credentialReader.read = read
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, originalEnvironment)
    await rm(sandbox, { recursive: true, force: true })
  }
  console.log(JSON.stringify(result))
  if (!result.success) process.exitCode = 1
}
