import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

test("the live probe refuses to run without explicit confirmation", async () => {
  const execute = promisify(execFile)
  await assert.rejects(execute(process.execPath, [fileURLToPath(new URL("../scripts/verify-live.mjs", import.meta.url))]), error => {
    assert.equal(error.code, 2)
    assert.equal(error.stdout, "")
    assert.match(error.stderr, /Requires --confirm/)
    return true
  })
})
