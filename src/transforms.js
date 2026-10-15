import { failure } from "./errors.js"
import { hash, record } from "./storage.js"

export const VERSION = "2.1.280"
export const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const BILLING = "x-anthropic-billing-header:"
const BASE_BETAS = ["claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14", "prompt-caching-scope-2026-01-05", "context-management-2025-06-27", "advisor-tool-2026-03-01", "thinking-token-count-2026-05-13", "extended-cache-ttl-2025-04-11"]
const LIMIT = 16_777_216

export function billingHeader(messages) {
  const user = messages.find(message => message.role === "user")
  const text = typeof user?.content === "string" ? user.content : user?.content.find(block => block.type === "text")?.text ?? ""
  if (typeof text !== "string") throw failure("invalid-request")
  const sampled = [4, 7, 20].map(index => index < text.length ? text[index] : "0").join("")
  return `${BILLING} cc_version=${VERSION}.${hash("59cf53e54c78" + sampled + VERSION).slice(0, 3)}; cc_entrypoint=sdk-cli; cch=${hash(text).slice(0, 5)};`
}

export function toolAlias(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(name)) throw failure("invalid-request")
  const alias = /^mcp_[A-Z]/u.test(name) ? name : "mcp_" + name[0].toUpperCase() + name.slice(1)
  return alias.length > 64 ? alias.slice(0, 51) + "_" + hash(name).slice(0, 12) : alias
}

function toolIDs(message, type) {
  if (!Array.isArray(message?.content)) return []
  const ids = message.content.filter(block => block.type === type).map(block => block[type === "tool_use" ? "id" : "tool_use_id"])
  if (ids.some(id => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) throw failure("invalid-request")
  return ids
}

function repairTools(messages) {
  const cleaned = messages.flatMap((message, index) => {
    if (!Array.isArray(message.content)) return [message]
    const previous = messages[index - 1]
    const uses = new Set(previous?.role === "assistant" ? toolIDs(previous, "tool_use") : [])
    toolIDs(message, "tool_result")
    const content = message.content.filter(block => block.type !== "tool_result" || uses.has(block.tool_use_id))
    return content.length ? [{ ...message, content }] : []
  })
  const output = []
  for (let index = 0; index < cleaned.length; index++) {
    const message = cleaned[index]
    output.push(message)
    const uses = message.role === "assistant" ? toolIDs(message, "tool_use") : []
    const next = cleaned[index + 1]
    const present = new Set(next?.role === "user" ? toolIDs(next, "tool_result") : [])
    const missing = uses.filter(id => !present.has(id))
    if (!missing.length) continue
    const placeholders = missing.map(id => ({ type: "tool_result", tool_use_id: id, is_error: true, content: "Tool result unavailable (removed during context compaction)." }))
    if (next?.role === "user") {
      const content = typeof next.content === "string" ? next.content ? [{ type: "text", text: next.content }] : [] : next.content
      output.push({ ...next, content: [...placeholders, ...content] })
      index++
    } else output.push({ role: "user", content: placeholders })
  }
  return output
}

export function adaptRequest(payload) {
  if (!record(payload) || typeof payload.model !== "string" || !payload.model) throw failure("invalid-request")
  const body = structuredClone(payload)
  const { messages } = body
  if (!Array.isArray(messages) || !messages.length || messages.some(message => !record(message) || !["user", "assistant"].includes(message.role) || !(typeof message.content === "string" || Array.isArray(message.content) && message.content.every(record)))) throw failure("invalid-request")
  const first = messages.find(message => message.role === "user")
  if (!first) throw failure("invalid-request")
  const billing = billingHeader(messages)
  const system = typeof body.system === "string" ? [{ type: "text", text: body.system }] : body.system ?? []
  if (!Array.isArray(system) || system.some(entry => !record(entry) || entry.type !== "text" || typeof entry.text !== "string")) throw failure("invalid-request")
  const moved = system.flatMap(entry => {
    if (entry.text.startsWith(BILLING)) return []
    const text = entry.text.startsWith(IDENTITY) ? entry.text.slice(IDENTITY.length).replace(/^\n+/u, "") : entry.text
    return text ? [text] : []
  })
  body.system = [{ type: "text", text: billing }, { type: "text", text: IDENTITY }]
  if (moved.length) {
    const prefix = moved.join("\n\n")
    if (typeof first.content === "string") first.content = prefix + "\n\n" + first.content
    else first.content.unshift({ type: "text", text: prefix })
  }
  const betas = [...BASE_BETAS]
  const model = body.model.toLowerCase()
  if (model.includes("haiku")) {
    for (const key of ["output_config", "thinking"]) if (Object.hasOwn(body, key)) {
      if (!record(body[key])) throw failure("invalid-request")
      delete body[key].effort
      if (!Object.keys(body[key]).length) delete body[key]
    }
  } else if (["opus-4-5", "4-6", "4-7"].some(pattern => model.includes(pattern))) betas.push("effort-2025-11-24")
  const tools = body.tools ?? []
  if (!Array.isArray(tools)) throw failure("invalid-request")
  const names = new Map()
  const aliases = new Map()
  for (const tool of tools) {
    if (!record(tool)) throw failure("invalid-request")
    const alias = toolAlias(tool.name)
    if (aliases.has(tool.name)) throw failure("invalid-request")
    if (tool.type !== undefined && tool.type !== "custom") { aliases.set(tool.name, tool.name); continue }
    if (names.has(alias)) throw failure("invalid-request")
    names.set(alias, tool.name)
    aliases.set(tool.name, alias)
    tool.name = alias
  }
  for (const message of messages) if (Array.isArray(message.content)) for (const block of message.content) {
    if (block.type === "tool_use") block.name = aliases.get(block.name) ?? toolAlias(block.name)
  }
  if (record(body.tool_choice) && body.tool_choice.type === "tool") {
    if (!aliases.has(body.tool_choice.name)) throw failure("invalid-request")
    body.tool_choice.name = aliases.get(body.tool_choice.name)
  }
  body.messages = repairTools(messages)
  return { body, betas, version: VERSION, toolNames: Object.fromEntries(names) }
}

export function transformBody(raw) {
  if (typeof raw !== "string") throw failure("invalid-request")
  if (Buffer.byteLength(raw) > LIMIT) throw failure("request-limit")
  let result
  try { result = adaptRequest(JSON.parse(raw)) } catch { throw failure("invalid-request") }
  if (Buffer.byteLength(JSON.stringify(result)) > LIMIT) throw failure("request-limit")
  return result
}
