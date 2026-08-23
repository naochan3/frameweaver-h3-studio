# Prompt rewriter verification

The browser talks only to the bounded `/rewriter` gateway. It does not proxy the
Ollama API directly.

## Automated checks

Run before changing the prompt rewriter:

```powershell
npm ci
npm test
npm run lint
npm run build
npm audit --audit-level=high
```

The suite covers the route allowlist, model allowlist, request/response limits,
upstream timeout, video schema and timestamp validation, image language/length
validation, selected-model availability, and stale-response protection.

## Local gateway smoke test

Start `npm run dev`, then verify:

- `GET /rewriter/models` returns only the three allowed model names.
- `POST /rewriter/generate` accepts an allowed model.
- `/ollama/api/delete` and unknown `/rewriter/*` routes return 404.
- an unlisted model returns 403.

These checks do not require exposing Ollama outside localhost.
