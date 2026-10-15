import assert from "node:assert/strict"
import { test } from "node:test"
import { adaptRequest, billingHeader, IDENTITY } from "../src/transforms.js"

const request = fields => ({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hey" }], ...fields })

test("moves system instructions without mutating input or duplicating cache controls", () => {
  const payload = request({ system: [{ type: "text", text: "instructions", cache_control: { type: "ephemeral" } }, { type: "text", text: IDENTITY + "\nmore instructions" }, { type: "text", text: "x-anthropic-billing-header: obsolete" }] })
  const original = structuredClone(payload)
  const adapted = adaptRequest(payload)
  assert.deepEqual(payload, original)
  assert.deepEqual(adapted.body.system, [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.280.d7b; cc_entrypoint=sdk-cli; cch=fa690;" }, { type: "text", text: IDENTITY }])
  assert.equal(adapted.body.messages[0].content, "instructions\n\nmore instructions\n\nhey")
})

test("preserves structured user content and string system instructions", () => {
  const adapted = adaptRequest(request({ system: "instructions", messages: [{ role: "user", content: [{ type: "text", text: "hey" }, { type: "image", source: { type: "base64", data: "fixture" } }] }] }))
  assert.deepEqual(adapted.body.messages[0].content, [{ type: "text", text: "instructions" }, { type: "text", text: "hey" }, { type: "image", source: { type: "base64", data: "fixture" } }])
})

test("preserves native system and empty effort updates across Claude 5.5 turns", () => {
  const messages = [
    { role: "user", content: "hey" },
    { role: "assistant", content: [{ type: "thinking", thinking: "fixture", signature: "fixture-signature" }, { type: "text", text: "hello" }] },
    { role: "user", content: "continue" },
    { role: "system", content: [{ type: "text", text: "updated instructions", cache_control: { type: "ephemeral" } }] },
    { role: "system", content: [], output_config: { effort: "high" } },
    { role: "assistant", content: "second response" },
    { role: "user", content: "continue again" },
    { role: "system", content: [], output_config: { effort: "low" } },
  ]
  for (const model of ["claude-sonnet-5-5", "claude-haiku-5-5"]) {
    const payload = request({ model, messages, system: "initial instructions" })
    const original = structuredClone(payload)
    const adapted = adaptRequest(payload)
    assert.deepEqual(payload, original)
    assert.equal(adapted.body.messages[0].content, "initial instructions\n\nhey")
    assert.deepEqual(adapted.body.messages.slice(1), messages.slice(1))
  }
})

test("rejects malformed native system updates", () => {
  for (const update of [
    { content: "not structured" },
    { content: [{ type: "text", text: 42 }] },
    { content: [{ type: "tool_use", id: "id-1", name: "read", input: {} }] },
    { content: [], output_config: null },
    { content: [], output_config: { effort: 42 } },
  ]) assert.throws(() => adaptRequest(request({ messages: [{ role: "user", content: "hey" }, { role: "system", ...update }] })), { code: "invalid-request" })
})

test("billing preserves the previous UTF-16 and UTF-8 compatibility vectors", () => {
  for (const [text, cch, suffix] of [["hey", "fa690", "d7b"], ["hello", "2cf24", "790"], ["😀😀a😀0123456789😀XYZ", "f2fc1", "17d"], ["a\ud800b", "05087", "d7b"]]) {
    const value = billingHeader([{ role: "user", content: text }])
    assert.ok(value.includes(`cc_version=2.1.280.${suffix};`))
    assert.ok(value.includes(`cch=${cch};`))
  }
})

test("Haiku removes only effort while supported models retain it", () => {
  let adapted = adaptRequest(request({ output_config: { effort: "high", format: "fixture" }, thinking: { type: "enabled", budget_tokens: 1024, effort: "high" } }))
  assert.deepEqual(adapted.body.output_config, { format: "fixture" })
  assert.deepEqual(adapted.body.thinking, { type: "enabled", budget_tokens: 1024 })
  assert.ok(!adapted.betas.includes("effort-2025-11-24"))
  adapted = adaptRequest(request({ output_config: { effort: "high" }, thinking: { effort: "high" } }))
  assert.equal(Object.hasOwn(adapted.body, "output_config"), false)
  assert.equal(Object.hasOwn(adapted.body, "thinking"), false)
  for (const model of ["claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7"]) {
    const supported = adaptRequest(request({ model, output_config: { effort: "high" } }))
    assert.equal(supported.body.output_config.effort, "high")
    assert.ok(supported.betas.includes("effort-2025-11-24"))
  }
  assert.ok(!adaptRequest(request({ model: "claude-sonnet-4-5" })).betas.includes("effort-2025-11-24"))
})

test("tool definitions, forced choice and historical calls use the same reversible alias", () => {
  const adapted = adaptRequest(request({ tools: [{ name: "HTTPGet", input_schema: { type: "object" } }], tool_choice: { type: "tool", name: "HTTPGet", disable_parallel_tool_use: true }, messages: [{ role: "user", content: "hey" }, { role: "assistant", content: [{ type: "tool_use", id: "id-1", name: "HTTPGet", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "id-1", content: "fixture" }] }] }))
  assert.deepEqual(adapted.toolNames, { mcp_HTTPGet: "HTTPGet" })
  assert.equal(adapted.body.tools[0].name, "mcp_HTTPGet")
  assert.equal(adapted.body.tool_choice.name, "mcp_HTTPGet")
  assert.equal(adapted.body.tool_choice.disable_parallel_tool_use, true)
  assert.equal(adapted.body.messages[1].content[0].name, "mcp_HTTPGet")
})

test("long aliases are bounded, server tools are unchanged and ambiguous aliases are rejected", () => {
  const adapted = adaptRequest(request({ tools: [{ name: "a".repeat(64) }, { name: "a".repeat(63) + "b" }, { name: "web_search", type: "web_search_20250305" }] }))
  const aliases = adapted.body.tools.map(tool => tool.name)
  assert.equal(aliases[0].length, 64)
  assert.notEqual(aliases[0], aliases[1])
  assert.equal(aliases[2], "web_search")
  assert.equal(Object.hasOwn(adapted.toolNames, "web_search"), false)
  for (const tools of [[{ name: "read" }, { name: "Read" }], [{ name: "not a valid tool" }], [{ name: "read" }, { name: "read" }]]) assert.throws(() => adaptRequest(request({ tools })), { code: "invalid-request" })
})

test("missing results receive placeholders without rewriting thinking or signatures", () => {
  const thinking = { type: "thinking", thinking: "fixture reasoning", signature: "fixture-signature" }
  const messages = [{ role: "user", content: "hey" }, { role: "assistant", content: [thinking, { type: "tool_use", id: "id-1", name: "read", input: {} }] }, { role: "user", content: "continue" }]
  const body = adaptRequest(request({ messages })).body
  assert.deepEqual(body.messages[1].content[0], thinking)
  assert.equal(body.messages[2].content[0].tool_use_id, "id-1")
  assert.equal(body.messages[2].content[0].is_error, true)
  assert.deepEqual(body.messages[2].content[1], { type: "text", text: "continue" })
  assert.equal(messages[2].content, "continue")
})

test("repair handles each repeated occurrence independently and removes orphan results", () => {
  const use = { role: "assistant", content: [{ type: "tool_use", id: "same-id", name: "read", input: {} }] }
  const messages = [{ role: "user", content: "hey" }, use, { role: "user", content: [{ type: "tool_result", tool_use_id: "same-id", content: "first" }] }, structuredClone(use), { role: "user", content: [{ type: "tool_result", tool_use_id: "orphan", content: "drop" }, { type: "text", text: "continue" }] }]
  const repaired = adaptRequest(request({ messages })).body.messages
  assert.equal(repaired[2].content[0].content, "first")
  assert.equal(repaired[4].content[0].tool_use_id, "same-id")
  assert.ok(!JSON.stringify(repaired).includes("orphan"))
})

test("tool repair preserves system updates and matches results across them", () => {
  const updates = [{ role: "system", content: [], output_config: { effort: "high" } }, { role: "system", content: [], output_config: { effort: "low" } }]
  const result = { type: "tool_result", tool_use_id: "id-1", content: "actual result" }
  for (const next of [{ role: "user", content: [result] }, { role: "user", content: "continue" }, { role: "assistant", content: "continue" }, undefined]) {
    const messages = [{ role: "user", content: "hey" }, { role: "assistant", content: [{ type: "tool_use", id: "id-1", name: "read", input: {} }] }, ...updates, ...(next ? [next] : [])]
    const original = structuredClone(messages)
    const repaired = adaptRequest(request({ messages })).body.messages
    assert.deepEqual(messages, original)
    assert.deepEqual(repaired.slice(2, 4), updates)
    assert.equal(repaired[4].role, "user")
    assert.equal(repaired[4].content[0].tool_use_id, "id-1")
    if (next?.role === "assistant") assert.deepEqual(repaired[5], next)
    if (next?.role === "user" && typeof next.content === "string") assert.deepEqual(repaired[4].content[1], { type: "text", text: next.content })
    if (Array.isArray(next?.content)) assert.deepEqual(repaired[4].content, [result])
    else assert.equal(repaired[4].content[0].is_error, true)
  }
})

test("invalid inputs are rejected instead of silently discarding instructions", () => {
  for (const value of [null, [], {}, request({ messages: [] }), request({ messages: [{ role: "assistant", content: "no user" }] }), request({ system: { secret: "fixture-secret" } }), request({ messages: [{ role: "user", content: ["fixture-secret"] }] }), request({ tool_choice: { type: "tool", name: "missing" } })]) assert.throws(() => adaptRequest(value), { code: "invalid-request" })
})
