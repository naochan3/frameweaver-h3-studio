"""FrameWeaver 用の最小API拡張。
出力フォルダを Windows のエクスプローラーで開く。localhost からの POST のみ想定。
"""
import os
import subprocess

from aiohttp import web
from server import PromptServer

# ComfyUI の出力ルート(このcustom_nodesから2つ上がComfyUI本体)
COMFY_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUTPUT_ROOT = os.path.join(COMFY_ROOT, "output")

# 開いてよいサブフォルダ(任意の絶対パスは開かせない)
ALLOWED_SUBDIRS = {"", "video", "zimage", "krea2"}


@PromptServer.instance.routes.post("/frameweaver/open_output")
async def open_output(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        data = {}
    subdir = str(data.get("subdir", "")).strip().strip("/\\")

    if subdir not in ALLOWED_SUBDIRS:
        return web.json_response({"ok": False, "error": "invalid subdir"}, status=400)

    target = os.path.join(OUTPUT_ROOT, subdir) if subdir else OUTPUT_ROOT
    target = os.path.normpath(target)
    # OUTPUT_ROOT の外に出ていないか最終確認
    if not target.startswith(os.path.normpath(OUTPUT_ROOT)):
        return web.json_response({"ok": False, "error": "path escape"}, status=400)
    if not os.path.isdir(target):
        os.makedirs(target, exist_ok=True)

    try:
        if os.name == "nt":
            os.startfile(target)  # type: ignore[attr-defined]
        elif os.sys.platform == "darwin":  # type: ignore[attr-defined]
            subprocess.Popen(["open", target])
        else:
            subprocess.Popen(["xdg-open", target])
    except Exception as e:  # noqa: BLE001
        return web.json_response({"ok": False, "error": str(e)}, status=500)

    return web.json_response({"ok": True, "path": target})


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
print("[FrameWeaver] open_output API registered (/frameweaver/open_output)")
