# ノード能力・モデル適合度設計

## 目的

FrameWeaverを異なるGPU・統合メモリ構成のマシンへ同じコードで配置し、各ノードが利用可能なモデルと推奨設定を自己診断できるようにする。優先順位は高速化、軽量化、安定化の順とし、自動ジョブ移送や中央クラスタを先に導入しない。

## 実測ベースライン

2026-08-24の読み取り専用プローブでは、物理6ノードの計算資源は次の階層だった。公開文書にはTailnet名、IP、ユーザー名を保存しない。

| ノード階層 | メモリ | 観測状態 |
|---|---:|---|
| CUDA high | VRAM 24GB / RAM 128GB | ComfyUI ready、モデルAPI ready |
| CUDA mid | VRAM 16GB / RAM 64GB | ComfyUI ready、限定モデル在庫 |
| CUDA light x2 | VRAM 8GB / RAM 64GB | 一方はlistenerのみ、他方はComfyUI停止 |
| Apple Silicon high | 統合メモリ 64GB | クライアント・ローカルLLM用途 |
| Apple Silicon light | 統合メモリ 16GB | クライアント・軽量LLM用途 |

全Windows GPUノードで`training=false`を確認した。稼働状態はスナップショットであり、ルーティング判断には取得時刻と鮮度が必須である。

## 検討した方式

### A. 各ノード自己診断＋決定論的ランキング（採用）

各FrameWeaverが同一オリジンのComfyUIだけを診断し、共通の`NodeCapabilitySnapshot`へ正規化する。モデル適合度は副作用のない関数で計算する。既存の「GPUノードごとの独立URL」を維持するため、ネットワーク往復、認証面、障害範囲が最小になる。

### B. 中央コントロールプレーン

中央APIが全ノードを常時監視し、共有キューとジョブ配送を行う。最終形には適するが、ジョブ所有権、認証、再試行、二重実行防止、永続台帳が必要になる。現在のモデル探索を改善するには過剰なので今回は実装しない。

### C. ブラウザから全ノードへ直接接続

ブラウザが複数のTailnet URLを同時にポーリングする。サーバー追加は不要だが、CORS、証明書、端末ごとの到達差、接続先情報の露出が増える。安定化要件に反するため採用しない。

## アーキテクチャ

```text
ComfyUI system_stats / object_info
              │
              ▼
   capability collector
   - single-flight
   - timeout
   - schema normalization
              │
              ▼
 NodeCapabilitySnapshot ─── ModelCatalog
              │                  │
              └──── rankModels() ┘
                         │
                         ▼
          推奨 / 実行可 / 注意 / 利用不可
```

収集、モデル定義、順位付け、表示を分離する。UIとZustandは計算ロジックを持たず、スナップショットとランキング結果だけを保持する。

## データ契約

### NodeCapabilitySnapshot

- `capturedAt`: ISO 8601取得時刻
- `status`: `ready | degraded | unavailable | stale`
- `accelerator`: `cuda | mps | cpu | unknown`
- `memory`: VRAM総量・空き量、または統合メモリ総量
- `queueRemaining`: ComfyUIキュー長。取得不能なら`null`
- `inventory`: checkpoint、UNet、CLIP、VAE、LoRAの正規化済みファイル名
- `features`: 必要なComfyUIノードクラスの有無
- `errors`: 表示可能な短い診断コード。生レスポンスや秘密情報は含めない

未知フィールドは無視し、必須値欠落は`degraded`へ落とす。最後に成功した値は保持するが、取得後60秒で`stale`とし、推奨根拠へ使わない。

### ModelCatalogEntry

- `id`、表示名、用途（image / video / upscale / llm）
- 必須モデルファイル群とファイル名alias
- 最小VRAM、推奨VRAM、対応accelerator
- 推奨解像度・stepsの上限
- 必須ComfyUIノードクラス
- 品質、速度、メモリ効率の相対特性

カタログはTypeScriptの静的データとし、外部レジストリや新規依存は追加しない。未知モデルは在庫には表示できるが、適合度は`unknown`とする。

## モデル探索と順位付け

`rankModels(snapshot, catalog, task)`は次の順で決定する。

1. 必須ノードクラスとモデルファイルが揃わない候補を`unavailable`にする。
2. accelerator非対応または最小メモリ未満を`unavailable`にする。
3. スナップショットがstale、APIがdegraded、学習中などの状態を減点する。
4. 推奨メモリを満たす既導入モデルを最上位にする。
5. 同点では速度、メモリ効率、品質の順で安定ソートする。

ランキングは必ず理由コードを返す。例: `installed`、`recommended-memory`、`low-free-vram`、`missing-clip`、`stale-capability`。自動的に別ノードへ送信せず、実行対象は現在開いているFrameWeaverだけに限定する。

## 高速化・軽量化

- 現在の5秒固定VRAMポーリングを適応型へ変更する。
  - 生成中かつ表示中: 2秒
  - idleかつ表示中: 10秒
  - background: 60秒、または`visibilitychange`まで停止
- 同じ取得処理を重ねないsingle-flightと2秒timeoutを入れる。
- モデル在庫は初回接続、再接続、手動更新時だけ取得し、VRAMポーリングへ混ぜない。
- 初期画面は能力収集を待たず表示し、探索結果は後から更新する。
- 新しい常駐プロセス、データベース、状態管理ライブラリを追加しない。

## 安定化

- HTTP 200でもJSON形式が不正なら`degraded`とする。
- ComfyUI停止時は最後の在庫を表示できるが、実行ボタンの可否判定には使わない。
- 複数GPUレスポンスを配列として保持し、先頭GPU固定をやめる。初期版の実行対象はComfyUIが選んだprimary deviceとする。
- listener存在とAPI readyを区別する。
- 収集エラーで既存の生成ストア全体をerrorへ遷移させない。
- スナップショットにはホスト名、Tailnet名、IP、ユーザー名を必須項目として持たせない。

## UI

画像・動画のモデル選択部に、現在ノード向けの状態バッジを追加する。

- `推奨`: 導入済みで推奨メモリを満たす
- `実行可`: 導入済みで最小メモリを満たす
- `注意`: VRAM不足、stale、またはAPI degraded
- `未導入`: 必須ファイル不足

詳細理由は展開時だけ表示し、スマホでは既定で折り畳む。全ノード統合ダッシュボードや自動ルーティングUIは追加しない。

## テスト設計

### 自動テスト

- 24GB、16GB、8GB、Apple統合メモリのfixtureでランキング順と理由を固定する。
- モデルファイルalias、大文字小文字、Windowsのバックスラッシュを正規化する。
- system_statsの欠落、複数GPU、不正JSON、timeout、HTTP failureを検証する。
- fake timerでactive / idle / backgroundのポーリング間隔とsingle-flightを検証する。
- カタログの全項目が一意ID、正のメモリ値、既知taskを持つことを検証する。
- 既存の`npm test`、`npm run lint`、`npm run build`をCIの必須ゲートにする。

### 実環境テスト

- `scripts/verify-runtime.mjs --base-url <url>`を追加し、HTML、system_stats、必要object_infoを読み取り専用で検証する。
- Tailnet内の物理6ノードは、到達性と能力取得を別母数で報告する。
- ComfyUI停止ノードは「到達失敗」ではなく`unavailable`の期待ケースとして検証する。
- 最小生成テストはreadyなGPUノードだけで固定seed・低解像度を使い、生成経路を変更した場合に限って実施する。

## 成功条件

- 既存モデルを現在ノードの適合度順で決定論的に表示できる。
- API停止、不正値、VRAM不足をUIクラッシュなしで説明できる。
- idle時のVRAMリクエスト回数を現行の毎分12回から毎分6回以下へ半減する。
- backgroundでは毎分1回以下にする。
- 新規npm依存0、常駐プロセス0、秘密情報の公開差分0を維持する。
- fixture、統合検証CLI、既存CIの三段階で再現可能にテストできる。

## 非目標

- 自動ジョブルーティング、共有キュー、ジョブ移送
- モデルの自動ダウンロード・削除・同期
- Tailscale ACL、Serve、SSH、自動起動の変更
- macOSへComfyUIやモデルを自動配備
- ベンチマーク結果だけでモデル品質を自動決定すること

これらは`NodeCapabilitySnapshot`を入力にする別フェーズとして追加できる。
