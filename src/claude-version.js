import childProcess from "node:child_process"

export const FALLBACK_VERSION = "2.1.329"

export function detectClaudeVersion() {
  return new Promise(resolve => {
    childProcess.execFile("claude", ["--version"], { timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 4096, windowsHide: true }, (error, stdout) => {
      const version = !error && /^(\d+\.\d+\.\d+)(?: \(Claude Code\))?$/u.exec(stdout.trim())?.[1]
      if (!version) console.warn(`Claudeway: could not detect Claude Code via \`claude --version\`. Using ${FALLBACK_VERSION}; check the PATH available to OpenCode.`)
      resolve(version || FALLBACK_VERSION)
    })
  })
}
