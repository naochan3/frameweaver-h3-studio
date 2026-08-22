# FrameWeaver P2 Authentication and GPU Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discord ID allowlist認証、server-owned job identity、複数ComfyUI worker routing、UI/異常系自動テスト、idle resource分析を実装し、security gateを通してPRを作成する。

**Architecture:** Rust daemonがOAuth、session、owner binding、worker registry、routing policyの唯一のsecurity boundaryになる。Reactは`/api/auth/me`と`/api/workers`のtyped APIだけを利用し、Discord ID、worker endpoint、credentialを保持しない。各jobはsubmit前に`worker_id`をSQLiteへ永続化し、以後のstatus/cancel/outputはそのworkerへ固定する。

**Tech Stack:** Rust 2024, Axum 0.8, SQLx/SQLite, Reqwest/Rustls, HMAC-SHA256, React 19, TypeScript 6, Zustand, Vitest, Playwright, Pester, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-22-frameweaver-p2-auth-routing-design.md`

## Global Constraints

- Tailnet到達制御を維持し、ComfyUIとworker APIをpublic interfaceへbindしない。
- Discord user IDの完全一致allowlistだけを許可し、guild role、display name、emailを認可に使わない。
- token、OAuth code、state、cookie、Discord ID、prompt、workflow、worker credentialをログへ出さない。
- 認証有効時はbrowser owner headerを無視し、server sessionからownerを決定する。
- global interrupt、global queue clear、任意filesystem操作をworker interfaceへ追加しない。
- `rtx4090`はAutoのfallback/manual、`rtx5060ti`をAutoの第一候補とする。
- tracked secret、実Discord ID、実生成promptをcommitしない。
- 既存`.audit/`はユーザー所有物として変更しない。

---

### Task 1: Auth configuration and durable state

**Files:**
- Create: `frameweaverd/migrations/0002_auth_routing.sql`
- Create: `frameweaverd/src/auth/mod.rs`
- Create: `frameweaverd/src/auth/config.rs`
- Create: `frameweaverd/src/auth/repository.rs`
- Modify: `frameweaverd/src/config.rs`
- Modify: `frameweaverd/src/lib.rs`
- Modify: `frameweaverd/Cargo.toml`
- Test: `frameweaverd/tests/auth_repository.rs`
- Test: `frameweaverd/tests/health_api.rs`

**Interfaces:**
- Produces: `AuthConfig::disabled()`, `AuthConfig::from_env() -> Result<AuthConfig, ConfigError>`.
- Produces: `AuthRepository::{create_state, consume_state, create_session, resolve_session, revoke_session}`.
- Produces: `SessionIdentity { owner_id: Uuid, discord_user_hash: String, expires_at: DateTime<Utc> }`.

- [ ] **Step 1: Write failing config and repository tests**

Add literal cases proving disabled mode needs no secrets; enabled mode rejects missing client ID/secret, non-HTTPS production callback, empty/malformed/duplicate allowlist, and secret shorter than 32 bytes. Add SQLite tests proving only hashed state/session values are stored, state is single-use, expired/revoked sessions fail, and allowlist removal invalidates an existing session.

- [ ] **Step 2: Verify RED**

Run: `cargo test --manifest-path frameweaverd/Cargo.toml --test auth_repository --test health_api`

Expected: compile failure because `auth` module, migration, and repository do not exist.

- [ ] **Step 3: Implement minimal auth config and repository**

Use `hmac` + `sha2` for keyed hashes, `subtle` for constant-time verification, `rand` for 32-byte tokens. Migration creates `oauth_states`, `sessions`, adds `jobs.worker_id`, and indexes expiry/owner fields. Raw state/session/Discord ID must never be bound into SQL.

- [ ] **Step 4: Verify GREEN and inspect schema**

Run: `cargo test --manifest-path frameweaverd/Cargo.toml --test auth_repository --test health_api`

Expected: all new tests pass; `SELECT sql FROM sqlite_master` fixture asserts no raw-secret columns.

- [ ] **Step 5: Commit**

Run: `git add frameweaverd && git commit -m "feat: add durable auth state"`

### Task 2: Discord OAuth routes and server-owned identity

**Files:**
- Create: `frameweaverd/src/auth/discord.rs`
- Create: `frameweaverd/src/auth/service.rs`
- Create: `frameweaverd/src/auth/api.rs`
- Create: `frameweaverd/tests/auth_api.rs`
- Modify: `frameweaverd/src/jobs/api.rs`
- Modify: `frameweaverd/src/main.rs`
- Modify: `frameweaverd/src/proxy.rs`
- Test: `frameweaverd/tests/jobs_api.rs`
- Test: `frameweaverd/tests/proxy_api.rs`

**Interfaces:**
- Consumes: `AuthConfig`, `AuthRepository`, `SessionIdentity` from Task 1.
- Produces: trait `DiscordClient { exchange_code; current_user }` with complete Discord response DTOs.
- Produces: extractor `AuthenticatedIdentity(SessionIdentity)` and routes `/auth/login`, `/auth/callback`, `/auth/logout`, `/api/auth/me`.
- Produces: cookie name `__Host-frameweaver_session`; no alternate cookie/header identity.

- [ ] **Step 1: Write failing HTTP contract tests**

Use a real Axum router plus local Discord fake server. Assert unauthenticated jobs/fleet/proxy/WebSocket reject, health/login remain available, login redirect contains exact `scope=identify`, callback validates state/binding/expiry/single-use, allowlist denial is 403, token/user timeout is 502/504, cookie attributes are exact, logout revokes, and owner header spoof cannot cross job boundaries.

- [ ] **Step 2: Verify RED**

Run: `cargo test --manifest-path frameweaverd/Cargo.toml --test auth_api --test jobs_api --test proxy_api`

Expected: compile failure for missing auth router/extractor and current owner header remains trusted.

- [ ] **Step 3: Implement OAuth and middleware**

Build authorization URL with `Url::query_pairs_mut`, exchange form-urlencoded code with 5-second timeout, fetch `/users/@me`, canonicalize decimal snowflake, consume state before outcome, and discard access token after user fetch. Middleware resolves only the opaque cookie. In disabled compatibility mode, retain the P1 header extractor; enabled mode ignores it.

- [ ] **Step 4: Add rate/body/error boundaries**

Limit callback query length, reject duplicate parameters, cap upstream response body, require exact configured redirect URI, set `Cache-Control: no-store` on auth responses, and ensure structured events contain only result/duration/owner-short.

- [ ] **Step 5: Verify GREEN**

Run: `cargo test --manifest-path frameweaverd/Cargo.toml --test auth_api --test jobs_api --test proxy_api`

Expected: all auth, IDOR, CSRF, callback replay, cookie tamper, and proxy tests pass.

- [ ] **Step 6: Commit**

Run: `git add frameweaverd && git commit -m "feat: authenticate jobs with Discord sessions"`

### Task 3: Worker registry and deterministic routing

**Files:**
- Create: `frameweaverd/src/workers/mod.rs`
- Create: `frameweaverd/src/workers/model.rs`
- Create: `frameweaverd/src/workers/client.rs`
- Create: `frameweaverd/src/workers/policy.rs`
- Create: `frameweaverd/src/workers/api.rs`
- Create: `frameweaverd/tests/worker_routing.rs`
- Modify: `frameweaverd/src/jobs/model.rs`
- Modify: `frameweaverd/src/jobs/repository.rs`
- Modify: `frameweaverd/src/jobs/api.rs`
- Modify: `frameweaverd/src/main.rs`
- Modify: `.env.example`

**Interfaces:**
- Produces: `WorkerId`, `WorkerCapability`, `WorkerSnapshot`, `WorkerPreference::{Auto, Explicit}`.
- Produces: `RoutingPolicy::select(request, snapshots) -> Result<WorkerId, RoutingError>`.
- Produces: `WorkerClient` with `submit`, `get_job`, `cancel`, `view`; endpoint/credential stay private.
- Produces: `GET /api/workers` returning only safe ID, label, capability, online/stale, free VRAM, queue depth.

- [ ] **Step 1: Write failing policy tests with hand-derived selections**

Literal tables cover unknown worker, offline, stale, role mismatch, VRAM shortage, explicit no-fallback, 5060 Ti preferred over 4090, 3070/2070 light workloads, 4090 fallback only when necessary, and no eligible worker.

- [ ] **Step 2: Verify policy RED**

Run: `cargo test --manifest-path frameweaverd/Cargo.toml --test worker_routing`

Expected: compile failure because worker types/policy are absent.

- [ ] **Step 3: Implement typed registry and policy**

Parse registry from one JSON environment value or a non-secret config file whose credentials are environment references. Validate unique IDs, `http://127.0.0.1` only for local worker and `https://*.tail37947a.ts.net` for remote workers, nonempty capabilities, bounded VRAM requirements, and no URL userinfo/query/fragment.

- [ ] **Step 4: Write failing job integration tests**

Real fake workers prove submit/status/cancel always use persisted `worker_id`, retries carry one idempotency key, worker A jobs never hit worker B, restart recovery preserves route, and safe worker list omits endpoint/credential.

- [ ] **Step 5: Implement worker-aware jobs**

Add `worker_preference` request and `worker_id` response/storage. Persist the selected worker before submit. Replace the singleton `ComfyApi` in jobs state with registry lookup. Preserve the current local 4090 client as disabled-auth compatibility configuration.

- [ ] **Step 6: Verify GREEN**

Run: `cargo test --manifest-path frameweaverd/Cargo.toml --test worker_routing --test jobs_api --test job_repository`

Expected: routing and persistence tests pass without changing global proxy permissions.

- [ ] **Step 7: Commit**

Run: `git add frameweaverd .env.example && git commit -m "feat: route jobs to GPU workers"`

### Task 4: Authentication and worker selection UI

**Files:**
- Create: `src/lib/auth-api.ts`
- Create: `src/lib/auth-api.test.ts`
- Create: `src/components/AuthGate.tsx`
- Create: `src/components/AuthGate.test.tsx`
- Create: `src/components/WorkerSelector.tsx`
- Create: `src/components/WorkerSelector.test.tsx`
- Modify: `src/lib/frameweaver-api.ts`
- Modify: `src/lib/frameweaver-api.test.ts`
- Modify: `src/store/generation.ts`
- Modify: `src/store/generation.test.ts`
- Modify: `src/components/GenerateBar.tsx`
- Modify: `src/components/Header.tsx`
- Modify: `src/components/HistoryPanel.tsx`
- Modify: `src/App.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Produces: `AuthState = { enabled, authenticated, displayName? }` from `/api/auth/me`.
- Produces: `SafeWorker`, `WorkerPreference`, `WorkerSelector`.
- Consumes: job API `worker_preference`; renders returned `worker_id`.

- [ ] **Step 1: Write failing component/API tests**

Assert login-only screen, allowlist/session/Discord error copy, logout, selector order `Auto/5060 Ti/3070/2070/4090`, disabled options with reasons, selected worker included in both image/video requests, actual worker in history, and owner header absent when auth is enabled.

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/lib/auth-api.test.ts src/components/AuthGate.test.tsx src/components/WorkerSelector.test.tsx src/store/generation.test.ts`

Expected: missing modules/components and request shape failures.

- [ ] **Step 3: Implement minimal UI**

AuthGate fetches session state with credentials same-origin. WorkerSelector consumes `/api/workers`, keeps Auto as default, exposes status through accessible text, and stays next to Generate controls on mobile. API errors preserve numeric status in a typed `FrameWeaverApiError` so UI maps 401/403/409/502/503/504 without string parsing.

- [ ] **Step 4: Verify GREEN and responsive unit behavior**

Run: `npm test -- src/lib/auth-api.test.ts src/components/AuthGate.test.tsx src/components/WorkerSelector.test.tsx src/store/generation.test.ts src/components/FleetPanel.test.tsx`

Expected: all targeted tests pass with no React act warnings.

- [ ] **Step 5: Run React quality review**

Run: `npm run lint && npm run build`

Inspect that fetches are deduplicated, effects clean up, state subscriptions are narrow, and worker metadata is not duplicated in multiple components.

- [ ] **Step 6: Commit**

Run: `git add src package.json package-lock.json && git commit -m "feat: add authenticated GPU selection UI"`

### Task 5: Browser E2E and failure automation

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/fixtures/frameweaver.ts`
- Create: `e2e/auth-routing.spec.ts`
- Create: `e2e/error-states.spec.ts`
- Create: `scripts/Test-FrameWeaverFaultMatrix.ps1`
- Create: `scripts/tests/FrameWeaverFaultMatrix.Tests.ps1`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces scripts: `npm run test:e2e`, `npm run test:e2e:ui`, `npm run test:all`.
- Produces Pester fault matrix artifact outside repository.

- [ ] **Step 1: Add Playwright and write failing E2E**

Install pinned `@playwright/test` as dev dependency. Mock Discord and workers at network boundary, not component internals. Test desktop 1440x900 and mobile 390x844: login callback, selector, submit, history, logout, 401/403/409/502/503/504/network failure, focus, console errors, and no framework overlay.

- [ ] **Step 2: Verify RED**

Run: `npm run test:e2e`

Expected: failures until Task 4 UI and test server integration expose the required states.

- [ ] **Step 3: Add deterministic webServer/fixtures**

Use ephemeral ports, temporary SQLite, fake Discord/worker servers, and test-only environment values. Do not put bypass routes or magic identities in production code. Save screenshots/traces to ignored `test-results/` only on failure.

- [ ] **Step 4: Add fault matrix RED then GREEN**

Pester invokes a shadow daemon with scripted worker outcomes and asserts stable status/error body, bounded duration, no process leak, and no secret/prompt in JSONL. Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Import-Module Pester; Invoke-Pester scripts/tests/FrameWeaverFaultMatrix.Tests.ps1"` before and after implementing the runner.

- [ ] **Step 5: Verify browser/fault GREEN**

Run: `npm run test:e2e && powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Import-Module Pester; $r=Invoke-Pester scripts/tests -PassThru; if($r.FailedCount){exit 1}"`

Expected: all E2E and Pester tests pass, no child process remains.

- [ ] **Step 6: Commit**

Run: `git add package.json package-lock.json playwright.config.ts e2e scripts .gitignore && git commit -m "test: automate auth routing failures"`

### Task 6: Production configuration, worker rollout, and live auth smoke

**Files:**
- Create: `config/workers.example.json`
- Create: `scripts/Install-FrameWeaverWorkerTask.ps1`
- Create: `scripts/Test-FrameWeaverAuthSmoke.ps1`
- Create: `scripts/tests/FrameWeaverWorkerTask.Tests.ps1`
- Modify: `scripts/Start-FrameWeaver.ps1`
- Modify: `scripts/Invoke-FrameWeaverCutover.ps1`
- Modify: `docs/operations/frameweaver-cutover.md`
- Modify: `README.md`

**Interfaces:**
- Produces dry-run-first worker Task installer and rollback artifact.
- Produces auth smoke that accepts secrets only through environment/`op://`, never command arguments.

- [ ] **Step 1: Write failing lifecycle/cutover/worker tests**

Assert auth-enabled startup fails on missing secret, launcher redacts new fields, cutover requires auth health, worker installer is dry-run, loopback-only, same-name backup/rollback, and unknown port owner fails closed.

- [ ] **Step 2: Verify RED**

Run all Pester suites and expect the new worker/auth lifecycle assertions to fail.

- [ ] **Step 3: Implement production scripts and docs**

Keep credentials in process environment. Add health readback for `auth=ready`, exact callback URL, worker registry parse, and rollback to current P1 Task/XML/database backup. Do not alter remote Task/Tailscale until each target's plan and rollback are printed and the already-approved P2 scope is confirmed against the exact host.

- [ ] **Step 4: Configure Discord application inputs**

Read client ID/secret/allowed IDs/session secret from existing environment or `op://`. If absent, stop production auth enablement while continuing mock E2E/security validation. Never synthesize or expose a real Discord identity.

- [ ] **Step 5: Roll out workers one host at a time**

Order: `rtx5060ti`, `nicolas2025`, `nicoyuri`; for each capture current listener/Task/Serve, apply loopback worker, verify health/capability/targeted smoke, and retain host-specific rollback. Keep 4090 local fallback working throughout.

- [ ] **Step 6: Live smoke and commit**

Verify allowlisted login, denied unlisted identity using a mock-only path rather than a real third-party account, one preferred-worker image, one targeted cancel, history persistence, and Tailnet URL. Commit scripts/docs without secret artifacts.

Run: `git add config scripts docs README.md && git commit -m "ops: deploy authenticated GPU workers"`

### Task 7: Comfy idle RAM/VRAM impact analysis

**Files:**
- Create: `scripts/Measure-ComfyIdleResources.ps1`
- Create: `scripts/tests/Measure-ComfyIdleResources.Tests.ps1`
- Create: `docs/operations/comfy-idle-resource-analysis.md`

**Interfaces:**
- Produces timestamped JSONL/summary outside repository with `host, state, comfy_pid, private_bytes, working_set, system_ram_used, vram_used, gpu_util, power_draw, temperature`.
- Produces three states: `stopped`, `idle_started`, `post_generation_idle`.

- [ ] **Step 1: Write failing parser/sampler tests**

Fixtures cover no PID, multiple GPUs, missing counters, timeout, stale remote sample, and ensure output omits command line/environment/prompt.

- [ ] **Step 2: Verify RED**

Run: `Invoke-Pester scripts/tests/Measure-ComfyIdleResources.Tests.ps1`

Expected: missing measurement script.

- [ ] **Step 3: Implement bounded sampler**

Sample every second for 60 seconds per state using NVML/nvidia-smi, CIM process counters, and system memory. Write raw JSONL under `%LOCALAPPDATA%\FrameWeaver\analysis`, calculate median/p95/max/delta, and never start/stop Comfy implicitly.

- [ ] **Step 4: Collect live evidence safely**

Use current running state for `idle_started` and `post_generation_idle`. Collect `stopped` only on workers where Comfy is already stopped or after an operator-authorized maintenance stop; do not interrupt active jobs. Capture 4090, 5060 Ti, 3070, 2070 where reachable.

- [ ] **Step 5: Analyze retention and operational policy**

Distinguish allocator reservation from active utilization, report model residency, host RAM, baseline power, and time-to-release. Recommend per-worker unload/stop policy from measured deltas, not generic advice.

- [ ] **Step 6: Verify and commit tool/docs**

Run Pester plus JSON schema/readback. Commit only redacted aggregate analysis; keep raw JSONL outside repository.

Run: `git add scripts docs/operations/comfy-idle-resource-analysis.md && git commit -m "perf: measure Comfy idle resources"`

### Task 8: Full security, extensibility, CI, and PR gate

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `SECURITY.md` if absent
- Modify: files identified by validated findings only
- Create outside repo: deep security scan canonical artifacts managed by Codex Security

**Interfaces:**
- Produces a single CI gate for Rust, Vitest, Pester, Playwright, audits, and secret scan.
- Produces sealed deep-security report and PR URL.

- [ ] **Step 1: Add CI with least privileges**

Use `contents: read`, pinned major action versions, npm/cargo lockfiles, no production secrets, mock OAuth/workers, artifact retention for failed Playwright traces only.

- [ ] **Step 2: Run local full gate**

Run: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, `npm test`, `npm run lint`, `npm run build`, `npm run test:e2e`, all Pester, `cargo audit`, `npm audit`, and tracked secret scan.

- [ ] **Step 3: Run repository-wide Codex Deep Security Scan**

Target the canonical worktree root with scope `.`. Complete and seal the scan exactly once. Any Critical/High or auth bypass/IDOR/SSRF/secret finding blocks PR; write a failing regression test before each remediation.

- [ ] **Step 4: Review UI/function extensibility**

Check module sizes, dependency direction, typed boundaries, worker hardcoding, duplicated error mapping, test fixture coupling, and ability to add one worker/role without editing unrelated modules. Important findings block PR.

- [ ] **Step 5: Verify branch and live state**

Confirm only intended files differ from `main`, `.audit/` untouched, live P1 remains available until gated P2 cutover succeeds, rollback artifacts exist, and no test process/port remains.

- [ ] **Step 6: Authenticate GitHub, push, and create PR**

If `gh auth status` is invalid, request operator reauthentication; do not paste tokens. Push the named feature branch without force. Create PR against `main` with verified/unverified/rollback/security/idle-resource sections and link the sealed report.

- [ ] **Step 7: Final verification**

Read PR checks and review comments. Do not call complete until required checks pass or an external check is explicitly reported as pending/blocked.
