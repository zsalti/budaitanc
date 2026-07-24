from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv
from pipeline_registry import PipelineDefinition, load_pipelines


@dataclass
class AppConfig:
    csv_path: Path | None
    pipeline_id: str
    adapter_name: str
    spreadsheet_id: str
    tab_name: str
    service_account_json: str | None
    pipelines_config_path: Path | None


def load_config(
    csv_path: str | None,
    pipeline_id: str | None,
    spreadsheet_id: str | None,
    tab_name: str | None,
    service_account_json: str | None,
    pipelines_config_path: str | None = None,
    require_csv_path: bool = True,
) -> AppConfig:
    load_dotenv()

    resolved_csv_path = csv_path or os.getenv("CSV_IMPORT_PATH")
    resolved_pipeline_id = pipeline_id or os.getenv("PIPELINE_ID")
    resolved_spreadsheet_id = spreadsheet_id or os.getenv("GOOGLE_SHEETS_SPREADSHEET_ID")
    resolved_tab_name = tab_name or os.getenv("GOOGLE_SHEETS_TAB_NAME")
    resolved_service_account_json = (
        service_account_json
        or os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")
        or os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT")
    )
    resolved_pipelines_config_path = pipelines_config_path or os.getenv(
        "PIPELINES_CONFIG_PATH"
    )
    adapter_name = os.getenv("DEFAULT_PIPELINE_ADAPTER", "dance_course_registration")

    pipeline_definition: PipelineDefinition | None = None
    registry_path: Path | None = None
    if resolved_pipeline_id and resolved_pipelines_config_path:
        registry_path = Path(resolved_pipelines_config_path)
        if registry_path.exists():
            pipelines = load_pipelines(registry_path)
            pipeline_definition = pipelines.get(resolved_pipeline_id)
            if pipeline_definition is None:
                raise ValueError(
                    f"Unknown pipeline_id {resolved_pipeline_id!r} in {registry_path}"
                )
            resolved_spreadsheet_id = pipeline_definition.spreadsheet_id
            resolved_tab_name = pipeline_definition.tab_name
            adapter_name = pipeline_definition.adapter

    required_pairs = [
        ("spreadsheet_id", resolved_spreadsheet_id),
        ("tab_name", resolved_tab_name),
    ]
    if require_csv_path:
        required_pairs.insert(0, ("csv_path", resolved_csv_path))

    missing = [name for name, value in required_pairs if not value]
    if missing:
        raise ValueError(f"Missing required settings: {', '.join(missing)}")

    path: Path | None = None
    if resolved_csv_path:
        path = Path(resolved_csv_path)
        if require_csv_path and not path.exists():
            raise FileNotFoundError(f"CSV file not found: {path}")

    return AppConfig(
        csv_path=path,
        pipeline_id=resolved_pipeline_id or "default",
        adapter_name=adapter_name,
        spreadsheet_id=resolved_spreadsheet_id,
        tab_name=resolved_tab_name,
        service_account_json=resolved_service_account_json,
        pipelines_config_path=registry_path,
    )
