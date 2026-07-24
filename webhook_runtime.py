from __future__ import annotations

import os
from dataclasses import dataclass

from config import AppConfig, load_config
from google_sheets_sync import build_service, resolve_tab_name, write_registrations
from gravity_forms_webhook import payload_to_record
from pipeline_registry import PipelineDefinition, load_pipelines


@dataclass
class WebhookRuntime:
    config: AppConfig
    webhook_secret: str
    pipeline_registry: dict[str, PipelineDefinition]
    service_cache: dict[str, object]
    tab_cache: dict[str, str]

    def resolve_pipeline(self, pipeline_id: str) -> PipelineDefinition:
        if pipeline_id and pipeline_id in self.pipeline_registry:
            return self.pipeline_registry[pipeline_id]

        return PipelineDefinition(
            pipeline_id=self.config.pipeline_id,
            adapter=self.config.adapter_name,
            spreadsheet_id=self.config.spreadsheet_id,
            tab_name=self.config.tab_name,
        )

    def get_service_for_pipeline(self, pipeline_id: str):
        if pipeline_id not in self.service_cache:
            self.service_cache[pipeline_id] = build_service(
                self.config.service_account_json
            )
        return self.service_cache[pipeline_id]

    def get_tab_for_pipeline(self, pipeline_id: str) -> str:
        if pipeline_id not in self.tab_cache:
            pipeline = self.resolve_pipeline(pipeline_id)
            self.tab_cache[pipeline_id] = resolve_tab_name(
                self.get_service_for_pipeline(pipeline_id),
                pipeline.spreadsheet_id,
                pipeline.tab_name,
            )
        return self.tab_cache[pipeline_id]

    def process_payload(self, payload: dict) -> dict:
        pipeline_id = str(payload.get("pipeline_id", "")).strip()
        pipeline = self.resolve_pipeline(pipeline_id)
        record = payload_to_record(pipeline.adapter, payload)
        updates = write_registrations(
            service=self.get_service_for_pipeline(pipeline.pipeline_id),
            spreadsheet_id=pipeline.spreadsheet_id,
            tab_name=self.get_tab_for_pipeline(pipeline.pipeline_id),
            registrations=[record],
            dry_run=False,
        )
        row_index, _record = updates[0]
        return {
            "status": "ok",
            "pipeline_id": pipeline.pipeline_id,
            "row_index": row_index,
            "student_name": record.display_name,
        }


def load_runtime() -> WebhookRuntime:
    config = load_config(
        csv_path=os.getenv("CSV_IMPORT_PATH"),
        pipeline_id=os.getenv("PIPELINE_ID"),
        spreadsheet_id=os.getenv("GOOGLE_SHEETS_SPREADSHEET_ID"),
        tab_name=os.getenv("GOOGLE_SHEETS_TAB_NAME"),
        service_account_json=os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON"),
        pipelines_config_path=os.getenv("PIPELINES_CONFIG_PATH"),
        require_csv_path=False,
    )

    webhook_secret = os.getenv("WEBHOOK_SHARED_SECRET")
    if not webhook_secret:
        raise ValueError("Missing required setting: WEBHOOK_SHARED_SECRET")

    pipelines = {}
    if config.pipelines_config_path and config.pipelines_config_path.exists():
        pipelines = load_pipelines(config.pipelines_config_path)

    default_service = build_service(config.service_account_json)
    default_tab_name = resolve_tab_name(
        default_service, config.spreadsheet_id, config.tab_name
    )

    return WebhookRuntime(
        config=config,
        webhook_secret=webhook_secret,
        pipeline_registry=pipelines,
        service_cache={"default": default_service},
        tab_cache={"default": default_tab_name},
    )

