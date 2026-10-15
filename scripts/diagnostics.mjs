import { setTimeout as delay } from "node:timers/promises"

// Structural baseline from opencode-claude-auth 2.2.1, not a claim that every field is required.
const reference = "opencode-claude-auth@2.2.1#8aad811a4da3813ab3985063e656fed582909780"
const baseBetas = [
  "claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14",
  "prompt-caching-scope-2026-01-05", "context-management-2025-06-27",
  "advisor-tool-2026-03-01", "thinking-token-count-2026-05-13", "extended-cache-ttl-2025-04-11",
]
const clientHeaders = [
  "anthropic-dangerous-direct-browser-access", "x-app", "user-agent", "x-client-request-id", "x-claude-code-session-id",
  "x-stainless-arch", "x-stainless-lang", "x-stainless-os", "x-stainless-package-version",
  "x-stainless-retry-count", "x-stainless-runtime", "x-stainless-runtime-version", "x-stainless-timeout",
]
const identity = "You are Claude Code, Anthropic's official CLI for Claude."

export async function compareRequest(request) {
  const headers = request.headers
  const betas = new Set((headers.get("anthropic-beta") ?? "").split(",").map(value => value.trim()))
  let body
  try { body = await request.clone().json() } catch { body = null }
  const system = Array.isArray(body?.system) ? body.system : []
  return {
    reference,
    headers: {
      bearer: /^Bearer [\x21-\x7e]+$/iu.test(headers.get("authorization") ?? ""),
      apiKeyAbsent: !headers.has("x-api-key"),
      anthropicVersion: headers.get("anthropic-version") === "2023-06-01",
      betaQuery: new URL(request.url).searchParams.get("beta") === "true",
      missingBaseBetas: baseBetas.filter(beta => !betas.has(beta)),
      missingClientHeaders: clientHeaders.filter(name => !headers.has(name)),
      cliApp: headers.get("x-app") === "cli",
      claudeUserAgent: (headers.get("user-agent") ?? "").startsWith("claude-cli/"),
      directBrowserAccess: headers.get("anthropic-dangerous-direct-browser-access") === "true",
    },
    body: {
      json: body !== null && typeof body === "object" && !Array.isArray(body),
      billingFirst: system[0]?.type === "text" && typeof system[0].text === "string" && system[0].text.startsWith("x-anthropic-billing-header:"),
      identitySeparate: system.some(entry => entry?.type === "text" && entry.text === identity),
      toolNamesPrefixed: Array.isArray(body?.tools) && body.tools.length > 0
        ? body.tools.every(tool => typeof tool?.name === "string" && /^mcp_[A-Z]/u.test(tool.name)) : null,
    },
  }
}

function errorDiagnostics(data) {
  const category = data?.error?.type
  const message = typeof data?.error?.message === "string" ? data.error.message.slice(0, 4096) : ""
  const hints = [
    ["claude-code-only", /only authorized.*Claude Code|only.*official Claude Code/iu],
    ["oauth-not-supported", /OAuth.*not supported|does not support.*OAuth/iu],
    ["expired", /\bexpired\b/iu],
    ["revoked", /\brevoked\b|\binvalidated\b/iu],
    ["invalid-token", /invalid.*(?:oauth|access|bearer)[ _-]?token|(?:oauth|access|bearer)[ _-]?token.*invalid/iu],
    ["invalid-api-key", /invalid[ _-]?api[ _-]?key/iu],
    ["beta-header", /(?:missing|required|invalid|unsupported).*\b(?:anthropic-beta|beta (?:header|flag)s?)\b|\b(?:anthropic-beta|beta (?:header|flag)s?)\b.*(?:missing|required|invalid|unsupported)/iu],
    ["insufficient-scope", /insufficient.*scope|scope.*(?:missing|required|insufficient)|missing.*scope/iu],
    ["extra-usage", /extra usage/iu],
  ]
  return {
    category: ["invalid_request_error", "authentication_error", "permission_error", "not_found_error", "rate_limit_error", "overloaded_error", "api_error"].includes(category) ? category : null,
    hint: hints.find(([, pattern]) => pattern.test(message))?.[0] ?? null,
  }
}

export async function waitForOAuth(integration, input) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const { data } = await integration.oauth.status(input)
    if (data?.status === "complete") return
    if (data?.status !== "pending") {
      throw Object.assign(new Error("Probe OAuth authorization did not complete."), { code: "oauth-incomplete" })
    }
    await delay(50)
  }
  throw Object.assign(new Error("Probe OAuth authorization timed out."), { code: "oauth-timeout" })
}

export function installTransportBudget(result, maximum) {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 3) throw new Error("Invalid probe request budget.")
  const send = globalThis.fetch
  let sent = 0
  result.transportRequests = 0
  result.maxRequests = maximum
  result.attempts = []
  const guarded = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== "https://api.anthropic.com" || url.username || url.password || url.pathname !== "/v1/messages" || request.method !== "POST") {
      throw Object.assign(new Error("Probe transport destination rejected."), { code: "probe-destination" })
    }
    const comparison = await compareRequest(request)
    const body = await request.clone().json().catch(() => null)
    if (!comparison.headers.bearer || !comparison.headers.apiKeyAbsent || !Number.isInteger(body?.max_tokens) || body.max_tokens < 1 || body.max_tokens > 8) {
      throw Object.assign(new Error("Probe transport authentication or token budget rejected."), { code: "probe-auth-or-tokens" })
    }
    if (sent >= maximum) throw Object.assign(new Error("Probe transport request budget exhausted."), { code: "probe-budget" })
    result.transportRequests = ++sent
    const attempt = { request: comparison, status: null, category: null, hint: null }
    result.attempts.push(attempt)
    result.request = comparison
    // Scoped to this standalone verifier, never installed by the production plugin.
    const response = await send(request, { redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]) })
    attempt.status = result.status = response.status
    const diagnosis = response.ok ? { category: null, hint: null } : errorDiagnostics(await response.clone().json().catch(() => null))
    Object.assign(attempt, diagnosis)
    Object.assign(result, diagnosis)
    return response
  }
  globalThis.fetch = guarded
  return () => { if (globalThis.fetch === guarded) globalThis.fetch = send }
}

export function compatibilityProbe(result) {
  return {
    id: "claudeway.compatibility-probe",
    async setup(ctx) {
      await ctx.session.hook("generate", event => { event.options.maxTokens = 8 }, { providerID: "anthropic" })
      await ctx.session.hook("retry", event => { event.decision = { retry: false } }, { providerID: "anthropic" })
      await ctx.session.hook("http.request", async event => {
        const url = new URL(event.request.url)
        if (
          url.origin !== "https://api.anthropic.com" || url.username || url.password ||
          url.pathname !== "/v1/messages" || event.request.method !== "POST" || result.requests !== 0
        ) throw new Error("Probe request budget or destination rejected")
        const comparison = await compareRequest(event.request)
        if (result.requests !== 0) throw new Error("Probe request budget or destination rejected")
        result.request = comparison
        // Configuring provider timeouts can make V2 dispatch an unauthenticated bootstrap request.
        if (!comparison.headers.bearer) throw Object.assign(new Error("Probe refused a request without a valid Bearer header."), { code: "missing-bearer" })
        if (!comparison.headers.apiKeyAbsent) throw Object.assign(new Error("Probe refused an unexpected API key."), { code: "unexpected-api-key" })
        result.requests++
      }, { providerID: "anthropic" })
      await ctx.session.hook("http.response", async event => {
        result.status = event.response.status
        if (!event.response.ok) {
          const data = await event.response.clone().json().catch(() => null)
          Object.assign(result, errorDiagnostics(data))
        }
      }, { providerID: "anthropic" })
    },
  }
}
