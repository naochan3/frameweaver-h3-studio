# FrameWeaver Control Plane Design

## Goal and scope

FrameWeaverを、Tailnet内の複数利用者が同時利用しても他人のジョブを停止せず、クラッシュ後にも状態を追跡できる常駐サービスへ移行する。P0/P1のみを今回の実装範囲とし、Discord認証とGPUルーティングはAPIの拡張点だけを残してP2へ延期する。

## Current evidence

- UIはReact 19 + TypeScript + Viteで、`npm run dev`をScheduled Taskから常駐させている。
- `/comfy`、`/api/fleet`、DiscordミドルウェアはVite dev server内にある。
- 停止操作は`POST /interrupt`の直後に`POST /queue {clear:true}`を呼ぶため、利用者を問わず実行中・待機中ジョブへ影響する。
-履歴はブラウザの`localStorage`だけで、サーバー再起動・別端末・複数利用者間で共有されない。
- VRAMはブラウザの`/comfy/system_stats` 5秒ポーリングと、`/api/fleet`の2秒ポーリングが重複している。
- ComfyUI側にはcanonical UUIDを受け取る`prompt_id`と`/api/jobs/{job_id}/cancel`が存在する。
- Rust 1.96、Cargo 1.96、Node 24.19がこのホストで利用可能である。

## Target architecture

```text
Tailnet client
    |
    | HTTPS :10000 (existing Tailscale Serve)
    v
frameweaverd :5180 (Rust, loopback only)
    |-- static dist/ assets
    |-- /api/jobs, /api/fleet, /api/health
    |-- /comfy HTTP + WebSocket reverse proxy
    |-- SQLite WAL job ledger
    |-- structured logs + child/process health
    v
ComfyUI :8188 (Python, loopback only)
```

React/TypeScriptはUIとして維持する。Tauri/Electronは常駐Webサービスの要件を改善せず、スマホアクセスにも寄与しないため導入しない。Rustは配信、API、台帳、監視、プロキシに限定し、ワークフロー解釈とGPU推論はComfyUIへ委譲する。

## Trust and ownership model

今回のTailnet段階では認証済みユーザーIDをまだ持たないため、ブラウザごとに生成して永続化する`owner_id`を所有者キーとする。`owner_id`はUUIDで、ジョブ作成・参照・停止時に`X-FrameWeaver-Owner`へ送る。

- ジョブ作成時にサーバーが`job_id`をUUIDで採番し、同じ値をComfyUIの`prompt_id`へ渡す。
- 停止は`DELETE /api/jobs/{job_id}`のみをUIから使用する。
- サーバーは台帳上の`owner_id`一致を確認後、ComfyUIの`/api/jobs/{job_id}/cancel`へ中継する。
- UIからglobal `/interrupt`とqueue clearを削除する。
- P2ではDiscord subjectを`owner_id`へマッピングできるが、今回のAPI契約は変えない。

この方式はTailnet内の誤操作を分離するもので、悪意あるクライアントに対する強い認証ではない。Discord認証が有効になるまではTailnet ACLがセキュリティ境界である。

## Job ledger

SQLiteは`%LOCALAPPDATA%/FrameWeaver/frameweaver.db`へ置き、WAL、`busy_timeout=5000`、foreign keysを有効にする。

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','video')),
  mode TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancel_requested','cancelled','orphaned')),
  prompt TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  output_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX jobs_owner_created_idx ON jobs(owner_id, created_at DESC);
```

起動時に`queued`/`running`/`cancel_requested`をComfyUI `/api/jobs/{id}`と照合する。存在しない未完了ジョブは`orphaned`にし、存在するものは状態を収束させる。ブラウザ履歴はAPIへ移行し、旧localStorageは初回だけ表示用フォールバックとして読み、その後はサーバー台帳を正とする。

## HTTP contract

- `GET /api/health`: daemon、DB、ComfyUIの状態、build SHA、起動時刻。
- `POST /api/jobs`: owner header、kind/mode/prompt/settings/workflowを受け、台帳へ記録してComfyUIへ投入する。
- `GET /api/jobs?limit=50`: owner一致の履歴のみ返す。
- `GET /api/jobs/{id}`: owner一致を確認し状態を返す。
- `DELETE /api/jobs/{id}`: owner一致なら対象ジョブだけcancel、他ownerは404として情報を漏らさない。
- `GET /api/fleet`:全GPUの統一スナップショット。既存フィールドを維持する。
- `/comfy/*`: HTTP/WebSocket reverse proxy。ただしUIの通常生成・停止は上記APIを使用する。

入力サイズ、JSON深度、タイムアウトを制限する。プロンプト本文は通常ログへ出さず、job ID、owner IDの短縮値、遷移、所要時間だけを記録する。

## Process lifecycle, watchdog, and logs

`frameweaverd`自身はWindows Scheduled Taskでログオン時に起動し、失敗時再起動を3回・1分間隔で設定する。daemonはComfyUIを所有するのではなく、既存ComfyUI Scheduled Taskを監視する。無断で再起動は行わず、healthへ障害を反映する。将来の明示的管理モード用インターフェースだけ分離する。

ログは`%LOCALAPPDATA%/FrameWeaver/logs/`へJSON Linesで出力し、日次または10MiBでローテーション、7日保持とする。

- daemon起動/正常終了/panic
- listen失敗、DB migration失敗
- ComfyUI healthのup/down遷移
- proxy接続失敗、WebSocket切断理由
- job状態遷移、cancel結果、orphan回収
- shutdown signalと終了コード

`/api/health`は2秒以内に返し、ComfyUI確認は短いキャッシュを使って画面要求をブロックしない。8188停止時も静的UIと台帳閲覧は生存する。

## Fleet telemetry and VRAM

VRAM表示の正は`GET /api/fleet`だけとし、`generation.ts`の`/system_stats`ポーリングとストア内`vram`を削除する。ローカルはNVML利用を第一候補とし、NVMLロード不能時だけ`nvidia-smi`へフォールバックする。遠隔ノードは現行SSH採取を維持し、15秒キャッシュ、3秒タイムアウト、同時実行抑止を行う。

- ローカル採取2秒、遠隔15秒、ブラウザ表示2秒。
- `sampleIntervalMs`、`collectedAt`、`ageMs`、`stale`を明示する。
- 前回正常値と現在の到達性を分離し、古い値を現在値として見せない。
- UIで「GPU全体使用量」であることを維持し、ComfyUI専有量とは表現しない。

## Mobile UI

幅640px未満ではGPU監視を初期状態で折り畳み、見出しにオンライン数・合計使用VRAM・最古サンプル時刻だけを表示する。入力タブと生成フォームをGPU詳細より上に置く。展開状態はそのタブ内だけで保持し、デスクトップでは常時展開する。主要操作のタップ領域を最低44pxにし、固定Generate barとコンテンツ末尾の余白を一致させる。

## Custom-node profiles

ComfyUI起動引数のプロファイルをリポジトリ内の宣言ファイルで管理する。

- `minimal`: 全custom node無効。health/台帳/基本接続診断用。
- `image`: FrameWeaver画像生成に必要なallowlistだけ。
- `video`: H3動画生成に必要なallowlistだけ。
- `full`: 現行互換。開発・手動検証専用。

既定は`image`ではなく、現行生成互換性を失わない`full`のままとする。各profileは`--whitelist-custom-nodes`へ展開し、存在しないノード、import失敗、重複を診断コマンドで報告する。profile切替はComfyUI再起動を伴うため今回のWeb UIからは操作できない。

## Rollout and rollback

1. 現行Vite常駐を残したまま、Rust daemonを別ポート`15180`でshadow起動する。
2. unit/integration tests、静的配信、API、WebSocket proxy、SQLite再起動復旧を確認する。
3. Tailnet外へ公開せず、localhostで画像smoke jobを作成・完了・履歴取得する。
4. 異なるownerで停止拒否、同ownerで対象ジョブだけ停止を確認する。
5. 操作者承認後だけScheduled TaskとTailscale Serveの転送先を切り替える。

切替前のVite用Scheduled Task定義とServe設定を保存する。失敗時は転送先とTask actionを元へ戻せば、DBやComfyUIを変更せず復旧できる。既存ポート5180、8188、Tailnet URLは最終的に維持する。

## Verification gates

- Rust: format、clippy warnings-as-errors、unit/integration tests。
- UI: Vitest、Oxlint、TypeScript build。
- Contract: owner分離、targeted cancel、SQLite再起動復旧、orphan回収。
- Runtime: 15180でhealth、static asset、HTTP proxy、WebSocket接続。
- Browser: 390x844とdesktopで入力順序、折り畳み、44px操作、生成状態。
- Generation: 最小画像1件。動画は既知のH3安定性問題と分離し、daemonの完了条件にはしない。
- Cutover: 同一Tailnetのスマホから既存URLで表示、監視、画像生成、履歴、対象停止を一気通しで確認する。

## Deferred P2

- Discord OAuth allowlistの本番有効化とowner binding。
- GPU capability registry、scheduler、wake/power control、モデル配置制約付きrouting。
- 複数ComfyUIを単一ワークフローの分散GPUとして扱う機能。
- Tauri管理コンソール。
