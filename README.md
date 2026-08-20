# FrameWeaver H3 Studio

ローカルPC(RTX 4070 12GB / RAM 64GB)で動く **動画+画像生成スタジオ**。
ComfyUI をバックエンドに、**MiniMax H3**(動画+音声)、**Z-Image Turbo** / **Krea 2 Turbo**(画像)を1つのWebUIから使えます。

- 動画: Text / First / First+Last / Last / Reference の5モード(すべて音声同時生成)
- 画像: Z-Image Turbo(万能・約10秒) / Krea 2 Turbo(実写・iPhone写真風)切替
- NSFWトグル(無検閲テキストエンコーダ切替)、Turbo LoRA高速化、進捗+残り時間表示、生成履歴、使い方ガイド内蔵

---

## 起動方法

### 一番かんたん(ダブルクリック)

```
start_studio.bat
```

ComfyUIバックエンド(127.0.0.1:8189)とWebUI(http://localhost:5180)が別ウィンドウで立ち上がり、ブラウザが自動で開きます。ComfyUIはlocalhost限定、WebUIはLAN内から開けます(下記「スマホから開く」参照)。

### 手動起動

```powershell
# 1. バックエンド
powershell -ExecutionPolicy Bypass -File C:\AI\ComfyUI_H3\start.ps1
# 2. WebUI(このフォルダで)
npm run dev
# 3. ブラウザで http://localhost:5180
```

終了はそれぞれのウィンドウを閉じるだけ。生成を止めたいだけならWebUIヘッダーの「停止」、VRAMを空けたいときは「解放」。

### 同じWi-Fi(LAN)内のスマホ・タブレットから開く

WebUIは `0.0.0.0` で待ち受けているので、**同じネットワークの別端末のブラウザ**から次のURLで開けます(PCのIPは環境で変わる。現在は `192.168.3.42`):

```
http://192.168.3.42:5180
```

- ブラウザ→ComfyUIの通信はViteの `/comfy` プロキシ経由でPCに中継されるため、**別端末側で追加設定は不要**(スマホで開くだけで繋がる)。
- PCのIPは `ipconfig`(または `Get-NetIPAddress`)で確認。ルーターのDHCP次第で変わることがある。
- **初回はWindowsファイアウォールの許可が必要**な場合があります。スマホから開けないときは、管理者権限のPowerShellで一度だけ次を実行(ポート5180をLAN内に開放):
  ```powershell
  New-NetFirewallRule -DisplayName "FrameWeaver WebUI 5180" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5180 -Profile Private
  ```
- 公開範囲はLAN内のみ(インターネットには出しません)。外に出したい場合は別途トンネル等が必要。

---

## 構成

| 役割 | 場所 | 備考 |
|---|---|---|
| WebUI(本体) | このフォルダ(Vite + React) | port 5180 |
| ComfyUI バックエンド | `C:\AI\ComfyUI_H3\ComfyUI` (v0.33) | port 8189、`--disable-pinned-memory` 必須 |
| モデル置き場 | `C:\AI\ComfyUI_Data\models\` | 既存のComfyUI Desktopと共有(`extra_model_paths.yaml`) |
| 生成物の出力先 | `C:\AI\ComfyUI_H3\ComfyUI\output\` | `video/` `zimage/` `krea2/` に分かれる |
| サンプル(証明) | `samples/` | 生成記録は `samples/README.md` |

**既存の ComfyUI Desktop(port 8188)には一切手を加えていません。** モデルフォルダへ新規ファイルを追加しただけです。

---

## 必要モデル一覧と配置場所

すべて `C:\AI\ComfyUI_Data\models\` 配下。導入済み。

### 動画: MiniMax H3(`Comfy-Org/MiniMax-H3` より)

| ファイル | 配置 | サイズ |
|---|---|---|
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | diffusion_models/ | 21GB |
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | diffusion_models/ | 21GB |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`(通常エンコーダ) | text_encoders/ | 15.7GB |
| `qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors`(**NSFW用**、`Momoking/Qwen3-VL-32B-Heretic-MiniMax-H3-NVFP4`) | text_encoders/ | 15.7GB |
| `minimax_h3_video_vae_fp16.safetensors` / `minimax_h3_audio_vae_fp32.safetensors` | vae/ | 5.2GB / 605MB |
| `minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors`(既定Turbo) | loras/ | — |
| `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors`(Reference用Turbo) | loras/ | — |
| `minimax_h3_turbo_v4_step600_ema.safetensors`(larryvrh版・任意) | loras/ | 780MB |

### 画像

| モデル | ファイル | 配置 |
|---|---|---|
| Z-Image Turbo | `z_image_turbo_nvfp4.safetensors` / `qwen_3_4b.safetensors` / `ae_zimage.safetensors` | diffusion_models / text_encoders / vae |
| Krea 2 Turbo (`Comfy-Org/Krea-2`) | `krea2_turbo_fp8_scaled.safetensors`(12.2GB) / `qwen3vl_4b_fp8_scaled.safetensors`(4.9GB) / `qwen_image_vae.safetensors`(242MB) | 同上 |

### モデルをAI(FABLE等)にダウンロードさせる場合の注意

- **リポジトリ名を記憶で書かせない。** HuggingFace API(`/api/models/<repo>/tree/main`)でファイル実在を確認してからDLさせること(過去に記憶ベースのリポ名指定で401を繰り返した実績あり)。
- uncensored系・LoRA系は**テイクダウンで消えることがある**。必要なものは早めにローカル保存。
- DLはRAM/帯域と競合するので、生成テストと同時に走らせるなら1本ずつ。

---

## 使い方

初回アクセス時に**使い方ガイド**(アニメーション付き8ステップ)が自動表示されます。ヘッダーの「使い方」からいつでも再表示できます。

### 動画生成の流れ

1. 上部タブで「動画生成」→ モード選択(Text/First/First+Last/Last/Reference)
2. SCENE にプロンプト(自然文で「誰が・どこで・何をする+カメラ+音」)
3. First系/Reference は SOURCE に画像をドラッグ&ドロップ(Referenceは最大9枚、プロンプトから `<Picture 1>` で参照)
4. RECIPE でアスペクト比×画質・長さ・Turbo・シードを設定 → 生成を開始
5. 右のOUTPUTに進捗・**残り時間**・完成動画。履歴から過去分も開ける

### NSFWの使い方

- RECIPE の **NSFWモード** トグルをONにすると、テキストエンコーダが無検閲版(Heretic、refusal 99→4/100)に切り替わります。
- 切替後の1回目はモデル再読込のため+1〜2分かかります。頻繁にON/OFFを切り替えるとその都度再読込が走るので、NSFWセッションはまとめて行うのが効率的。
- 注意: MiniMax H3のライセンスには「セーフガード回避の禁止」条項があり、NSFW利用は厳密にはグレーです(日本は利用許諾地域内)。**生成物の公開・商用利用は自己責任で。** 未成年表現は絶対に不可。

### 画像生成の流れ

1. 「画像生成」タブ → モデル選択(Z-Image / Krea 2)
2. プロンプト(実写なら `iPhone photo` / `realistic skin texture` / `full body` 等が有効)
3. アスペクト比(TikTok素材は9:16)×画質 → 生成(Z-Imageなら約10秒)
4. できた画像は動画タブの First / Reference の素材に流用可能(Motion Sync用の元画像づくり)

---

## 12GB VRAM向け推奨設定(実測ベース)

| 用途 | 設定 | 目安時間 |
|---|---|---|
| 動画・試行錯誤 | 0.4〜0.5MP / 5秒 / Turbo ON(5 steps) | **約2分/本** |
| 動画・本番 | 1.0MP / Turbo ON | 5〜10分/本 |
| 動画・最高品質 | 1.3MP(上限) / Turbo OFF(20 steps) | 20分超/本 |
| 画像(Z-Image) | 9:16 1.3MP / 8 steps | 約12秒/枚 |

- **1.3MP超は選択不可にしてある**(2Kは二重スワップで1ステップ35分になり非実用、実測記事より)。
- 固定シードでも**解像度を変えると動きが変わる**。低解像度で当たりを探して高解像度で清書、は完全再現ではない点に注意。
- 生成が異常に遅い場合はヘッダー「解放」でモデルをアンロードしてから再実行。

---

## よくあるエラーと対処

| 症状 | 原因 | 対処 |
|---|---|---|
| ヘッダーが「ComfyUI 未接続」のまま | バックエンド未起動 / CORS | `start_studio.bat` で起動。`start.ps1` の `--enable-cors-header "http://localhost:5180"` を消さないこと |
| 生成開始直後にエラー(node_errors) | モデルファイル不足 | 上の一覧のファイルが揃っているか確認。追加直後はComfyUI再起動が確実 |
| OOM / プロセスが落ちる | pinned memory | `start.ps1` の `--disable-pinned-memory` が付いているか確認(必須) |
| 生成が途中から極端に遅い | RAM逼迫→SSDスワップ | 解像度を下げる。他の重いアプリを閉じる。「解放」でアンロード |
| NSFW ONで生成が変わらない | エンコーダ未DL | text_encoders に heretic ファイルがあるか確認 |
| ポート8188と競合? | しない | 本スタジオは8189。既存ComfyUI Desktop(8188)と共存可(同時のGPU使用は不可) |
| 動画の音が出ない | プレイヤーのミュート | プレイヤーの音量アイコンを確認。音声はAACで常に埋め込まれる |

---

## 今後追加できるもの

- Reference モードの音声/動画参照(モデルは対応済み、UIは画像のみ)
- 自作キャラLoRAの学習(ai-toolkit、12GBで可能。手順はVault `MiniMax-H3-運用ノウハウ` 参照)
- 音声のみ生成モード(32×32ハックで30秒BGMが約22秒)
- Krea 2 のプロンプト自動強化(TextGenerateノード)・スタイルLoRA 9種
- アップスケール(SeedVR2導入済み)/ フレーム補間
