# FrameWeaver H3 Studio

ローカルPC(**RTX 4070 12GB / RAM 64GB** 想定)で動く **動画+画像生成スタジオ**。
ComfyUI をバックエンドに、複数のAIモデルを1つのWebUIから使えます。**プロンプトはローカルLLMが自動強化**するので、一言入れるだけで本番品質の指示に変換されます。

## できること

| 種類 | モデル | 特徴 |
|---|---|---|
| **動画+音声** | MiniMax H3 | Text / First / First+Last / Last / Reference の5モード。映像と音声を同時生成 |
| 動画NSFW | 10Eros-Max(H3融合) | H3を差し替えるNSFW寄り動画モデル(任意) |
| **画像・万能** | Z-Image Turbo | アニメ〜実写。約10秒/枚 |
| **画像・実写** | Krea 2 Turbo | iPhone写真風の自然な人物 |
| **画像・アニメ** | WAI / NoobAI(Illustrious系SDXL) | **キャラ名(英語Danbooruタグ)でNSFWアニメ**。ネガティブ+cfg有効 |
| **プロンプト強化** | ローカルLLM(Ollama) | 一言→本番プロンプトに自動変換(動画=H3公式仕様 / 画像=各モデル公式仕様準拠) |
| **LoRAカタログ** | 200+ LoRA | サムネ画像+ジャンル+トリガーで選ぶ。「使う」で対象モデル自動切替 |

- 画像生成は**検閲ノードが無く、素でNSFW対応**(Z-Image/Krea2)
- Turbo LoRA高速化、進捗+残り時間表示、生成履歴、使い方ガイド内蔵、LAN内のスマホから利用可

---

## セットアップ(ゼロから再現する手順)

### 0. 前提

| 必要物 | 補足 |
|---|---|
| Windows 11 + NVIDIA GPU(12GB VRAM 目安) | RAM 48GB以上推奨(モデルをRAMへ退避するため) |
| ComfyUI(v0.33系) | `C:\AI\ComfyUI_H3\ComfyUI` に配置(下記) |
| Node.js 20+ / npm | WebUI用(このリポジトリ) |
| Ollama | プロンプト強化用LLMランナー。`winget install Ollama.Ollama` |
| ディスク | モデル込みで **合計150〜250GB** 程度見込む |

### 1. WebUI(このリポジトリ)

```powershell
git clone <このリポジトリ>
cd frameweaver-h3-studio
npm install
```

### 2. ComfyUI バックエンド

`C:\AI\ComfyUI_H3\ComfyUI` に ComfyUI(v0.33系)を配置し、起動スクリプト `C:\AI\ComfyUI_H3\start.ps1` を作る:

```powershell
# start.ps1 の中身(ポート8189・12GB向けフラグ)
Set-Location "$PSScriptRoot\ComfyUI"
& ".\.venv\Scripts\python.exe" main.py --listen 127.0.0.1 --port 8189 `
  --disable-pinned-memory --enable-cors-header "http://localhost:5180"
```

- `--disable-pinned-memory` は **12GBでのOOM対策で必須**
- `--enable-cors-header` はWebUI(5180)からの接続許可
- モデル置き場は `extra_model_paths.yaml` で `C:\AI\ComfyUI_Data\models` を共有参照(既存のComfyUI Desktopと共用可)

### 3. カスタムノード(出力フォルダを開く / 履歴・LoRAカタログ用API)

このリポジトリの `comfyui_addon/frameweaver_openfolder` を
`C:\AI\ComfyUI_H3\ComfyUI\custom_nodes\` にコピー(または junction)。
ComfyUI再起動で `/frameweaver/open_output` `/list_output` `/lora_meta` が有効化。

### 4. モデルをダウンロード(下記「必要モデル一覧」)

すべて `C:\AI\ComfyUI_Data\models\` 配下へ。

### 5. プロンプト強化用のOllamaモデルを作成

```powershell
# 動画(H3)用: GGUFをDLしてから
#   indhic-ai/MiniMax_H3-Prompt_Rewriter-8B-LORA-Merged-GGUF の Q8_0.gguf を docs/ollama/ に置く
ollama create frameweaver-rewriter -f docs/ollama/Modelfile.h3video

# 画像(Krea2 / Z-Image)用: ベースは自動でpullされる(huihui_ai/qwen2.5-abliterate:7b)
ollama create fw-rewriter-krea2  -f docs/ollama/Modelfile.krea2
ollama create fw-rewriter-zimage -f docs/ollama/Modelfile.zimage
```

3つのModelfileには各モデルの**公式プロンプト仕様**(H3の3ブロック形式 / Krea公式 expansion.txt / Z-Image公式ガイド)を焼き込んである。NSFW対応のため無検閲LLM(abliterate)をエンジンに使用。

### 6. 起動

```
start_studio.bat
```

Ollama →(未起動なら起動)→ ComfyUI(8189)→ WebUI(5180)→ ブラウザ自動オープン。

---

## 起動と接続

### かんたん起動

`start_studio.bat` をダブルクリック。各サーバーが別ウィンドウで立ち上がる。

### 手動起動

```powershell
powershell -ExecutionPolicy Bypass -File C:\AI\ComfyUI_H3\start.ps1  # ComfyUI
npm run dev                                                          # WebUI(このフォルダ)
# ブラウザで http://localhost:5180
```

生成を止めるだけならヘッダー「停止」、VRAMを空けるなら「解放」。

### 同じWi-Fi(LAN)内のスマホ・タブレットから開く

WebUIは `0.0.0.0` 待受。同じネットワークの端末から `http://<PCのIP>:5180`(例 `http://192.168.3.42:5180`)。

- ComfyUI通信はViteの `/comfy`、プロンプト強化は制限付き `/rewriter/models`・`/rewriter/generate` がPCに中継するので**端末側は追加設定不要**。Ollamaの管理APIは公開しません。
- PCのIPは `ipconfig`。初回はファイアウォール許可が要る場合あり:
  ```powershell
  New-NetFirewallRule -DisplayName "FrameWeaver WebUI 5180" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5180 -Profile Private
  ```
- 公開はLAN内のみ(インターネットには出さない)

---

## 構成

| 役割 | 場所 | 備考 |
|---|---|---|
| WebUI(本体) | このフォルダ(Vite + React + zustand) | port 5180 |
| ComfyUI バックエンド | `C:\AI\ComfyUI_H3\ComfyUI`(v0.33) | port 8189、`--disable-pinned-memory` 必須 |
| プロンプト強化LLM | Ollama | port 11434(`/ollama` プロキシ経由) |
| モデル置き場 | `C:\AI\ComfyUI_Data\models\` | 既存ComfyUI Desktopと共有 |
| カスタムノード | `custom_nodes\frameweaver_openfolder` | 出力フォルダを開く/履歴/LoRAカタログAPI |
| 生成物の出力先 | `output\` の `video/` `zimage/` `krea2/` `anime/` | 種類別 |

**既存の ComfyUI Desktop(port 8188)には一切手を加えていません。**

---

## 必要モデル一覧と配置場所

すべて `C:\AI\ComfyUI_Data\models\` 配下。

### 動画: MiniMax H3

| ファイル | 配置 | 出典 |
|---|---|---|
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors`(約21GB) | diffusion_models/ | Comfy-Org/MiniMax-H3 |
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors`(約21GB) | diffusion_models/ | 同上 |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`(通常エンコーダ・15.7GB) | text_encoders/ | 同上 |
| `qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors`(**NSFW用**・15.7GB) | text_encoders/ | Momoking/...Heretic-MiniMax-H3-NVFP4 |
| `minimax_h3_video_vae_fp16.safetensors` / `minimax_h3_audio_vae_fp32.safetensors` | vae/ | Comfy-Org/MiniMax-H3 |
| `minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors`(既定Turbo) | loras/ | lightx2v |
| `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors`(Reference用Turbo) | loras/ | lightx2v |

### 動画NSFW(任意): 10Eros-Max

| ファイル(各約20GB) | 配置 | 出典 |
|---|---|---|
| `10Eros_Max_h3_fl2va_beta2_pruned_int8_convrot.safetensors` | diffusion_models/ | cicalooo/10Eros-Max-h3-int8-convrot |
| `10Eros_Max_h3_ref2va_beta2_pruned_int8_convrot.safetensors` | diffusion_models/ | 同上 |

### 画像

| モデル | ファイル | 配置 | 出典 |
|---|---|---|---|
| Z-Image Turbo | `z_image_turbo_nvfp4.safetensors` / `qwen_3_4b.safetensors` / `ae_zimage.safetensors` | diffusion_models / text_encoders / vae | Tongyi-MAI/Z-Image-Turbo |
| Krea 2 Turbo | `krea2_turbo_fp8_scaled.safetensors` / `qwen3vl_4b_fp8_scaled.safetensors` / `qwen_image_vae.safetensors` | 同上 | Comfy-Org/Krea-2 |
| アニメ(即動く) | `waiIllustriousSDXL_v170.safetensors`(6.9GB) | checkpoints/ | LyliaEngine/waiIllustriousSDXL_v170 |
| アニメ(最高品質) | `NoobAI-XL-Vpred-v1.0.safetensors`(7.1GB、V-Pred) | checkpoints/ | Laxhar/noobai-XL-Vpred-1.0 |

- アニメ用SDXLチェックポイントは1ファイルにUNET/CLIP/VAE同梱。**ファイル名に `vpred` を含むと自動でv-prediction設定**に切り替わる。
- **キャラ生成は英語のDanbooruタグ必須**(例 `hatsune miku`、`roxy migurdia \(mushoku tensei\)`)。日本語名では別キャラになる。

### LoRA(任意・カタログ機能)

- `loras/<ベースモデル>/*.safetensors`(例 `loras/illustrious/`, `loras/zimageturbo/`, `loras/krea2/`)に置くと、アプリの**LoRAカタログ**にサムネ付きで並ぶ。
- 各LoRAの説明メタは `loras/frameweaver_lora_meta.json`(Civitai由来の名前/ジャンル/トリガー/画像URL)。カスタムノードの `/frameweaver/lora_meta` が配信する。
- LoRAは**学習元モデル専用**。対象が違うと効かない(アプリは自動で仕分け・警告)。

**一括収集スクリプト**: Civitaiの人気LoRAをベースモデル別に自動DLし、上記メタJSONとカタログMDまで生成する:

```powershell
$env:CIVITAI_TOKEN = "<あなたのCivitai APIキー>"   # Manage Account → API Keys で発行
node scripts/fetch-loras.mjs
```

- 429(レート制限)は自動バックオフ、既存ファイルはスキップ。収集対象は `scripts/fetch-loras.mjs` の `CURATED` / `QUERIES` で編集可。
- 保存先は既定 `C:\AI\ComfyUI_Data\models\loras`(`LORA_DIR` で変更可)。
- **トークンはコードに書かず環境変数のみ**。不要ジャンル(動物エロ等)は各自 `loras/_trash` へ退避してよい。未成年表現は扱わない。

### プロンプト強化(Ollama)

| Ollamaモデル | 用途 | ベース |
|---|---|---|
| `frameweaver-rewriter` | 動画(H3)一言→3ブロック本番プロンプト | Qwen3-VL-8B + H3 Rewriter LoRA(Q8 GGUF) |
| `fw-rewriter-krea2` | Krea2一言→本番プロンプト | qwen2.5-abliterate 7B + Krea公式 expansion.txt |
| `fw-rewriter-zimage` | Z-Image一言→本番プロンプト | 同上 + Z-Image公式ガイド |

Modelfileは `docs/ollama/`。作成コマンドは上記「セットアップ 5」参照。

---

## 使い方

初回アクセス時に**使い方ガイド**(8ステップ)が自動表示。ヘッダー「使い方」でいつでも再表示。

### 動画生成

1. 「動画生成」タブ → モード(Text/First/First+Last/Last/Reference)
2. SCENE に一言 → **「プロンプト自動強化」**で本番プロンプトへ(任意)。First系/Referenceは画像をドラッグ&ドロップ
3. RECIPE でアスペクト比×画質・長さ・Turbo・**NSFWトグル**・シード → 生成
4. 右OUTPUTに進捗・残り時間・完成動画。履歴から過去分も開ける

### 画像生成

1. 「画像生成」タブ → モデル(Z-Image / Krea 2 / アニメ)
2. 一言 → **「プロンプト自動強化」**(Z-Image/Krea2のみ。各モデル公式仕様で展開)。アニメは英語Danbooruタグで入力
3. アスペクト比×画質 → 生成。できた画像は動画のFirst/Referenceに流用可
4. **LoRAカタログ**からサムネで選び「使う」で即設定(対象モデルに自動切替+トリガー挿入)

### NSFW

- **画像(Z-Image/Krea2/アニメ)は素でNSFW対応**(検閲ノードなし)。プロンプトにそのまま書けば出る
- **動画はRECIPEのNSFWトグル**でエンコーダを無検閲版(Heretic)に切替。切替直後の1回目は再読込で+1〜2分
- 未成年表現は絶対に不可。生成物の公開・商用は自己責任(H3ライセンスのセーフガード条項に注意)

### プロンプト自動強化のしくみ

一言(日本語OK)を、ローカルLLMが**各モデルの公式プロンプト仕様に沿って**本番プロンプトへ変換する。翻訳ではなく、カメラ・光・質感・構図・音などを補って**膨らませる**。動画はwarm約20秒、画像はwarm約2秒。出力は英語。NSFWも検閲しない。気に入らなければ「元に戻す」。

---

## 12GB VRAM向け推奨設定(実測ベース)

| 用途 | 設定 | 目安時間 |
|---|---|---|
| 動画・試行錯誤 | 0.4〜0.5MP / 5秒 / Turbo ON(5 steps) | 約2分/本 |
| 動画・本番 | 1.0MP / Turbo ON | 5〜10分/本 |
| 画像(Z-Image) | 9:16 1.3MP / 8 steps | 約12秒/枚 |
| 画像(Krea2) | 9:16 1.3MP / 8 steps | 約21秒/枚 |
| 画像(アニメSDXL) | 9:16 1.0MP / 28 steps / cfg6 | 約12秒/枚 |

- **1.3MP超は選択不可**(2Kは二重スワップで非実用、実測より)
- 固定シードでも**解像度を変えると動きが変わる**(低解像度プレビュー→高解像度の完全再現は不可)
- 生成が異常に遅いときはヘッダー「解放」でアンロード

---

## よくあるエラーと対処

| 症状 | 原因 | 対処 |
|---|---|---|
| ヘッダーが「ComfyUI 未接続」 | バックエンド未起動 / CORS | `start_studio.bat`。`start.ps1` の `--enable-cors-header` を消さない |
| 生成開始直後にエラー(node_errors) | モデル不足 | 上の一覧を確認。追加直後はComfyUI再起動 |
| OOM / プロセスが落ちる | pinned memory | `--disable-pinned-memory` が付いているか(必須) |
| 生成が途中から極端に遅い | RAM逼迫→SSDスワップ | 解像度を下げる・重いアプリを閉じる・「解放」 |
| プロンプト強化ボタンが出ない/効かない | Ollama未起動 or モデル未作成 | Ollama起動(`ollama serve`)+ 上記の `ollama create` 実行 |
| アニメでキャラが別人 | 日本語名/自然文で入力 | **英語Danbooruタグ**で(例 `roxy migurdia \(mushoku tensei\)`) |
| NSFW ONで動画が変わらない | エンコーダ未DL | text_encoders に heretic があるか |
| LoRAカタログが空 | メタ未生成 | `loras/frameweaver_lora_meta.json` を用意(Civitai APIから生成) |

---

## リポジトリ構成

```
src/                     WebUI本体(React + zustand)
  components/            画面(動画/画像/履歴/カタログ/強化ボタン等)
  lib/                   ワークフロー生成・ComfyUIクライアント・rewriter(Ollama)・LoRA分類
  store/generation.ts    状態管理の中枢
comfyui_addon/           ComfyUIカスタムノード(出力フォルダ/履歴/LoRAメタAPI)
scripts/fetch-loras.mjs  Civitai人気LoRAの一括収集(トークンは環境変数)
docs/
  ollama/                プロンプト強化用 Modelfile 3種(H3/Krea2/Z-Image)
  WORKFLOWS.md           対応ワークフローのカタログ(正本)
  LORA_CATALOG.md        収集済みLoRA一覧(自動生成)
start_studio.bat         Ollama→ComfyUI→WebUI をまとめて起動
```

検証: `npm run lint` / `npm run test` / `npm run build`。

---

## 今後追加できるもの

- キャラを踊らせる(Wan2.2-Animate / ポーズ駆動)
- 動画の高解像度化(MMH3 UltimateUpscale / フルHD一発生成)
- 自作キャラLoRA学習(ai-toolkit、12GBで可能)
- Reference モードの音声/動画参照(モデルは対応、UIは画像のみ)
