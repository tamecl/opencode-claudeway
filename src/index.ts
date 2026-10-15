import { Integration, Plugin } from "@opencode/plugin"
import { CredentialStore } from "./storage.js"

const store = new CredentialStore()

export default Plugin.define({
  id: "opencode-claudeway",
  async setup(ctx) {
    const load = async () => {
      const { credentials } = await store.read()
      // shortcut: read-only viability probe; add coordinated renewal after the real-account gate.
      if (credentials.expiresAt <= Date.now() + 60_000) {
        throw new Error("Claude Code credentials are expired or near expiry; refresh with Claude Code before this compatibility test.")
      }
      return credentials
    }
    const oauth = async () => {
      const credentials = await load()
      return { type: "oauth" as const, methodID: Integration.MethodID.make("claudeway"), access: credentials.accessToken, refresh: credentials.refreshToken, expires: credentials.expiresAt }
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
      const connection = await ctx.integration.connection.active("anthropic")
      if (!connection || connection.type !== "credential" || connection.method !== "oauth") return
      const credential = await ctx.integration.connection.resolve(connection)
      if (credential?.type !== "oauth" || credential.methodID !== "claudeway") return

      const url = new URL(event.request.url)
      if (
        url.origin !== "https://api.anthropic.com" || url.username || url.password ||
        !["/v1/messages", "/v1/messages/count_tokens"].includes(url.pathname)
      ) throw new Error("Claudeway refused an unauthorized credential destination.")

      const credentials = await load()
      const headers = new Headers(event.request.headers)
      headers.delete("x-api-key")
      headers.set("authorization", `Bearer ${credentials.accessToken}`)
      event.request = new Request(event.request, { headers, redirect: "error" })
    }, { providerID: "anthropic" })
  },
})
