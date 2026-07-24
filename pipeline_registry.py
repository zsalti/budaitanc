from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass
class PipelineDefinition:
    pipeline_id: str
    adapter: str
    spreadsheet_id: str
    tab_name: str


def load_pipelines(config_path: Path) -> dict[str, PipelineDefinition]:
    raw = json.loads(config_path.read_text(encoding="utf-8"))
    pipelines: dict[str, PipelineDefinition] = {}
    for item in raw.get("pipelines", []):
        definition = PipelineDefinition(
            pipeline_id=item["pipeline_id"],
            adapter=item["adapter"],
            spreadsheet_id=item["spreadsheet_id"],
            tab_name=item["tab_name"],
        )
        pipelines[definition.pipeline_id] = definition
    return pipelines
