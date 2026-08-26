#!/usr/bin/env python3
"""Project production changes since freeze into an isolated staging review tab."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import load_config
from google_sheets_sync import build_service
from gravity_forms_csv import load_registrations
from scripts.rehearse_recovery_sheet import quote_tab, read_csv, read_tab, semantic_hash, trim_rows


REVIEW_TAB = "Élesítés előtti eltérések"
STUDENT_NAME_INDEX = 5
EMAIL_INDEX = 17


def text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def row_map(rows: list[list[Any]]) -> dict[str, tuple[int, list[Any]]]:
    return {
        text(row[0]): (row_number, row)
        for row_number, row in enumerate(rows[1:], start=2)
        if row and text(row[0])
    }


def value_at(row: list[Any], index: int) -> str:
    return text(row[index] if index < len(row) else "")


def ensure_review_tab(service: Any, spreadsheet_id: str) -> int:
    metadata = service.spreadsheets().get(
        spreadsheetId=spreadsheet_id,
        fields="sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))",
    ).execute()
    existing = {
        sheet["properties"]["title"]: sheet["properties"]
        for sheet in metadata.get("sheets", [])
    }
    if REVIEW_TAB in existing:
        return int(existing[REVIEW_TAB]["sheetId"])
    response = service.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={
            "requests": [{
                "addSheet": {
                    "properties": {
                        "title": REVIEW_TAB,
                        "gridProperties": {"rowCount": 100, "columnCount": 12},
                    }
                }
            }]
        },
    ).execute()
    return int(response["replies"][0]["addSheet"]["properties"]["sheetId"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gravity-csv", type=Path, required=True)
    parser.add_argument("--scratch-dir", type=Path, required=True)
    parser.add_argument("--staging-spreadsheet-id", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()

    config = load_config(
        csv_path=None,
        pipeline_id=None,
        spreadsheet_id=None,
        tab_name=None,
        service_account_json=None,
        require_csv_path=False,
    )
    if args.staging_spreadsheet_id == config.spreadsheet_id:
        raise RuntimeError("A konfliktuslista nem írható az éles spreadsheetbe.")

    service = build_service(config.service_account_json)
    frozen = trim_rows(read_csv(args.scratch_dir / "master-before.csv"))
    target = trim_rows(read_csv(args.scratch_dir / "master-reconstruction.csv"))
    live = trim_rows(read_tab(service, config.spreadsheet_id, config.tab_name))
    if not frozen or not target or not live:
        raise RuntimeError("Hiányzó főlapadat a konfliktusvizsgálathoz.")
    source_rows = load_registrations(args.gravity_csv, config.adapter_name)
    source = {text(item.reference_id): list(item.sheet_row) for item in source_rows}
    frozen_by_id = row_map(frozen)
    target_by_id = row_map(target)
    live_by_id = row_map(live)
    headers = live[0]

    review_rows: list[list[Any]] = [[
        "Bejegyzés azonosító",
        "Éles sor",
        "Változott mező",
        "Befagyasztott érték",
        "Mostani éles érték",
        "Rekonstrukció célértéke",
        "Kanonikus növendék",
        "Éles sor növendéke",
        "Kanonikus e-mail",
        "Éles sor e-mailje",
        "Identitás egyezik",
        "Döntés / megjegyzés",
    ]]
    pii_free_conflicts: list[dict[str, Any]] = []
    for entry_id, (live_row_number, live_row) in sorted(live_by_id.items()):
        if entry_id not in frozen_by_id or entry_id not in target_by_id or entry_id not in source:
            continue
        _, frozen_row = frozen_by_id[entry_id]
        _, target_row = target_by_id[entry_id]
        source_row = source[entry_id]
        identity_matches = (
            value_at(live_row, STUDENT_NAME_INDEX).casefold()
            == value_at(source_row, STUDENT_NAME_INDEX).casefold()
            and value_at(live_row, EMAIL_INDEX).casefold()
            == value_at(source_row, EMAIL_INDEX).casefold()
        )
        changed_columns: list[str] = []
        for column_index in range(max(len(frozen_row), len(live_row))):
            frozen_value = value_at(frozen_row, column_index)
            live_value = value_at(live_row, column_index)
            if frozen_value == live_value:
                continue
            header = headers[column_index] if column_index < len(headers) else f"Oszlop {column_index + 1}"
            changed_columns.append(header)
            review_rows.append([
                entry_id,
                live_row_number,
                header,
                frozen_value,
                live_value,
                value_at(target_row, column_index),
                value_at(source_row, STUDENT_NAME_INDEX),
                value_at(live_row, STUDENT_NAME_INDEX),
                value_at(source_row, EMAIL_INDEX),
                value_at(live_row, EMAIL_INDEX),
                "IGEN" if identity_matches else "NEM",
                "",
            ])
        if changed_columns:
            pii_free_conflicts.append({
                "entry_id": entry_id,
                "live_row": live_row_number,
                "changed_columns": changed_columns,
                "identity_matches_source": identity_matches,
            })

    if len(review_rows) == 1:
        raise RuntimeError("Nincs stagingre vetíthető production eltérés.")
    sheet_id = ensure_review_tab(service, args.staging_spreadsheet_id)
    service.spreadsheets().values().clear(
        spreadsheetId=args.staging_spreadsheet_id,
        range=quote_tab(REVIEW_TAB),
        body={},
    ).execute()
    service.spreadsheets().values().update(
        spreadsheetId=args.staging_spreadsheet_id,
        range=f"{quote_tab(REVIEW_TAB)}!A1",
        valueInputOption="RAW",
        body={"majorDimension": "ROWS", "values": review_rows},
    ).execute()
    service.spreadsheets().batchUpdate(
        spreadsheetId=args.staging_spreadsheet_id,
        body={
            "requests": [
                {
                    "updateSheetProperties": {
                        "properties": {
                            "sheetId": sheet_id,
                            "gridProperties": {"frozenRowCount": 1},
                        },
                        "fields": "gridProperties.frozenRowCount",
                    }
                },
                {
                    "repeatCell": {
                        "range": {
                            "sheetId": sheet_id,
                            "startRowIndex": 0,
                            "endRowIndex": 1,
                            "startColumnIndex": 0,
                            "endColumnIndex": 12,
                        },
                        "cell": {
                            "userEnteredFormat": {
                                "backgroundColor": {"red": 0.976, "green": 0.796, "blue": 0.612},
                                "textFormat": {"bold": True},
                                "wrapStrategy": "WRAP",
                            }
                        },
                        "fields": "userEnteredFormat(backgroundColor,textFormat,wrapStrategy)",
                    }
                },
                {
                    "repeatCell": {
                        "range": {
                            "sheetId": sheet_id,
                            "startRowIndex": 1,
                            "endRowIndex": len(review_rows),
                            "startColumnIndex": 10,
                            "endColumnIndex": 11,
                        },
                        "cell": {
                            "userEnteredFormat": {
                                "backgroundColor": {"red": 0.957, "green": 0.8, "blue": 0.8},
                                "textFormat": {"bold": True},
                            }
                        },
                        "fields": "userEnteredFormat(backgroundColor,textFormat)",
                    }
                },
                {
                    "autoResizeDimensions": {
                        "dimensions": {
                            "sheetId": sheet_id,
                            "dimension": "COLUMNS",
                            "startIndex": 0,
                            "endIndex": 12,
                        }
                    }
                },
            ]
        },
    ).execute()
    actual = read_tab(service, args.staging_spreadsheet_id, REVIEW_TAB)
    if semantic_hash(actual) != semantic_hash(review_rows):
        raise RuntimeError("A staging konfliktuslap visszaolvasása eltér.")

    report = {
        "generated_at": datetime.now(UTC).isoformat(),
        "mode": "staging_only_production_conflict_review",
        "production_spreadsheet_untouched": True,
        "staging_spreadsheet_id": args.staging_spreadsheet_id,
        "review_sheet_id": sheet_id,
        "review_rows": len(review_rows) - 1,
        "conflicts": pii_free_conflicts,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
