#!/usr/bin/env python3
"""Preflight or apply the approved Budai Tánc production recovery.

This command never sends e-mail. Production writes require an exact recovery
manifest digest, a verified Drive backup identifier, an approval record and
two explicit execution acknowledgements. Every source tab is read twice and
must still equal the frozen incident snapshot before any write occurs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import load_config
from google_sheets_sync import build_service
from scripts.rehearse_recovery_sheet import (
    EMAIL_OUTPUT_TAB,
    ensure_email_sent_formatting,
    has_consistent_send_history,
    quote_tab,
    read_csv,
    read_tab,
    semantic_hash,
    trim_rows,
)


EMAIL_EVENT_LOG_TAB = "E-mail eseménynapló"
AUTOMATION_CONFIG_TAB = "Automata kalk"
EMAIL_SETTINGS_TAB = "E-mail beállítások"
INCIDENT_ARCHIVE_TAB = "E-mail kimenet – incidensarchívum"
MANUAL_HISTORY_TAB = "Kézi küldés egyeztetés"
MANUAL_ACTION_TAB = "Kézi elbírálás teendők"

SNAPSHOT_FILES = {
    "master": ("master-before.csv", "master_before"),
    EMAIL_OUTPUT_TAB: ("email-output-archive.csv", "email_output_archive"),
    EMAIL_EVENT_LOG_TAB: ("email-event-archive.csv", "email_event_archive"),
    AUTOMATION_CONFIG_TAB: ("automation-config.csv", "automation_config"),
    EMAIL_SETTINGS_TAB: ("email-settings.csv", "email_settings"),
}

TARGET_FILES = {
    "master": ("master-reconstruction.csv", "master_reconstruction"),
    EMAIL_OUTPUT_TAB: ("email-output-reconstruction.csv", "email_output_reconstruction"),
    INCIDENT_ARCHIVE_TAB: (
        "email-output-incident-archive.csv",
        "email_output_incident_archive",
    ),
    MANUAL_HISTORY_TAB: (
        "email-manual-history-review.csv",
        "email_manual_history_review",
    ),
    MANUAL_ACTION_TAB: (
        "email-manual-action-queue.csv",
        "email_manual_action_queue",
    ),
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def checked(value: Any) -> bool:
    return value is True or str(value).strip().casefold() in {"true", "igaz", "igen", "1"}


def write_report(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def load_and_verify_bundle(
    scratch_dir: Path,
    manifest_path: Path,
    expected_manifest_sha256: str,
) -> tuple[dict[str, Any], dict[str, list[list[str]]], dict[str, list[list[str]]]]:
    actual_manifest_sha256 = sha256_file(manifest_path)
    if actual_manifest_sha256 != expected_manifest_sha256:
        raise RuntimeError(
            "A recovery manifest digestje eltér a jóváhagyott revíziótól."
        )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest_files = manifest.get("files", {})
    for manifest_key, file_record in manifest_files.items():
        filename = str(file_record.get("filename", ""))
        path = scratch_dir / filename
        if (
            not filename
            or path.parent.resolve() != scratch_dir.resolve()
            or not path.is_file()
            or file_record.get("sha256") != sha256_file(path)
        ):
            raise RuntimeError(
                f"Eltérő vagy hiányzó recovery-fájl a manifestben: {manifest_key}"
            )

    snapshots: dict[str, list[list[str]]] = {}
    targets: dict[str, list[list[str]]] = {}
    for logical_name, (filename, manifest_key) in SNAPSHOT_FILES.items():
        path = scratch_dir / filename
        expected = manifest_files.get(manifest_key, {})
        if expected.get("filename") != filename or expected.get("sha256") != sha256_file(path):
            raise RuntimeError(f"Eltérő vagy hiányzó recovery-fájl: {filename}")
        snapshots[logical_name] = read_csv(path)
    for logical_name, (filename, manifest_key) in TARGET_FILES.items():
        path = scratch_dir / filename
        expected = manifest_files.get(manifest_key, {})
        if expected.get("filename") != filename or expected.get("sha256") != sha256_file(path):
            raise RuntimeError(f"Eltérő vagy hiányzó recovery-fájl: {filename}")
        targets[logical_name] = read_csv(path)
    return manifest, snapshots, targets


def resolved_tabs(master_tab: str) -> dict[str, str]:
    return {
        "master": master_tab,
        EMAIL_OUTPUT_TAB: EMAIL_OUTPUT_TAB,
        EMAIL_EVENT_LOG_TAB: EMAIL_EVENT_LOG_TAB,
        AUTOMATION_CONFIG_TAB: AUTOMATION_CONFIG_TAB,
        EMAIL_SETTINGS_TAB: EMAIL_SETTINGS_TAB,
    }


def read_snapshot(
    service: Any,
    spreadsheet_id: str,
    tab_names: dict[str, str],
) -> dict[str, list[list[Any]]]:
    return {
        logical_name: read_tab(service, spreadsheet_id, title)
        for logical_name, title in tab_names.items()
    }


def snapshot_hashes(rows_by_tab: dict[str, list[list[Any]]]) -> dict[str, str]:
    return {name: semantic_hash(rows) for name, rows in rows_by_tab.items()}


def assert_snapshot_matches(
    actual: dict[str, list[list[Any]]],
    expected: dict[str, list[list[str]]],
) -> None:
    mismatches = [
        name
        for name in expected
        if semantic_hash(actual.get(name, [])) != semantic_hash(expected[name])
    ]
    if mismatches:
        raise RuntimeError(
            "Az éles Sheet megváltozott a befagyasztott snapshot óta: "
            + ", ".join(mismatches)
        )


def validate_targets(targets: dict[str, list[list[str]]]) -> dict[str, Any]:
    master_rows = trim_rows(targets["master"])
    email_rows = trim_rows(targets[EMAIL_OUTPUT_TAB])
    master_ids = [row[0] for row in master_rows[1:] if row]
    send_keys = [row[0] for row in email_rows[1:] if row]
    approvals = [row[11] if len(row) > 11 else "" for row in email_rows[1:] if row]
    if len(master_ids) != 169 or len(master_ids) != len(set(master_ids)):
        raise RuntimeError("A production cél nem 169 egyedi forrásrekordot tartalmaz.")
    if len(send_keys) != 169 or len(send_keys) != len(set(send_keys)):
        raise RuntimeError("A production e-mail cél nem 169 egyedi küldési kulcsot tartalmaz.")
    if any(str(value).strip().casefold() not in {"", "false"} for value in approvals):
        raise RuntimeError("A production cél bekapcsolt e-mail-jóváhagyást tartalmaz.")
    return {
        "master_unique_ids": len(master_ids),
        "email_unique_send_keys": len(send_keys),
        "email_approvals_enabled": 0,
        "green_sent_rows": sum(has_consistent_send_history(row) for row in email_rows[1:]),
        "incident_archive_rows": len(trim_rows(targets[INCIDENT_ARCHIVE_TAB])) - 1,
        "manual_history_review_rows": len(trim_rows(targets[MANUAL_HISTORY_TAB])) - 1,
        "manual_action_rows": len(trim_rows(targets[MANUAL_ACTION_TAB])) - 1,
    }


def spreadsheet_metadata(service: Any, spreadsheet_id: str) -> dict[str, Any]:
    return (
        service.spreadsheets()
        .get(
            spreadsheetId=spreadsheet_id,
            fields=(
                "spreadsheetId,spreadsheetUrl,properties(title),"
                "sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))"
            ),
        )
        .execute()
    )


def add_auxiliary_tabs(
    service: Any,
    spreadsheet_id: str,
    metadata: dict[str, Any],
    targets: dict[str, list[list[str]]],
) -> list[int]:
    existing = {
        sheet["properties"]["title"]: sheet["properties"]
        for sheet in metadata.get("sheets", [])
    }
    collisions = sorted(
        title for title in (INCIDENT_ARCHIVE_TAB, MANUAL_HISTORY_TAB, MANUAL_ACTION_TAB)
        if title in existing
    )
    if collisions:
        raise RuntimeError(
            "A production segédlap már létezik; részleges migráció gyanú: "
            + ", ".join(collisions)
        )

    used_ids = {properties["sheetId"] for properties in existing.values()}
    next_id = 1_780_000_001
    requests: list[dict[str, Any]] = []
    created_ids: list[int] = []
    for title in (INCIDENT_ARCHIVE_TAB, MANUAL_HISTORY_TAB, MANUAL_ACTION_TAB):
        while next_id in used_ids:
            next_id += 1
        rows = targets[title]
        requests.append({
            "addSheet": {
                "properties": {
                    "sheetId": next_id,
                    "title": title,
                    "gridProperties": {
                        "rowCount": max(1000, len(rows) + 10),
                        "columnCount": max(26, max(map(len, rows), default=1)),
                    },
                }
            }
        })
        created_ids.append(next_id)
        used_ids.add(next_id)
        next_id += 1
    service.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={"requests": requests},
    ).execute()
    return created_ids


def clear_and_write_targets(
    service: Any,
    spreadsheet_id: str,
    master_tab: str,
    targets: dict[str, list[list[str]]],
) -> None:
    destination_titles = {
        "master": master_tab,
        EMAIL_OUTPUT_TAB: EMAIL_OUTPUT_TAB,
        INCIDENT_ARCHIVE_TAB: INCIDENT_ARCHIVE_TAB,
        MANUAL_HISTORY_TAB: MANUAL_HISTORY_TAB,
        MANUAL_ACTION_TAB: MANUAL_ACTION_TAB,
    }
    service.spreadsheets().values().batchClear(
        spreadsheetId=spreadsheet_id,
        body={"ranges": [quote_tab(title) for title in destination_titles.values()]},
    ).execute()
    service.spreadsheets().values().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={
            "valueInputOption": "RAW",
            "data": [
                {
                    "range": f"{quote_tab(title)}!A1",
                    "majorDimension": "ROWS",
                    "values": targets[logical_name],
                }
                for logical_name, title in destination_titles.items()
            ],
        },
    ).execute()


def validate_written_targets(
    service: Any,
    spreadsheet_id: str,
    master_tab: str,
    targets: dict[str, list[list[str]]],
) -> dict[str, str]:
    destination_titles = {
        "master": master_tab,
        EMAIL_OUTPUT_TAB: EMAIL_OUTPUT_TAB,
        INCIDENT_ARCHIVE_TAB: INCIDENT_ARCHIVE_TAB,
        MANUAL_HISTORY_TAB: MANUAL_HISTORY_TAB,
        MANUAL_ACTION_TAB: MANUAL_ACTION_TAB,
    }
    result: dict[str, str] = {}
    for logical_name, title in destination_titles.items():
        actual = read_tab(service, spreadsheet_id, title)
        actual_hash = semantic_hash(actual)
        expected_hash = semantic_hash(targets[logical_name])
        if actual_hash != expected_hash:
            raise RuntimeError(f"Eltérő production visszaolvasás: {title}")
        result[title] = actual_hash
    return result


def rollback(
    service: Any,
    spreadsheet_id: str,
    master_tab: str,
    snapshots: dict[str, list[list[str]]],
    created_sheet_ids: list[int],
) -> None:
    titles = {"master": master_tab, EMAIL_OUTPUT_TAB: EMAIL_OUTPUT_TAB}
    service.spreadsheets().values().batchClear(
        spreadsheetId=spreadsheet_id,
        body={"ranges": [quote_tab(title) for title in titles.values()]},
    ).execute()
    service.spreadsheets().values().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={
            "valueInputOption": "RAW",
            "data": [
                {
                    "range": f"{quote_tab(title)}!A1",
                    "majorDimension": "ROWS",
                    "values": snapshots[logical_name],
                }
                for logical_name, title in titles.items()
            ],
        },
    ).execute()
    if created_sheet_ids:
        service.spreadsheets().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={
                "requests": [
                    {"deleteSheet": {"sheetId": sheet_id}}
                    for sheet_id in created_sheet_ids
                ]
            },
        ).execute()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scratch-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--manifest-sha256", required=True)
    parser.add_argument("--backup-spreadsheet-id")
    parser.add_argument("--approval-id")
    parser.add_argument("--report", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preflight-only", action="store_true")
    mode.add_argument("--execute-production-migration", action="store_true")
    parser.add_argument("--acknowledge-no-email-send", action="store_true")
    args = parser.parse_args()

    manifest, snapshots, targets = load_and_verify_bundle(
        args.scratch_dir,
        args.manifest,
        args.manifest_sha256,
    )
    target_validation = validate_targets(targets)
    config = load_config(
        csv_path=None,
        pipeline_id=None,
        spreadsheet_id=None,
        tab_name=None,
        service_account_json=None,
        require_csv_path=False,
    )
    service = build_service(config.service_account_json)
    metadata = spreadsheet_metadata(service, config.spreadsheet_id)
    sheet_titles = {
        sheet["properties"]["title"] for sheet in metadata.get("sheets", [])
    }
    master_tab = next(
        (title for title in sheet_titles if title.strip() == config.tab_name.strip()),
        None,
    )
    if master_tab is None:
        raise RuntimeError("A konfigurált production főlap nem található.")
    tab_names = resolved_tabs(master_tab)
    missing_tabs = sorted(set(tab_names.values()) - sheet_titles)
    if missing_tabs:
        raise RuntimeError("Hiányzó production lapok: " + ", ".join(missing_tabs))

    first_live = read_snapshot(service, config.spreadsheet_id, tab_names)
    second_live = read_snapshot(service, config.spreadsheet_id, tab_names)
    first_hashes = snapshot_hashes(first_live)
    second_hashes = snapshot_hashes(second_live)
    if first_hashes != second_hashes:
        raise RuntimeError("Az éles Sheet megváltozott a két preflight-olvasás között.")
    assert_snapshot_matches(second_live, snapshots)

    base_report: dict[str, Any] = {
        "generated_at": datetime.now(UTC).isoformat(),
        "mode": "production_preflight" if args.preflight_only else "production_migration",
        "approval_id": args.approval_id or "",
        "approved_manifest_sha256": args.manifest_sha256,
        "production_spreadsheet_id": config.spreadsheet_id,
        "backup_spreadsheet_id": args.backup_spreadsheet_id or "",
        "real_email_send": False,
        "source_snapshot_stable": True,
        "source_snapshot_hashes": second_hashes,
        "target_validation": target_validation,
        "manifest_mode": manifest.get("mode", ""),
        "manifest_snapshot_mode": manifest.get("snapshot_mode", ""),
    }
    if args.preflight_only:
        base_report["production_write"] = False
        write_report(args.report, base_report)
        print(json.dumps(base_report, ensure_ascii=False, sort_keys=True))
        return 0

    if not args.acknowledge_no_email_send:
        raise RuntimeError("Hiányzik az --acknowledge-no-email-send védelmi kapcsoló.")
    if not args.approval_id:
        raise RuntimeError("Az éles migrációhoz jóváhagyási rekord szükséges.")
    if not args.backup_spreadsheet_id:
        raise RuntimeError("Az éles migrációhoz ellenőrzött Drive-backup szükséges.")
    if args.backup_spreadsheet_id == config.spreadsheet_id:
        raise RuntimeError("A backup spreadsheet nem lehet azonos a production Sheettel.")

    created_sheet_ids: list[int] = []
    try:
        created_sheet_ids = add_auxiliary_tabs(
            service, config.spreadsheet_id, metadata, targets
        )
        clear_and_write_targets(
            service, config.spreadsheet_id, master_tab, targets
        )
        written_hashes = validate_written_targets(
            service, config.spreadsheet_id, master_tab, targets
        )
        formatting = ensure_email_sent_formatting(
            service,
            config.spreadsheet_id,
            len(targets[EMAIL_OUTPUT_TAB][0]),
        )
    except Exception as migration_error:
        rollback(
            service,
            config.spreadsheet_id,
            master_tab,
            snapshots,
            created_sheet_ids,
        )
        restored = read_snapshot(service, config.spreadsheet_id, tab_names)
        assert_snapshot_matches(restored, snapshots)
        failure_report = {
            **base_report,
            "production_write": True,
            "migration_succeeded": False,
            "rollback_succeeded": True,
            "error_type": type(migration_error).__name__,
        }
        write_report(args.report, failure_report)
        raise RuntimeError(
            "Az éles migráció sikertelen volt; a forrássnapshot visszaállt."
        ) from migration_error

    success_report = {
        **base_report,
        "production_write": True,
        "migration_succeeded": True,
        "rollback_required": False,
        "written_semantic_hashes": written_hashes,
        "sent_conditional_formatting": formatting,
    }
    write_report(args.report, success_report)
    print(json.dumps(success_report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
