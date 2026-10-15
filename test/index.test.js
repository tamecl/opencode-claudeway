import assert from "node:assert/strict"
import { mock, test } from "node:test"
import plugin, { credentialReader } from "opencode-claudeway"

const body = JSON.stringify({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "fixture prompt" }] })

function context(credential = { type: "oauth", methodID: "claudeway" }) {
  const hooks = new Map()
  const registrations = []
  return {
    hooks, registrations,
    ctx: {
      integration: {
        transform: async callback => callback({ method: { update: input => registrations.push(input) } }),
        connection: {
          active: async () => credential ? { type: "credential", id: "fixture", method: credential.type } : undefined,
          resolve: async () => credential,
        },
      },
      session: { hook: async (name, callback, options) => hooks.set(name, { callback, options }) },
    },
  }
}

test("exports a V2 definition and registers an explicit native connection without reading secrets", async t => {
  const read = t.mock.method(credentialReader, "read", async () => { throw new Error("must not read at setup") })
  const fixture = context()
  assert.equal(plugin.id, "opencode-claudeway")
  await plugin.setup(fixture.ctx)
  assert.equal(read.mock.callCount(), 0)
  assert.equal(fixture.registrations[0].integrationID, "anthropic")
  assert.deepEqual(fixture.registrations[0].method, { id: "claudeway", type: "oauth", label: "Claude Code credentials (Claudeway)" })
  assert.deepEqual(fixture.hooks.get("http.request").options, { providerID: "anthropic" })
})

test("attaches credentials only to the official destination and requests redirect rejection", async t => {
  t.mock.method(credentialReader, "read", async () => ({ accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: Date.now() + 120_000 }))
  const fixture = context()
  await plugin.setup(fixture.ctx)
  for (const kind of ["primary", "title", "compaction", "generate"]) {
    const event = { kind, model: { providerID: "anthropic", id: "fixture" }, request: new Request("https://api.anthropic.com/v1/messages", { method: "POST", body, headers: { "x-api-key": "old-key" } }) }
    await fixture.hooks.get("http.request").callback(event)
    assert.equal(event.request.headers.get("authorization"), "Bearer fixture-access")
    assert.equal(event.request.headers.has("x-api-key"), false)
    assert.equal(event.request.redirect, "error")
  }
})

test("the HTTP hook preserves native system updates through consecutive Claude 5.5 turns", async t => {
  t.mock.method(credentialReader, "read", async () => ({ accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: Date.now() + 120_000 }))
  const fixture = context()
  await plugin.setup(fixture.ctx)
  for (const model of ["claude-sonnet-5-5", "claude-haiku-5-5"]) {
    const messages = [{ role: "user", content: "hey" }]
    for (let turn = 0; turn < 3; turn++) {
      const event = { kind: "primary", model: { providerID: "anthropic", id: model }, request: new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify({ model, messages }) }) }
      await fixture.hooks.get("http.request").callback(event)
      assert.equal(event.request.headers.get("authorization"), "Bearer fixture-access")
      assert.deepEqual((await event.request.json()).messages, messages)
      messages.push({ role: "assistant", content: "fixture reply" }, { role: "user", content: "continue" }, { role: "system", content: [{ type: "text", text: "fixture update" }] }, { role: "system", content: [], output_config: { effort: "high" } })
    }
  }
})

test("rejects custom origins before reading or attaching credentials", async t => {
  const read = t.mock.method(credentialReader, "read", async () => { throw new Error("must not read") })
  const fixture = context()
  await plugin.setup(fixture.ctx)
  for (const url of ["http://api.anthropic.com/v1/messages", "https://api.anthropic.com.evil.test/v1/messages", "https://api.anthropic.com:444/v1/messages", "https://api.anthropic.com/api/other", "https://user:password@api.anthropic.com/v1/messages"]) {
    await assert.rejects(fixture.hooks.get("http.request").callback({ model: { providerID: "anthropic" }, request: { url } }), /destination/)
  }
  assert.equal(read.mock.callCount(), 0)
})

test("does not change API keys, other connections, or other providers", async t => {
  const read = t.mock.method(credentialReader, "read", async () => { throw new Error("must not read") })
  for (const credential of [undefined, { type: "key", key: "fixture-key" }, { type: "oauth", methodID: "another-plugin" }, { type: "external", methodID: "claudeway" }]) {
    const fixture = context(credential ?? null)
    await plugin.setup(fixture.ctx)
    const request = new Request("https://custom.test/v1/messages")
    const event = { model: { providerID: "anthropic" }, request }
    await fixture.hooks.get("http.request").callback(event)
    assert.equal(event.request, request)
    const response = new Response('{"error":{"message":"You\'re out of extra usage"}}', { status: 429 })
    const received = { request, response }
    await fixture.hooks.get("http.response").callback(received)
    assert.equal(received.response, response)
    const retry = { error: { status: 429, response: { body: "extra usage" } }, decision: { retry: true, delay: 10 } }
    await fixture.hooks.get("retry").callback(retry)
    assert.deepEqual(retry.decision, { retry: true, delay: 10 })
  }
  const fixture = context()
  await plugin.setup(fixture.ctx)
  await fixture.hooks.get("http.request").callback({ model: { providerID: "openai" }, request: new Request("https://custom.test") })
  assert.equal(read.mock.callCount(), 0)
})

test("compatibility errors stop host retries only for the selected Claudeway account", async () => {
  const fixture = context()
  await plugin.setup(fixture.ctx)
  const retry = { error: { status: 400, response: { body: "You're out of extra usage" } }, decision: { retry: true, delay: 10 } }
  await fixture.hooks.get("retry").callback(retry)
  assert.deepEqual(retry.decision, { retry: false })
  for (const status of [401, 500]) {
    retry.error.status = status
    retry.decision = { retry: true, delay: 10 }
    await fixture.hooks.get("retry").callback(retry)
    assert.deepEqual(retry.decision, { retry: true, delay: 10 })
  }
})

test("a 401 with a Claudeway token asks for a new token instead of a generic error", async t => {
  t.mock.method(credentialReader, "read", async () => ({ accessToken: "fixture-access", refreshToken: "fixture-access", expiresAt: Date.now() + 120_000, fixed: true }))
  const fixture = context()
  await plugin.setup(fixture.ctx)
  const event = { model: { providerID: "anthropic", id: "fixture" }, request: new Request("https://api.anthropic.com/v1/messages", { method: "POST", body }) }
  await fixture.hooks.get("http.request").callback(event)
  await assert.rejects(fixture.hooks.get("http.response").callback({ request: event.request, response: new Response("{}", { status: 401 }) }), /setup-token/)
})

test("propagates a credential-reader failure instead of faking successful authentication", async t => {
  t.mock.method(credentialReader, "read", async () => { throw Object.assign(new Error("Claude Code credentials are expired"), { code: "expired" }) })
  const fixture = context()
  await plugin.setup(fixture.ctx)
  await assert.rejects(fixture.hooks.get("http.request").callback({ model: { providerID: "anthropic" }, request: new Request("https://api.anthropic.com/v1/messages", { method: "POST", body }) }), /expired/)
})

test("imports credentials through the native OAuth callback and uses the same reader on refresh", async t => {
  const read = t.mock.method(credentialReader, "read", async () => ({ accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: 2_000_000_000_000 }))
  const fixture = context()
  await plugin.setup(fixture.ctx)
  const method = fixture.registrations[0]
  const authorization = await method.authorize()
  assert.equal(authorization.mode, "auto")
  const expected = { type: "oauth", methodID: "claudeway", access: "fixture-access", refresh: "fixture-refresh", expires: 2_000_000_000_000 }
  assert.deepEqual(await authorization.callback, expected)
  assert.deepEqual(await method.refresh(), expected)
  assert.equal(read.mock.callCount(), 2)
})

test.after(() => mock.restoreAll())
