# -*- coding: utf-8 -*-
"""
生信大杂烩 · 微信公众号排版工作台 (Claude UI 风格)
后端服务：提供本地 Markdown 文件扫描、读写、本地图片流映射、图片压缩转码及微信公众号官方素材库 API 对接

v3.0 优化要点：
- 安全：移除 CORS 通配，校验 Host/Origin（防恶意网页与 DNS Rebinding 读写本地文件）；
        读写仅允许文本扩展名，保存仅限工作区目录；图片接口仅允许图片扩展名
- 性能：多线程服务器；目录扫描剪枝；图片 Base64 结果 LRU 缓存；本地图片 ETag/304 协商缓存
- 健壮：原子写入、保留原文件换行符、外部修改冲突检测（409）；上传图片按内容哈希去重命名
- 微信：AccessToken 内存缓存与失效重试；图片自动压缩至 1MB 以内；逐张返回失败原因
"""
import os
import re
import io
import sys
import json
import time
import base64
import hashlib
import tempfile
import threading
import mimetypes
import webbrowser
import urllib.parse
import urllib.request
from collections import OrderedDict
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

STUDIO_DIR = Path(__file__).parent.resolve()
STATIC_DIR = STUDIO_DIR / "static"
UPLOAD_DIR = STUDIO_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# 默认扫描的根目录（可通过环境变量覆盖；若预设目录不存在则回退到项目内 workspace 目录）
_default_ws = Path(r"E:\公众号相关\文献解读")
_default_root = Path(r"E:\公众号相关")
WORKSPACE_DIR = Path(os.environ.get("WECHAT_MD_WORKSPACE") or (_default_ws if _default_ws.exists() else STUDIO_DIR / "workspace"))
PARENT_DIR = Path(os.environ.get("WECHAT_MD_ROOT") or (_default_root if _default_root.exists() else WORKSPACE_DIR))
WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

TEXT_EXTS = {".md", ".markdown", ".txt"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".tif", ".tiff"}
IGNORE_DIRS = {"node_modules", "tmp", "site-packages", ".git", ".venv", "venv", "__pycache__"}
MAX_BODY_BYTES = 80 * 1024 * 1024  # 请求体上限 80MB
WECHAT_MAX_IMG_BYTES = 1024 * 1024 - 8 * 1024  # 微信 uploadimg 限制 1MB，预留余量

try:
    from PIL import Image, ImageOps
    HAS_PIL = True
except ImportError:  # 未安装 Pillow 时回退为原图直传
    HAS_PIL = False


# ======================= 通用工具函数 =======================
def norm(p):
    """统一输出正斜杠路径"""
    return str(p).replace("\\", "/")


def is_within(p, roots):
    """判断路径 p 是否位于任一根目录之下"""
    try:
        rp = Path(p).resolve()
    except OSError:
        return False
    for r in roots:
        try:
            rp.relative_to(Path(r).resolve())
            return True
        except ValueError:
            continue
    return False


def writable_roots():
    """允许写入 Markdown 的目录"""
    return [d for d in {WORKSPACE_DIR, PARENT_DIR, UPLOAD_DIR} if d.exists()]


def safe_filename(name, default="untitled"):
    name = re.sub(r"[^\w.\-\u4e00-\u9fff]", "_", (name or "").strip()) or default
    return name[:120]


def unique_path(p):
    """若目标已存在则追加序号，避免覆盖"""
    p = Path(p)
    if not p.exists():
        return p
    for i in range(1, 1000):
        cand = p.with_name(f"{p.stem}_{i}{p.suffix}")
        if not cand.exists():
            return cand
    return p.with_name(f"{p.stem}_{int(time.time())}{p.suffix}")


def resolve_image_path(img_path, base_dir=""):
    """将 Markdown 中的图片引用解析为磁盘绝对路径，失败返回 None"""
    if not img_path:
        return None
    clean = re.sub(r"^file:///+", "", img_path.strip(), flags=re.IGNORECASE)
    clean = urllib.parse.unquote(clean)
    candidates = []
    p = Path(clean)
    if p.is_absolute():
        candidates.append(p)
    else:
        if base_dir:
            candidates.append(Path(base_dir) / clean)
        candidates.append(WORKSPACE_DIR / clean)
    candidates.append(WORKSPACE_DIR / "figures" / Path(clean).name)
    for c in candidates:
        try:
            if c.suffix.lower() in IMAGE_EXTS and c.is_file():
                return c.resolve()
        except OSError:
            continue
    return None


def compress_image(p, max_w=1080, quality=85, max_bytes=None, force_raster=False):
    """
    压缩图片并返回 (bytes, mime)。
    - GIF/SVG 默认保持原样（保留动图与矢量），force_raster=True 时转 JPEG（微信 uploadimg 仅支持 JPG/PNG）
    - 自动纠正 EXIF 旋转、透明背景铺白、超宽缩放至 max_w
    - 指定 max_bytes 时逐级降低质量/尺寸直到满足体积限制
    """
    suffix = p.suffix.lower()
    raw = p.read_bytes()
    if not HAS_PIL or (suffix in {".gif", ".svg"} and not force_raster):
        return raw, mimetypes.guess_type(str(p))[0] or "image/png"
    if suffix == ".svg":
        return raw, "image/svg+xml"  # PIL 无法栅格化 SVG

    with Image.open(io.BytesIO(raw)) as src:
        im = ImageOps.exif_transpose(src)
        if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
            im = im.convert("RGBA")
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.split()[3])
            im = bg
        elif im.mode != "RGB":
            im = im.convert("RGB")
        if im.width > max_w:
            im = im.resize((max_w, int(im.height * max_w / im.width)), Image.Resampling.LANCZOS)

        q = quality
        while True:
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=q, optimize=True, progressive=True)
            data = buf.getvalue()
            if not max_bytes or len(data) <= max_bytes:
                return data, "image/jpeg"
            if q > 60:
                q -= 8
            elif im.width > 480:
                im = im.resize((int(im.width * 0.85), int(im.height * 0.85)), Image.Resampling.LANCZOS)
            else:
                return data, "image/jpeg"


class LRUCache:
    """线程安全的简易 LRU 缓存"""

    def __init__(self, capacity=64):
        self.capacity = capacity
        self.data = OrderedDict()
        self.lock = threading.Lock()

    def get(self, key):
        with self.lock:
            if key in self.data:
                self.data.move_to_end(key)
                return self.data[key]
        return None

    def set(self, key, value):
        with self.lock:
            self.data[key] = value
            self.data.move_to_end(key)
            while len(self.data) > self.capacity:
                self.data.popitem(last=False)


BASE64_CACHE = LRUCache(64)
TOKEN_CACHE = {}  # app_id -> (token, expires_at)
TOKEN_LOCK = threading.Lock()


def get_access_token(app_id, app_secret, force_refresh=False):
    """获取并缓存微信 AccessToken（官方有效期 7200 秒，提前 5 分钟刷新）"""
    with TOKEN_LOCK:
        cached = TOKEN_CACHE.get(app_id)
        if cached and not force_refresh and cached[1] > time.time():
            return cached[0]
        url = (
            "https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential"
            f"&appid={urllib.parse.quote(app_id)}&secret={urllib.parse.quote(app_secret)}"
        )
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if "access_token" not in data:
            raise RuntimeError(f"获取微信 AccessToken 失败: {data.get('errmsg', data)}（errcode={data.get('errcode')}）")
        TOKEN_CACHE[app_id] = (data["access_token"], time.time() + int(data.get("expires_in", 7200)) - 300)
        return data["access_token"]


def wechat_upload_img(access_token, filename, jpg_bytes):
    """调用 media/uploadimg 上传图文内图片，返回 JSON"""
    boundary = "----WeChatMDStudio" + hashlib.md5(jpg_bytes[:4096]).hexdigest()[:16]
    body = b"".join([
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="media"; filename="{filename}"\r\n'.encode("utf-8"),
        b"Content-Type: image/jpeg\r\n\r\n",
        jpg_bytes,
        f"\r\n--{boundary}--\r\n".encode(),
    ])
    req = urllib.request.Request(
        f"https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token={access_token}",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def scan_markdown_files():
    """扫描工作区 Markdown 文件（os.walk 剪枝忽略目录，避免深入 node_modules 等）"""
    roots = []
    for d in (PARENT_DIR, WORKSPACE_DIR):
        if d.exists() and not any(is_within(d, [r]) for r in roots):
            roots.append(d)
    files, seen = [], set()
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [n for n in dirnames if n not in IGNORE_DIRS and not n.startswith(".")]
            if Path(dirpath).resolve() == STUDIO_DIR:
                continue
            for fn in filenames:
                if Path(fn).suffix.lower() not in {".md", ".markdown"}:
                    continue
                p = Path(dirpath) / fn
                key = norm(p.resolve())
                if key in seen:
                    continue
                seen.add(key)
                try:
                    st = p.stat()
                except OSError:
                    continue
                try:
                    rel_dir = norm(p.parent.relative_to(root)) or "."
                except ValueError:
                    rel_dir = norm(p.parent)
                files.append({"name": p.name, "path": key, "dir": rel_dir, "size": st.st_size, "mtime": st.st_mtime})
    files.sort(key=lambda x: x["mtime"], reverse=True)
    return files


def atomic_write_text(p, content):
    """原子写入文本；若原文件使用 CRLF 换行则保持一致"""
    content = content.replace("\r\n", "\n")
    if p.exists():
        try:
            with open(p, "rb") as f:
                if b"\r\n" in f.read(65536):
                    content = content.replace("\n", "\r\n")
        except OSError:
            pass
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".~", suffix=".tmp", dir=str(p.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        os.replace(tmp, p)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


# ======================= HTTP 请求处理器 =======================
class StudioRequestHandler(SimpleHTTPRequestHandler):
    """自定义 HTTP 请求处理器，支持静态资源与 REST API"""

    server_version = "WeChatMDStudio/3.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    # ---------- 基础设施 ----------
    def send_header(self, keyword, value):
        if keyword.lower() == "cache-control":
            self._has_cache_header = True
        super().send_header(keyword, value)

    def end_headers(self):
        # 未显式声明缓存策略的响应（静态资源与 JSON）禁用缓存，确保前端修改刷新即生效
        if not getattr(self, "_has_cache_header", False):
            super().send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()
        self._has_cache_header = False

    def log_request(self, code="-", size="-"):
        # 仅打印异常请求，避免控制台被图片请求刷屏
        try:
            if int(code) >= 400:
                super().log_request(code, size)
        except (TypeError, ValueError):
            pass

    def is_trusted(self):
        """校验 Host 与 Origin，阻止任意网页跨站调用本地文件接口"""
        port = self.server.server_address[1]
        allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if self.headers.get("Host", "") not in allowed_hosts:
            return False
        origin = self.headers.get("Origin")
        if origin and origin not in {f"http://{h}" for h in allowed_hosts}:
            return False
        return True

    def send_json(self, data, status=200):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        # 不再提供 CORS 预检许可，跨域请求将被浏览器拦截
        self.send_response(204)
        self.end_headers()

    # ---------- GET ----------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        q = lambda k: query.get(k, [""])[0]

        if route.startswith("/api/") and not self.is_trusted():
            return self.send_json({"ok": False, "error": "Forbidden"}, 403)

        try:
            if route == "/api/config":
                return self.send_json({
                    "ok": True,
                    "workspaceDir": norm(WORKSPACE_DIR),
                    "rootDir": norm(PARENT_DIR),
                    "hasPIL": HAS_PIL,
                })
            if route == "/api/files":
                return self.send_json({"ok": True, "files": scan_markdown_files()})
            if route == "/api/read":
                return self.api_read(q("path"))
            if route == "/api/local-image":
                return self.api_local_image(q("path"), q("baseDir"))
            if route == "/api/image-base64":
                return self.api_image_base64(q("path"), q("baseDir"))
        except Exception as e:  # 兜底，避免单个请求异常导致连接挂起
            return self.send_json({"ok": False, "error": f"{type(e).__name__}: {e}"}, 500)

        if route.startswith("/api/"):
            return self.send_json({"ok": False, "error": "Unknown API endpoint"}, 404)
        return super().do_GET()

    def api_read(self, file_path):
        if not file_path:
            return self.send_json({"ok": False, "error": "未指定文件路径"}, 400)
        p = Path(file_path)
        if p.suffix.lower() not in TEXT_EXTS:
            return self.send_json({"ok": False, "error": "仅支持读取 .md / .markdown / .txt 文件"}, 400)
        if not p.is_file():
            return self.send_json({"ok": False, "error": f"文件不存在: {file_path}"}, 404)
        content = p.read_text(encoding="utf-8-sig", errors="replace").replace("\r\n", "\n")
        rp = p.resolve()
        return self.send_json({
            "ok": True,
            "name": rp.name,
            "path": norm(rp),
            "baseDir": norm(rp.parent),
            "mtime": rp.stat().st_mtime,
            "content": content,
        })

    def api_local_image(self, img_path, base_dir):
        p = resolve_image_path(img_path, base_dir)
        if not p:
            self.send_error(404, "Image not found")
            return
        st = p.stat()
        etag = f'"{int(st.st_mtime * 1000):x}-{st.st_size:x}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            return
        data = p.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(str(p))[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("ETag", etag)
        # no-cache = 可缓存但每次协商，图片被替换后预览可立即更新
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def api_image_base64(self, img_path, base_dir):
        p = resolve_image_path(img_path, base_dir)
        if not p:
            return self.send_json({"ok": False, "error": "Image not found"}, 404)
        st = p.stat()
        key = (str(p), st.st_mtime, st.st_size)
        data_url = BASE64_CACHE.get(key)
        if not data_url:
            try:
                data, mime = compress_image(p, max_w=1080, quality=85)
            except Exception:
                data, mime = p.read_bytes(), mimetypes.guess_type(str(p))[0] or "image/png"
            data_url = f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
            BASE64_CACHE.set(key, data_url)
        return self.send_json({"ok": True, "dataUrl": data_url})

    # ---------- POST ----------
    def do_POST(self):
        route = urllib.parse.urlparse(self.path).path
        if not self.is_trusted():
            return self.send_json({"ok": False, "error": "Forbidden"}, 403)
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            return self.send_json({"ok": False, "error": "无效的 Content-Length"}, 400)
        if length > MAX_BODY_BYTES:
            return self.send_json({"ok": False, "error": "请求体过大"}, 413)
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8")) if length > 0 else {}
            if not isinstance(body, dict):
                raise ValueError
        except Exception:
            return self.send_json({"ok": False, "error": "请求体不是合法 JSON"}, 400)

        handlers = {
            "/api/save": self.api_save,
            "/api/delete": self.api_delete,
            "/api/upload-image": self.api_upload_image,
            "/api/wechat/upload-images": self.api_wechat_upload,
        }
        handler = handlers.get(route)
        if not handler:
            return self.send_json({"ok": False, "error": "Unknown API endpoint"}, 404)
        try:
            return handler(body)
        except Exception as e:
            return self.send_json({"ok": False, "error": f"{type(e).__name__}: {e}"}, 500)

    def api_save(self, body):
        file_path = (body.get("path") or "").strip()
        content = body.get("content", "")
        if not isinstance(content, str):
            return self.send_json({"ok": False, "error": "content 必须为字符串"}, 400)

        if not file_path:
            # 新文档：保存到工作区，自动避免覆盖同名文件
            name = safe_filename(body.get("name") or "未命名推文.md")
            if Path(name).suffix.lower() not in TEXT_EXTS:
                name += ".md"
            p = unique_path(WORKSPACE_DIR / name)
        else:
            p = Path(file_path)
            if p.suffix.lower() not in TEXT_EXTS:
                return self.send_json({"ok": False, "error": "仅允许保存 .md / .markdown / .txt 文件"}, 400)
            if not is_within(p, writable_roots()):
                return self.send_json({"ok": False, "error": f"出于安全考虑，仅允许保存到工作区目录：{norm(PARENT_DIR)}"}, 403)
            # 冲突检测：文件在外部被修改过且未要求强制覆盖
            expected = body.get("expectedMtime")
            if p.exists() and expected and not body.get("force"):
                if abs(p.stat().st_mtime - float(expected)) > 0.01:
                    return self.send_json({"ok": False, "conflict": True, "error": "文件已在外部被修改"}, 409)

        atomic_write_text(p, content)
        rp = p.resolve()
        return self.send_json({
            "ok": True,
            "name": rp.name,
            "path": norm(rp),
            "baseDir": norm(rp.parent),
            "mtime": rp.stat().st_mtime,
            "message": "保存成功",
        })

    def api_delete(self, body):
        """删除工作区中的指定 Markdown 文档"""
        file_path = (body.get("path") or "").strip()
        if not file_path:
            return self.send_json({"ok": False, "error": "未指定要删除的文件路径"}, 400)
        p = Path(file_path)
        if p.suffix.lower() not in TEXT_EXTS:
            return self.send_json({"ok": False, "error": "仅允许删除 .md / .markdown / .txt 文档"}, 400)
        if not is_within(p, writable_roots()):
            return self.send_json({"ok": False, "error": "仅允许删除工作区目录内的文档"}, 403)
        if not p.is_file():
            return self.send_json({"ok": False, "error": "文件不存在或已被删除"}, 404)
        p.unlink()
        return self.send_json({"ok": True, "files": scan_markdown_files()})

    def api_upload_image(self, body):
        data_url = body.get("dataUrl", "")
        m = re.match(r"^data:(image/[\w.+-]+);base64,(.+)$", data_url, re.S)
        if not m:
            return self.send_json({"ok": False, "error": "无效的图片数据"}, 400)
        raw = base64.b64decode(m.group(2))
        filename = safe_filename(body.get("filename") or "image.png", "image.png")
        stem, ext = Path(filename).stem, Path(filename).suffix.lower()
        if ext not in IMAGE_EXTS:
            ext = mimetypes.guess_extension(m.group(1)) or ".png"
            ext = ".jpg" if ext == ".jpe" else ext
        # 以内容哈希命名：同一张图重复上传不会产生多个副本，不同图片同名也不会互相覆盖
        digest = hashlib.sha1(raw).hexdigest()[:8]
        target = UPLOAD_DIR / f"{stem}_{digest}{ext}"
        if not target.exists():
            target.write_bytes(raw)
        path = norm(target.resolve())
        return self.send_json({"ok": True, "path": path, "url": f"/api/local-image?path={urllib.parse.quote(path)}"})

    def api_wechat_upload(self, body):
        app_id = (body.get("appId") or "").strip()
        app_secret = (body.get("appSecret") or "").strip()
        images = body.get("images") or []
        base_dir = body.get("baseDir") or ""
        if not app_id or not app_secret:
            return self.send_json({"ok": False, "error": "请先填写微信公众号 AppID 和 AppSecret"}, 400)
        if not HAS_PIL:
            return self.send_json({"ok": False, "error": "缺少 Pillow，请先执行 pip install pillow"}, 500)

        try:
            token = get_access_token(app_id, app_secret)
        except Exception as e:
            return self.send_json({"ok": False, "error": str(e)}, 400)

        url_map, failed = {}, []
        for orig in dict.fromkeys(images):  # 去重并保持顺序
            p = resolve_image_path(orig, base_dir)
            if not p:
                failed.append({"path": orig, "error": "本地文件不存在"})
                continue
            try:
                jpg, _ = compress_image(p, max_w=1080, quality=85, max_bytes=WECHAT_MAX_IMG_BYTES, force_raster=True)
                res = wechat_upload_img(token, f"{safe_filename(p.stem, 'img')}.jpg", jpg)
                if res.get("errcode") in (40001, 40014, 42001):  # token 失效，刷新后重试一次
                    token = get_access_token(app_id, app_secret, force_refresh=True)
                    res = wechat_upload_img(token, f"{safe_filename(p.stem, 'img')}.jpg", jpg)
                if "url" in res:
                    url_map[orig] = res["url"]
                else:
                    failed.append({"path": orig, "error": f"{res.get('errmsg')}（errcode={res.get('errcode')}）"})
            except Exception as e:
                failed.append({"path": orig, "error": str(e)})
        return self.send_json({"ok": True, "urlMap": url_map, "failed": failed})


class StudioHTTPServer(ThreadingHTTPServer):
    """Windows 下禁用 SO_REUSEADDR，防止多个进程静默绑定同一端口导致旧进程抢占请求"""

    allow_reuse_address = os.name != "nt"
    daemon_threads = True


def run_server(port=8765, open_browser=False):
    try:
        httpd = StudioHTTPServer(("127.0.0.1", port), StudioRequestHandler)
    except OSError as e:
        print(f"[错误] 端口 {port} 无法监听（可能已被占用）：{e}", flush=True)
        print(f"       若工作台已在运行，请直接访问 http://127.0.0.1:{port}", flush=True)
        if open_browser:
            webbrowser.open(f"http://127.0.0.1:{port}")
        return
    url = f"http://127.0.0.1:{port}"
    print("============================================================", flush=True)
    print("  生信大杂烩 · 微信公众号排版工作台 (Claude UI Edition v3.0)", flush=True)
    print(f"  服务已启动: {url}", flush=True)
    print(f"  默认工作区: {WORKSPACE_DIR}", flush=True)
    if not HAS_PIL:
        print("  [提示] 未检测到 Pillow，图片压缩不可用：pip install pillow", flush=True)
    print("  按 Ctrl+C 停止服务", flush=True)
    print("============================================================", flush=True)
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    run_server(int(args[0]) if args else 8765, open_browser="--open" in sys.argv)
