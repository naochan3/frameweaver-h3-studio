"""出力ファイル(PNG/MP4)に ComfyUI が埋め込むワークフローJSONからプロンプト文を抽出する。
server 非依存の純ロジック(単体で実行検証できるよう __init__.py から分離)。
"""
import json
import os
from typing import Any

# (path, mtime) → プロンプト文のキャッシュ。一覧APIが呼ばれるたびの再パースを避ける
_cache: dict[str, tuple[float, str | None]] = {}


def _prompt_from_workflow(raw: str) -> str | None:
    """APIフォーマットのワークフローJSONから、ユーザーが入力したプロンプト文を取り出す。
    優先順: 動画条件付けノード(cond)の prompt → positive の text → 任意の CLIPTextEncode。
    """
    try:
        nodes: dict[str, Any] = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(nodes, dict):
        return None

    def text_of(node_id: str, key: str) -> str | None:
        node = nodes.get(node_id)
        if not isinstance(node, dict):
            return None
        value = node.get("inputs", {}).get(key)
        return value if isinstance(value, str) and value.strip() else None

    # 本スタジオのワークフローは動画=cond.inputs.prompt / 画像=positive.inputs.text
    found = text_of("cond", "prompt") or text_of("positive", "text")
    if found:
        return found
    # 他ツール生成ファイル向けの汎用フォールバック
    for node_id, node in nodes.items():
        if isinstance(node, dict) and node.get("class_type") == "CLIPTextEncode":
            found = text_of(node_id, "text")
            if found:
                return found
    return None


def _read_embedded_workflow(path: str) -> str | None:
    lower = path.lower()
    if lower.endswith((".png", ".webp")):
        from PIL import Image

        with Image.open(path) as im:
            value = im.info.get("prompt")
            return value if isinstance(value, str) else None
    if lower.endswith((".mp4", ".webm", ".mov")):
        import av

        with av.open(path) as container:
            value = dict(container.metadata).get("prompt")
            return value if isinstance(value, str) else None
    return None


def extract_prompt(path: str) -> str | None:
    """ファイルからプロンプト文を抽出する(失敗時 None)。mtime が変わらない限りキャッシュ。"""
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    cached = _cache.get(path)
    if cached is not None and cached[0] == mtime:
        return cached[1]
    try:
        raw = _read_embedded_workflow(path)
        prompt = _prompt_from_workflow(raw) if raw else None
    except Exception:  # noqa: BLE001 - 壊れたファイルでも一覧APIは落とさない
        prompt = None
    _cache[path] = (mtime, prompt)
    return prompt
