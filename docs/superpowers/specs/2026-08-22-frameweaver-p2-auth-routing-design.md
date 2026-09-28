# FrameWeaver P2 Discord Authentication and GPU Routing Design

## Purpose

FrameWeaverをTailnet内の複数利用者へ安全に提供する。Discord user IDの明示allowlistだけを認証主体として受け入れ、認証済み主体をジョブ所有者へサーバー側で結び付ける。同時に、画像・動画・アップスケールを4090、5060 Ti、3070、2070の独立ComfyUI workerへ配送できるようにする。

P0/P1のジョブ台帳、対象ジョブだけを停止する契約、統一telemetry、ビルド済みUI、watchdogは維持する。P2はこの境界へ認証とworker選択を追加し、ブラウザ指定のowner UUIDを信頼しない。

## Scope

### Included

- Discord OAuth2 Authorization Code Grantによるログイン。
- Discord `identify` scopeから得たuser IDの完全一致allowlist。
- SQLite session、Secure cookie、CSRF `state`、callback再利用防止。
- Discord主体から内部`owner_id`への決定的なサーバー側binding。
- worker registry、明示GPU選択、用途別capability、保守的なAuto選択。
- worker別job送信、状態取得、対象job停止、出力取得。
- 認証、認可、ルーティング、障害、UIの自動テスト。
- repository全体の依存監査、secret scan、認可境界とproxyの脆弱性診断。
- GitHub Pull Request。

### Excluded

- 複数GPUのVRAMを単一ComfyUIプロセスへ合算する分散推論。
- 公開インターネットへの直接公開。
- Discord guild roleや過去メッセージを用いた認可。
- 管理UIからのallowlist編集。
- 自動モデル配布、課金、優先度課金、NSFW判定。
- 複雑な最適化solver、学習型scheduler、汎用cluster orchestrator。

## Security Boundary

Tailscaleは到達制御、Discord OAuthは利用者認証、FrameWeaver allowlistはアプリ認可を担当する。三者を代替関係として扱わない。

認証有効時、次の経路だけを未認証で許可する。

- `GET /api/health`
- `GET /auth/login`
- `GET /auth/callback`
- 認証画面に必要なhashed static assets

その他の`/api/*`、`/comfy/*`、WebSocket、SPA画面は有効sessionを要求する。認証無効モードは開発・既存rollback用に残すが、production launcherは明示設定を要求し、設定不備ではfail-closedにする。

ブラウザの`X-FrameWeaver-Owner`は認証有効時に無視する。内部`owner_id`はDiscord user IDをdomain-separated hashへ変換した安定UUIDとし、生のDiscord IDをjobs tableへ保存しない。監査ログにはuser IDやtokenを出さず、owner短縮識別子だけを記録する。

## Discord OAuth Flow

1. `GET /auth/login`は256-bit以上のランダム`state`を生成する。
2. `state`は短寿命・一回限りとしてSQLiteへhash保存し、ブラウザへsame-site binding cookieを返す。
3. Discord authorization endpointへ`response_type=code`、`scope=identify`、正確な`redirect_uri`、`state`を付けてredirectする。
4. callbackはquery size、`code`、`state`、cookie、expiry、未使用を検証する。検証前にtoken exchangeを行わない。
5. codeをDiscord token endpointで交換し、Bearer tokenを使って`GET /users/@me`を一度取得する。
6. user IDをcanonical decimal snowflakeとして検証し、`DISCORD_ALLOWED_USER_IDS`の完全一致集合へ照合する。
7. 許可された場合だけopaque session IDを作成し、session hash、owner UUID、expiryをSQLiteへ保存する。
8. OAuth access tokenはuser取得後に破棄し、DB・cookie・ログへ保存しない。
9. callback stateは成功・失敗を問わず消費し、再利用を拒否する。
10. session cookieは`HttpOnly; Secure; SameSite=Lax; Path=/`、固定寿命、rotation可能なserver secretで保護する。

Logoutはsession rowを失効させcookieを削除する。allowlistから削除された利用者は、次のrequestで再照合されsession期限を待たず拒否される。

## Configuration and Secret Handling

productionで必要な設定:

- `DISCORD_AUTH_ENABLED=1`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI=https://rtx4090.tail37947a.ts.net:10000/auth/callback`
- `DISCORD_ALLOWED_USER_IDS`（comma-separated decimal IDs）
- `FRAMEWEAVER_SESSION_SECRET`（32 bytes以上のランダム値）

秘密値は`.env`、tracked file、Markdown、test fixture、process argumentへ書かない。productionでは既存envまたは`op://`参照からlauncher process environmentへ渡す。起動時はclient ID、secret、redirect URI、allowlist、session secretを検証し、欠落・空集合・重複・不正ID・HTTP redirect URIでは起動しない。

## Session Storage

SQLiteへOAuth stateとsessionのmigrationを追加する。

`oauth_states`:

- `state_hash` primary key
- `binding_hash`
- `expires_at`
- `consumed_at`

`sessions`:

- `session_hash` primary key
- `owner_id`
- `discord_user_hash`
- `created_at`
- `expires_at`
- `revoked_at`

raw state、raw session token、Discord access token、Discord user IDは保存しない。lookup可能な値はkeyed hashにする。expired rowはrequest pathをブロックせずbounded cleanupする。

## Worker Architecture

各GPUは独立ComfyUI workerであり、1 jobは常に1 workerへ属する。

初期registry:

| worker | GPU | Roles | Default availability |
|---|---|---|---|
| `rtx4090` | RTX 4090 24 GB | image, video, upscale | fallback/manual |
| `rtx5060ti` | RTX 5060 Ti 16 GB | image, video, upscale | preferred |
| `nicolas2025` | RTX 3070 8 GB | image, light-video, upscale | available |
| `nicoyuri` | RTX 2070 8 GB | image, light-video, upscale | available |

worker APIは各machineのloopbackで待受し、Tailscale Serveまたは明示Tailnet endpointだけから到達させる。control planeとworkerの通信にはworkerごとのcredentialを用い、ブラウザへendpointやcredentialを返さない。workerはhealth、capabilities、submit、status、targeted cancel、viewだけを提供し、global queue clear、global interrupt、任意filesystem操作は提供しない。

worker deploymentはmachineごとに独立rollback可能にする。他machineの永続Task、Tailscale Serve、credential設定は適用前に対象とrollbackをreadbackする。

## Job Routing

job requestへ`worker_preference`を追加する。値は`auto`またはregistryのworker IDだけを許可する。サーバーは認証済みowner、用途、workflow requirement、worker snapshotから配送先を決め、決定した`worker_id`をjobs rowへ永続化してからsubmitする。

明示選択:

- offline、stale、capability不一致、推定VRAM不足は409/503で拒否し、別workerへ黙って配送しない。

Auto選択:

1. onlineかつfresh。
2. required roleを持つ。
3. 推定必要VRAMに安全余裕を加えて空きがある。
4. 4090以外を優先する。
5. 適格候補のうち空きVRAM、queue depth、安定性の固定順で決定する。
6. 適格workerがなければ4090を評価し、それでも不適格なら503にする。

初期versionは静的なworkflow profileごとのVRAM requirementを使う。曖昧なworkflowを楽観的に配送しない。配送後のstatus、cancel、outputはjobs rowの`worker_id`だけを参照し、client指定先へ切り替えない。

## UI

- 未認証時はDiscord login画面だけを表示する。
- allowlist拒否、session期限切れ、Discord障害を区別して表示するが内部詳細やuser IDを出さない。
- login後のheaderに表示名・logoutを置く。avatarは初期versionでは取得・保存しない。
- Generate入力近くに`Auto / 5060 Ti / 3070 / 2070 / 4090` selectorを置く。
- 各選択肢へonline、freshness、空きVRAM、対応用途を表示する。
- mobileではselectorと入力を上部に保ち、詳細telemetryは既存どおり折り畳む。
- job historyへ実際のworkerを表示する。
- 401はloginへ、403はallowlist拒否へ、409は選択worker不適合、503は利用可能workerなし、502/504はworker障害として復旧可能な文言を出す。

## Error Handling and Observability

外部Discord request、worker request、SQLite操作には個別timeoutを設ける。retryはGETまたは安全なidempotency key付きsubmitに限定する。OAuth callback、cancel、状態遷移を盲目的にretryしない。

構造化イベント:

- `auth_login_started`
- `auth_callback`（allowed/denied/state_invalid/upstream_error）
- `session_created` / `session_revoked` / `session_expired`
- `routing_decision`
- `worker_submit` / `worker_timeout` / `worker_cancel`

eventにはtoken、code、cookie、state、Discord ID、prompt、workflowを含めない。request ID、owner短縮値、worker ID、result、durationだけを許可する。

## Automated Verification

### Authentication and authorization

- 未認証API、SPA、WebSocketが401またはlogin redirect。
- healthとlogin assetだけが未認証で利用可能。
- valid state、state不一致、期限切れ、callback再利用、binding cookie欠落。
- token exchange 4xx/5xx/timeout、malformed user payload。
- allowlist内、allowlist外、起動後allowlist削除。
- session cookie改ざん、期限切れ、logout、revocation。
- clientのowner header偽装がjobs/history/cancelへ影響しない。
- owner Aからowner Bのjobが404となる。

### Routing and failures

- 明示worker成功、unknown worker、offline、stale、role不一致、VRAM不足。
- Autoが5060 Tiを4090より優先する。
- 5060 Ti不適格時だけ4090 fallback。
- worker timeout、malformed response、submit failure、status disconnect。
- worker Aのjobをworker Bへcancelしない。
- restart recoveryが永続worker IDを使う。
- idempotency keyでsubmit重複を防止する。

### UI E2E

PlaywrightでDiscord mock serverとworker mockを用意し、実secretやDiscord accountを使わずCIで再現する。

- login redirect、callback、許可、拒否、logout。
- GPU selector、Auto決定表示、job history worker表示。
- 401、403、409、502、503、504とnetwork断のerror UI。
- desktopとmobileの主要flow、keyboard操作、accessible name、focus。
- page identity、blank page、framework overlay、console error、asset load。

本番Discord smokeはoperatorの許可されたIDだけで行い、CIとは分離する。

### Security gates

- `cargo fmt`, `cargo clippy -D warnings`, Rust tests。
- Vitest、lint、production build。
- Pester lifecycle/cutover/profile tests。
- Playwright Chromium desktop/mobile。
- `cargo audit`、`npm audit`。
- tracked secret pattern scan。
- 認証bypass、CSRF、open redirect、session fixation、IDOR、SSRF、proxy traversal、oversized body、rate abuseを対象にrepository全体を診断する。

## Extensibility Rules

- Discord protocol、session store、auth middleware、worker client、routing policy、React API clientを別moduleにする。
- route handlerはpolicyを直接実装せず、typed serviceを呼ぶ。
- worker固有差分はregistry/capabilityへ閉じ込め、UIへhostnameやURLをhardcodeしない。
- 新しいworker、role、routing metricは既存job APIを破壊せず追加できる。
- test fixtureは実Discord/Comfy payload shapeを完全に模倣し、production codeへtest-only hookを入れない。
- P2のために汎用IAM、Kubernetes、message broker、distributed databaseは導入しない。

## Deployment and Rollback

1. migrationとdaemonをshadow portで検証する。
2. auth disabled互換modeで既存P0/P1回帰を通す。
3. Discord credentials、allowlist、session secretを既存secret経路へ設定する。
4. callback URLとTailnet HTTPSをreadbackする。
5. auth enabled shadow E2Eを通す。
6. control planeをsame-name Taskでcutoverする。
7. workerは1台ずつreadback、smoke、rollback artifactを作成して追加する。

rollbackはP1 daemon/task XMLとdatabase backupへ戻す。新migrationは破壊的down migrationを行わず、旧binaryが追加table/columnを無視できる形にする。worker追加失敗はそのworkerをregistryから無効化し、既存4090経路を保持する。

## Pull Request Acceptance

- 設計・実装・migration・運用手順が同一branchにある。
- 全自動gateがgreen。
- 実secret、user ID、token、生成promptがdiffとartifactにない。
- auth enabled時の本番smokeと少なくとも1 remote worker smokeを証跡化する。
- repository全体のsecurity reportでCritical/Highが未解決でない。
- UI/機能追加の責務境界レビューでCritical/Importantが未解決でない。
- PR本文に検証済み、未検証、rollback、残余リスクを分けて記載する。
