const messages = {
  missing: "Claude Code credentials not found; sign in with Claude Code first.",
  invalid: "Invalid Claude Code credentials; the source was not modified.",
  permission: "Permission denied accessing Claude Code credentials.",
  io: "Cannot safely read or persist Claude Code credentials.",
  keychain: "Cannot access the Claude Code Keychain item; unlock it or check permissions.",
  "keychain-limit": "Keychain update exceeds the security tool's safe input limit; use Claude Code to renew.",
  expired: "Claude Code credentials are expired or near expiry; refresh with Claude Code first.",
  "source-changed": "Claude Code credentials changed concurrently; no account was overwritten. Retry after checking the selected account.",
  "refresh-busy": "Another Claudeway process holds the renewal lock; try again later.",
  "unsupported-platform": "Automatic renewal is not enabled on Windows until private recovery-file ACLs are verified; renew with Claude Code instead.",
  "refresh-rejected": "Claude OAuth renewal was rejected; sign in with Claude Code again.",
  "refresh-unavailable": "Claude OAuth renewal is temporarily unavailable; try again later.",
  "refresh-uncertain": "OAuth renewal has an uncertain outcome; do not repeat the old refresh token. Reauthenticate with Claude Code if recovery is unavailable.",
  "recovery-pending": "Renewed credentials could not be persisted; private recovery data was retained. Check storage permissions and try again.",
  "invalid-request": "Claudeway refused an invalid compatibility request.",
  "request-limit": "Claudeway request exceeded its size limit.",
}

export function failure(code) {
  if (!Object.hasOwn(messages, code)) code = "io"
  return Object.assign(new Error(messages[code]), { code })
}
