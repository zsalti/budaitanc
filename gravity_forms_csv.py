from __future__ import annotations

import csv
from pathlib import Path

from pipeline_adapters import record_from_csv_row
from registration_model import SheetRecord


def load_registrations(csv_path: Path, adapter_name: str) -> list[SheetRecord]:
    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return [record_from_csv_row(adapter_name, row) for row in reader]
