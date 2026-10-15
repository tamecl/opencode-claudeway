import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { Host } from "@opencode/plugin/host"
import plugin from "opencode-claudeway"
import { CredentialStore } from "../dist/storage.js"

const nativeFetch = globalThis.fetch
let transport = async () => { throw new Error("Network disabled in Claudeway tests") }
function responseFixture() {
  const events = [
    ["message_start", { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture response" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
    ["message_stop", { type: "message_stop" }],
  ]
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
  t.mock.method(CredentialStore.prototype, "read", async () => ({ source: { kind: "file", path: "/fixture" }, credentials: { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: Date.now() + 120_000 } }))
  const requests = []
  const setup = t.mock.method(plugin, "setup", plugin.setup)
  transport = async (input, init) => {
    const request = new Request(input, init)
    assert.equal(new URL(request.url).origin, "https://api.anthropic.com")
    assert.equal(request.headers.get("authorization"), "Bearer fixture-access")
    // V2 2.0.29 drops Request.redirect when rebuilding the native transport request.
    assert.equal(request.redirect, "follow")
    requests.push(await request.json())
    return responseFixture()
  }
  t.mock.method(globalThis, "fetch", (input, init) => transport(input, init))
  const { OpenCode } = await import("@opencode/sdk")
  const host = await OpenCode.create({
    database: { path: ":memory:" },
    config: { directory, project: false },
    models: { fetch: false, snapshot: true },
    fs: { filewatcher: false, fff: false },
    plugins: [plugin],
    log: { level: "error", emit() {} },
  })
  t.after(() => host.close())
  const location = { directory }
  const session = await host.sessions.create({ location })
  // The SDK starts location plugins on the first generation, not on registry reads.
  await host.sessions.generate({ sessionID: session.id, prompt: "Initialize offline fixture." }).catch(() => {})
  const providers = await host.provider.list({ location })
  assert.ok(setup.mock.callCount() > 0, JSON.stringify(providers))
  const integration = await host.integration.get({ location, integrationID: "anthropic" })
  assert.ok(integration.data.methods.some(method => method.id === "claudeway"), JSON.stringify(integration.data))
  const attempt = await host.integration.oauth.connect({ location, integrationID: "anthropic", methodID: "claudeway" })
  await host.integration.oauth.status({ location, integrationID: "anthropic", attemptID: attempt.data.attemptID })
  const saved = await host.credential.list()
  assert.equal(saved[0].value.type, "oauth")
  assert.equal(saved[0].value.methodID, "claudeway")
  await host.sessions.switchModel({ sessionID: session.id, model: { providerID: "anthropic", id: "claude-sonnet-4-5" } })
  const result = await host.sessions.generate({ sessionID: session.id, prompt: "Reply with a fixture response." })
  assert.equal(result.text, "fixture response")
  assert.equal(requests.length, 1)
})

test("loads the built package through the V2 package loader and lists it as active", { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(sandbox, "package-"))
  t.mock.method(Socket.prototype, "connect", () => { throw new Error("Network disabled in Claudeway tests") })
  transport = async () => { throw new Error("Network disabled in Claudeway tests") }
  t.mock.method(globalThis, "fetch", (input, init) => transport(input, init))
  const root = fileURLToPath(new URL("../", import.meta.url))
  const entry = Host.resolve({ directory: root, name: "opencode-claudeway" })
  assert.ok(entry.server.replaceAll("\\", "/").endsWith("/dist/index.js"))
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
  t.mock.method(CredentialStore.prototype, "read", async () => ({ source: { kind: "file", path: "/fixture" }, credentials: { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: Date.now() + 120_000 } }))
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
  await host.integration.oauth.status({ location, integrationID: "anthropic", attemptID: attempt.data.attemptID })
  await host.sessions.switchModel({ sessionID: session.id, model: { providerID: "anthropic", id: "claude-sonnet-4-5" } })
  assert.equal((await host.sessions.generate({ sessionID: session.id, prompt: "Reply with a fixture response." })).text, "fixture response")
  assert.deepEqual(received, [{ hop: "source", authorization: "Bearer fixture-access" }, { hop: "destination", authorization: undefined }])
})
