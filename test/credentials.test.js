import assert from "node:assert/strict"
import childProcess from "node:child_process"
import * as fs from "node:fs/promises"
import { createServer } from "node:http"
import { Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { test } from "node:test"
import { readCredentials, parseOAuthResponse, TOKEN_URL } from "../src/credentials.js"
import { CredentialStore, fingerprint, hash } from "../src/storage.js"

const secret = "fixture-secret"
const nativeFetch = globalThis.fetch
const safeError = code => error => error.code === code && !error.message.includes(secret) && !JSON.stringify(error).includes(secret)
const response = (data, status = 200, headers) => new Response(JSON.stringify(data), { status, headers })
const next = () => ({ accessToken: "fixture-new-access", refreshToken: "fixture-rotated-refresh", expiresAt: Date.now() + 3_600_000 })
const oauth = value => ({ access_token: value.accessToken, refresh_token: value.refreshToken, expires_at: value.expiresAt })

async function fixture(t, remaining = 60_000) {
  const directory = await fs.mkdtemp(join(tmpdir(), "claudeway-renewal-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const path = join(directory, ".credentials.json")
  const current = { accessToken: "fixture-old-access", refreshToken: "fixture-old-refresh", expiresAt: Date.now() + remaining }
  const store = new CredentialStore({ env: { CLAUDE_CONFIG_DIR: directory }, platform: "linux" })
  await fs.writeFile(path, JSON.stringify({ claudeAiOauth: { ...current, scopes: ["fixture-scope"] }, metadata: "keep" }), { mode: 0o600 })
  return { directory, path, store, current }
}

test("accepts only validated OAuth tokens and future absolute or relative expiry", () => {
  const now = 1_000_000_000_000
  assert.deepEqual(parseOAuthResponse({ access_token: "fixture-access", expires_in: 3600 }, "fixture-refresh", now), { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: now + 3_600_000 })
  assert.equal(parseOAuthResponse({ access_token: "fixture-access", refresh_token: "rotated", expires_at: now + 600_000, expires_in: 9999 }, "old", now).expiresAt, now + 600_000)
  assert.equal(parseOAuthResponse({ access_token: "fixture-access", expires_at: 1000, expires_in: 600 }, "old", now).expiresAt, now + 600_000)
  for (const value of [null, [], {}, { access_token: secret }, { access_token: secret, expires_in: "3600" }, { access_token: secret, expires_in: 60 }, { access_token: secret, expires_in: 1e30 }, { access_token: secret, refresh_token: null, expires_in: 3600 }, { access_token: secret + "\n", expires_in: 3600 }]) assert.throws(() => parseOAuthResponse(value, "old", now), safeError("refresh-uncertain"))
})

test("fresh credentials require no network, lock, journal or source writes", async t => {
  const { directory, path, store, current } = await fixture(t, 3_600_000)
  const send = t.mock.method(globalThis, "fetch", () => assert.fail("must not send"))
  const before = await fs.stat(path)
  assert.deepEqual(await readCredentials(store), current)
  assert.equal(send.mock.callCount(), 0)
  assert.deepEqual(await fs.readdir(directory), [".credentials.json"])
  assert.equal((await fs.stat(path)).mtimeMs, before.mtimeMs)
})

test("read-only diagnostics retain the exact sixty-second boundary and never renew", async t => {
  const { directory, store, path, current } = await fixture(t)
  const now = Date.now()
  t.mock.method(Date, "now", () => now)
  t.mock.method(globalThis, "fetch", () => assert.fail("must not send"))
  for (const remaining of [-1, 0, 59_999, 60_000, 60_001]) {
    const credentials = { ...current, expiresAt: now + remaining }
    await fs.writeFile(path, JSON.stringify(credentials))
    if (remaining > 60_000) assert.deepEqual(await readCredentials(store, { renew: false }), credentials)
    else await assert.rejects(readCredentials(store, { renew: false }), safeError("expired"))
  }
  assert.deepEqual(await fs.readdir(directory), [".credentials.json"])
})

test("renews on demand with one fixed-destination request and persists rotation without losing metadata", async t => {
  const { store, current, path, directory } = await fixture(t, -1)
  const renewed = next()
  const send = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, TOKEN_URL)
    assert.equal(init.method, "POST")
    assert.equal(init.redirect, "error")
    assert.equal(init.headers["content-type"], "application/x-www-form-urlencoded")
    assert.deepEqual(Object.fromEntries(init.body), { grant_type: "refresh_token", client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e", refresh_token: current.refreshToken })
    assert.equal((await store.readState()).phase, "inflight")
    return response(oauth(renewed))
  })
  assert.deepEqual(await readCredentials(store), renewed)
  assert.deepEqual(await readCredentials(store), renewed)
  assert.equal(send.mock.callCount(), 1)
  assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")), { claudeAiOauth: { ...renewed, scopes: ["fixture-scope"] }, metadata: "keep" })
  const state = await fs.readFile(store.statePath, "utf8")
  assert.ok(!state.includes(renewed.accessToken) && !state.includes(renewed.refreshToken))
  assert.equal(JSON.parse(state).phase, "receipt")
  assert.equal((await fs.stat(store.statePath)).mode & 0o777, 0o600)
  assert.deepEqual((await fs.readdir(directory)).sort(), [".claudeway-refresh.json", ".credentials.json"])
})

test("a Claudeway token is used as-is without renewal, locks, journal or Claude Code credentials", async t => {
  const { directory, path, store } = await fixture(t, -1)
  await fs.writeFile(store.tokenPath, "fixture-static\n", { mode: 0o600 })
  const send = t.mock.method(globalThis, "fetch", () => assert.fail("must not send"))
  for (const options of [undefined, { renew: false }]) {
    const value = await readCredentials(store, options)
    assert.equal(value.accessToken, "fixture-static")
    assert.equal(value.fixed, true)
  }
  assert.equal(send.mock.callCount(), 0)
  assert.deepEqual((await fs.readdir(directory)).sort(), [".claudeway-token", ".credentials.json"])
  assert.equal(JSON.parse(await fs.readFile(path, "utf8")).claudeAiOauth.accessToken, "fixture-old-access")
})

test("concurrent callers share exactly one renewal", async t => {
  const { store } = await fixture(t)
  const renewed = next()
  const send = t.mock.method(globalThis, "fetch", async () => { await new Promise(resolve => setTimeout(resolve, 30)); return response(oauth(renewed)) })
  const results = await Promise.all(Array.from({ length: 8 }, () => readCredentials(store)))
  assert.ok(results.every(value => value.accessToken === renewed.accessToken))
  assert.equal(send.mock.callCount(), 1)
})

test("renewal begins at the exact five-minute boundary", async t => {
  const now = Date.now()
  t.mock.method(Date, "now", () => now)
  const renewed = next()
  const send = t.mock.method(globalThis, "fetch", async () => response(oauth(renewed)))
  const fresh = await fixture(t, 300_001)
  assert.deepEqual(await readCredentials(fresh.store), fresh.current)
  assert.equal(send.mock.callCount(), 0)
  const due = await fixture(t, 300_000)
  assert.deepEqual(await readCredentials(due.store), renewed)
  assert.equal(send.mock.callCount(), 1)
})

test("separate processes serialize renewal and reuse the durable receipt", { timeout: 15_000 }, async t => {
  const { directory, store } = await fixture(t)
  const count = join(directory, "requests")
  const script = join(directory, "fixture.mjs")
  const credentialsURL = new URL("../src/credentials.js", import.meta.url).href
  const storageURL = new URL("../src/storage.js", import.meta.url).href
  await fs.writeFile(script, `
    import { readCredentials } from ${JSON.stringify(credentialsURL)}
    import { CredentialStore } from ${JSON.stringify(storageURL)}
    import { appendFile } from 'node:fs/promises'
    globalThis.fetch = async () => {
      await appendFile(${JSON.stringify(count)}, 'sent\\n')
      await new Promise(resolve => setTimeout(resolve, 200))
      return new Response(JSON.stringify({access_token:'fixture-new',refresh_token:'fixture-rotated',expires_in:3600}))
    }
    const store = new CredentialStore({env:{CLAUDE_CONFIG_DIR:${JSON.stringify(directory)}},platform:'linux'})
    const value = await readCredentials(store)
    if(value.accessToken!=='fixture-new') throw new Error('fixture mismatch')
    console.log('ok')
  `)
  const execute = promisify(childProcess.execFile)
  const results = await Promise.all([execute(process.execPath, [script]), execute(process.execPath, [script])])
  assert.ok(results.every(result => result.stdout.trim() === "ok" && result.stderr === ""))
  assert.equal(await fs.readFile(count, "utf8"), "sent\n")
  assert.equal((await store.read()).credentials.accessToken, "fixture-new")
})

test("terminal rejection is sanitized and not retried for the same refresh token", async t => {
  const { store, path } = await fixture(t)
  const raw = await fs.readFile(path, "utf8")
  const send = t.mock.method(globalThis, "fetch", async () => response({ error: "invalid_grant", error_description: secret }, 400))
  for (let index = 0; index < 2; index++) await assert.rejects(readCredentials(store), safeError("refresh-rejected"))
  assert.equal(send.mock.callCount(), 1)
  assert.equal(await fs.readFile(path, "utf8"), raw)
  assert.equal(await store.readState(), null)
})

test("explicit rate limits use cooldown without leaving an uncertain renewal marker", async t => {
  const { store } = await fixture(t)
  const send = t.mock.method(globalThis, "fetch", async () => response({ error: "temporarily_unavailable", error_description: secret }, 429, { "retry-after": "60" }))
  for (let index = 0; index < 2; index++) await assert.rejects(readCredentials(store), safeError("refresh-unavailable"))
  assert.equal(send.mock.callCount(), 1)
  assert.equal(await store.readState(), null)
})

test("network failures and malformed success responses prevent replay of the uncertain refresh token", async t => {
  for (const kind of ["network", "malformed", "invalid", "server"]) {
    const { store, path, current } = await fixture(t)
    const send = t.mock.method(globalThis, "fetch", async () => {
      if (kind === "network") throw new Error(secret)
      if (kind === "malformed") return new Response("{" + secret)
      if (kind === "server") return response({}, 500)
      return response({ access_token: secret, expires_in: -1 })
    })
    await assert.rejects(readCredentials(store), safeError("refresh-uncertain"))
    // Changing only access/expiry must not make the old refresh token safe to reuse.
    await fs.writeFile(path, JSON.stringify({ ...current, accessToken: "fixture-other-access", expiresAt: Date.now() + 120_000 }))
    await assert.rejects(readCredentials(store), safeError("refresh-uncertain"))
    assert.equal(send.mock.callCount(), 1)
    assert.equal((await store.readState()).phase, "inflight")
  }
})

test("the OAuth timeout is bounded and its unknown outcome cannot be retried", async t => {
  const { store } = await fixture(t)
  const timeout = AbortSignal.timeout
  t.mock.method(AbortSignal, "timeout", milliseconds => { assert.equal(milliseconds, 15_000); return timeout(5) })
  const send = t.mock.method(globalThis, "fetch", (_url, init) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(response(oauth(next()))), 1000)
    init.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error(secret)) }, { once: true })
  }))
  for (let index = 0; index < 2; index++) await assert.rejects(readCredentials(store), safeError("refresh-uncertain"))
  assert.equal(send.mock.callCount(), 1)
})

test("OAuth redirects are blocked by native Fetch using only loopback fixtures", async t => {
  const { store } = await fixture(t)
  let destinationRequests = 0
  async function listen(handler) {
    const server = createServer(handler)
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
    return server.address().port
  }
  const destination = await listen((_request, reply) => { destinationRequests++; reply.end("must not arrive") })
  const source = await listen((_request, reply) => { reply.writeHead(307, { location: `http://127.0.0.1:${destination}/redirected` }); reply.end() })
  const connect = Socket.prototype.connect
  t.mock.method(Socket.prototype, "connect", function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0]
    if (options?.host !== "127.0.0.1" || ![source, destination].includes(Number(options.port))) throw new Error("Only fixture loopback connections are allowed")
    return Reflect.apply(connect, this, args)
  })
  const send = t.mock.method(globalThis, "fetch", (url, init) => {
    assert.equal(url, TOKEN_URL)
    return nativeFetch(`http://127.0.0.1:${source}/token`, init)
  })
  for (let index = 0; index < 2; index++) await assert.rejects(readCredentials(store), safeError("refresh-uncertain"))
  assert.equal(send.mock.callCount(), 1)
  assert.equal(destinationRequests, 0)
})

test("a fresh sign-in can clear an uncertain marker without overwriting its new credentials", async t => {
  const { store, path } = await fixture(t)
  const send = t.mock.method(globalThis, "fetch", async () => { throw new Error(secret) })
  await assert.rejects(readCredentials(store), safeError("refresh-uncertain"))
  const signedIn = next()
  await fs.writeFile(path, JSON.stringify(signedIn))
  assert.deepEqual(await readCredentials(store), signedIn)
  assert.equal(send.mock.callCount(), 1)
  assert.equal(await store.readState(), null)
})

test("a fresh sign-in may change the Keychain account locator without retaining an unusable uncertain marker", async t => {
  const { store } = await fixture(t, 3_600_000)
  const current = await store.read()
  await store.writeState({ version: 1, phase: "inflight", source: hash("old-account-locator"), previous: hash("old-credentials"), refresh: hash("old-refresh") })
  const send = t.mock.method(globalThis, "fetch", () => assert.fail("must not send"))
  assert.deepEqual(await readCredentials(store), current.credentials)
  assert.equal(await store.readState(), null)
  assert.equal(send.mock.callCount(), 0)
})

test("failed source persistence leaves a private recovery record and never refreshes again", async t => {
  const { store, directory } = await fixture(t)
  const renewed = next()
  const send = t.mock.method(globalThis, "fetch", async () => response(oauth(renewed)))
  const write = t.mock.method(store, "write", async () => { throw new Error(secret) })
  await assert.rejects(readCredentials(store), safeError("recovery-pending"))
  assert.equal((await store.readState()).phase, "pending")
  assert.deepEqual((await store.readState()).credentials, renewed)
  assert.equal((await fs.stat(store.statePath)).mode & 0o777, 0o600)
  write.mock.restore()
  const restarted = new CredentialStore({ env: { CLAUDE_CONFIG_DIR: directory }, platform: "linux" })
  assert.deepEqual(await readCredentials(restarted), renewed)
  assert.equal(send.mock.callCount(), 1)
  assert.equal((await store.readState()).phase, "receipt")
})

test("a failed pending-journal write keeps the result in memory and blocks another exchange", async t => {
  const { store } = await fixture(t)
  const renewed = next()
  const send = t.mock.method(globalThis, "fetch", async () => response(oauth(renewed)))
  const original = store.writeState.bind(store)
  const write = t.mock.method(store, "writeState", async state => {
    if (state.phase === "pending") throw new Error(secret)
    await original(state)
  })
  await assert.rejects(readCredentials(store), safeError("recovery-pending"))
  assert.equal((await store.readState()).phase, "inflight")
  write.mock.restore()
  assert.deepEqual(await readCredentials(store), renewed)
  assert.equal(send.mock.callCount(), 1)
})

test("a failed final receipt is recovered without rewriting or refreshing a verified source", async t => {
  const { store } = await fixture(t)
  const renewed = next()
  const send = t.mock.method(globalThis, "fetch", async () => response(oauth(renewed)))
  const original = store.writeState.bind(store)
  const write = t.mock.method(store, "writeState", async state => {
    if (state.phase === "receipt") throw new Error(secret)
    await original(state)
  })
  await assert.rejects(readCredentials(store), safeError("recovery-pending"))
  assert.deepEqual((await store.read()).credentials, renewed)
  write.mock.restore()
  const sourceWrite = t.mock.method(store, "write", () => assert.fail("already persisted"))
  assert.deepEqual(await readCredentials(store), renewed)
  assert.equal(sourceWrite.mock.callCount(), 0)
  assert.equal(send.mock.callCount(), 1)
})

test("account changes during renewal are not overwritten and retain recovery data", async t => {
  const { store, path } = await fixture(t)
  const switched = { ...next(), accessToken: "fixture-other-account", refreshToken: "fixture-other-refresh" }
  const renewed = next()
  t.mock.method(globalThis, "fetch", async () => { await fs.writeFile(path, JSON.stringify(switched)); return response(oauth(renewed)) })
  await assert.rejects(readCredentials(store), safeError("source-changed"))
  assert.deepEqual((await store.read()).credentials, switched)
  assert.deepEqual((await store.readState()).credentials, renewed)
  await assert.rejects(readCredentials(store), safeError("source-changed"))
})

test("read/lock races with an unrecognized account change abort before any network request", async t => {
  const { store, path } = await fixture(t)
  const original = store.read.bind(store)
  let reads = 0
  t.mock.method(store, "read", async () => {
    if (++reads === 2) await fs.writeFile(path, JSON.stringify(next()))
    return original()
  })
  const send = t.mock.method(globalThis, "fetch", () => assert.fail("must not send"))
  await assert.rejects(readCredentials(store), safeError("source-changed"))
  assert.equal(send.mock.callCount(), 0)
})

test("unsafe recovery destinations fail before token rotation", async t => {
  const { store, path } = await fixture(t)
  await fs.symlink(path, store.statePath)
  const send = t.mock.method(globalThis, "fetch", () => assert.fail("must not send"))
  await assert.rejects(readCredentials(store), safeError("permission"))
  assert.equal(send.mock.callCount(), 0)
})

test("an unwritable initial journal fails before any OAuth exchange", async t => {
  const { store } = await fixture(t)
  t.mock.method(store, "writeState", async () => { throw Object.assign(new Error(secret), { code: "EACCES" }) })
  const send = t.mock.method(globalThis, "fetch", () => assert.fail("must not send"))
  await assert.rejects(readCredentials(store), safeError("io"))
  assert.equal(send.mock.callCount(), 0)
})

test("Keychain renewal preserves metadata and updates only the selected service/account through stdin", async t => {
  const { directory, current } = await fixture(t)
  let root = { claudeAiOauth: { ...current, scopes: ["keep"] }, unrelated: 'quotes"\\😀' }
  const writes = []
  const run = async (args, input) => {
    if (args.includes("Claudeway-token")) throw Object.assign(new Error("missing"), { code: 44 })
    if (args[0] === "-i") {
      assert.deepEqual(args, ["-i"])
      const command = input.match(/"(?:\\.|[^"\\])*"/gu).map(value => JSON.parse(value))
      assert.deepEqual(command.slice(0, 7), ["add-generic-password", "-U", "-s", store.service, "-a", "fixture-account", "-w"])
      root = JSON.parse(command[7])
      writes.push(command)
      return ""
    }
    assert.deepEqual(args.slice(0, 3), ["find-generic-password", "-s", store.service])
    return args.includes("-w") ? JSON.stringify(root) : '"acct"<blob>="fixture-account"'
  }
  const store = new CredentialStore({ env: { CLAUDE_CONFIG_DIR: directory }, platform: "darwin", security: run })
  const renewed = next()
  const send = t.mock.method(globalThis, "fetch", async () => response(oauth(renewed)))
  assert.deepEqual(await readCredentials(store), renewed)
  assert.equal(send.mock.callCount(), 1)
  assert.equal(writes.length, 1)
  assert.deepEqual(root, { claudeAiOauth: { ...renewed, scopes: ["keep"] }, unrelated: 'quotes"\\😀' })
  assert.equal((await store.readState()).phase, "receipt")
})

test("oversized existing Keychain blobs are rejected before renewal", async t => {
  const { directory, current } = await fixture(t)
  const raw = JSON.stringify({ claudeAiOauth: current, extra: "é".repeat(4096) })
  const store = new CredentialStore({ env: { CLAUDE_CONFIG_DIR: directory }, platform: "darwin", security: async args => {
    if (args.includes("Claudeway-token")) throw Object.assign(new Error("missing"), { code: 44 })
    assert.notEqual(args[0], "-i")
    return args.includes("-w") ? raw : '"acct"<blob>="fixture-account"'
  } })
  const send = t.mock.method(globalThis, "fetch", () => assert.fail("must not send"))
  await assert.rejects(readCredentials(store), safeError("keychain-limit"))
  assert.equal(send.mock.callCount(), 0)
  assert.equal(await store.readState(), null)
})

test("unexpectedly large rotated tokens remain recoverable instead of truncating Keychain data", async t => {
  const { directory, current } = await fixture(t)
  const raw = JSON.stringify(current)
  const store = new CredentialStore({ env: { CLAUDE_CONFIG_DIR: directory }, platform: "darwin", security: async args => {
    if (args.includes("Claudeway-token")) throw Object.assign(new Error("missing"), { code: 44 })
    assert.notEqual(args[0], "-i", "oversized commands must never reach security")
    return args.includes("-w") ? raw : '"acct"<blob>="fixture-account"'
  } })
  const renewed = { ...next(), accessToken: "a".repeat(3000), refreshToken: "r".repeat(3000) }
  const send = t.mock.method(globalThis, "fetch", async () => response(oauth(renewed)))
  await assert.rejects(readCredentials(store), safeError("recovery-pending"))
  assert.deepEqual((await store.readState()).credentials, renewed)
  await assert.rejects(readCredentials(store), safeError("keychain-limit"))
  assert.equal(send.mock.callCount(), 1)
})

test("a pending journal survives across process restarts and contains only expected source hashes", async t => {
  const { store, current, directory } = await fixture(t)
  const renewed = next()
  const stored = await store.read()
  await store.writeState({ version: 1, phase: "pending", source: hash(JSON.stringify(stored.source)), previous: fingerprint(current), refresh: hash(current.refreshToken), next: fingerprint(renewed), credentials: renewed })
  const script = join(directory, "recover.mjs")
  await fs.writeFile(script, `
    import { readCredentials } from ${JSON.stringify(new URL("../src/credentials.js", import.meta.url).href)}
    import { CredentialStore, fingerprint } from ${JSON.stringify(new URL("../src/storage.js", import.meta.url).href)}
    globalThis.fetch = () => { throw new Error('No network allowed in recovery fixture') }
    const value = await readCredentials(new CredentialStore({env:{CLAUDE_CONFIG_DIR:${JSON.stringify(directory)}},platform:'linux'}))
    if(fingerprint(value)!==${JSON.stringify(fingerprint(renewed))}) throw new Error('fixture mismatch')
    console.log('recovered')
  `)
  const result = await promisify(childProcess.execFile)(process.execPath, [script])
  assert.equal(result.stdout.trim(), "recovered")
  assert.equal(result.stderr, "")
  assert.equal((await store.readState()).phase, "receipt")
  assert.deepEqual((await store.read()).credentials, renewed)
})

test("the standalone verifier opts out of renewal explicitly", async () => {
  const raw = await fs.readFile(fileURLToPath(new URL("../scripts/verify-live.mjs", import.meta.url)), "utf8")
  assert.match(raw, /read\(originalEnvironment, \{ renew: false \}\)/u)
})

test("renewal fails closed on Windows until private recovery-file ACLs are supported", async t => {
  const { store } = await fixture(t)
  const original = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: "win32" })
  t.after(() => Object.defineProperty(process, "platform", original))
  const send = t.mock.method(globalThis, "fetch", () => assert.fail("must not send"))
  await assert.rejects(readCredentials(store), safeError("unsupported-platform"))
  assert.equal(send.mock.callCount(), 0)
  assert.equal(await store.readState(), null)
})
