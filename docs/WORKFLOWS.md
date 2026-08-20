# ワークフローカタログ

本スタジオが使うワークフローと、公式テンプレートにある関連ワークフローの全体像。
**一次資料**: ComfyUI v0.33 同梱の公式テンプレ(`comfyui_workflow_templates_json/templates/`)と、稼働サーバーの `/object_info`(2026-08-21 取得)。

## 1. 動画: MiniMax H3

### モデルの基本仕様(公式ノートより)

- 映像+**ステレオ音声を単一パスで同時生成**(後付けではない)。最大2K・24fps・**最長約15秒**。
- フレーム数は `17k+5` グリッド(124フレーム≒5秒)。**学習レンジは124〜362フレーム(≒5〜15秒)**。範囲外は品質保証なし。
- プロンプトには「ショット・カメラワーク・**音声(セリフ/SFX/音楽)**」まで書くのが公式推奨。

### チェックポイントは2つだけ、条件付けノードで用途が分かれる

| チェックポイント | 条件付けノード | できること |
|---|---|---|
| **FL2VA** | `MiniMaxH3ImageToVideo` | `first_frame`/`last_frame` が**両方オプション**。0枚=T2V、firstのみ=I2V、両方=First+Last、lastのみ=Last。→ 本スタジオの4モードは全部この1ワークフローの入力差 |
| **Ref2VA** | `MiniMaxH3ReferenceToVideo` | 参照から人物・スタイルを引き継いで生成。`ref_images`(最大9枚)に加え **`ref_videos` / `ref_audios` / `ref_video_audios` も受け付ける**(動画参照・音声参照=声の引き継ぎ)。UIは現状画像のみ対応 |

### 公式テンプレ3種と本スタジオの対応

| 公式テンプレ | 内容 | 本スタジオ |
|---|---|---|
| `video_minimax_h3_t2v` | FL2VA、画像なし。res_multistep/simple、Turbo切替(8step LoRA)内蔵 | Text モード(一致) |
| `video_minimax_h3_i2v` | 同上+first_frame。入力画像はそのまま条件付けへ(必須の前処理スケーリングはない。0.9MPスケーラは補助チェーン) | First モード(一致) |
| `video_minimax_h3_r2v` | Ref2VA+ref_image_size='match'。非Turbo時 20steps | Reference モード(一致) |

### 本スタジオの意図的な逸脱(根拠あり)

| 項目 | 公式 | 本スタジオ | 根拠 |
|---|---|---|---|
| Turbo LoRA | fl2v_turbo **8step** v1.0 | **lightx2v 4step 768p**(steps=5) | 実測レポート(2026-08-14)で8stepはノイズ化、4stepが全タスク最良 |
| Turbo時サンプラー | res_multistep/simple のまま | **euler/beta** | lightx2v系の推奨設定(実測記事準拠) |
| `MiniMaxH3SigmaShift` | テンプレでは**未使用** | 明示挿入(video 12.0 / audio 3.0) | ノードのデフォルト値と同一なので実質同挙動の想定(**未確認**。差が疑われたら外して1変数比較) |

### UI未対応だが使える公式ノード(拡張候補)

- **`MiniMaxH3AddGuide`**: 任意のフレーム位置(`frame_idx`、負値=末尾起点)に画像・クリップ・音声をアンカーできる。**中間キーフレーム指定・既存音声(BGM/セリフ)の持ち込み**が可能になる。conditioningに直列に挟むだけ。
- **`EmptyMiniMaxH3LatentAV`**: 条件なしの空AVlatent。音声のみ生成ハック(README記載の32×32)にも使う。
- **`MiniMaxH3TurboLoRA` / `MiniMaxH3TurboSampler`**(larryvrhカスタムノード、導入済み): larryvrh版 turbo_v4 LoRA を使う場合の専用ローダ(low_vramマージオプション付き)+専用サンプラー。現行既定のlightx2vでは不要。

## 2. 画像: Z-Image Turbo

### 本スタジオが使う構成(公式 `image_z_image_turbo` と一致)

`UNETLoader → ModelSamplingAuraFlow(shift 3.0) → KSampler(res_multistep/simple/8steps/cfg 1.0)`、negative は `ConditioningZeroOut`、latent は `EmptySD3LatentImage`。公式は bf16、本スタジオは導入済み nvfp4(12GB対策)。

### 未活用の公式ワークフロー

| テンプレ | 内容 | 追加で必要なもの |
|---|---|---|
| `image_z_image_turbo_fun_union_controlnet` | **ControlNet(構図・ポーズ制御)**。`ModelPatchLoader` + `QwenImageDiffsynthControlnet` + Canny 等の制御画像 | `Z-Image-Turbo-Fun-Controlnet-Union.safetensors` |
| `utility_z_image_turbo_2k_upscaler` | **2Kアップスケール**。RealESRGAN x4 → 0.5縮小 → img2img(denoise 0.33, dpmpp_2m_sde/beta, 5steps) | `RealESRGAN_x4plus.safetensors` |

## 3. 画像: Krea 2 Turbo

### 本スタジオが使う構成(公式 `image_krea2_turbo_t2i` のコアと一致)

`UNETLoader → KSampler(euler/simple/8steps/cfg 1.0)`。shift 1.15はモデル定義内蔵のためノード不要。latent は `EmptyLatentImage`。

公式テンプレはコアの外に **`TextGenerate`(ローカルLLMによるプロンプト自動強化)** と **スタイルLoRA切替**(darkbrush等9種)を持つ。本スタジオは追加LoRA欄で代替、TextGenerateは未対応。

### 未活用の公式ワークフロー

| テンプレ | 内容 | 追加で必要なもの |
|---|---|---|
| `image_krea2_turbo_int8_image_style_reference` | **画風参照生成**(参照画像のスタイルを新規生成に適用)。`TextEncodeQwenImageEditPlus` + `FluxKontextMultiReferenceLatentMethod` + `ModelSamplingFlux(1.15)` + 専用LoRA | `krea2_style_reference.safetensors`(+テンプレはint8本体を使用) |

## 4. LoRA互換表(導入済み)

**LoRAは学習元モデル専用。** 別モデルに入れても効かない(黙って無視されるか品質が壊れる)。UIの追加LoRA候補は選択中モデル用だけを表示する(`src/lib/lora.ts` のカタログが正本)。

| ファイル | 対象 | 種別 | 備考 |
|---|---|---|---|
| `hinano_v1/v2_lora` | Z-Image | キャラ | トリガー `hinano`、強度0.7実績(v2推奨) |
| `Amateur_Photography_ZIT` | Z-Image | 画風 | スマホ写真風。強度0.2前後 |
| `K2R_KTMix_KR_beta/v01` | Krea 2 | キャラ | 強度0.4〜0.8(v01推奨)。K2R=Krea 2 Raw学習(RawのLoRAはTurboで動く) |
| `K2R_yayoi_S1_1k` | Krea 2 | キャラ | yayoi |
| `h3-realism-people-t2v-i2v-r2v` | H3(全モード) | 実写人物 | fal製(DL 24k超/likes 267)。トリガー `r34l1sm` をプロンプト先頭に。強度1.0(軽めは0.6〜0.8)。2026-08-21導入 |
| `minimax_h3_fl2v_turbo_4step_768p` | H3 FL2VA | システム | Turbo ONで自動適用。手動選択不要 |
| `minimax_h3_fl2v_turbo_8step` | H3 FL2VA | システム | 実測でノイズ化のため不採用 |
| `minimax_h3_ref2v_turbo_4step` | H3 Ref2VA | システム | Reference時に自動適用 |
| `minimax_h3_turbo_v4_step600_ema` | H3 | システム | larryvrh版。専用サンプラー必須+pruned系ベースで過飽和報告(GitHub issue)。未使用推奨 |
| `wan2.2_*_lightx2v_*`(2本) | Wan 2.2 | 対象外 | 本スタジオ未対応モデル用 |

新しいLoRAを入れたら `src/lib/lora.ts` の `CATALOG` に1行追加する(対象モデル・用途・推奨強度)。命名規則(`K2R_`=Krea2 / `_ZIT`=Z-Image / `minimax_h3_`=動画)に従えばカタログ外でも自動分類される。

## 5. 使い分けの指針

| やりたいこと | 使うワークフロー |
|---|---|
| プロンプトだけから動画 | FL2VA / Text |
| 生成画像を動かす(Motion Sync) | 画像生成 → FL2VA / First |
| 始点と終点を固定した補間 | FL2VA / First+Last |
| キャラの見た目・声を引き継ぐ | Ref2VA / Reference(将来: 音声参照で声も) |
| 途中のキーフレームも指定 | FL2VA + `AddGuide`(未実装) |
| ポーズ・構図を厳密に指定した画像 | Z-Image ControlNet(未実装) |
| 画像の高解像度化 | Z-Image 2K Upscaler or SeedVR2(未実装) |
| 参照画像の画風で画像生成 | Krea 2 Style Reference(未実装) |

## 更新ルール

ComfyUI/テンプレ更新時はこのファイルも見直す。確認コマンド:
テンプレ一覧 `ls .venv/Lib/site-packages/comfyui_workflow_templates_json/templates/`、
ノード仕様 `GET http://127.0.0.1:8189/object_info`。
