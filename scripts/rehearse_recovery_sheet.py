#!/usr/bin/env python3
"""Create and verify an isolated Google Sheets recovery rehearsal.

The production spreadsheet is never touched. A new service-account-owned
spreadsheet is populated from the frozen recovery bundle, cleared, restored,
and validated. The retained report contains only counts, hashes and the new
spreadsheet identifier.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import load_config
from google_sheets_sync import build_service


TAB_FILES = {
    "__MASTER__": "master-reconstruction.csv",
    "E-mail kimenet": "email-output-reconstruction.csv",
    "E-mail kimenet – incidensarchívum": "email-output-incident-archive.csv",
    "Kézi küldés egyeztetés": "email-manual-history-review.csv",
    "Kézi elbírálás teendők": "email-manual-action-queue.csv",
    "E-mail eseménynapló": "email-event-archive.csv",
    "Automata kalk": "automation-config.csv",
    "E-mail beállítások": "email-settings.csv",
}

EMAIL_OUTPUT_TAB = "E-mail kimenet"
EMAIL_APPROVED_COLUMN_INDEX = 11
EMAIL_STATUS_COLUMN_INDEX = 12
EMAIL_MESSAGE_ID_COLUMN_INDEX = 13
EMAIL_MANUAL_SENT_COLUMN_INDEX = 18
EMAIL_SENT_FORMAT_FORMULA = (
    '=OR(AND($N2<>"",$N2<>"MANUÁLIS",'
    'OR($M2="BREVO FOGADTA",$M2="KÉZBESÍTVE")),'
    'AND(OR($S2=TRUE,$S2="TRUE",$S2="IGAZ",$S2="IGEN",$S2=1),'
    'OR($M2="ELKÜLDVE",'
    '$M2="ELKÜLDÉS UTÁN MÓDOSULT")))'
)
EMAIL_SENT_GREEN = {"red": 0.8509804, "green": 0.9411765, "blue": 0.827451}


def read_csv(path: Path) -> list[list[str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return [list(row) for row in csv.reader(handle)]


def trim_rows(rows: list[list[Any]]) -> list[list[str]]:
    normalized: list[list[str]] = []
    for row in rows:
        values = ["" if value is None else str(value) for value in row]
        while values and values[-1] == "":
            values.pop()
        normalized.append(values)
    while normalized and not normalized[-1]:
        normalized.pop()
    return normalized


def semantic_hash(rows: list[list[Any]]) -> str:
    payload = json.dumps(trim_rows(rows), ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def quote_tab(title: str) -> str:
    return "'" + title.replace("'", "''") + "'"


def column_letter(index: int) -> str:
    """Return the one-based A1 column label for a zero-based index."""
    value = index + 1
    result = ""
    while value:
        value, remainder = divmod(value - 1, 26)
        result = chr(65 + remainder) + result
    return result


def read_tab(service: Any, spreadsheet_id: str, title: str) -> list[list[Any]]:
    response = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=spreadsheet_id, range=quote_tab(title))
        .execute()
    )
    return response.get("values", [])


def validate_snapshot(
    service: Any,
    spreadsheet_id: str,
    expected: dict[str, list[list[str]]],
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    actual_tabs: dict[str, list[list[Any]]] = {}
    for title, rows in expected.items():
        actual = read_tab(service, spreadsheet_id, title)
        actual_tabs[title] = actual
        expected_hash = semantic_hash(rows)
        actual_hash = semantic_hash(actual)
        if actual_hash != expected_hash:
            raise RuntimeError(f"A staging Sheet visszaolvasása eltér: {title}")
        result[title] = {
            "rows_including_header": len(trim_rows(actual)),
            "semantic_sha256": actual_hash,
        }

    master_rows = trim_rows(actual_tabs[next(iter(expected))])
    master_ids = [row[0] for row in master_rows[1:] if row]
    if len(master_ids) != 169 or len(master_ids) != len(set(master_ids)):
        raise RuntimeError("A staging főtábla nem 169 egyedi forrás-ID-t tartalmaz.")

    email_rows = trim_rows(actual_tabs["E-mail kimenet"])
    send_keys = [row[0] for row in email_rows[1:] if row]
    approvals = [row[11] if len(row) > 11 else "" for row in email_rows[1:] if row]
    if len(send_keys) != 169 or len(send_keys) != len(set(send_keys)):
        raise RuntimeError("A staging E-mail kimenet kulcsai hiányosak vagy duplikáltak.")
    if any(str(value).strip().casefold() not in {"", "false"} for value in approvals):
        raise RuntimeError("A staging E-mail kimenet bekapcsolt jóváhagyást tartalmaz.")
    return result


def write_snapshot(
    service: Any,
    spreadsheet_id: str,
    expected: dict[str, list[list[str]]],
) -> None:
    data = [
        {
            "range": f"{quote_tab(title)}!A1",
            "majorDimension": "ROWS",
            "values": rows,
        }
        for title, rows in expected.items()
    ]
    (
        service.spreadsheets()
        .values()
        .batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={"valueInputOption": "RAW", "data": data},
        )
        .execute()
    )


def clear_snapshot(service: Any, spreadsheet_id: str, titles: list[str]) -> None:
    (
        service.spreadsheets()
        .values()
        .batchClear(
            spreadsheetId=spreadsheet_id,
            body={"ranges": [quote_tab(title) for title in titles]},
        )
        .execute()
    )


def ensure_staging_tabs(
    service: Any,
    spreadsheet_id: str,
    expected: dict[str, list[list[str]]],
) -> None:
    metadata = (
        service.spreadsheets()
        .get(
            spreadsheetId=spreadsheet_id,
            fields="sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))",
        )
        .execute()
    )
    existing = {
        sheet["properties"]["title"]: sheet["properties"]
        for sheet in metadata.get("sheets", [])
    }
    requests: list[dict[str, Any]] = []
    for title, rows in expected.items():
        required_rows = max(1000, len(rows) + 10)
        required_columns = max(26, max(map(len, rows), default=1))
        if title not in existing:
            requests.append({
                "addSheet": {
                    "properties": {
                        "title": title,
                        "gridProperties": {
                            "rowCount": required_rows,
                            "columnCount": required_columns,
                        },
                    }
                }
            })
            continue
        grid = existing[title].get("gridProperties", {})
        if int(grid.get("rowCount", 0)) < required_rows or int(grid.get("columnCount", 0)) < required_columns:
            requests.append({
                "updateSheetProperties": {
                    "properties": {
                        "sheetId": existing[title]["sheetId"],
                        "gridProperties": {
                            "rowCount": max(required_rows, int(grid.get("rowCount", 0))),
                            "columnCount": max(required_columns, int(grid.get("columnCount", 0))),
                        },
                    },
                    "fields": "gridProperties(rowCount,columnCount)",
                }
            })
    if requests:
        service.spreadsheets().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={"requests": requests},
        ).execute()


def checked(value: Any) -> bool:
    return value is True or str(value).strip().casefold() in {"true", "igaz", "igen", "1"}


def has_consistent_send_history(row: list[Any]) -> bool:
    status = str(row[EMAIL_STATUS_COLUMN_INDEX]).strip() if len(row) > EMAIL_STATUS_COLUMN_INDEX else ""
    message_id = str(row[EMAIL_MESSAGE_ID_COLUMN_INDEX]).strip() if len(row) > EMAIL_MESSAGE_ID_COLUMN_INDEX else ""
    manual_sent = checked(row[EMAIL_MANUAL_SENT_COLUMN_INDEX]) if len(row) > EMAIL_MANUAL_SENT_COLUMN_INDEX else False
    brevo_sent = (
        bool(message_id)
        and message_id != "MANUÁLIS"
        and status in {"BREVO FOGADTA", "KÉZBESÍTVE"}
    )
    manual_send = manual_sent and status in {"ELKÜLDVE", "ELKÜLDÉS UTÁN MÓDOSULT"}
    return brevo_sent or manual_send


def ensure_email_sent_formatting(
    service: Any,
    spreadsheet_id: str,
    column_count: int,
) -> dict[str, Any]:
    metadata = (
        service.spreadsheets()
        .get(
            spreadsheetId=spreadsheet_id,
            fields=(
                "sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),"
                "conditionalFormats)"
            ),
        )
        .execute()
    )
    email_sheet = next(
        (
            sheet
            for sheet in metadata.get("sheets", [])
            if sheet.get("properties", {}).get("title") == EMAIL_OUTPUT_TAB
        ),
        None,
    )
    if email_sheet is None:
        raise RuntimeError(f"Hiányzó staging lap: {EMAIL_OUTPUT_TAB}")

    properties = email_sheet["properties"]
    sheet_id = properties["sheetId"]
    row_count = int(properties.get("gridProperties", {}).get("rowCount", 0))
    if row_count < 2:
        raise RuntimeError("Az E-mail kimenet staging lapnak nincs formázható adatsora.")

    rule = {
        "ranges": [{
            "sheetId": sheet_id,
            "startRowIndex": 1,
            "endRowIndex": row_count,
            "startColumnIndex": 0,
            "endColumnIndex": column_count,
        }],
        "booleanRule": {
            "condition": {
                "type": "CUSTOM_FORMULA",
                "values": [{"userEnteredValue": EMAIL_SENT_FORMAT_FORMULA}],
            },
            "format": {
                "backgroundColor": EMAIL_SENT_GREEN,
                "backgroundColorStyle": {"rgbColor": EMAIL_SENT_GREEN},
            },
        },
    }
    existing_rules = email_sheet.get("conditionalFormats", [])
    matching_indexes = [
        index
        for index, existing_rule in enumerate(existing_rules)
        if existing_rule.get("booleanRule", {}).get("condition", {}).get("type") == "CUSTOM_FORMULA"
        and any(
            "$S2=TRUE" in str(value.get("userEnteredValue", ""))
            for value in existing_rule.get("booleanRule", {}).get("condition", {}).get("values", [])
        )
    ]
    if matching_indexes:
        requests = [
            {"deleteConditionalFormatRule": {"sheetId": sheet_id, "index": index}}
            for index in reversed(matching_indexes[1:])
        ]
        requests.append({
            "updateConditionalFormatRule": {
                "sheetId": sheet_id,
                "index": matching_indexes[0],
                "rule": rule,
            }
        })
        action = "updated"
    else:
        requests = [{"addConditionalFormatRule": {"index": 0, "rule": rule}}]
        action = "added"
    service.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={"requests": requests},
    ).execute()
    return {
        "action": action,
        "formula": EMAIL_SENT_FORMAT_FORMULA,
        "range": f"A2:AH{row_count}",
        "duplicate_rules_removed": max(0, len(matching_indexes) - 1),
    }


def ensure_email_output_checkboxes(
    service: Any,
    spreadsheet_id: str,
    email_rows: list[list[Any]],
) -> dict[str, Any]:
    """Restore typed checkbox values and validation without changing meaning."""
    rows = trim_rows(email_rows)
    if not rows:
        raise RuntimeError("Az E-mail kimenet nem tartalmaz fejlécet.")
    header = rows[0]
    required_headers = {
        "Jóváhagyva": EMAIL_APPROVED_COLUMN_INDEX,
        "Manuálisan elküldve": EMAIL_MANUAL_SENT_COLUMN_INDEX,
    }
    for expected_header, index in required_headers.items():
        if len(header) <= index or header[index] != expected_header:
            raise RuntimeError(
                f"Az E-mail kimenet checkbox-oszlopa hiányzik: {expected_header}"
            )

    metadata = (
        service.spreadsheets()
        .get(
            spreadsheetId=spreadsheet_id,
            fields="sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))",
        )
        .execute()
    )
    email_sheet = next(
        (
            sheet
            for sheet in metadata.get("sheets", [])
            if sheet.get("properties", {}).get("title") == EMAIL_OUTPUT_TAB
        ),
        None,
    )
    if email_sheet is None:
        raise RuntimeError(f"Hiányzó lap: {EMAIL_OUTPUT_TAB}")
    properties = email_sheet["properties"]
    sheet_id = properties["sheetId"]
    grid_row_count = int(properties.get("gridProperties", {}).get("rowCount", 0))
    if grid_row_count < max(2, len(rows)):
        raise RuntimeError("Az E-mail kimenet gridje kisebb az aktív adatsornál.")

    active_rows = rows[1:]
    value_updates = []
    for index in required_headers.values():
        if active_rows:
            label = column_letter(index)
            value_updates.append({
                "range": f"{quote_tab(EMAIL_OUTPUT_TAB)}!{label}2:{label}{len(rows)}",
                "majorDimension": "ROWS",
                "values": [
                    [checked(row[index]) if len(row) > index else False]
                    for row in active_rows
                ],
            })
    if value_updates:
        service.spreadsheets().values().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={"valueInputOption": "RAW", "data": value_updates},
        ).execute()

    checkbox_rule = {
        "condition": {"type": "BOOLEAN"},
        "strict": True,
        "showCustomUi": True,
    }
    validation_requests = [
        {
            "setDataValidation": {
                    "range": {
                        "sheetId": sheet_id,
                        "startRowIndex": 1,
                        "endRowIndex": len(rows),
                    "startColumnIndex": index,
                    "endColumnIndex": index + 1,
                },
                "rule": checkbox_rule,
                "filteredRowsIncluded": True,
            }
        }
        for index in required_headers.values()
    ]
    service.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={"requests": validation_requests},
    ).execute()
    return {
        "approval_column": column_letter(EMAIL_APPROVED_COLUMN_INDEX),
        "approval_checked": sum(
            checked(row[EMAIL_APPROVED_COLUMN_INDEX])
            for row in active_rows
            if len(row) > EMAIL_APPROVED_COLUMN_INDEX
        ),
        "manual_sent_column": column_letter(EMAIL_MANUAL_SENT_COLUMN_INDEX),
        "manual_sent_checked": sum(
            checked(row[EMAIL_MANUAL_SENT_COLUMN_INDEX])
            for row in active_rows
            if len(row) > EMAIL_MANUAL_SENT_COLUMN_INDEX
        ),
        "validation_end_row": len(rows),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scratch-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument(
        "--create-staging-sheet",
        action="store_true",
        help="Required acknowledgement that a new isolated Google spreadsheet will be created.",
    )
    parser.add_argument(
        "--staging-spreadsheet-id",
        help="Existing isolated spreadsheet copy to overwrite and validate.",
    )
    args = parser.parse_args()
    if args.create_staging_sheet == bool(args.staging_spreadsheet_id):
        parser.error(
            "Pontosan az egyik staging célt add meg: --create-staging-sheet vagy "
            "--staging-spreadsheet-id."
        )

    config = load_config(
        csv_path=None,
        pipeline_id=None,
        spreadsheet_id=None,
        tab_name=None,
        service_account_json=None,
        require_csv_path=False,
    )
    service = build_service(config.service_account_json)
    expected: dict[str, list[list[str]]] = {}
    for configured_title, filename in TAB_FILES.items():
        title = config.tab_name if configured_title == "__MASTER__" else configured_title
        path = args.scratch_dir / filename
        if not path.is_file():
            raise FileNotFoundError(f"Hiányzó recovery-fájl: {path}")
        expected[title] = read_csv(path)

    if args.staging_spreadsheet_id:
        if args.staging_spreadsheet_id == config.spreadsheet_id:
            raise RuntimeError("A staging spreadsheet nem lehet az éles spreadsheet.")
        spreadsheet_id = args.staging_spreadsheet_id
        created = (
            service.spreadsheets()
            .get(
                spreadsheetId=spreadsheet_id,
                fields="spreadsheetId,spreadsheetUrl,properties(title)",
            )
            .execute()
        )
        title = created.get("properties", {}).get("title", "")
    else:
        title = "Budai Tánc recovery rehearsal " + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        created = (
            service.spreadsheets()
            .create(
                body={
                    "properties": {
                        "title": title,
                        "locale": "hu_HU",
                        "timeZone": "Europe/Budapest",
                    },
                    "sheets": [
                        {
                            "properties": {
                                "title": tab_title,
                                "gridProperties": {
                                    "rowCount": max(1000, len(rows) + 10),
                                    "columnCount": max(26, max(map(len, rows), default=1)),
                                },
                            }
                        }
                        for tab_title, rows in expected.items()
                    ],
                },
                fields="spreadsheetId,spreadsheetUrl,properties(title)",
            )
            .execute()
        )
        spreadsheet_id = created["spreadsheetId"]

    ensure_staging_tabs(service, spreadsheet_id, expected)

    # A copied production workbook may contain formulas or stale rows below the
    # active dataset. Clear only the isolated staging tabs before the first
    # write so the validation compares the complete reconstructed state.
    clear_snapshot(service, spreadsheet_id, list(expected))
    write_snapshot(service, spreadsheet_id, expected)
    first_checkboxes = ensure_email_output_checkboxes(
        service, spreadsheet_id, expected[EMAIL_OUTPUT_TAB]
    )
    first_validation = validate_snapshot(service, spreadsheet_id, expected)
    first_formatting = ensure_email_sent_formatting(
        service,
        spreadsheet_id,
        len(expected[EMAIL_OUTPUT_TAB][0]),
    )

    clear_snapshot(service, spreadsheet_id, list(expected))
    write_snapshot(service, spreadsheet_id, expected)
    replay_checkboxes = ensure_email_output_checkboxes(
        service, spreadsheet_id, expected[EMAIL_OUTPUT_TAB]
    )
    replay_validation = validate_snapshot(service, spreadsheet_id, expected)
    replay_formatting = ensure_email_sent_formatting(
        service,
        spreadsheet_id,
        len(expected[EMAIL_OUTPUT_TAB][0]),
    )
    if first_validation != replay_validation:
        raise RuntimeError("A staging rollback/replay nem adott azonos eredményt.")

    active_email = expected[EMAIL_OUTPUT_TAB]
    active_status_counts = Counter(
        value_at[EMAIL_STATUS_COLUMN_INDEX] if len(value_at) > EMAIL_STATUS_COLUMN_INDEX else ""
        for value_at in active_email[1:]
    )
    active_brevo_ids = {
        row[EMAIL_MESSAGE_ID_COLUMN_INDEX]
        for row in active_email[1:]
        if len(row) > EMAIL_MESSAGE_ID_COLUMN_INDEX
        and row[EMAIL_MESSAGE_ID_COLUMN_INDEX]
        and row[EMAIL_MESSAGE_ID_COLUMN_INDEX] != "MANUÁLIS"
    }
    active_manual_sent = sum(
        len(row) > EMAIL_MANUAL_SENT_COLUMN_INDEX
        and checked(row[EMAIL_MANUAL_SENT_COLUMN_INDEX])
        for row in active_email[1:]
    )
    active_green_sent_rows = sum(has_consistent_send_history(row) for row in active_email[1:])

    report = {
        "mode": "isolated_staging_sheet",
        "production_spreadsheet_untouched": True,
        "real_email_send": False,
        "staging_spreadsheet_id": spreadsheet_id,
        "staging_spreadsheet_url": created.get("spreadsheetUrl", ""),
        "title": created.get("properties", {}).get("title", title),
        "initial_write": first_validation,
        "rollback_replay": replay_validation,
        "initial_email_checkboxes": first_checkboxes,
        "replay_email_checkboxes": replay_checkboxes,
        "initial_sent_conditional_formatting": first_formatting,
        "replay_sent_conditional_formatting": replay_formatting,
        "master_unique_ids": 169,
        "email_unique_send_keys": 169,
        "email_approvals_enabled": 0,
        "active_email_status_counts": dict(sorted(active_status_counts.items())),
        "active_brevo_message_ids": len(active_brevo_ids),
        "active_manual_sent_markers": active_manual_sent,
        "active_green_sent_rows": active_green_sent_rows,
        "incident_archive_rows": len(expected["E-mail kimenet – incidensarchívum"]) - 1,
        "manual_history_review_rows": len(expected["Kézi küldés egyeztetés"]) - 1,
        "manual_action_rows": len(expected["Kézi elbírálás teendők"]) - 1,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "staging_spreadsheet_id": spreadsheet_id,
        "master_unique_ids": 169,
        "email_unique_send_keys": 169,
        "email_approvals_enabled": 0,
        "rollback_replay_identical": True,
        "active_email_status_counts": dict(sorted(active_status_counts.items())),
        "active_brevo_message_ids": len(active_brevo_ids),
        "active_manual_sent_markers": active_manual_sent,
        "active_green_sent_rows": active_green_sent_rows,
        "manual_action_rows": len(expected["Kézi elbírálás teendők"]) - 1,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
