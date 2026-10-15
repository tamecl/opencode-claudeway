import assert from "node:assert/strict"
import childProcess from "node:child_process"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { test } from "node:test"
import { CredentialStore, atomicJSON, hash, keychainCommand, parseCredentials, readBounded, security, withFileLock } from "../src/storage.js"
import { credentialReader } from "opencode-claudeway"

const credentials = { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: 2_000_000_000_000 }
const safeError = code => error => error.code === code && !JSON.stringify(error).includes("fixture-secret") && !error.message.includes("fixture-secret")

async function fixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), "claudeway-storage-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const store = new CredentialStore({ env: { CLAUDE_CONFIG_DIR: directory }, platform: "linux" })
  const path = join(directory, ".credentials.json")
  await fs.writeFile(path, JSON.stringify({ claudeAiOauth: credentials, unrelated: true }))
  return { directory, store, path }
}

test("validates plain and wrapped credentials without exposing malformed contents", () => {
  for (const value of [credentials, { claudeAiOauth: credentials }]) assert.deepEqual(parseCredentials(JSON.stringify(value)), credentials)
  const invalid = ["", "{fixture-secret", "null", "[]", "0", "{}", '{"unrelated": NaN}', JSON.stringify({ ...credentials, claudeAiOauth: null })]
  for (const [key, values] of Object.entries({ accessToken: ["", "fixture-secret\n", "has space", "unicode-é", 123, null], refreshToken: ["", "fixture-secret\r", false], expiresAt: ["soon", -1, 0, true, 1.5, 2**53, null] })) for (const value of values) invalid.push(JSON.stringify({ ...credentials, [key]: value }))
  for (const raw of invalid) assert.throws(() => parseCredentials(raw), safeError("invalid"))
})

test("reads only the selected file and preserves its contents and timestamp", async t => {
  const { store, path } = await fixture(t)
  const before = await fs.stat(path)
  const raw = await fs.readFile(path, "utf8")
  const result = await store.read()
  assert.deepEqual(result, { source: { kind: "file", path }, credentials, raw })
  assert.equal(await fs.readFile(path, "utf8"), raw)
  assert.equal((await fs.stat(path)).mtimeMs, before.mtimeMs)
  await fs.writeFile(path, "{fixture-secret")
  await assert.rejects(store.read(), safeError("invalid"))
  await fs.unlink(path)
  await assert.rejects(store.read(), safeError("missing"))
})

test("preserves the exact config-directory hash and selects only one Keychain item", async () => {
  const directory = "/fixture/claude config/../selected"
  const calls = []
  const run = async args => {
    calls.push(args)
    return args.includes("-w") ? JSON.stringify({ claudeAiOauth: credentials }) : '"acct"<blob>="fixture\\\"account"'
  }
  const store = new CredentialStore({ env: { CLAUDE_CONFIG_DIR: directory }, platform: "darwin", security: run })
  assert.equal(store.configDir, directory)
  assert.equal(store.service, "Claude Code-credentials-" + hash(directory).slice(0, 8))
  const result = await store.read()
  assert.deepEqual(result.credentials, credentials)
  assert.deepEqual(result.source, { kind: "keychain", service: store.service, account: 'fixture"account' })
  assert.deepEqual(calls, [["find-generic-password", "-s", store.service, "-w"], ["find-generic-password", "-s", store.service]])
  const ordinary = new CredentialStore({ env: { HOME: "/fixture/home" }, platform: "darwin", security: run })
  assert.equal(ordinary.configDir, "/fixture/home/.claude")
  assert.equal(ordinary.service, "Claude Code-credentials")
})

test("falls back from Keychain only for a missing item, never invalid data or denied access", async t => {
  const { directory } = await fixture(t)
  for (const code of [44, 36, "ETIMEDOUT", "ENOENT"]) {
    const store = new CredentialStore({ env: { CLAUDE_CONFIG_DIR: directory }, platform: "darwin", security: async () => { throw Object.assign(new Error("fixture-secret"), { code }) } })
    if (code === 44) assert.deepEqual((await store.read()).credentials, credentials)
    else await assert.rejects(store.read(), safeError("keychain"))
  }
  for (const [raw, metadata, code] of [["fixture-secret", "", "invalid"], [JSON.stringify(credentials), "fixture-secret", "keychain"], [JSON.stringify(credentials), '"acct"<blob>=""', "keychain"]]) {
    const store = new CredentialStore({ env: { CLAUDE_CONFIG_DIR: directory }, platform: "darwin", security: async args => args.includes("-w") ? raw : metadata })
    await assert.rejects(store.read(), safeError(code))
  }
})

test("reads the Claudeway token only from its own private file or Keychain item", async t => {
  const { directory, store } = await fixture(t)
  assert.equal(await store.readStatic(), null)
  await fs.writeFile(store.tokenPath, "fixture-static\n", { mode: 0o644 })
  await assert.rejects(store.readStatic(), safeError("permission"))
  await fs.chmod(store.tokenPath, 0o600)
  const value = await store.readStatic()
  assert.deepEqual({ ...value, expiresAt: 0 }, { accessToken: "fixture-static", refreshToken: "fixture-static", expiresAt: 0, fixed: true })
  assert.ok(value.expiresAt > Date.now())
  await fs.writeFile(store.tokenPath, "has space", { mode: 0o600 })
  await assert.rejects(store.readStatic(), safeError("invalid"))
  const calls = []
  const keychain = code => new CredentialStore({ env: { CLAUDE_CONFIG_DIR: directory }, platform: "darwin", security: async args => { calls.push(args); if (code) throw Object.assign(new Error("fixture-secret"), { code }); return "fixture-static" } })
  assert.equal((await keychain().readStatic()).accessToken, "fixture-static")
  assert.deepEqual(calls, [["find-generic-password", "-s", "Claudeway-token", "-w"]])
  assert.equal(await keychain(44).readStatic(), null)
  await assert.rejects(keychain(36).readStatic(), safeError("keychain"))
})

test("Keychain commands use an absolute executable, captured pipes, timeout and no shell or secrets in argv", async t => {
  let input = ""
  const execute = t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    assert.equal(command, "/usr/bin/security")
    assert.deepEqual(args, ["-i"])
    assert.equal(options.timeout, 2_000)
    assert.equal(options.maxBuffer, 1_048_576)
    assert.equal(options.shell, undefined)
    const stdin = new PassThrough()
    stdin.on("data", chunk => { input += chunk })
    queueMicrotask(() => callback(null, "fixture response\n", "fixture-secret"))
    return { stdin }
  })
  const command = keychainCommand({ service: "fixture-service", account: 'fixture"account' }, JSON.stringify({ accessToken: "fixture-secret", text: "quotes\"\\\n😀" }))
  assert.equal(await security(["-i"], command), "fixture response")
  assert.equal(input, command)
  assert.equal(execute.mock.callCount(), 1)
  assert.ok(!JSON.stringify(execute.mock.calls[0].arguments.slice(0, 3)).includes("fixture-secret"))
  assert.ok(command.includes('fixture\\"account'))
  assert.throws(() => keychainCommand({ service: "fixture", account: "unsafe\naccount" }, "{}"), safeError("keychain"))
  assert.throws(() => keychainCommand({ service: "fixture", account: "account" }, "é".repeat(4096)), safeError("keychain-limit"))
})

test("subprocess failures expose no raw output, stderr or exceptions", async t => {
  for (const code of [44, 36, "ETIMEDOUT"]) {
    t.mock.method(childProcess, "execFile", (_command, _args, _options, callback) => callback(Object.assign(new Error("fixture-secret"), { code, stdout: "fixture-secret" }), "fixture-secret", "fixture-secret"))
    await assert.rejects(security([]), safeError(code === 44 ? 44 : "keychain"))
  }
  t.mock.method(childProcess, "execFile", () => { throw new Error("fixture-secret") })
  await assert.rejects(security([]), safeError("keychain"))
})

test("atomic updates preserve unrelated metadata and create private files", async t => {
  const { store, path } = await fixture(t)
  const before = await store.read()
  const next = { ...credentials, accessToken: "fixture-new", refreshToken: "fixture-rotated" }
  assert.deepEqual((await store.write(before, next)).credentials, next)
  assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")), { claudeAiOauth: next, unrelated: true })
  assert.equal((await fs.stat(path)).mode & 0o777, 0o600)
  assert.deepEqual((await fs.readdir(store.configDir)).filter(name => name.endsWith(".tmp")), [])
})

test("refuses source changes and symlinks instead of overwriting another account", async t => {
  const { store, path, directory } = await fixture(t)
  const before = await store.read()
  const switched = { ...credentials, accessToken: "fixture-other-account" }
  await fs.writeFile(path, JSON.stringify(switched))
  await assert.rejects(store.write(before, credentials), safeError("source-changed"))
  assert.deepEqual((await store.read()).credentials, switched)
  await fs.symlink(path, join(directory, "symlink"))
  await assert.rejects(readBounded(join(directory, "symlink")), safeError("permission"))
  await assert.rejects(atomicJSON(join(directory, "symlink"), credentials), safeError("permission"))
  await fs.writeFile(store.statePath, "{}", { mode: 0o644 })
  await assert.rejects(readBounded(store.statePath, true), safeError("permission"))
})

test("file locks serialize operations, reclaim dead owners and never steal live or unknown locks", async t => {
  const { store } = await fixture(t)
  const seen = []
  await Promise.all([withFileLock(store.lockPath, async () => { seen.push(1); await new Promise(resolve => setTimeout(resolve, 20)); seen.push(2) }), withFileLock(store.lockPath, async () => { seen.push(3) })])
  assert.deepEqual([...seen].sort(), [1, 2, 3])
  assert.equal(seen.indexOf(2), seen.indexOf(1) + 1)
  await fs.writeFile(store.lockPath, JSON.stringify({ pid: process.pid }), { mode: 0o600 })
  await assert.rejects(withFileLock(store.lockPath, () => assert.fail("must not enter"), 0), safeError("refresh-busy"))
  await fs.writeFile(store.lockPath, "{}")
  await assert.rejects(withFileLock(store.lockPath, () => assert.fail("must not enter"), 0), safeError("refresh-busy"))
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("fixture-secret"), { code: "ESRCH" }) })
  await fs.writeFile(store.lockPath, JSON.stringify({ pid: 12345 }))
  assert.equal(await withFileLock(store.lockPath, () => "reclaimed"), "reclaimed")
})

test("the public JS reader needs no interpreter and supports explicitly read-only diagnostics", async t => {
  const { directory } = await fixture(t)
  t.mock.method(childProcess, "execFile", () => assert.fail("no subprocess for file credentials"))
  t.mock.method(CredentialStore.prototype, "readStatic", async () => null)
  const read = t.mock.method(CredentialStore.prototype, "read", async function () {
    assert.equal(this.configDir, directory)
    return { source: { kind: "file", path: join(directory, ".credentials.json") }, credentials, raw: JSON.stringify(credentials) }
  })
  assert.deepEqual(await credentialReader.read({ CLAUDE_CONFIG_DIR: directory }, { renew: false }), credentials)
  assert.equal(read.mock.callCount(), 1)
})
