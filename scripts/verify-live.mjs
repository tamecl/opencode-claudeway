import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../dist/index.js"

if (!process.argv.includes("--confirm")) {
  console.error("Requires --confirm: reads Claude Code credentials and sends one minimal request to Anthropic; never refreshes or writes the credential source.")
  process.exitCode = 2
} else {
  const sandbox = await mkdtemp(join(tmpdir(), "claudeway-live-"))
  const originalEnvironment = { ...process.env }
  const keep = new Set(["path", "systemroot", "windir", "comspec", "pathext", "tmp", "temp", "tmpdir"])
  for (const key of Object.keys(process.env)) if (!keep.has(key.toLowerCase())) delete process.env[key]
  Object.assign(process.env, {
    HOME: sandbox, USERPROFILE: sandbox,
    XDG_CONFIG_HOME: join(sandbox, "config"), XDG_DATA_HOME: join(sandbox, "data"),
    XDG_CACHE_HOME: join(sandbox, "cache"), XDG_STATE_HOME: join(sandbox, "state"),
  })
  const result = { version: "2.0.29", success: false, requests: 0, status: null, category: null, hint: null, sourceModified: false, database: "memory" }
  let host
  let stage = "initialize"
  try {
    const { OpenCode } = await import("@opencode/sdk")
    const probe = {
      id: "claudeway.compatibility-probe",
      async setup(ctx) {
        await ctx.session.hook("generate", event => { event.options.maxTokens = 8 }, { providerID: "anthropic" })
        await ctx.session.hook("retry", event => { event.decision = { retry: false } }, { providerID: "anthropic" })
        await ctx.session.hook("http.request", event => {
          if (new URL(event.request.url).origin !== "https://api.anthropic.com" || result.requests !== 0) throw new Error("Probe request budget or origin rejected")
          result.requests++
        }, { providerID: "anthropic" })
        await ctx.session.hook("http.response", async event => {
          result.status = event.response.status
          if (!event.response.ok) {
            const data = await event.response.clone().json().catch(() => ({}))
            const category = data?.error?.type
            if (["invalid_request_error", "authentication_error", "permission_error", "not_found_error", "rate_limit_error", "overloaded_error", "api_error"].includes(category)) result.category = category
            const message = typeof data?.error?.message === "string" ? data.error.message : ""
            if (/only authorized.*Claude Code/i.test(message)) result.hint = "claude-code-only"
            else if (/OAuth.*not supported/i.test(message)) result.hint = "oauth-not-supported"
            else if (/extra usage/i.test(message)) result.hint = "extra-usage"
            else if (/expired/i.test(message)) result.hint = "expired"
          }
        }, { providerID: "anthropic" })
      },
    }
    host = await OpenCode.create({
      database: { path: ":memory:" },
      config: { directory: sandbox, project: false, content: JSON.stringify({ model: "anthropic/claude-haiku-4-5", providers: { anthropic: { settings: { timeout: 15_000, headerTimeout: 10_000, chunkTimeout: 10_000 } } } }) },
      models: { fetch: false, snapshot: true }, fs: { filewatcher: false, fff: false },
      plugins: [plugin, probe], log: { level: "fatal", emit() {} },
    })
    const location = { directory: sandbox }
    const session = await host.sessions.create({ location })
    await host.sessions.generate({ sessionID: session.id, prompt: "Initialize without a connected account." }).catch(() => {})
    if (result.requests !== 0) throw new Error("Unexpected preflight request")
    stage = "credentials"
    const attempt = await host.integration.oauth.connect({ location, integrationID: "anthropic", methodID: "claudeway" })
    await host.integration.oauth.status({ location, integrationID: "anthropic", attemptID: attempt.data.attemptID })
    stage = "request"
    await host.sessions.switchModel({ sessionID: session.id, model: { providerID: "anthropic", id: "claude-haiku-4-5" } })
    const response = await host.sessions.generate({ sessionID: session.id, prompt: "Reply with exactly OK." }, { signal: AbortSignal.timeout(20_000) })
    result.success = response.text.trim().toUpperCase() === "OK" && result.status === 200
  } catch (error) {
    // Never print host exceptions: they can carry a request, response or OAuth grant.
    result.category ??= ["missing", "invalid", "permission", "io", "keychain"].includes(error?.code) ? error.code : `probe-${stage}-failed`
  } finally {
    await host?.close().catch(() => {})
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, originalEnvironment)
    await rm(sandbox, { recursive: true, force: true })
  }
  console.log(JSON.stringify(result))
  if (!result.success) process.exitCode = 1
}
