# Node Capability and Model Ranking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 現在開いているFrameWeaverノードの能力とモデル在庫を軽量に収集し、実行可能なモデルを理由付きで順位付けして、実URLでも自動検証できるようにする。

**Architecture:** ComfyUIレスポンスの正規化、静的モデルカタログ、純粋な順位付け関数、適応ポーラーを独立した小さなモジュールへ分ける。Zustandは結果だけを保持し、UIは順位付け理由を表示する。実URLの検証はNode標準APIだけのCLIで行う。

**Tech Stack:** TypeScript 6、React 19、Zustand 5、Vitest 4、Node.js 24、ComfyUI HTTP API

**Spec:** `docs/superpowers/specs/2026-08-24-node-capability-model-ranking-design.md`

## Global Constraints

- 優先順位は高速化、軽量化、安定化の順。
- 新規npm依存、常駐プロセス、データベースを追加しない。
- 別GPUノードへの自動送信、モデルダウンロード、Tailscale設定変更を行わない。
- ホスト名、Tailnet名、IP、ユーザー名を公開差分へ保存しない。
- 各production変更は失敗するテストを先に確認する。

---

### Task 1: モデルカタログと適合度ランキング

**Files:**
- Create: `src/lib/model-capability.ts`
- Create: `src/lib/model-capability.test.ts`
- Modify: `src/lib/types.ts`

**Interfaces:**
- Produces: `NodeCapabilitySnapshot`, `ModelCatalogEntry`, `ModelFit`, `MODEL_CATALOG`
- Produces: `normalizeModelPath(value: string): string`
- Produces: `rankModels(snapshot: NodeCapabilitySnapshot, task: ModelTask): ModelFit[]`

- [ ] **Step 1: Write the failing ranking tests**

Cover installed 24GB, installed but low-free 16GB, missing-file 8GB, stale snapshot, Windows path normalization, and deterministic ordering. The expected public API is:

```ts
const fits = rankModels(snapshot, 'image')
expect(fits.map((fit) => [fit.model.id, fit.status])).toEqual([
  ['zimage', 'recommended'],
  ['anime', 'available'],
  ['krea2', 'unavailable'],
])
expect(fits[0].reasons).toContain('installed')
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/lib/model-capability.test.ts`

Expected: FAIL because `./model-capability` does not exist.

- [ ] **Step 3: Implement the minimal types, catalog, normalization, and ranking**

Use these exact unions:

```ts
export type CapabilityStatus = 'ready' | 'degraded' | 'unavailable' | 'stale'
export type AcceleratorKind = 'cuda' | 'mps' | 'cpu' | 'unknown'
export type ModelTask = 'image' | 'video' | 'upscale' | 'llm'
export type ModelFitStatus = 'recommended' | 'available' | 'warning' | 'unavailable'
```

Catalog only the currently supported `zimage`, `krea2`, `anime`, and `h3-video`. Match required files case-insensitively after replacing backslashes with slashes. Missing required files and insufficient total VRAM are hard failures; stale/degraded state and low free VRAM produce warnings.

- [ ] **Step 4: Verify GREEN and regression suite**

Run: `npm test -- src/lib/model-capability.test.ts`

Expected: all new tests pass.

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```text
feat: モデル適合度をノード能力から判定
```

---

### Task 2: ComfyUI能力収集と複数GPU正規化

**Files:**
- Create: `src/lib/capability-collector.ts`
- Create: `src/lib/capability-collector.test.ts`
- Modify: `src/lib/comfy-client.ts`

**Interfaces:**
- Consumes: `NodeCapabilitySnapshot`
- Produces: `collectNodeCapability(baseUrl: string, fetchImpl?: typeof fetch): Promise<NodeCapabilitySnapshot>`
- Produces: `ComfyClient.capabilities(): Promise<NodeCapabilitySnapshot>`

- [ ] **Step 1: Write failing collector tests**

Use a deterministic fetch function that returns `system_stats` and object-info payloads. Cover multiple GPUs, four model inventory classes, HTTP failure, malformed payload, and timeout/abort.

```ts
const snapshot = await collectNodeCapability('/comfy', fakeFetch)
expect(snapshot.devices).toHaveLength(2)
expect(snapshot.inventory.unets).toContain('z_image_turbo_nvfp4.safetensors')
expect(snapshot.status).toBe('ready')
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/lib/capability-collector.test.ts`

Expected: FAIL because the collector does not exist.

- [ ] **Step 3: Implement minimal concurrent collection**

Fetch `/system_stats` first with a 2-second `AbortSignal.timeout`. If ready, fetch the following endpoints concurrently:

```text
/object_info/CheckpointLoaderSimple
/object_info/UNETLoader
/object_info/CLIPLoader
/object_info/VAELoader
/object_info/LoraLoaderModelOnly
```

Preserve all returned devices. Partial object-info failure yields `degraded` with a short error code; system-stats failure yields `unavailable`. Do not include raw response bodies in errors.

- [ ] **Step 4: Verify GREEN and regression suite**

Run: `npm test -- src/lib/capability-collector.test.ts`

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```text
feat: ComfyUI能力とモデル在庫を正規化
```

---

### Task 3: 適応ポーリングとストア配線

**Files:**
- Create: `src/lib/adaptive-poller.ts`
- Create: `src/lib/adaptive-poller.test.ts`
- Modify: `src/store/generation.ts`
- Modify: `src/store/generation.test.ts`

**Interfaces:**
- Produces: `pollDelay(status: GenerationStatus, visibility: DocumentVisibilityState): number`
- Produces: `createAdaptivePoller(options): { start(): void; stop(): void; trigger(): Promise<void> }`
- Store adds: `capability: NodeCapabilitySnapshot | null`
- Store adds: `refreshCapability(): Promise<void>`

- [ ] **Step 1: Write failing scheduling tests**

```ts
expect(pollDelay('running', 'visible')).toBe(2_000)
expect(pollDelay('idle', 'visible')).toBe(10_000)
expect(pollDelay('idle', 'hidden')).toBe(60_000)
```

Prove single-flight by holding the first poll promise open and triggering twice; the callback count must remain one. Prove `stop()` clears the scheduled timer.

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/lib/adaptive-poller.test.ts`

Expected: FAIL because the poller does not exist.

- [ ] **Step 3: Implement the poller and replace the fixed interval**

The poller must schedule the next timeout only after the current call settles. Run an immediate first poll. On success, store the snapshot and derive primary-device VRAM. On unavailable/stale results, set `connected=false` without turning a generation job into an error.

- [ ] **Step 4: Verify GREEN and store integration**

Run: `npm test -- src/lib/adaptive-poller.test.ts src/store/generation.test.ts`

Expected: all focused tests pass and fake timers are drained/stopped.

Run: `npm test`

Expected: all tests pass without hanging workers.

- [ ] **Step 5: Commit**

```text
perf: VRAM監視を状態連動のsingle-flightへ変更
```

---

### Task 4: 適合度UIと実URLsmoke検証

**Files:**
- Create: `src/components/ModelFitBadge.tsx`
- Modify: `src/components/ImageStudio.tsx`
- Modify: `src/components/RecipePanel.tsx`
- Create: `scripts/verify-runtime.mjs`
- Create: `src/server/runtime-smoke.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `docs/TAILSCALE-MULTI-MACHINE.md`

**Interfaces:**
- Consumes: `ModelFit`
- Produces: compact `ModelFitBadge` with Japanese label and reason summary
- Produces CLI: `npm run smoke:runtime -- --base-url <url>`

- [ ] **Step 1: Write failing runtime CLI test**

Start a temporary Node HTTP server inside the test. Execute the CLI as a child process. Assert exit 0 for valid HTML/system-stats/object-info and non-zero for HTML-only or malformed JSON.

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/server/runtime-smoke.test.ts`

Expected: FAIL because `scripts/verify-runtime.mjs` is absent.

- [ ] **Step 3: Implement the CLI and compact UI**

CLI options:

```text
--base-url <FrameWeaver origin>
--timeout-ms <positive integer, default 3000>
```

It must request `/`, `/comfy/system_stats`, and required object-info routes, emit one JSON summary, avoid printing response bodies, and never submit or interrupt a job. UI badges are collapsed on mobile and must not block selection of an unknown model.

- [ ] **Step 4: Wire verification gates**

Add `docs:verify` to CI after `npm test`. Keep live runtime smoke out of hosted CI; its child-process contract test runs under Vitest. Document the live Tailscale command with placeholders only.

- [ ] **Step 5: Verify focused, full, and browser paths**

Run:

```text
npm ci
npm test
npm run lint
npm run build
npm run docs:verify
npm audit --audit-level=high
```

Then run the smoke CLI against the active Tailnet URL and confirm a read-only exit 0. In a real browser, verify desktop and 390px mobile layouts, no horizontal overflow, model-fit labels, theme persistence, and console errors 0.

- [ ] **Step 6: Commit**

```text
test: 実URLのComfyUI能力診断を自動化
```

---

### Task 5: Fleet validation and PR handoff

**Files:**
- Modify: PR body only after all local checks pass

**Interfaces:**
- Consumes: runtime smoke CLI and canonical fleet roster
- Produces: verified / unavailable / operator-gated node matrix

- [ ] **Step 1: Verify canonical roster and live Tailscale population**

Record roster SHA256 and timestamp. Exclude retired and no-SSH entries from the SSH denominator.

- [ ] **Step 2: Run bounded read-only probes**

For each physical node, record Tailscale online, SSH success, accelerator memory, Comfy listener, Comfy API readiness, and runtime-smoke result when FrameWeaver is deployed. Do not start services or change persistent settings.

- [ ] **Step 3: Review lean design**

Confirm new dependencies 0, new daemons 0, no central scheduler, no secret identifiers, and no duplicate polling path.

- [ ] **Step 4: Push and verify PR checks**

Push the existing feature branch, update PR #4 with verified and unverified scopes, wait for GitHub Actions, and confirm merge state `CLEAN`. Do not merge.
