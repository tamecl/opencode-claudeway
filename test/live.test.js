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

test("invalid live budgets are rejected before credentials or host initialization", async () => {
  const execute = promisify(execFile)
  const script = fileURLToPath(new URL("../scripts/verify-live.mjs", import.meta.url))
  for (const args of [["--max-requests=0"], ["--max-requests=4"], ["--max-requests=fixture-secret"], ["--max-requests=1", "--max-requests=3"]]) {
    await assert.rejects(execute(process.execPath, [script, "--confirm", ...args]), error => error.code === 2 && error.stdout === "" && /Invalid request budget/u.test(error.stderr) && !error.stderr.includes("fixture-secret"))
  }
})
