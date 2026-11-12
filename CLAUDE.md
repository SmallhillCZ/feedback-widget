# feedback-widget

- Generic click-to-comment widget; feedback = GitHub issues created with the reviewer's GitHub App user token. Nothing project-specific.
- No runtime dependencies (Node 18+). `server.js` + `lib/` (config, HMAC state store, injecting proxy), `public/widget.js` (Shadow DOM overlay, calls api.github.com directly), `demo/`.
- Tests: `npm test` (node:test + Playwright against `test/mock-github.js`). Keep the e2e test green when changing the widget.
- Issues are matched by the `feedback-meta` HTML comment, not only the label (labels drop without triage access).
