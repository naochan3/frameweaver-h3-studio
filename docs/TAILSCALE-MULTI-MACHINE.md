# Tailscale・複数マシン構成

FrameWeaverをインターネットへ公開せず、同じtailnetに参加したPC・Mac・スマートフォンから使うための構成です。

## 対応範囲

| 構成 | 状態 |
|---|---|
| 複数のブラウザ端末 → 1つのFrameWeaver URL | 対応済み |
| 1つのFrameWeaver → 同じGPU PC上の1つのComfyUI | 対応済み |
| 複数GPU PC → GPU PCごとの独立URL | 対応済み |
| 1つの共有キューからGPUを自動選択 | 未実装 |
| ノード間のモデル同期・ジョブ移送 | 未実装 |

現行 `main` はGPUクラスタのスケジューラーではありません。複数GPU PCを使う場合は、各PCでFrameWeaverとComfyUIを起動し、用途別のURLとして使い分けます。

## 推奨トポロジー

```text
Windows / macOS / iPhone / Android
                │
          Tailscale HTTPS
                │
      FrameWeaver :10000 (Serve)
                │ loopback proxy
      FrameWeaver :5180
          ├─ /comfy/*    → ComfyUI :8189
          └─ /rewriter/* → Ollama :11434
```

ComfyUIとOllamaの管理ポートは直接tailnetへ公開せず、FrameWeaverが許可した経路だけを使います。

## 1. ローカルで起動確認

FrameWeaverを起動し、ホストPCで確認します。

```powershell
start_studio.bat
Invoke-WebRequest http://127.0.0.1:5180 -Headers @{ Accept = 'text/html' }
```

期待結果はHTTP 200と `<title>FrameWeaver H3 Studio</title>` です。先にローカルを緑にしてからTailscaleを設定します。

## 2. Tailscale Serve

Tailscaleへログイン済みのホストPCで実行します。

tailnetだけに限定したい場合は、WebUIをloopback待受で起動します（通常の `npm run dev` はLANからも接続できる設定です）。

```powershell
npm run dev -- --host 127.0.0.1
```

```powershell
tailscale serve --bg --https=10000 http://127.0.0.1:5180
tailscale serve status
```

表示されたURLを使います。

```text
https://<device>.<tailnet>.ts.net:10000/
```

`tailscale serve` はtailnet内限定です。公開インターネットへ出す `tailscale funnel` は、この用途では使用しません。HTTPSが未設定のtailnetでは、初回だけTailscaleの案内に従って証明書発行を有効化します。

設定を外す場合:

```powershell
tailscale serve --https=10000 off
```

## 3. 別デバイスから確認

別PC・Macでは次を実行します。

```bash
curl -fsS -H 'Accept: text/html' -o /dev/null \
  -w 'HTTP %{http_code} in %{time_total}s\n' \
  https://<device>.<tailnet>.ts.net:10000/
```

スマートフォンでは、Tailscaleが接続済みであることを確認してからURLをブラウザで開きます。

| 確認対象 | 合格条件 |
|---|---|
| HTML | HTTP 200、タイトル表示 |
| JS/CSS | HTTP 200、画面が白紙にならない |
| ComfyUI | ヘッダーが接続済み、または `/comfy/system_stats` が成功 |
| PC/Mac | 入力、テーマ切替、生成操作が使える |
| スマホ | 横スクロールなし、入力と生成ボタンが表示される |
| 再接続 | Tailscale再接続後も同じMagicDNS URLで開ける |

## 4. GPU PCを増やす

各GPU PCで同じ手順を実行し、URLを用途別に管理します。

| 例 | 用途 |
|---|---|
| `https://<image-node>.<tailnet>.ts.net:10000/` | 画像生成 |
| `https://<video-node>.<tailnet>.ts.net:10000/` | 動画生成 |
| `https://<upscale-node>.<tailnet>.ts.net:10000/` | アップスケール |

各インスタンスのキュー、モデル、履歴、VRAMは独立しています。モデルファイルをネットワーク越しに直接共有すると、ロード時間と障害範囲が増えるため、まずは各GPU PCのローカルSSDへ置く構成を推奨します。

## 5. 検証チェックリスト

- [ ] ホストPCの `127.0.0.1:5180` がHTTP 200
- [ ] `tailscale status` でホストとクライアントがonline
- [ ] `tailscale serve status` が `127.0.0.1:5180` を指す
- [ ] 別PCまたはMacからHTMLとJS/CSSがHTTP 200
- [ ] スマートフォンからUIが表示される
- [ ] ComfyUI接続状態とVRAM表示が更新される
- [ ] 画像の最小生成を1件完了できる
- [ ] 停止とVRAM解放が対象インスタンスだけに作用する
- [ ] GPU PCごとのURL、モデル、空き容量を運用表へ記録した
- [ ] Tailscale ACLで利用者・端末の範囲を確認した

## トラブルシュート

| 症状 | 確認 |
|---|---|
| ホストでも開かない | FrameWeaverプロセス、5180 listener、起動ログ |
| ホストでは開くがtailnetから開かない | `tailscale status`、`tailscale serve status`、HTTPS有効化、ACL |
| 名前だけ解決しない | MagicDNS、端末のTailscale接続、DNSキャッシュ |
| UIは出るがComfyUI未接続 | ComfyUIの8189、`/comfy/system_stats`、proxy設定 |
| 1台だけ遅い | そのGPU PCのVRAM、RAM、SSD、ComfyUIキューを個別確認 |

Tailscale Serveの現行仕様は、[公式Serveドキュメント](https://tailscale.com/docs/features/tailscale-serve)と[CLIリファレンス](https://tailscale.com/docs/reference/tailscale-cli/serve)を参照してください。
