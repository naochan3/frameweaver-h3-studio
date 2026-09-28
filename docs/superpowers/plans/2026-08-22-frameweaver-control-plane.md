# FrameWeaver Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tailnet内で所有者分離された生成・停止、永続ジョブ履歴、統一GPU監視、安定した静的UI配信を提供する。

**Architecture:** React/TypeScript UIはビルド成果物として維持し、Rust `frameweaverd`が静的配信、API、SQLite台帳、ComfyUI proxy、healthを担当する。ComfyUIはloopback上の推論エンジンとして維持する。

**Tech Stack:** Rust 1.96, Axum, Tokio, Reqwest, SQLx SQLite, Serde, tracing, tower-http, React 19, TypeScript 6, Vitest

**Spec:** `docs/superpowers/specs/2026-08-22-frameweaver-control-plane-design.md`

## Global Constraints

- P0/P1のみを実装し、Discord認証とGPUルーティングは実装しない。
- `127.0.0.1:8188`のComfyUIと既存Tailnet URLを維持する。
- 本番のScheduled TaskまたはTailscale Serve切替は別の明示ゲートにする。
- UIからglobal interruptとqueue clearを呼ばない。
- 既存未追跡`.audit/`を変更・commitしない。

---

### Task 1: Rust service skeleton and health

**Files:**
- Create: `frameweaverd/Cargo.toml`
- Create: `frameweaverd/src/main.rs`
- Create: `frameweaverd/src/config.rs`
- Create: `frameweaverd/src/health.rs`
- Create: `frameweaverd/tests/health_api.rs`

**Interfaces:**
- Produces: `AppConfig`, `build_router(AppState) -> Router`, `GET /api/health`.

- [ ] **Step 1: Write failing integration tests** for HTTP 200, JSON `service`, `database`, `comfy`, `build`, and a two-second timeout using an ephemeral listener.
- [ ] **Step 2: Run** `cargo test --manifest-path frameweaverd/Cargo.toml health_api` and verify the missing crate/router failure.
- [ ] **Step 3: Implement** config parsing, tracing initialization, graceful Ctrl-C shutdown, static build metadata, and cached Comfy health probing.
- [ ] **Step 4: Run** `cargo fmt --manifest-path frameweaverd/Cargo.toml --check && cargo clippy --manifest-path frameweaverd/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path frameweaverd/Cargo.toml` and require success.
- [ ] **Step 5: Commit** only Task 1 files with `feat: add frameweaverd health service`.

### Task 2: SQLite job ledger and recovery

**Files:**
- Create: `frameweaverd/src/jobs/mod.rs`
- Create: `frameweaverd/src/jobs/model.rs`
- Create: `frameweaverd/src/jobs/repository.rs`
- Create: `frameweaverd/migrations/0001_jobs.sql`
- Create: `frameweaverd/tests/job_repository.rs`

**Interfaces:**
- Produces: `JobRepository::{create,get_for_owner,list_for_owner,transition,recover_incomplete}` and typed `Job`, `JobStatus`, `NewJob`.

- [ ] **Step 1: Write failing repository tests** proving WAL mode, owner-filtered reads, legal status transitions, persistence after pool reopen, and recovery candidate selection.
- [ ] **Step 2: Run** `cargo test --manifest-path frameweaverd/Cargo.toml job_repository` and verify failure.
- [ ] **Step 3: Implement** the exact schema from the spec with SQLx migrations, `busy_timeout=5000`, foreign keys, and UTC RFC3339 timestamps.
- [ ] **Step 4: Run** the repository test plus full Rust fmt/clippy/test gate.
- [ ] **Step 5: Commit** with `feat: persist frameweaver jobs in sqlite`.

### Task 3: Owner-scoped submission and targeted cancellation

**Files:**
- Create: `frameweaverd/src/comfy.rs`
- Create: `frameweaverd/src/jobs/api.rs`
- Create: `frameweaverd/tests/jobs_api.rs`
- Modify: `frameweaverd/src/main.rs`

**Interfaces:**
- Consumes: `JobRepository` from Task 2.
- Produces: `POST/GET/DELETE /api/jobs`, `ComfyApi::{submit,get_job,cancel}`.

- [ ] **Step 1: Write failing HTTP tests** with a mock Comfy server proving server-generated UUID is sent as `prompt_id`, owner A can cancel its job, owner B receives 404, and neither `/interrupt` nor `/queue` is called.
- [ ] **Step 2: Run** `cargo test --manifest-path frameweaverd/Cargo.toml jobs_api` and verify failure.
- [ ] **Step 3: Implement** validated `X-FrameWeaver-Owner`, request size limit, database-first creation, Comfy submission, failure transition, and targeted cancellation through `/api/jobs/{id}/cancel`.
- [ ] **Step 4: Add recovery tests** where startup reconciles incomplete rows against mocked Comfy state and marks absent jobs `orphaned`.
- [ ] **Step 5: Run** full Rust gate and commit with `feat: isolate job ownership and cancellation`.

### Task 4: Static UI and Comfy reverse proxy

**Files:**
- Create: `frameweaverd/src/proxy.rs`
- Create: `frameweaverd/src/static_files.rs`
- Create: `frameweaverd/tests/proxy_api.rs`
- Modify: `frameweaverd/src/main.rs`
- Modify: `package.json`

**Interfaces:**
- Produces: SPA fallback from `dist/`, `/comfy/*` HTTP proxy and WebSocket tunnel, `npm run serve` for shadow runtime.

- [ ] **Step 1: Write failing tests** for index fallback, immutable hashed assets, proxy path rewriting, Origin rewriting, upstream timeout, and WebSocket echo through `/comfy/ws`.
- [ ] **Step 2: Run** targeted Rust tests and verify failure.
- [ ] **Step 3: Implement** static service and bounded proxy without embedding Vite runtime dependencies.
- [ ] **Step 4: Run** `npm run build`, full Rust gate, then start on `127.0.0.1:15180` and verify `Invoke-WebRequest http://127.0.0.1:15180/api/health` plus `dist` asset retrieval.
- [ ] **Step 5: Commit** with `feat: serve built studio through frameweaverd`.

### Task 5: UI API client, persistent history, and safe stop

**Files:**
- Create: `src/lib/frameweaver-api.ts`
- Create: `src/lib/frameweaver-api.test.ts`
- Modify: `src/lib/comfy-client.ts`
- Modify: `src/store/generation.ts`
- Modify: `src/components/HistoryPanel.tsx`

**Interfaces:**
- Consumes: Task 3 API.
- Produces: `FrameWeaverApi::{createJob,listJobs,cancelJob}`, browser-stable owner UUID, API-backed generation history.

- [ ] **Step 1: Write failing Vitest cases** proving owner header inclusion, job UUID tracking, targeted DELETE, no global clear calls, API history loading, and one-time localStorage fallback.
- [ ] **Step 2: Run** `npm test -- frameweaver-api` and verify failure.
- [ ] **Step 3: Implement** the API client and store integration; remove `interrupt()`, `clearQueue()`, `systemStats()` and the five-second VRAM interval from normal UI paths.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build` and require success.
- [ ] **Step 5: Commit** with `feat: use owner-scoped job api in studio`.

### Task 6: Unified fleet telemetry in Rust

**Files:**
- Create: `frameweaverd/src/fleet/mod.rs`
- Create: `frameweaverd/src/fleet/model.rs`
- Create: `frameweaverd/src/fleet/collector.rs`
- Create: `frameweaverd/tests/fleet_api.rs`
- Modify: `frameweaverd/src/main.rs`
- Modify: `vite.config.ts`

**Interfaces:**
- Produces: existing-compatible `GET /api/fleet` snapshot with one source of truth.

- [ ] **Step 1: Write failing tests** for 2-second local/15-second remote intervals, in-flight suppression, stale values, last-good separation, and partial-node failure.
- [ ] **Step 2: Run** `cargo test --manifest-path frameweaverd/Cargo.toml fleet_api` and verify failure.
- [ ] **Step 3: Port** current collector semantics to Rust, use NVML when loadable and `nvidia-smi` fallback, and retain bounded SSH remote collection.
- [ ] **Step 4: Remove** the Vite fleet plugin from production config while retaining dev proxy to the Rust API where needed.
- [ ] **Step 5: Run** Rust and frontend gates and commit with `feat: centralize fleet telemetry`.

### Task 7: Mobile-first layout and accessible controls

**Files:**
- Create: `src/components/FleetPanel.test.tsx`
- Modify: `src/components/FleetPanel.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/GenerateBar.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: unified fleet snapshot.
- Produces: collapsed mobile summary and input-first document order.

- [ ] **Step 1: Write failing component tests** for mobile default collapse, aggregate summary, accessible expand button, desktop expansion, and error/stale labels.
- [ ] **Step 2: Run** the targeted Vitest test and verify failure.
- [ ] **Step 3: Move** generation inputs above fleet details, implement responsive disclosure, minimum 44px primary controls, and bottom padding equal to the fixed Generate bar.
- [ ] **Step 4: Run** frontend gates and browser checks at 390x844 and 1440x900, saving screenshots outside the commit.
- [ ] **Step 5: Commit** with `feat: prioritize generation controls on mobile`.

### Task 8: Custom-node profiles and diagnostics

**Files:**
- Create: `config/comfy-profiles.json`
- Create: `scripts/Get-ComfyProfileArgs.ps1`
- Create: `scripts/Test-ComfyProfile.ps1`
- Create: `scripts/tests/ComfyProfiles.Tests.ps1`
- Modify: `README.md`

**Interfaces:**
- Produces: `minimal`, `image`, `video`, `full` profile validation and CLI argument expansion.

- [ ] **Step 1: Write failing Pester tests** for valid names, duplicate rejection, missing custom-node reporting, and exact whitelist expansion.
- [ ] **Step 2: Run** `Invoke-Pester scripts/tests/ComfyProfiles.Tests.ps1 -Output Detailed` and verify failure.
- [ ] **Step 3: Implement** declarative profiles without changing the currently scheduled ComfyUI command or defaulting away from `full`.
- [ ] **Step 4: Run** Pester and a read-only diagnostic against `C:\Users\ogosh\work\ComfyUI\custom_nodes`.
- [ ] **Step 5: Commit** with `feat: define comfy custom-node profiles`.

### Task 9: Windows lifecycle, logs, and shadow E2E

**Files:**
- Create: `scripts/Install-FrameWeaverdTask.ps1`
- Create: `scripts/Test-FrameWeaverdShadow.ps1`
- Modify: `scripts/Start-FrameWeaver.ps1`
- Modify: `README.md`

**Interfaces:**
- Consumes: built Rust binary and UI dist.
- Produces: dry-run task definition, log paths/retention, shadow E2E report, rollback commands.

- [ ] **Step 1: Add dry-run tests** proving generated Scheduled Task action, working directory, three retries at one-minute intervals, and no live mutation without `-Apply`.
- [ ] **Step 2: Implement** timestamped JSONL stdout/stderr capture, panic/exit visibility, health wait, rotation, and explicit rollback export.
- [ ] **Step 3: Run** all Rust/frontend/Pester gates and `Test-FrameWeaverdShadow.ps1 -Port 15180`.
- [ ] **Step 4: Execute localhost E2E**: static load, health, fleet, owner A create/read, owner B cancel denial, owner A targeted cancel, restart persistence, WebSocket connect, and one minimal image generation if Comfy is healthy.
- [ ] **Step 5: Commit** with `feat: add resilient frameweaverd lifecycle`.

### Task 10: Final review and gated cutover

**Files:**
- Modify only files required by validated review findings.

**Interfaces:**
- Produces: final evidence report and an operator-controlled cutover decision.

- [ ] **Step 1: Run Sol read-only review** for ownership bypass, data loss, proxy exposure, watchdog loops, log privacy, SQLite recovery, and test gaps.
- [ ] **Step 2: Fix validated P0/P1 findings** with a failing regression test first; rerun all gates.
- [ ] **Step 3: Capture current Scheduled Task and Tailscale Serve configuration** read-only and generate exact apply/rollback commands.
- [ ] **Step 4: Ask for the live cutover gate** because Task action/Tailscale changes are persistent machine settings.
- [ ] **Step 5: After approval only**, apply, verify the existing Tailnet URL from desktop and smartphone, and record E2E evidence.
