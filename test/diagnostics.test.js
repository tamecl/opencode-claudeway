import assert from "node:assert/strict"
import { test } from "node:test"
import { compareRequest, compatibilityProbe, waitForOAuth, installTransportBudget } from "../scripts/diagnostics.mjs"

const secret = "fixture-secret"

// Synthetic structure from the pinned upstream; the billing marker is not a computed signature.
function referenceRequest() {
  return new Request("https://api.anthropic.com/v1/messages?beta=true", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`, "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,context-management-2025-06-27,advisor-tool-2026-03-01,thinking-token-count-2026-05-13,extended-cache-ttl-2025-04-11",
      "anthropic-dangerous-direct-browser-access": "true", "x-app": "cli",
      "user-agent": "claude-cli/2.1.280 (external, sdk-cli)",
      "x-client-request-id": secret, "x-claude-code-session-id": secret,
      "x-stainless-arch": "arm64", "x-stainless-lang": "js", "x-stainless-os": "MacOS",
      "x-stainless-package-version": "0.81.0", "x-stainless-retry-count": "0",
      "x-stainless-runtime": "node", "x-stainless-runtime-version": "v24.12.0", "x-stainless-timeout": "600",
      [`x-${secret}`]: secret,
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5", max_tokens: 8,
      system: [
        { type: "text", text: `x-anthropic-billing-header: ${secret}` },
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      ],
      messages: [{ role: "user", content: secret }],
      tools: [{ name: "mcp_Read", input_schema: { type: "object" } }],
    }),
  })
}

async function probeFixture() {
  const hooks = new Map()
  const result = { requests: 0, status: null, category: null, hint: null, request: null }
  await compatibilityProbe(result).setup({ session: { hook: async (name, callback, options) => {
    assert.deepEqual(options, { providerID: "anthropic" })
    hooks.set(name, callback)
  } } })
  return { hooks, result }
}

test("compares a pinned reference fixture without leaking headers, prompts, IDs or credentials", async () => {
  const request = referenceRequest()
  const original = await request.clone().text()
  const report = await compareRequest(request)
  assert.equal(report.reference, "opencode-claude-auth@2.2.1#8aad811a4da3813ab3985063e656fed582909780")
  assert.deepEqual(report.headers, {
    bearer: true, apiKeyAbsent: true, anthropicVersion: true, betaQuery: true,
    missingBaseBetas: [], missingClientHeaders: [], cliApp: true, claudeUserAgent: true, directBrowserAccess: true,
  })
  assert.deepEqual(report.body, { json: true, billingFirst: true, identitySeparate: true, toolNamesPrefixed: true })
  assert.equal(request.bodyUsed, false)
  assert.equal(await request.text(), original)
  assert.ok(!JSON.stringify(report).includes(secret))
})

test("reports exact missing reference fields without modifying the request or echoing unknown values", async () => {
  const request = new Request(`https://api.anthropic.com/v1/messages?beta=${secret}&other=${secret}`, referenceRequest())
  request.headers.set("anthropic-beta", request.headers.get("anthropic-beta").split(",").filter(beta => !["claude-code-20250219", "oauth-2025-04-20"].includes(beta)).concat(secret, "oauth-2025-04-20-other").join(", "))
  request.headers.set("x-api-key", secret)
  request.headers.set("anthropic-version", secret)
  request.headers.delete("x-app")
  request.headers.set("user-agent", secret)
  request.headers.set("anthropic-dangerous-direct-browser-access", "false")
  const report = await compareRequest(request)
  assert.deepEqual(report.headers.missingBaseBetas, ["claude-code-20250219", "oauth-2025-04-20"])
  assert.deepEqual(report.headers.missingClientHeaders, ["x-app"])
  for (const key of ["apiKeyAbsent", "anthropicVersion", "betaQuery", "cliApp", "claudeUserAgent", "directBrowserAccess"]) assert.equal(report.headers[key], false)
  assert.equal(request.headers.get("x-api-key"), secret)
  assert.equal(request.bodyUsed, false)
  assert.ok(!JSON.stringify(report).includes(secret))
})

test("does not confuse HTTP billing headers or combined identity text with upstream body markers", async () => {
  const headers = { "x-anthropic-billing-header": secret }
  const body = JSON.stringify({
    system: [{ type: "text", text: `You are Claude Code, Anthropic's official CLI for Claude.\n${secret}` }],
    tools: [{ name: "read" }],
  })
  const report = await compareRequest(new Request("https://api.anthropic.com/v1/messages", { method: "POST", headers, body }))
  assert.deepEqual(report.body, { json: true, billingFirst: false, identitySeparate: false, toolNamesPrefixed: false })
  assert.ok(!JSON.stringify(report).includes(secret))
})

test("handles malformed or non-object request bodies without consuming or exposing them", async () => {
  for (const body of [secret, "null", "[]", JSON.stringify(secret)]) {
    const request = new Request("https://api.anthropic.com/v1/messages", { method: "POST", body })
    const report = await compareRequest(request)
    assert.deepEqual(report.body, { json: false, billingFirst: false, identitySeparate: false, toolNamesPrefixed: null })
    assert.equal(request.bodyUsed, false)
    assert.ok(!JSON.stringify(report).includes(secret))
  }
})

test("classifies response hints using only allowlisted categories and never consumes the response", async () => {
  const cases = [
    [401, "authentication_error", "This credential is only authorized for use with Claude Code", "claude-code-only"],
    [400, "invalid_request_error", "OAuth authentication is not supported", "oauth-not-supported"],
    [401, "authentication_error", "Invalid API key: OAuth token has expired", "expired"],
    [401, "authentication_error", "OAuth token has been revoked", "revoked"],
    [401, "authentication_error", "Invalid access token", "invalid-token"],
    [401, "authentication_error", "Invalid API key", "invalid-api-key"],
    [400, "invalid_request_error", "Missing required anthropic-beta header", "beta-header"],
    [403, "permission_error", "Insufficient OAuth scope", "insufficient-scope"],
    [429, "rate_limit_error", "You're out of extra usage", "extra-usage"],
  ]
  for (const [status, category, message, hint] of cases) {
    const { hooks, result } = await probeFixture()
    const response = new Response(JSON.stringify({ error: { type: category, message: `${message}: ${secret}` }, accessToken: secret, prompt: secret }), { status })
    await hooks.get("http.response")({ response })
    assert.equal(result.status, status)
    assert.equal(result.category, category)
    assert.equal(result.hint, hint)
    assert.equal(response.bodyUsed, false)
    assert.ok(!JSON.stringify(result).includes(secret))
  }
})

test("does not guess a 401 cause or echo malformed, unknown or successful response bodies", async () => {
  for (const body of [secret, "null", JSON.stringify(secret), JSON.stringify({ error: { type: secret, message: secret } }), JSON.stringify({ error: { message: { accessToken: secret } } })]) {
    const { hooks, result } = await probeFixture()
    await hooks.get("http.response")({ response: new Response(body, { status: 401 }) })
    assert.equal(result.status, 401)
    assert.equal(result.category, null)
    assert.equal(result.hint, null)
    assert.ok(!JSON.stringify(result).includes(secret))
  }
  const { hooks, result } = await probeFixture()
  const response = new Response(secret)
  await hooks.get("http.response")({ response })
  assert.equal(result.status, 200)
  assert.equal(response.bodyUsed, false)
  assert.equal(result.hint, null)
})

test("keeps the probe generation limit, disables retries, and accepts only one request", async () => {
  const { hooks, result } = await probeFixture()
  const generate = { options: { maxTokens: 100 } }
  await hooks.get("generate")(generate)
  assert.equal(generate.options.maxTokens, 8)
  const retry = {}
  await hooks.get("retry")(retry)
  assert.deepEqual(retry.decision, { retry: false })
  const request = referenceRequest()
  await hooks.get("http.request")({ request })
  assert.equal(result.requests, 1)
  assert.equal(request.bodyUsed, false)
  assert.deepEqual(result.request, await compareRequest(request))
  await assert.rejects(hooks.get("http.request")({ request }), /budget or destination rejected/)
  assert.equal(result.requests, 1)
})

test("rejects wrong probe destinations and methods before inspecting their bodies", async () => {
  const { hooks, result } = await probeFixture()
  for (const [url, method] of [
    [`https://${secret}.test/v1/messages`, "POST"],
    ["http://api.anthropic.com/v1/messages", "POST"],
    ["https://api.anthropic.com:444/v1/messages", "POST"],
    ["https://api.anthropic.com/v1/messages/count_tokens", "POST"],
    [`https://${secret}@api.anthropic.com/v1/messages`, "POST"],
    ["https://api.anthropic.com/v1/messages", "GET"],
  ]) {
    await assert.rejects(hooks.get("http.request")({ request: { url, method } }), error => error.message === "Probe request budget or destination rejected")
    assert.equal(result.requests, 0)
    assert.equal(result.request, null)
  }
})

test("blocks unauthenticated initialization without spending the request budget", async () => {
  for (const authorization of [null, "Basic fixture-secret", "Bearer"]) {
    const { hooks, result } = await probeFixture()
    const request = referenceRequest()
    if (authorization === null) request.headers.delete("authorization")
    else request.headers.set("authorization", authorization)
    await assert.rejects(hooks.get("http.request")({ request }), { code: "missing-bearer" })
    assert.equal(result.requests, 0)
    assert.equal(result.request.headers.bearer, false)
    assert.ok(!JSON.stringify(result).includes(secret))
    await hooks.get("http.request")({ request: referenceRequest() })
    assert.equal(result.requests, 1)
    assert.equal(result.request.headers.bearer, true)
  }
})

test("blocks unexpected API keys without consuming the subscription probe budget", async () => {
  const { hooks, result } = await probeFixture()
  const request = referenceRequest()
  request.headers.set("x-api-key", secret)
  await assert.rejects(hooks.get("http.request")({ request }), { code: "unexpected-api-key" })
  assert.equal(result.requests, 0)
  assert.equal(result.request.headers.apiKeyAbsent, false)
  assert.ok(!JSON.stringify(result).includes(secret))
})

test("the request budget also holds for concurrent hooks", async () => {
  const { hooks, result } = await probeFixture()
  const outcomes = await Promise.allSettled([
    hooks.get("http.request")({ request: referenceRequest() }),
    hooks.get("http.request")({ request: referenceRequest() }),
  ])
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1)
  assert.equal(outcomes.filter(outcome => outcome.status === "rejected").length, 1)
  assert.equal(result.requests, 1)
})

test("waits for OAuth persistence before allowing generation", async () => {
  let polls = 0
  const input = { integrationID: "anthropic", attemptID: "fixture-attempt" }
  const integration = { oauth: { status: async received => {
    assert.equal(received, input)
    return { data: { status: ++polls < 3 ? "pending" : "complete" } }
  } } }
  await waitForOAuth(integration, input)
  assert.equal(polls, 3)
})

test("OAuth failures are sanitized instead of exposing their messages", async () => {
  for (const status of ["failed", "expired", secret, undefined]) {
    const integration = { oauth: { status: async () => ({ data: { status, message: secret } }) } }
    await assert.rejects(waitForOAuth(integration, {}), error => error.code === "oauth-incomplete" && !error.message.includes(secret))
  }
})

test("OAuth polling has a bounded timeout", async t => {
  let now = 0
  t.mock.method(Date, "now", () => now)
  const integration = { oauth: { status: async () => {
    now = 5_001
    return { data: { status: "pending" } }
  } } }
  await assert.rejects(waitForOAuth(integration, {}), { code: "oauth-timeout" })
})

test("the standalone transport guard counts every fetch, blocks redirects and enforces the approved total", async t => {
  const native = t.mock.method(globalThis, "fetch", async (request, options) => {
    assert.equal(new URL(request.url).origin, "https://api.anthropic.com")
    assert.equal(options.redirect, "error")
    return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: `You're out of extra usage: ${secret}` } }), { status: 400 })
  })
  const result = {}
  const restore = installTransportBudget(result, 3)
  try {
    for (let index = 0; index < 3; index++) await fetch(referenceRequest())
    await assert.rejects(fetch(referenceRequest()), { code: "probe-budget" })
    assert.equal(result.transportRequests, 3)
    assert.equal(result.attempts.length, 3)
    assert.equal(result.attempts[0].hint, "extra-usage")
    assert.equal(native.mock.callCount(), 3)
    assert.ok(!JSON.stringify(result).includes(secret))
  } finally { restore() }
  assert.equal(globalThis.fetch, native)
})

test("the transport guard rejects unsafe destinations, keys and output budgets before any fetch", async t => {
  const send = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not send") })
  const result = {}
  const restore = installTransportBudget(result, 1)
  try {
    await assert.rejects(fetch(new Request("https://other.test/v1/messages", referenceRequest())), { code: "probe-destination" })
    const key = referenceRequest()
    key.headers.set("x-api-key", secret)
    await assert.rejects(fetch(key), { code: "probe-auth-or-tokens" })
    const excessive = new Request(referenceRequest().url, { method: "POST", headers: referenceRequest().headers, body: JSON.stringify({ max_tokens: 9 }) })
    await assert.rejects(fetch(excessive), { code: "probe-auth-or-tokens" })
    assert.equal(send.mock.callCount(), 0)
    assert.equal(result.transportRequests, 0)
  } finally { restore() }
  for (const maximum of [0, 4, NaN, "3"]) assert.throws(() => installTransportBudget({}, maximum), /Invalid probe request budget/u)
})

test("the transport guard budget holds when fetch calls start concurrently", async t => {
  const send = t.mock.method(globalThis, "fetch", async () => new Response("fixture response"))
  const result = {}
  const restore = installTransportBudget(result, 1)
  try {
    const outcomes = await Promise.allSettled([fetch(referenceRequest()), fetch(referenceRequest())])
    assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1)
    assert.equal(send.mock.callCount(), 1)
    assert.equal(result.transportRequests, 1)
  } finally { restore() }
})
