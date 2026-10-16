import assert from "node:assert/strict"
import { test } from "node:test"
import { requestHeaders, restoreResponse, compatibleResponse } from "../src/compatibility.js"
import { requestAdapter } from "@tamelabs/opencode-claudeway"

const payload = { model: "claude-haiku-4-5", messages: [{ role: "user", content: "fixture prompt" }], max_tokens: 8 }
const failure = (status = 400, message = "You're out of extra usage") => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), { status, headers: { "content-type": "application/json" } })

test("builds compatible headers without losing custom values or reintroducing excluded betas", () => {
  const request = new Request("https://api.anthropic.com/v1/messages", { headers: { "x-api-key": "fixture-secret", "content-length": "999", host: "other.test", "anthropic-beta": "interleaved-thinking-2025-05-14,custom-beta", "x-custom": "keep", "x-stainless-lang": "existing" } })
  const adapted = { version: "2.1.280", betas: ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"] }
  const headers = requestHeaders(request, adapted, "fixture-access", "fixture-session", new Set(["interleaved-thinking-2025-05-14"]))
  assert.equal(headers.get("authorization"), "Bearer fixture-access")
  for (const name of ["x-api-key", "content-length", "host"]) assert.equal(headers.has(name), false)
  assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20,custom-beta")
  assert.equal(headers.get("x-custom"), "keep")
  assert.equal(headers.get("x-stainless-lang"), "existing")
  assert.equal(headers.get("x-app"), "cli")
  assert.equal(headers.get("x-claude-code-session-id"), "fixture-session")
  assert.notEqual(headers.get("x-client-request-id"), requestHeaders(request, adapted, "fixture-access", "fixture-session", new Set()).get("x-client-request-id"))
  assert.equal(request.headers.get("x-api-key"), "fixture-secret")
  const haiku = requestHeaders(new Request(request, { headers: { "anthropic-beta": "effort-2025-11-24" } }), { ...adapted, body: { model: "claude-haiku-4-5" } }, "fixture-access", "fixture-session", new Set())
  assert.ok(!haiku.get("anthropic-beta").includes("effort-2025-11-24"))
})

test("the native JS request adapter preserves transformations and sanitizes invalid input", async () => {
  const adapted = await requestAdapter.transform(JSON.stringify({ ...payload, system: "fixture-secret", tools: [{ name: "HTTPGet", input_schema: { type: "object" } }] }))
  assert.equal(adapted.body.system.length, 2)
  assert.equal(adapted.body.messages[0].content, "fixture-secret\n\nfixture prompt")
  assert.deepEqual(adapted.toolNames, { mcp_HTTPGet: "HTTPGet" })
  await assert.rejects(requestAdapter.transform("{fixture-secret"), error => error.code === "invalid-request" && !error.message.includes("fixture-secret"))
  await assert.rejects(requestAdapter.transform("x".repeat(16_777_217)), { code: "request-limit" })
})

test("restores only tool names in fragmented SSE, not argument text, signatures or ordinary messages", async () => {
  const events = [
    'event: content_block_start\r\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"fixture","name":"mcp_HTTPGet","input":{}}}\r\n\r\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"name\\":\\"mcp_HTTPGet\\"}"}}\n\n',
    'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"😀 mcp_HTTPGet"}}\n\n',
    'data: {"type":"content_block_delta","delta":{"type":"signature_delta","signature":"fixture-signature"}}\n\n',
    'data: [DONE]\n\n',
  ]
  const raw = events.join("")
  const bytes = new TextEncoder().encode(raw)
  const source = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } })
  const response = await restoreResponse(new Response(source, { headers: { "content-type": "text/event-stream", "content-length": String(bytes.length), "content-encoding": "gzip" } }), { mcp_HTTPGet: "HTTPGet" })
  const output = await response.text()
  assert.match(output, /"name":"HTTPGet"/u)
  for (const event of events.slice(1)) assert.ok(output.includes(event))
  assert.equal(response.headers.has("content-length"), false)
  assert.equal(response.headers.has("content-encoding"), false)
})

test("restores JSON tool results while preserving nested input names and unknown aliases", async () => {
  const body = { content: [{ type: "tool_use", name: "mcp_HTTPGet", input: { name: "mcp_HTTPGet" } }, { type: "tool_use", name: "mcp_Unknown", input: {} }] }
  const response = await restoreResponse(new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "content-length": "999" } }), { mcp_HTTPGet: "HTTPGet" })
  const result = await response.json()
  assert.equal(result.content[0].name, "HTTPGet")
  assert.equal(result.content[0].input.name, "mcp_HTTPGet")
  assert.equal(result.content[1].name, "mcp_Unknown")
  assert.equal(response.headers.has("content-length"), false)
  const error = failure()
  assert.equal(await restoreResponse(error, { mcp_HTTPGet: "HTTPGet" }), error)
  assert.equal(error.bodyUsed, false)
})

test("stream cancellation reaches the upstream body and oversized events fail safely", async () => {
  let cancelled = false
  const source = new ReadableStream({ cancel() { cancelled = true } })
  const response = await restoreResponse(new Response(source, { headers: { "content-type": "text/event-stream" } }), { mcp_Read: "read" })
  await response.body.cancel()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled, true)
  const oversized = await restoreResponse(new Response("x".repeat(1_048_577), { headers: { "content-type": "text/event-stream" } }), { mcp_Read: "read" })
  await assert.rejects(oversized.text(), /size limit/u)
})

test("compatibility fallback drops only sent betas and replays the same body at most twice", async t => {
  const request = new Request("https://api.anthropic.com/v1/messages?beta=true", { method: "POST", headers: { authorization: "Bearer fixture-access", "anthropic-beta": "oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14" }, body: JSON.stringify(payload) })
  const seen = []
  t.mock.method(globalThis, "fetch", async next => {
    seen.push({ betas: next.headers.get("anthropic-beta"), body: await next.text(), redirect: next.redirect })
    return failure()
  })
  const excluded = new Set()
  const result = await compatibleResponse(request, failure(), {}, excluded)
  assert.equal(result.status, 400)
  assert.equal(seen.length, 2)
  assert.equal(seen[0].betas, "oauth-2025-04-20,interleaved-thinking-2025-05-14")
  assert.equal(seen[1].betas, "oauth-2025-04-20")
  for (const sent of seen) { assert.equal(sent.body, JSON.stringify(payload)); assert.equal(sent.redirect, "error") }
  assert.deepEqual([...excluded], ["context-1m-2025-08-07", "interleaved-thinking-2025-05-14"])
})

test("fallback skips absent betas, does not renew tokens, and leaves unrelated errors alone", async t => {
  const request = new Request("https://api.anthropic.com/v1/messages?beta=true", { method: "POST", headers: { authorization: "Bearer fixture-access", "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14" }, body: JSON.stringify(payload) })
  const send = t.mock.method(globalThis, "fetch", async next => {
    assert.equal(next.headers.get("anthropic-beta"), "oauth-2025-04-20")
    assert.equal(next.headers.get("authorization"), "Bearer fixture-access")
    return new Response("fixture success")
  })
  assert.equal((await compatibleResponse(request, failure(429), {}, new Set())).status, 200)
  assert.equal(send.mock.callCount(), 1)
  for (const [status, message] of [[401, "expired token"], [400, "other bad parameter"], [429, "rate limit"], [529, "overloaded"]]) {
    const original = failure(status, message)
    assert.equal(await compatibleResponse(request, original, {}, new Set()), original)
  }
  const controller = new AbortController()
  controller.abort()
  const cancelled = new Request(request.clone(), { signal: controller.signal })
  assert.equal((await compatibleResponse(cancelled, failure(), {}, new Set())).status, 400)
  assert.equal(send.mock.callCount(), 1)
  const noFallbackBeta = new Request(request.clone(), { headers: { "anthropic-beta": "oauth-2025-04-20" } })
  const original = failure()
  assert.equal(await compatibleResponse(noFallbackBeta, original, {}, new Set()), original)
  assert.equal(send.mock.callCount(), 1)
})
