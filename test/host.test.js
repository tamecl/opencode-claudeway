import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { Host } from "@opencode/plugin/host"
import plugin, { credentialReader } from "opencode-claudeway"
import { compareRequest, compatibilityProbe, waitForOAuth, installTransportBudget } from "../scripts/diagnostics.mjs"
import { CredentialStore } from "../src/storage.js"
import { readCredentials, TOKEN_URL } from "../src/credentials.js"

const nativeFetch = globalThis.fetch
let transport = async () => { throw new Error("Network disabled in Claudeway tests") }
function responseFixture(toolName) {
  const events = [
    ["message_start", { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture response" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
    ["message_stop", { type: "message_stop" }],
  ]
  if (toolName) events.splice(4, 0,
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "fixture-tool", name: toolName, input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } }],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
  )
  return new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
}

const sandbox = await mkdtemp(join(tmpdir(), "claudeway-sdk-"))
const originalEnvironment = { ...process.env }
const keep = new Set(["path", "systemroot", "windir", "comspec", "pathext", "tmp", "temp", "tmpdir", "node_test_context"])
for (const key of Object.keys(process.env)) if (!keep.has(key.toLowerCase())) delete process.env[key]
Object.assign(process.env, {
  HOME: sandbox, USERPROFILE: sandbox,
  XDG_CONFIG_HOME: join(sandbox, "config"), XDG_DATA_HOME: join(sandbox, "data"),
  XDG_CACHE_HOME: join(sandbox, "cache"), XDG_STATE_HOME: join(sandbox, "state"),
})

test.after(async () => {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnvironment)
  await rm(sandbox, { recursive: true, force: true })
})

test("the real V2 host activates a native OAuth connection and dispatches through the HTTP hook", { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(sandbox, "host-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  t.mock.method(Socket.prototype, "connect", () => { throw new Error("Network disabled in Claudeway tests") })
  const read = t.mock.method(credentialReader, "read", async () => ({ accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: Date.now() + 120_000 }))
  const requests = []
  const diagnostics = { requests: 0 }
  const setup = t.mock.method(plugin, "setup", plugin.setup)
  transport = async (input, init) => {
    const request = new Request(input, init)
    assert.equal(new URL(request.url).origin, "https://api.anthropic.com")
    assert.equal(request.headers.get("authorization"), "Bearer fixture-access")
    const comparison = await compareRequest(request)
    assert.deepEqual(comparison, diagnostics.request)
    assert.equal(comparison.headers.anthropicVersion, true)
    assert.equal(comparison.headers.betaQuery, true)
    assert.equal(comparison.headers.apiKeyAbsent, true)
    assert.deepEqual(comparison.headers.missingBaseBetas, [])
    assert.deepEqual(comparison.headers.missingClientHeaders, [])
    assert.equal(comparison.body.billingFirst, true)
    assert.equal(comparison.body.identitySeparate, true)
    assert.equal(comparison.body.toolNamesPrefixed, true)
    assert.equal(request.bodyUsed, false)
    // V2 2.0.29 drops Request.redirect when rebuilding the native transport request.
    assert.equal(request.redirect, "follow")
    requests.push(await request.json())
    return responseFixture()
  }
  t.mock.method(globalThis, "fetch", (input, init) => transport(input, init))
  const { OpenCode } = await import("@opencode/sdk")
  const host = await OpenCode.create({
    database: { path: ":memory:" },
    config: { directory, project: false, content: JSON.stringify({ model: "anthropic/claude-haiku-4-5", providers: { anthropic: { settings: { timeout: 15_000, headerTimeout: 10_000, chunkTimeout: 10_000 } } } }) },
    models: { fetch: false, snapshot: true },
    fs: { filewatcher: false, fff: false },
    plugins: [plugin, compatibilityProbe(diagnostics)],
    log: { level: "error", emit() {} },
  })
  t.after(() => host.close())
  const location = { directory }
  const session = await host.sessions.create({ location })
  // The SDK starts location plugins on the first generation, not on registry reads.
  await host.sessions.generate({ sessionID: session.id, prompt: "Initialize offline fixture." }).catch(() => {})
  assert.equal(read.mock.callCount(), 0)
  assert.equal(diagnostics.requests, 0)
  const providers = await host.provider.list({ location })
  assert.ok(setup.mock.callCount() > 0, JSON.stringify(providers))
  const integration = await host.integration.get({ location, integrationID: "anthropic" })
  assert.ok(integration.data.methods.some(method => method.id === "claudeway"), JSON.stringify(integration.data))
  const attempt = await host.integration.oauth.connect({ location, integrationID: "anthropic", methodID: "claudeway" })
  await waitForOAuth(host.integration, { location, integrationID: "anthropic", attemptID: attempt.data.attemptID })
  const saved = await host.credential.list()
  assert.equal(saved[0].value.type, "oauth")
  assert.equal(saved[0].value.methodID, "claudeway")
  await host.sessions.switchModel({ sessionID: session.id, model: { providerID: "anthropic", id: "claude-haiku-4-5" } })
  const result = await host.sessions.generate({ sessionID: session.id, prompt: "Reply with a fixture response." })
  assert.equal(result.text, "fixture response")
  assert.equal(requests.length, 1)
  assert.equal(diagnostics.requests, 1)
  assert.equal(diagnostics.status, 200)
  assert.ok(!JSON.stringify(diagnostics).includes("fixture-access"))
})

test("the V2 host handles compatibility retries and restores fixture tool names within a strict transport budget", { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(sandbox, "compatibility-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  t.mock.method(Socket.prototype, "connect", () => { throw new Error("Network disabled in Claudeway tests") })
  t.mock.method(credentialReader, "read", async () => ({ accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: Date.now() + 3_600_000 }))
  const result = { requests: 0 }
  const bodies = []
  let restored = ""
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const request = new Request(input, init)
    assert.equal(request.redirect, "error")
    const raw = await request.text()
    bodies.push(raw)
    const body = JSON.parse(raw)
    assert.ok(body.tools.some(tool => tool.name === "mcp_FixtureEcho"))
    assert.equal(body.system.length, 2)
    if (bodies.length < 3) return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "You're out of extra usage" } }), { status: 400, headers: { "content-type": "application/json" } })
    assert.ok(!request.headers.get("anthropic-beta").includes("interleaved-thinking-2025-05-14"))
    return responseFixture("mcp_FixtureEcho")
  })
  const restoreTransport = installTransportBudget(result, 3)
  transport = globalThis.fetch
  const fixtureTools = { id: "claudeway.fixture-input", async setup(ctx) {
    await ctx.session.hook("http.request", async event => {
      const body = await event.request.clone().json()
      // Transient generation intentionally has no tools; inject only into this wire fixture.
      body.tools = [{ name: "fixtureEcho", description: "Fixture only", input_schema: { type: "object", properties: {} } }]
      event.request = new Request(event.request, { method: event.request.method, body: JSON.stringify(body) })
    }, { providerID: "anthropic" })
  } }
  const observer = { id: "claudeway.fixture-tools", async setup(ctx) {
    await ctx.session.hook("model.request", event => { event.headers["anthropic-beta"] = "context-1m-2025-08-07" }, { providerID: "anthropic" })
    await ctx.session.hook("http.response", async event => { if (event.response.ok) restored = await event.response.clone().text() }, { providerID: "anthropic" })
  } }
  let host
  try {
    const { OpenCode } = await import("@opencode/sdk")
    host = await OpenCode.create({ database: { path: ":memory:" }, config: { directory, project: false }, models: { fetch: false, snapshot: true }, fs: { filewatcher: false, fff: false }, plugins: [fixtureTools, plugin, observer, compatibilityProbe(result)], log: { level: "fatal", emit() {} } })
    const location = { directory }
    const session = await host.sessions.create({ location })
    await host.sessions.generate({ sessionID: session.id, prompt: "Initialize offline fixture." }).catch(() => {})
    const attempt = await host.integration.oauth.connect({ location, integrationID: "anthropic", methodID: "claudeway" })
    await waitForOAuth(host.integration, { location, integrationID: "anthropic", attemptID: attempt.data.attemptID })
    await host.sessions.switchModel({ sessionID: session.id, model: { providerID: "anthropic", id: "claude-haiku-4-5" } })
    const response = await host.sessions.generate({ sessionID: session.id, prompt: "Reply with a fixture response." })
    assert.equal(response.text, "fixture response")
    assert.equal(result.requests, 1)
    assert.equal(result.transportRequests, 3)
    assert.deepEqual(result.attempts.map(attempt => attempt.status), [400, 400, 200])
    assert.equal(result.category, null)
    assert.match(restored, /"name":"fixtureEcho"/u)
    assert.ok(bodies.every(body => body === bodies[0]))
    assert.ok(!JSON.stringify(result).includes("fixture-access"))
  } finally {
    await host?.close()
    restoreTransport()
  }
})

test("loads the JavaScript package through the V2 package loader and lists it as active", { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(sandbox, "package-"))
  t.mock.method(Socket.prototype, "connect", () => { throw new Error("Network disabled in Claudeway tests") })
  transport = async () => { throw new Error("Network disabled in Claudeway tests") }
  t.mock.method(globalThis, "fetch", (input, init) => transport(input, init))
  const root = fileURLToPath(new URL("../", import.meta.url))
  const entry = Host.resolve({ directory: root, name: "opencode-claudeway" })
  assert.ok(entry.server.replaceAll("\\", "/").endsWith("/src/index.js"))
  const loaded = await Host.load(entry.server)
  const { OpenCode } = await import("@opencode/sdk")
  const host = await OpenCode.create({
    database: { path: ":memory:" },
    config: { directory, project: false },
    models: { fetch: false, snapshot: true },
    fs: { filewatcher: false, fff: false },
    plugins: [loaded.default],
    log: { level: "error", emit() {} },
  })
  t.after(() => host.close())
  const location = { directory }
  const session = await host.sessions.create({ location })
  await host.sessions.generate({ sessionID: session.id, prompt: "Initialize offline fixture." }).catch(() => {})
  const plugins = await host.plugin.list({ location })
  assert.ok(plugins.data.some(item => item.id === plugin.id && item.state.status === "active"), JSON.stringify(plugins.data.filter(item => item.source.type !== "builtin")))
})

test("the native Fetch transport removes authorization on a cross-origin redirect", { timeout: 30_000 }, async t => {
  const received = []
  const fixtureBody = await responseFixture().text()
  async function listen(handler) {
    const server = createServer(handler)
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
    return server.address().port
  }
  const destination = await listen((request, response) => {
    received.push({ hop: "destination", authorization: request.headers.authorization })
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(fixtureBody)
  })
  const source = await listen((request, response) => {
    received.push({ hop: "source", authorization: request.headers.authorization })
    response.writeHead(307, { location: `http://127.0.0.1:${destination}/redirected` })
    response.end()
  })
  const connect = Socket.prototype.connect
  t.mock.method(Socket.prototype, "connect", function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0]
    if (options?.host !== "127.0.0.1" || ![source, destination].includes(Number(options.port))) throw new Error("Only fixture loopback connections are allowed")
    return Reflect.apply(connect, this, args)
  })
  t.mock.method(credentialReader, "read", async () => ({ accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: Date.now() + 120_000 }))
  transport = async (input, init) => {
    const request = new Request(input, init)
    assert.equal(new URL(request.url).origin, "https://api.anthropic.com")
    // Only the test transport maps the official URL onto local fixture servers.
    return nativeFetch(`http://127.0.0.1:${source}/v1/messages`, { method: request.method, headers: request.headers, body: await request.text(), redirect: request.redirect, signal: request.signal })
  }
  t.mock.method(globalThis, "fetch", (input, init) => transport(input, init))
  const { OpenCode } = await import("@opencode/sdk")
  const directory = await mkdtemp(join(sandbox, "redirect-"))
  const host = await OpenCode.create({ database: { path: ":memory:" }, config: { directory, project: false }, models: { fetch: false, snapshot: true }, fs: { filewatcher: false, fff: false }, plugins: [plugin], log: { level: "error", emit() {} } })
  t.after(() => host.close())
  const location = { directory }
  const session = await host.sessions.create({ location })
  await host.sessions.generate({ sessionID: session.id, prompt: "Initialize offline fixture." }).catch(() => {})
  const attempt = await host.integration.oauth.connect({ location, integrationID: "anthropic", methodID: "claudeway" })
  await waitForOAuth(host.integration, { location, integrationID: "anthropic", attemptID: attempt.data.attemptID })
  await host.sessions.switchModel({ sessionID: session.id, model: { providerID: "anthropic", id: "claude-sonnet-4-5" } })
  assert.equal((await host.sessions.generate({ sessionID: session.id, prompt: "Reply with a fixture response." })).text, "fixture response")
  assert.deepEqual(received, [{ hop: "source", authorization: "Bearer fixture-access" }, { hop: "destination", authorization: undefined }])
})

test("the V2 host stores a renewed OAuth grant and generates using the rotated fixture credentials", { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(sandbox, "renewal-host-"))
  const source = await mkdtemp(join(sandbox, "renewal-source-"))
  t.mock.method(Socket.prototype, "connect", () => { throw new Error("Network disabled in Claudeway tests") })
  const store = new CredentialStore({ env: { CLAUDE_CONFIG_DIR: source }, platform: "linux" })
  const initial = { accessToken: "fixture-old", refreshToken: "fixture-old-refresh", expiresAt: Date.now() - 1000 }
  const renewed = { accessToken: "fixture-new", refreshToken: "fixture-new-refresh", expiresAt: Date.now() + 3_600_000 }
  await writeFile(join(source, ".credentials.json"), JSON.stringify(initial), { mode: 0o600 })
  t.mock.method(credentialReader, "read", (_env, options) => readCredentials(store, options))
  let exchanges = 0
  let generations = 0
  transport = async (input, init) => {
    const request = new Request(input, init)
    if (request.url === TOKEN_URL) {
      assert.equal(request.redirect, "error")
      const body = new URLSearchParams(await request.text())
      assert.equal(body.get("refresh_token"), initial.refreshToken)
      assert.equal(++exchanges, 1)
      return new Response(JSON.stringify({ access_token: renewed.accessToken, refresh_token: renewed.refreshToken, expires_at: renewed.expiresAt }), { headers: { "content-type": "application/json" } })
    }
    assert.equal(new URL(request.url).origin, "https://api.anthropic.com")
    assert.equal(request.headers.get("authorization"), "Bearer " + renewed.accessToken)
    generations++
    return responseFixture()
  }
  t.mock.method(globalThis, "fetch", (input, init) => transport(input, init))
  const { OpenCode } = await import("@opencode/sdk")
  const diagnostics = { requests: 0 }
  const host = await OpenCode.create({ database: { path: ":memory:" }, config: { directory, project: false }, models: { fetch: false, snapshot: true }, fs: { filewatcher: false, fff: false }, plugins: [plugin, compatibilityProbe(diagnostics)], log: { level: "fatal", emit() {} } })
  try {
    const location = { directory }
    const session = await host.sessions.create({ location })
    await host.sessions.generate({ sessionID: session.id, prompt: "Initialize offline fixture." }).catch(() => {})
    const attempt = await host.integration.oauth.connect({ location, integrationID: "anthropic", methodID: "claudeway" })
    await waitForOAuth(host.integration, { location, integrationID: "anthropic", attemptID: attempt.data.attemptID })
    const saved = await host.credential.list()
    assert.equal(saved[0].value.access, renewed.accessToken)
    assert.equal(saved[0].value.refresh, renewed.refreshToken)
    assert.equal(saved[0].value.expires, renewed.expiresAt)
    await host.sessions.switchModel({ sessionID: session.id, model: { providerID: "anthropic", id: "claude-haiku-4-5" } })
    assert.equal((await host.sessions.generate({ sessionID: session.id, prompt: "Fixture prompt." })).text, "fixture response")
    assert.equal(exchanges, 1)
    assert.equal(generations, 1)
    assert.equal(diagnostics.status, 200)
    assert.equal((await store.readState()).phase, "receipt")
  } finally { await host.close() }
})
