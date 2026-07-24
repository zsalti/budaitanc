from __future__ import annotations

from flask import Flask, jsonify, request

from webhook_runtime import load_runtime


runtime = load_runtime()
app = Flask(__name__)


@app.get("/healthz")
def healthcheck():
    return jsonify({"status": "ok"})


@app.post("/webhooks/gravity-forms")
def gravity_forms_webhook():
    received_secret = request.headers.get("X-BudaiTanc-Secret", "")
    if received_secret != runtime.webhook_secret:
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json"}), 400

    try:
        result = runtime.process_payload(payload)
    except Exception as exc:  # pragma: no cover
        return jsonify({"error": "processing_failed", "detail": str(exc)}), 500

    return jsonify(result), 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(__import__("os").getenv("PORT", "8080")))
