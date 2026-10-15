import assert from "node:assert/strict"
import { mock, test } from "node:test"
import plugin from "opencode-claudeway"
import { CredentialStore } from "../dist/storage.js"

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
  const read = t.mock.method(CredentialStore.prototype, "read", async () => { throw new Error("must not read at setup") })
  const fixture = context()
  assert.equal(plugin.id, "opencode-claudeway")
  await plugin.setup(fixture.ctx)
  assert.equal(read.mock.callCount(), 0)
  assert.equal(fixture.registrations[0].integrationID, "anthropic")
  assert.deepEqual(fixture.registrations[0].method, { id: "claudeway", type: "oauth", label: "Claude Code credentials (Claudeway)" })
  assert.deepEqual(fixture.hooks.get("http.request").options, { providerID: "anthropic" })
})

test("attaches credentials only to the official destination and requests redirect rejection", async t => {
  t.mock.method(CredentialStore.prototype, "read", async () => ({ source: { kind: "file", path: "/fixture" }, credentials: { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: Date.now() + 120_000 } }))
  const fixture = context()
  await plugin.setup(fixture.ctx)
  for (const kind of ["primary", "title", "compaction", "generate"]) {
    const event = { kind, model: { providerID: "anthropic", id: "fixture" }, request: new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}", headers: { "x-api-key": "old-key" } }) }
    await fixture.hooks.get("http.request").callback(event)
    assert.equal(event.request.headers.get("authorization"), "Bearer fixture-access")
    assert.equal(event.request.headers.has("x-api-key"), false)
    assert.equal(event.request.redirect, "error")
  }
})

test("rejects custom origins before reading or attaching credentials", async t => {
  const read = t.mock.method(CredentialStore.prototype, "read", async () => { throw new Error("must not read") })
  const fixture = context()
  await plugin.setup(fixture.ctx)
  for (const url of ["http://api.anthropic.com/v1/messages", "https://api.anthropic.com.evil.test/v1/messages", "https://api.anthropic.com:444/v1/messages", "https://api.anthropic.com/api/other"]) {
    await assert.rejects(fixture.hooks.get("http.request").callback({ model: { providerID: "anthropic" }, request: new Request(url) }), /destination/)
  }
  assert.equal(read.mock.callCount(), 0)
})

test("does not change API keys, other connections, or other providers", async t => {
  const read = t.mock.method(CredentialStore.prototype, "read", async () => { throw new Error("must not read") })
  for (const credential of [undefined, { type: "key", key: "fixture-key" }, { type: "oauth", methodID: "another-plugin" }, { type: "external", methodID: "claudeway" }]) {
    const fixture = context(credential ?? null)
    await plugin.setup(fixture.ctx)
    const request = new Request("https://custom.test/v1/messages")
    const event = { model: { providerID: "anthropic" }, request }
    await fixture.hooks.get("http.request").callback(event)
    assert.equal(event.request, request)
  }
  const fixture = context()
  await plugin.setup(fixture.ctx)
  await fixture.hooks.get("http.request").callback({ model: { providerID: "openai" }, request: new Request("https://custom.test") })
  assert.equal(read.mock.callCount(), 0)
})

test("refuses an expired token instead of faking a successful authentication", async t => {
  t.mock.method(CredentialStore.prototype, "read", async () => ({ credentials: { accessToken: "fixture", expiresAt: 1 } }))
  const fixture = context()
  await plugin.setup(fixture.ctx)
  await assert.rejects(fixture.hooks.get("http.request").callback({ model: { providerID: "anthropic" }, request: new Request("https://api.anthropic.com/v1/messages") }), /expired/)
})

test.after(() => mock.restoreAll())
