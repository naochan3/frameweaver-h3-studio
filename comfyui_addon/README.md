# ComfyUI アドオン(frameweaver_openfolder)

WebUIの「出力フォルダを開く」「保存先を開く」ボタン用の最小APIをComfyUIに足すカスタムノード。

- 追加するエンドポイント: `POST /frameweaver/open_output`(body: `{"subdir": "" | "video" | "zimage" | "krea2"}`)
- 動作: ComfyUIの `output/<subdir>` をOS標準のファイラー(Windowsはエクスプローラー)で開く。許可済みサブフォルダ以外は拒否

## インストール

`frameweaver_openfolder/` フォルダを ComfyUI の `custom_nodes/` にコピーし、ComfyUIを再起動するだけ。

```
copy comfyui_addon\frameweaver_openfolder  →  C:\AI\ComfyUI_H3\ComfyUI\custom_nodes\frameweaver_openfolder
```

導入済み環境: `C:\AI\ComfyUI_H3\ComfyUI\custom_nodes\frameweaver_openfolder`(2026-08-20)。
