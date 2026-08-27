#!/usr/bin/env python3
"""Read-only evidence report for the Budai Tánc e-mail incident.

The script never writes to Google Sheets. It intentionally reports only row
numbers and registration IDs, not names or e-mail addresses, so its output can
be retained alongside the recovery work without copying personal data.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

# Make the repository modules available when the script is invoked directly.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import load_config
from gravity_forms_csv import load_registrations
from google_sheets_sync import build_service


EMAIL_OUTPUT_TAB = "E-mail kimenet"
EMAIL_EVENT_LOG_TAB = "E-mail eseménynapló"
AUTOMATION_CONFIG_TAB = "Automata kalk"
EMAIL_SETTINGS_TAB = "E-mail beállítások"
RECOVERY_CLASSIFIER = (
    Path(__file__).resolve().parents[1]
    / "cloudflare-worker"
    / "scripts"
    / "classify-recovery-source.mjs"
)


def text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def value_at(row: list[str], index: int) -> str:
    return text(row[index] if index < len(row) else "")


def checked(value: Any) -> bool:
    return text(value).casefold() in {"true", "igen", "1"}


def email_key(value: str) -> str:
    return text(value).lower()


def expected_first_name(full_name: str) -> str:
    # The existing e-mail logic asks for a separately maintained helper field.
    # This produces only review candidates, never an automatic correction.
    pieces = [piece for piece in text(full_name).split() if piece]
    return pieces[-1] if pieces else ""


def normalize_name(value: str) -> str:
    return " ".join(text(value).casefold().split())


def normalized_value(value: Any) -> str:
    return " ".join(text(value).casefold().split())


def parse_date(value: str) -> date | None:
    match = re.search(r"(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})", text(value))
    if not match:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def expected_contact_first_name(row: list[str]) -> str:
    birth_date = parse_date(value_at(row, 14))
    submitted_date = parse_date(value_at(row, 6))
    student_name = value_at(row, 5)
    parent_name = value_at(row, 18)
    if not birth_date or not submitted_date:
        return ""
    age = submitted_date.year - birth_date.year - ((submitted_date.month, submitted_date.day) < (birth_date.month, birth_date.day))
    if age >= 18 and (not parent_name or normalize_name(parent_name) == normalize_name(student_name)):
        return expected_first_name(student_name)
    if age < 18 and parent_name:
        return expected_first_name(parent_name)
    return ""


def execute_read(request: Any) -> dict[str, Any]:
    """Retry only transient Google API read failures; no request here mutates data."""
    last_error: Exception | None = None
    for attempt in range(5):
        try:
            return request.execute()
        except Exception as error:  # Google client exceptions vary by transport.
            status = getattr(getattr(error, "resp", None), "status", None)
            if status not in {429, 500, 502, 503, 504} or attempt == 4:
                raise
            last_error = error
            time.sleep(2**attempt)
    raise RuntimeError("Unexpected exhausted read retry") from last_error


def read_range(service: Any, spreadsheet_id: str, tab_name: str, columns: str) -> list[list[str]]:
    request = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=spreadsheet_id, range=f"'{tab_name}'!{columns}")
    )
    result = execute_read(request)
    return result.get("values", [])


def count_duplicates(values: list[str]) -> dict[str, int]:
    counts = Counter(value for value in values if value)
    return {value: count for value, count in counts.items() if count > 1}


def classify_recovery_source(
    source_rows: list[Any], config_rows: list[list[str]], settings_rows: list[list[str]]
) -> dict[str, Any]:
    """Run the production JS rules and retain only the classifier's PII-free output."""
    payload = {
        "registrations": [
            {
                "entryId": text(row.reference_id),
                "sheetRow": list(row.sheet_row),
                "trialDate": text(row.trial_date),
            }
            for row in source_rows
        ],
        "configRows": config_rows,
        "settingsRows": settings_rows,
    }
    completed = subprocess.run(
        ["node", str(RECOVERY_CLASSIFIER)],
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip().splitlines()[-1] if completed.stderr.strip() else "ismeretlen hiba"
        raise RuntimeError(f"A read-only helyreállítási besorolás sikertelen: {detail}")
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("A read-only helyreállítási besorolás hibás JSON-t adott.") from error


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="JSON evidence report path")
    parser.add_argument(
        "--gravity-csv",
        type=Path,
        help="Complete Gravity Forms export to reconcile against the current master sheet",
    )
    args = parser.parse_args()

    config = load_config(
        csv_path=None,
        pipeline_id=None,
        spreadsheet_id=None,
        tab_name=None,
        service_account_json=None,
        require_csv_path=False,
    )
    service = build_service(config.service_account_json)
    metadata = execute_read(service.spreadsheets().get(
        spreadsheetId=config.spreadsheet_id,
        fields="sheets(properties(title))",
    ))
    tabs = {sheet["properties"]["title"] for sheet in metadata.get("sheets", [])}
    master_tab = next((title for title in tabs if title.strip() == config.tab_name.strip()), None)
    if not master_tab:
        raise RuntimeError(f"Could not resolve configured master sheet: {config.tab_name!r}")
    missing_tabs = sorted({EMAIL_OUTPUT_TAB, EMAIL_EVENT_LOG_TAB} - tabs)
    if missing_tabs:
        raise RuntimeError(f"Missing required sheets: {', '.join(missing_tabs)}")

    master_rows = read_range(service, config.spreadsheet_id, master_tab, "A:AT")
    email_rows = read_range(service, config.spreadsheet_id, EMAIL_OUTPUT_TAB, "A:AH")
    event_rows = read_range(service, config.spreadsheet_id, EMAIL_EVENT_LOG_TAB, "A:I")
    if value_at(master_rows[0] if master_rows else [], 0) != "Közlemény":
        raise RuntimeError("The master sheet does not start with the expected Közlemény header.")
    if value_at(email_rows[0] if email_rows else [], 0) != "Küldési kulcs":
        raise RuntimeError("The email output sheet does not start with the expected Küldési kulcs header.")

    master_data = master_rows[1:]
    email_data = email_rows[1:]
    event_data = event_rows[1:]
    email_event_summaries = [
        {
            "event_row": row_number,
            "event": value_at(row, 3),
            "raw_type": value_at(row, 8),
            "event_at": value_at(row, 5),
            "received_at": value_at(row, 6),
        }
        for row_number, row in enumerate(event_data, start=2)
        if value_at(row, 0)
    ]
    email_event_type_counts = Counter(
        summary["raw_type"] or "unknown" for summary in email_event_summaries
    )
    master_by_id: dict[str, list[tuple[int, list[str]]]] = defaultdict(list)
    stale_helper_candidates: list[dict[str, Any]] = []
    for offset, row in enumerate(master_data, start=2):
        entry_id = value_at(row, 0)
        if entry_id:
            master_by_id[entry_id].append((offset, row))
        expected_contact = expected_contact_first_name(row)
        expected_student = expected_first_name(value_at(row, 5))
        actual_contact = value_at(row, 44)
        actual_student = value_at(row, 45)
        if (actual_contact and expected_contact and actual_contact.casefold() != expected_contact.casefold()) or (
            actual_student and expected_student and actual_student.casefold() != expected_student.casefold()
        ):
            stale_helper_candidates.append({"master_row": offset, "entry_id": entry_id})

    duplicate_master_ids = {
        entry_id: [row_number for row_number, _ in rows]
        for entry_id, rows in master_by_id.items()
        if len(rows) > 1
    }
    nonempty_email_rows = [
        (row_number, row)
        for row_number, row in enumerate(email_data, start=2)
        if value_at(row, 0)
    ]
    active_email_approvals = [
        {"email_row": row_number, "entry_id": value_at(row, 1)}
        for row_number, row in nonempty_email_rows
        if checked(value_at(row, 11))
    ]
    duplicate_send_keys = count_duplicates([value_at(row, 0) for _, row in nonempty_email_rows])
    email_rows_by_send_key: dict[str, list[int]] = defaultdict(list)
    email_rows_by_intent: dict[tuple[str, str, str], list[int]] = defaultdict(list)
    email_identity_issues: list[dict[str, Any]] = []
    for row_number, row in nonempty_email_rows:
        send_key = value_at(row, 0)
        entry_id = value_at(row, 1)
        period = value_at(row, 2)
        event_type = value_at(row, 21) or (send_key.split("|")[1] if "|" in send_key else "")
        email_rows_by_send_key[send_key].append(row_number)
        email_rows_by_intent[(entry_id, event_type, period)].append(row_number)
        master_matches = master_by_id.get(entry_id, [])
        if len(master_matches) != 1:
            email_identity_issues.append({
                "email_row": row_number,
                "entry_id": entry_id,
                "reason": "missing_master" if not master_matches else "duplicate_master",
            })
            continue
        master_email = email_key(value_at(master_matches[0][1], 17))
        if master_email and email_key(value_at(row, 4)) != master_email:
            email_identity_issues.append({"email_row": row_number, "entry_id": entry_id, "reason": "recipient_mismatch"})

    duplicate_intents = [
        {"entry_id": entry_id, "event_type": event_type, "period": period, "email_rows": rows}
        for (entry_id, event_type, period), rows in email_rows_by_intent.items()
        if entry_id and len(rows) > 1
    ]
    report = {
        "generated_at": datetime.now(UTC).isoformat(),
        "mode": "read_only",
        "source": {"pipeline_id": config.pipeline_id, "master_tab": master_tab},
        "counts": {
            "master_rows": sum(1 for row in master_data if value_at(row, 0)),
            "email_output_rows": len(nonempty_email_rows),
            "email_event_rows": sum(1 for row in event_data if value_at(row, 0)),
            "duplicate_master_ids": len(duplicate_master_ids),
            "duplicate_send_keys": len(duplicate_send_keys),
            "duplicate_email_intents": len(duplicate_intents),
            "email_identity_issues": len(email_identity_issues),
            "stale_name_helper_candidates": len(stale_helper_candidates),
            "active_email_approvals": len(active_email_approvals),
            "email_event_types": dict(sorted(email_event_type_counts.items())),
        },
        "findings": {
            "duplicate_master_ids": duplicate_master_ids,
            "duplicate_send_keys": {key: rows for key, rows in email_rows_by_send_key.items() if len(rows) > 1},
            "duplicate_email_intents": sorted(duplicate_intents, key=lambda item: (item["entry_id"], item["event_type"], item["period"])),
            "email_identity_issues": email_identity_issues,
            "stale_name_helper_candidates": stale_helper_candidates,
            "active_email_approvals": active_email_approvals,
            "latest_email_events": email_event_summaries[-5:],
        },
    }
    if args.gravity_csv:
        classification_tabs = {AUTOMATION_CONFIG_TAB, EMAIL_SETTINGS_TAB}
        missing_classification_tabs = sorted(classification_tabs - tabs)
        if missing_classification_tabs:
            raise RuntimeError(
                "Missing recovery-classification sheets: "
                + ", ".join(missing_classification_tabs)
            )
        source_rows = load_registrations(args.gravity_csv, config.adapter_name)
        source_by_id = {text(row.reference_id): row for row in source_rows if text(row.reference_id)}
        if len(source_by_id) != len(source_rows):
            raise RuntimeError("The Gravity Forms export contains duplicate or missing entry IDs.")
        source_ids = set(source_by_id)
        master_ids = set(master_by_id)
        comparison_columns = list(range(0, 9)) + list(range(14, 27))
        source_vs_master_mismatches: list[dict[str, Any]] = []
        for entry_id in sorted(source_ids & master_ids):
            master_matches = master_by_id[entry_id]
            if len(master_matches) != 1:
                continue
            master_row = master_matches[0][1]
            source_row = source_by_id[entry_id].sheet_row
            changed_columns = [
                value_at(master_rows[0], index)
                for index in comparison_columns
                if normalized_value(source_row[index]) != normalized_value(value_at(master_row, index))
            ]
            if changed_columns:
                source_vs_master_mismatches.append({
                    "entry_id": entry_id,
                    "master_row": master_matches[0][0],
                    "columns": changed_columns,
                })
        report["gravity_forms_export"] = {
            "path": str(args.gravity_csv),
            "rows": len(source_rows),
            "unique_entry_ids": len(source_ids),
            "source_only_entry_ids": sorted(source_ids - master_ids),
            "master_only_entry_ids": sorted(master_ids - source_ids),
            "master_duplicate_entry_ids": sorted(entry_id for entry_id in source_ids if len(master_by_id.get(entry_id, [])) > 1),
            "unique_id_field_mismatches": source_vs_master_mismatches,
            "counts": {
                "source_only": len(source_ids - master_ids),
                "master_only": len(master_ids - source_ids),
                "master_duplicates_present_in_source": sum(len(master_by_id.get(entry_id, [])) > 1 for entry_id in source_ids),
                "unique_id_field_mismatches": len(source_vs_master_mismatches),
            },
        }
        config_rows = read_range(
            service, config.spreadsheet_id, AUTOMATION_CONFIG_TAB, "A:Y"
        )
        settings_rows = read_range(
            service, config.spreadsheet_id, EMAIL_SETTINGS_TAB, "A:H"
        )
        report["recovery_classification"] = classify_recovery_source(
            source_rows, config_rows, settings_rows
        )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report["counts"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
