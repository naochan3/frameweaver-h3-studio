# READMEスクリーンショット更新手順

READMEの画像は、実際に動くUIを同じ構図で撮り直せるように管理します。

## 保存先と寸法

| 画像 | viewport | scale | 保存寸法 | テーマ |
|---|---:|---:|---:|---|
| `docs/assets/readme/studio-desktop.png` | 1280×720 | 2 | 2560×1440 | Ember |
| `docs/assets/readme/studio-mobile.png` | 390×844 | 3 | 1170×2532 | Ocean |

## 撮影前

1. `npm ci` と `npm run build` を成功させる。
2. 既存の5180を触らず、`npm run dev -- --host 127.0.0.1 --port 5194` で起動する。
3. ガイド、履歴詳細、LoRAカタログなどのオーバーレイを閉じる。
4. 実ホスト名、tailnet名、IP、ユーザー名、個人の生成履歴が画面にないことを確認する。
5. ブラウザのズームを100%にする。

## 撮影

デスクトップは動画生成画面全体、スマホは上部操作・入力・生成ボタンの流れが分かる位置を撮ります。画像編集で引き伸ばさず、viewportとdevice scale factorで指定寸法を作ります。

## 検証

```powershell
npm run docs:verify
```

合格時は `README assets OK: 2` と表示されます。さらに原寸画像を開き、文字のぼけ、切れ、横スクロール、秘密情報がないことを目視します。
