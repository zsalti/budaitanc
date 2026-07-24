from __future__ import annotations

import json
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from webhook_runtime import load_runtime


class GravityWebhookHandler(BaseHTTPRequestHandler):
    server_version = "BudaiTancWebhook/1.0"

    def do_POST(self) -> None:
        if self.path != "/webhooks/gravity-forms":
            self.respond_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return

        expected_secret = self.server.webhook_secret  # type: ignore[attr-defined]
        received_secret = self.headers.get("X-BudaiTanc-Secret", "")
        if not expected_secret or received_secret != expected_secret:
            self.respond_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length)

        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError:
            self.respond_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_json"})
            return

        try:
            result = self.server.runtime.process_payload(payload)  # type: ignore[attr-defined]
        except Exception as exc:  # pragma: no cover
            self.log_error("Webhook processing failed: %s", exc)
            self.respond_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "processing_failed", "detail": str(exc)},
            )
            return

        self.respond_json(HTTPStatus.OK, result)

    def log_message(self, format: str, *args) -> None:
        return

    def respond_json(self, status: HTTPStatus, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    runtime = load_runtime()

    host = os.getenv("WEBHOOK_HOST", "0.0.0.0")
    port = int(os.getenv("WEBHOOK_PORT", "8080"))

    httpd = ThreadingHTTPServer((host, port), GravityWebhookHandler)
    httpd.webhook_secret = runtime.webhook_secret  # type: ignore[attr-defined]
    httpd.runtime = runtime  # type: ignore[attr-defined]

    print(f"Listening on http://{host}:{port}/webhooks/gravity-forms")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
