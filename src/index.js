import { Integration, Plugin } from "@opencode/plugin"
import { randomUUID } from "node:crypto"
import { requestHeaders, compatibleResponse } from "./compatibility.js"
import { credentialReader } from "./credentials.js"
import { failure } from "./errors.js"
import { transformBody } from "./transforms.js"

export { credentialReader }

export const requestAdapter = {
  async transform(body) {
    return transformBody(body)
  },
}

export default Plugin.define({
  id: "opencode-claudeway",
  async setup(ctx) {
    const sessionID = randomUUID()
    const owned = new WeakMap()
    const excludedByModel = new Map()
    const selected = async () => {
      const connection = await ctx.integration.connection.active("anthropic")
      if (!connection || connection.type !== "credential" || connection.method !== "oauth") return false
      const credential = await ctx.integration.connection.resolve(connection)
      return credential?.type === "oauth" && credential.methodID === "claudeway"
    }
    const oauth = async () => {
      const credentials = await credentialReader.read()
      return { type: "oauth", methodID: Integration.MethodID.make("claudeway"), access: credentials.accessToken, refresh: credentials.refreshToken, expires: credentials.expiresAt }
    }

    await ctx.integration.transform(editor => {
      editor.method.update({
        integrationID: "anthropic",
        method: { id: "claudeway", type: "oauth", label: "Claude Code credentials (Claudeway)" },
        authorize: async () => {
          const credential = await oauth()
          return { mode: "auto", url: "", instructions: "Use the existing Claude Code credentials; no browser login is required.", callback: Promise.resolve(credential) }
        },
        refresh: oauth,
      })
    })

    await ctx.session.hook("http.request", async event => {
      if (event.model.providerID !== "anthropic") return
      if (!await selected()) return

      const url = new URL(event.request.url)
      if (
        url.origin !== "https://api.anthropic.com" || url.username || url.password ||
        !["/v1/messages", "/v1/messages/count_tokens"].includes(url.pathname)
      ) throw new Error("Claudeway refused an unauthorized credential destination.")

      const adapted = await requestAdapter.transform(await event.request.clone().text())
      const credentials = await credentialReader.read()
      const excluded = excludedByModel.get(event.model.id) ?? new Set()
      excludedByModel.set(event.model.id, excluded)
      const headers = requestHeaders(event.request, adapted, credentials.accessToken, sessionID, excluded)
      if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) url.searchParams.set("beta", "true")
      event.request = new Request(url, { method: event.request.method, headers, body: JSON.stringify(adapted.body), redirect: "error", signal: event.request.signal })
      owned.set(event.request, { names: adapted.toolNames, excluded, fixed: credentials.fixed })
    }, { providerID: "anthropic" })

    await ctx.session.hook("http.response", async event => {
      const state = owned.get(event.request)
      if (!state) return
      if (state.fixed && event.response.status === 401) throw failure("static-rejected")
      event.response = await compatibleResponse(event.request, event.response, state.names, state.excluded)
    }, { providerID: "anthropic" })

    await ctx.session.hook("retry", async event => {
      if ([400, 429].includes(event.error.status) && /extra usage|long context beta/iu.test(event.error.response?.body ?? "") && await selected()) event.decision = { retry: false }
    }, { providerID: "anthropic" })
  },
})
