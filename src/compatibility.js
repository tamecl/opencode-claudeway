import { randomUUID } from "node:crypto"

export function requestHeaders(request, adapted, accessToken, sessionID, excluded) {
  const headers = new Headers(request.headers)
  for (const name of ["x-api-key", "content-length", "content-encoding", "host"]) headers.delete(name)
  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("content-type", "application/json")
  headers.set("anthropic-version", "2023-06-01")
  const incoming = (headers.get("anthropic-beta") ?? "").split(",").map(value => value.trim()).filter(Boolean)
  headers.set("anthropic-beta", [...new Set([...adapted.betas, ...incoming])].filter(beta => !excluded.has(beta) && !(adapted.body?.model.toLowerCase().includes("haiku") && beta === "effort-2025-11-24")).join(","))
  headers.set("anthropic-dangerous-direct-browser-access", "true")
  headers.set("x-app", "cli")
  headers.set("user-agent", `claude-cli/${adapted.version} (external, sdk-cli)`)
  headers.set("x-client-request-id", randomUUID())
  headers.set("x-claude-code-session-id", sessionID)
  for (const [name, value] of Object.entries({
    arch: process.arch, lang: "js", os: process.platform === "darwin" ? "MacOS" : process.platform,
    "package-version": "0.81.0", "retry-count": "0", runtime: "node", "runtime-version": process.version, timeout: "600",
  })) if (!headers.has(`x-stainless-${name}`)) headers.set(`x-stainless-${name}`, value)
  return headers
}

function restoreNames(payload, names) {
  let changed = false
  const blocks = payload?.type === "content_block_start" ? [payload.content_block] : payload?.content
  if (Array.isArray(blocks)) for (const block of blocks) {
    if (block?.type === "tool_use" && typeof block.name === "string" && Object.hasOwn(names, block.name)) {
      block.name = names[block.name]
      changed = true
    }
  }
  return changed
}

function restoreFrame(frame, names) {
  const lines = frame.split(/\r?\n/u)
  const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /u, "")).join("\n")
  let payload
  try { payload = JSON.parse(data) } catch { return frame }
  if (!restoreNames(payload, names)) return frame
  const first = lines.findIndex(line => line.startsWith("data:"))
  return lines.flatMap((line, index) => index === first ? [`data: ${JSON.stringify(payload)}`] : line.startsWith("data:") ? [] : [line]).join("\n")
}

export async function restoreResponse(response, names) {
  if (!response.ok || !response.body || Object.keys(names).length === 0) return response
  const headers = new Headers(response.headers)
  for (const name of ["content-length", "content-encoding", "transfer-encoding"]) headers.delete(name)
  let body
  if ((headers.get("content-type") ?? "").includes("text/event-stream")) {
    let buffer = ""
    const stream = new TransformStream({
      transform(chunk, controller) {
        buffer += chunk
        let boundary
        while ((boundary = /\r?\n\r?\n/u.exec(buffer))) {
          if (boundary.index > 1_048_576) throw new Error("Claudeway response event exceeded its size limit.")
          controller.enqueue(restoreFrame(buffer.slice(0, boundary.index), names) + boundary[0])
          buffer = buffer.slice(boundary.index + boundary[0].length)
        }
        // shortcut: individual SSE events are capped at 1,048,576 UTF-16 units; raise for larger upstream events.
        if (buffer.length > 1_048_576) throw new Error("Claudeway response event exceeded its size limit.")
      },
      flush(controller) { if (buffer) controller.enqueue(restoreFrame(buffer, names)) },
    })
    body = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(stream).pipeThrough(new TextEncoderStream())
  } else if ((headers.get("content-type") ?? "").includes("application/json")) {
    const payload = await response.clone().json().catch(() => null)
    if (!restoreNames(payload, names)) return response
    body = JSON.stringify(payload)
  } else return response
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}

export async function compatibleResponse(request, response, names, excluded) {
  const headers = new Headers(request.headers)
  for (let attempt = 0; attempt < 2 && [400, 429].includes(response.status); attempt++) {
    if (request.signal.aborted) break
    const error = await response.clone().json().catch(() => null)
    const message = typeof error?.error?.message === "string" ? error.error.message : ""
    if (!message.includes("Extra usage is required for long context requests") && !message.includes("long context beta is not yet available") && !message.includes("You're out of extra usage")) break
    const betas = (headers.get("anthropic-beta") ?? "").split(",").map(value => value.trim()).filter(Boolean)
    const beta = ["context-1m-2025-08-07", "interleaved-thinking-2025-05-14"].find(value => betas.includes(value))
    if (!beta) break
    excluded.add(beta)
    headers.set("anthropic-beta", betas.filter(value => value !== beta).join(","))
    headers.set("x-client-request-id", randomUUID())
    await response.body?.cancel()
    response = await fetch(new Request(request.clone(), { headers, redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]) }))
  }
  return restoreResponse(response, names)
}
