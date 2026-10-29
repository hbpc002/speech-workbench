"""回环 HTTP 服务：渲染器在选素材前把候选 Pexels 视频发过来，这里回答哪些没人。

和 TTS 桥同样的理由：渲染器是 Node，检测器在 Python；两边用最短的 HTTP 契约
连起来，比在 Node 里再装一套推理栈划算。只绑 `127.0.0.1`，容器外拿不到。

失败策略见 server/people.py 文件头：模型不可用时放行并报警，HTTP 层本身出错
由渲染器决定（它会退到 slug 过滤后继续，宁可出一条片也不让页签永远报错）。
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import people, redact

MAX_BODY = 2 * 1024 * 1024


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        if self.path == "/health":
            self._json(200, {"status": "ok", "available": people.available()})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        if self.path != "/people":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            if length <= 0 or length > MAX_BODY:
                raise ValueError("请求体为空或过大")
            payload = json.loads(self.rfile.read(length) or b"{}")
            result = people.handle(payload)
        except Exception as exc:  # noqa: BLE001 - every failure becomes a readable 400/500
            redact.log_only("people", exc)
            self._json(400, {"error": redact.scrub(exc)})
            return
        self._json(200, result)
        print(
            f"[people] checked={result['checked']} allowed={len(result['allowed'])} "
            f"detector={result['detector']}",
            flush=True,
        )

    def log_message(self, *args) -> None:
        return


def start(port: int) -> threading.Thread:
    server = ThreadingHTTPServer(("127.0.0.1", port), _Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, name="people-filter", daemon=True)
    thread.start()
    print(f"[boot] people filter on 127.0.0.1:{port} (available={people.available()})", flush=True)
    return thread
