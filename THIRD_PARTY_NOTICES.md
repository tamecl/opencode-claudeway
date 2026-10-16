# Third-party notices

Claudeway is an independent, unofficial project. Its credential format and
migration research reference `griffinmartin/opencode-claude-auth` `2.2.1`, commit
`8aad811a4da3813ab3985063e656fed582909780`:
https://github.com/griffinmartin/opencode-claude-auth

The credential reader and request compatibility logic are selectively derived from
this reference: client headers, beta flags, billing-marker hashing, identity,
system relocation, Haiku effort cleanup, tool naming, placeholder repair, and
bounded beta fallback. These adaptations now apply to production requests for the
explicitly selected Claudeway connection. The original notice is retained below.
The OAuth endpoint, public client identifier and token exchange fields also reference
`src/credentials.ts` at that commit. Claudeway implements its own on-demand renewal,
private recovery records, locking and JS persistence. The V1 entrypoint,
`auth.json` synchronization, account discovery, full prompts, optional lossy repair
mode, CLI-generation fallback and background renewal timers have not been copied.

## opencode-claude-auth

MIT License

Copyright (c) 2026 gmartin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Dependencies

`@opencode/plugin` `2.0.29` is MIT-licensed. It and its transitive dependencies
remain separate packages with their original notices; none are bundled here.
`@opencode/sdk` and oxlint are development dependencies only. The JavaScript core
uses built-in Node APIs without additional dependencies; no third-party code is
bundled in the published package.

CLIProxyAPI was consulted as an architectural reference; no code from it has
been copied into this milestone. Source-code licenses do not authorize use of
third-party services or trademarks.
