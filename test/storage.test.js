import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { CredentialStore, parseCredentials } from "../dist/storage.js"

const credentials = { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: 2_000_000_000_000 }

test("validates credential blobs without including their contents in errors", () => {
  assert.deepEqual(parseCredentials(JSON.stringify({ claudeAiOauth: credentials })), credentials)
  assert.deepEqual(parseCredentials(JSON.stringify(credentials)), credentials)
  for (const value of ["", "{secret", "null", "[]", "0", '{}', JSON.stringify({ ...credentials, claudeAiOauth: null }), JSON.stringify({ ...credentials, expiresAt: "soon" }), JSON.stringify({ ...credentials, expiresAt: -1 }), JSON.stringify({ ...credentials, accessToken: "" })]) {
    assert.throws(() => parseCredentials(value), /Invalid Claude Code credentials/)
  }
})

test("reads only the selected credentials file, including paths with spaces", async t => {
  const configDir = await mkdtemp(join(tmpdir(), "claudeway fixture "))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const path = join(configDir, ".credentials.json")
  await writeFile(path, JSON.stringify({ claudeAiOauth: credentials, unrelated: true }))
  const result = await new CredentialStore({ configDir, platform: "linux" }).read()
  assert.deepEqual(result, { source: { kind: "file", path }, credentials })
})

test("distinguishes absent, malformed and inaccessible files", async t => {
  const configDir = await mkdtemp(join(tmpdir(), "claudeway-missing-"))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const store = new CredentialStore({ configDir, platform: "linux" })
  await assert.rejects(store.read(), { code: "missing" })
  await writeFile(join(configDir, ".credentials.json"), "null")
  await assert.rejects(store.read(), { code: "invalid" })
  const denied = new CredentialStore({ configDir, platform: "linux", readFile: async () => { throw Object.assign(new Error("secret"), { code: "EACCES" }) } })
  await assert.rejects(denied.read(), error => error.code === "permission" && !error.message.includes("secret"))
})

test("macOS reads a specific Keychain item without scanning accounts or invoking a shell", async () => {
  const calls = []
  const store = new CredentialStore({
    configDir: "/fixture/claude", platform: "darwin", customConfigDir: true,
    security: async args => {
      calls.push(args)
      return args.includes("-w") ? JSON.stringify({ claudeAiOauth: credentials }) : '"acct"<blob>="fixture-account"'
    },
  })
  const result = await store.read()
  assert.equal(result.source.kind, "keychain")
  assert.equal(result.source.account, "fixture-account")
  assert.match(result.source.service, /^Claude Code-credentials-[a-f0-9]{8}$/)
  assert.equal(calls.length, 2)
  assert.ok(calls.every(args => args[0] === "find-generic-password"))
})

test("macOS falls back only for a missing Keychain item, not access denial", async t => {
  const configDir = await mkdtemp(join(tmpdir(), "claudeway-keychain-"))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  await writeFile(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: credentials }))
  const options = { configDir, platform: "darwin", customConfigDir: true }
  const missing = new CredentialStore({ ...options, security: async () => { throw Object.assign(new Error(), { code: 44 }) } })
  assert.equal((await missing.read()).source.kind, "file")
  const denied = new CredentialStore({ ...options, security: async () => { throw Object.assign(new Error("fixture-secret"), { code: 36 }) } })
  await assert.rejects(denied.read(), error => error.code === "keychain" && !error.message.includes("fixture-secret"))
})
