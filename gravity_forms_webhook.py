from __future__ import annotations

from pipeline_adapters import record_from_webhook_payload
from registration_model import SheetRecord


def payload_to_record(adapter_name: str, payload: dict) -> SheetRecord:
    return record_from_webhook_payload(adapter_name, payload)
