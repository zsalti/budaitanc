#!/usr/bin/env python3
"""Restore the incident-approved Sheets state from a verified staging copy.

The command never calls the Worker or Brevo. In preflight mode it performs
only reads. Execution is intentionally noisy: it creates a Drive copy of the
current production workbook, rechecks both sheets, restores only the approved
tabs, verifies their hashes, and rolls the values back on any failed check.
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
from google_sheets_sync import build_drive_service, build_service
from scripts.rehearse_recovery_sheet import (
EMAIL_APPROVED_COLUMN_INDEX,
    EMAIL_OUTPUT_TAB,
    read_tab,
    semantic_hash,
    trim_rows,
)

INCIDENT_ARCHIVE_TAB = "E-mail kimenet – incidensarchívum"
MANUAL_HISTORY_TAB = "Kézi küldés egyeztetés"
MANUAL_ACTION_TAB = "Kézi elbírálás teendők"

# These values are the recovered state independently rehearsed on 2026-08-26.
KNOWN_GOOD_HASHES = {
    "master": "16a1a62d5a9354cd2b330ffd2c0d9d00d2927326b49afb01728c8b1454909ac9",
    # Google Sheets serializes checked values as uppercase TRUE/FALSE, while
    # the frozen CSV had Python-style True/False. The canonical checkbox hash
    # below preserves the actual content meaning and catches every other diff.
    EMAIL_OUTPUT_TAB: "dfcec0f61b06ff3f8c5068171d1fe1f3b9ddcb3bcb54d3ddf43b8c6833abafff",
    INCIDENT_ARCHIVE_TAB: "6baac5896b64ec9499f1e005ac0b2bdcc02f4191bf8724e155f33cc5d2e72ca2",
    MANUAL_HISTORY_TAB: "8471f2260773b4732196ab7a09b090e14d6d06095f5282ee0794461f1c68e336",
    MANUAL_ACTION_TAB: "0ebe11b16eac6fb9b59bb1281b7ee242a81a5220b69f2249e372323e80be59fd",
}
HISTORICAL_RAW_EMAIL_OUTPUT_HASH = "04567732dace7eb8b2b755fed51c0e159496ef8329160dc9ed68ab07e0736b4e"
EMAIL_STATUS_INDEX = 12
EMAIL_MESSAGE_ID_INDEX = 13
EMAIL_ACCEPTED_AT_INDEX = 17
EMAIL_MANUAL_SENT_INDEX = 18
EMAIL_MANUAL_SENT_AT_INDEX = 19
EMAIL_MANUAL_SENT_BY_INDEX = 20
EMAIL_DELIVERY_STATUS_INDEX = 31
EMAIL_DELIVERY_AT_INDEX = 32
EMAIL_DELIVERY_ERROR_INDEX = 33
SEND_EVIDENCE_COLUMNS = (
    EMAIL_STATUS_INDEX,
    EMAIL_MESSAGE_ID_INDEX,
    EMAIL_ACCEPTED_AT_INDEX,
    EMAIL_MANUAL_SENT_INDEX,
    EMAIL_MANUAL_SENT_AT_INDEX,
    EMAIL_MANUAL_SENT_BY_INDEX,
    EMAIL_DELIVERY_STATUS_INDEX,
    EMAIL_DELIVERY_AT_INDEX,
    EMAIL_DELIVERY_ERROR_INDEX,
)


def quote_tab(title: str) -> str:
    return "'" + title.replace("'", "''") + "'"


def write_report(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def metadata(service: Any, spreadsheet_id: str) -> dict[str, Any]:
    return service.spreadsheets().get(
        spreadsheetId=spreadsheet_id,
        fields=(
            "spreadsheetId,spreadsheetUrl,properties(title),"
            "sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),basicFilter)"
        ),
    ).execute()


def find_master_tab(sheet_metadata: dict[str, Any], configured_name: str) -> str:
    for sheet in sheet_metadata.get("sheets", []):
        title = str(sheet.get("properties", {}).get("title", ""))
        if title.strip() == configured_name.strip():
            return title
    raise RuntimeError("A konfigurált főlap nem található a spreadsheetben.")


def source_titles(master_tab: str) -> dict[str, str]:
    return {
        "master": master_tab,
        EMAIL_OUTPUT_TAB: EMAIL_OUTPUT_TAB,
        INCIDENT_ARCHIVE_TAB: INCIDENT_ARCHIVE_TAB,
        MANUAL_HISTORY_TAB: MANUAL_HISTORY_TAB,
        MANUAL_ACTION_TAB: MANUAL_ACTION_TAB,
    }


def read_snapshot(service: Any, spreadsheet_id: str, titles: dict[str, str]) -> dict[str, list[list[Any]]]:
    return {logical_name: read_tab(service, spreadsheet_id, title) for logical_name, title in titles.items()}


def hashes(snapshot: dict[str, list[list[Any]]]) -> dict[str, str]:
    return {logical_name: semantic_hash(rows) for logical_name, rows in snapshot.items()}


def email_content_hash(rows: list[list[Any]]) -> str:
    """Hash e-mail rows while normalizing only typed checkbox representation."""
    normalized_rows = trim_rows(rows)
    for row in normalized_rows[1:]:
        for index in (EMAIL_APPROVED_COLUMN_INDEX, 18):
            if len(row) <= index:
                continue
            value = str(row[index]).strip().casefold()
            if value in {"true", "igaz", "igen", "1"}:
                row[index] = "TRUE"
            elif value in {"false", "hamis", "nem", "0", ""}:
                row[index] = "FALSE"
    payload = json.dumps(normalized_rows, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def content_hashes(snapshot: dict[str, list[list[Any]]]) -> dict[str, str]:
    result = hashes(snapshot)
    result[EMAIL_OUTPUT_TAB] = email_content_hash(snapshot[EMAIL_OUTPUT_TAB])
    return result


def value_at(row: list[Any], index: int) -> str:
    return str(row[index]).strip() if len(row) > index and row[index] is not None else ""


def checked(value: Any) -> bool:
    return str(value).strip().casefold() in {"true", "igaz", "igen", "1"}


def has_send_evidence(row: list[Any]) -> bool:
    status = value_at(row, EMAIL_STATUS_INDEX)
    message_id = value_at(row, EMAIL_MESSAGE_ID_INDEX)
    manual = checked(row[EMAIL_MANUAL_SENT_INDEX]) if len(row) > EMAIL_MANUAL_SENT_INDEX else False
    return manual or (message_id and message_id != "MANUÁLIS") or status in {"BREVO FOGADTA", "KÉZBESÍTVE"}


def overlay_production_send_evidence(
    staging_rows: list[list[Any]], production_rows: list[list[Any]],
) -> tuple[list[list[Any]], list[dict[str, str]]]:
    """Retain only verified send evidence from the post-migration production state."""
    restored = [list(row) for row in staging_rows]
    staging_by_key = {
        value_at(row, 0): index
        for index, row in enumerate(restored)
        if index > 0 and value_at(row, 0)
    }
    preserved: list[dict[str, str]] = []
    for production_row in production_rows[1:]:
        send_key = value_at(production_row, 0)
        if not send_key or not has_send_evidence(production_row):
            continue
        staging_index = staging_by_key.get(send_key)
        if staging_index is None:
            raise RuntimeError(
                "A productionben olyan igazolt küldési bizonyíték van, amely nincs "
                f"az ismert jó staging E-mail kimenetben: {send_key}."
            )
        staging_row = restored[staging_index]
        if value_at(staging_row, 4).casefold() != value_at(production_row, 4).casefold():
            raise RuntimeError(
                "A production küldési bizonyíték címzettje eltér a staging sortól: "
                f"{send_key}."
            )
        changed = False
        for column in SEND_EVIDENCE_COLUMNS:
            while len(staging_row) <= column:
                staging_row.append("")
            value = production_row[column] if len(production_row) > column else ""
            if staging_row[column] != value:
                staging_row[column] = value
                changed = True
        # A történeti küldési bizonyíték nem jelent új jóváhagyást.
        while len(staging_row) <= EMAIL_APPROVED_COLUMN_INDEX:
            staging_row.append("")
        staging_row[EMAIL_APPROVED_COLUMN_INDEX] = False
        if changed:
            preserved.append({
                "send_key": send_key,
                "evidence_type": "manual" if checked(production_row[EMAIL_MANUAL_SENT_INDEX]) else "brevo",
                "status": value_at(production_row, EMAIL_STATUS_INDEX),
                "message_id": value_at(production_row, EMAIL_MESSAGE_ID_INDEX),
            })
    return restored, preserved


def stable_read(service: Any, spreadsheet_id: str, titles: dict[str, str], label: str) -> tuple[dict[str, list[list[Any]]], dict[str, str]]:
    first = read_snapshot(service, spreadsheet_id, titles)
    second = read_snapshot(service, spreadsheet_id, titles)
    first_hashes = hashes(first)
    second_hashes = hashes(second)
    if first_hashes != second_hashes:
        raise RuntimeError(f"{label} a két egymást követő olvasás között megváltozott.")
    return second, second_hashes


def known_good_mismatches(source_hashes: dict[str, str]) -> dict[str, dict[str, str]]:
    return {
        name: {"expected": KNOWN_GOOD_HASHES[name], "actual": source_hashes.get(name, "")}
        for name in KNOWN_GOOD_HASHES
        if source_hashes.get(name) != KNOWN_GOOD_HASHES[name]
    }


def ensure_target_tabs(service: Any, spreadsheet_id: str, sheet_metadata: dict[str, Any], source: dict[str, list[list[Any]]], titles: dict[str, str]) -> list[int]:
    existing = {sheet["properties"]["title"]: sheet["properties"] for sheet in sheet_metadata.get("sheets", [])}
    requests: list[dict[str, Any]] = []
    created: list[int] = []
    next_id = 1_790_000_001
    used_ids = {properties["sheetId"] for properties in existing.values()}
    for logical_name, title in titles.items():
        if title in existing:
            continue
        rows = source[logical_name]
        while next_id in used_ids:
            next_id += 1
        requests.append({"addSheet": {"properties": {
            "sheetId": next_id,
            "title": title,
            "gridProperties": {
                "rowCount": max(1000, len(rows) + 10),
                "columnCount": max(26, max((len(row) for row in rows), default=1)),
            },
        }}})
        created.append(next_id)
        used_ids.add(next_id)
        next_id += 1
    if requests:
        service.spreadsheets().batchUpdate(spreadsheetId=spreadsheet_id, body={"requests": requests}).execute()
    return created


def write_snapshot(service: Any, spreadsheet_id: str, source: dict[str, list[list[Any]]], titles: dict[str, str]) -> None:
    ranges = [quote_tab(title) for title in titles.values()]
    service.spreadsheets().values().batchClear(spreadsheetId=spreadsheet_id, body={"ranges": ranges}).execute()
    service.spreadsheets().values().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={
            "valueInputOption": "RAW",
            "data": [
                {"range": f"{quote_tab(titles[name])}!A1", "majorDimension": "ROWS", "values": rows}
                for name, rows in source.items()
            ],
        },
    ).execute()


def remove_basic_filter(service: Any, spreadsheet_id: str, sheet_metadata: dict[str, Any], master_tab: str) -> bool:
    master = next(sheet for sheet in sheet_metadata.get("sheets", []) if sheet.get("properties", {}).get("title") == master_tab)
    basic_filter = master.get("basicFilter")
    if not basic_filter:
        return False
    service.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={"requests": [{"clearBasicFilter": {"sheetId": master["properties"]["sheetId"]}}]},
    ).execute()
    return True


def validate_target(snapshot: dict[str, list[list[Any]]]) -> dict[str, int]:
    master_rows = trim_rows(snapshot["master"])
    email_rows = trim_rows(snapshot[EMAIL_OUTPUT_TAB])
    master_ids = [str(row[0]).strip() for row in master_rows[1:] if row and str(row[0]).strip()]
    send_keys = [str(row[0]).strip() for row in email_rows[1:] if row and str(row[0]).strip()]
    approvals = [row[EMAIL_APPROVED_COLUMN_INDEX] if len(row) > EMAIL_APPROVED_COLUMN_INDEX else "" for row in email_rows[1:]]
    if len(master_ids) != 169 or len(master_ids) != len(set(master_ids)):
        raise RuntimeError("A visszaállított főlap nem 169 egyedi ID-t tartalmaz.")
    if len(send_keys) != 169 or len(send_keys) != len(set(send_keys)):
        raise RuntimeError("A visszaállított E-mail kimenet nem 169 egyedi küldési kulcsot tartalmaz.")
    if any(str(value).strip().casefold() not in {"", "false"} for value in approvals):
        raise RuntimeError("A visszaállított E-mail kimenet bekapcsolt jóváhagyást tartalmaz.")
    return {"master_unique_ids": len(master_ids), "email_unique_send_keys": len(send_keys), "email_approvals_enabled": 0}


def verify_backup_folder(drive: Any, folder_id: str) -> dict[str, str]:
    """Confirm that the requested archive folder accepts a new child file."""
    folder = drive.files().get(
        fileId=folder_id,
        fields="id,name,mimeType,trashed,driveId,capabilities(canAddChildren)",
        supportsAllDrives=True,
    ).execute()
    if folder.get("trashed") or folder.get("mimeType") != "application/vnd.google-apps.folder":
        raise RuntimeError("A backup célja nem elérhető Google Drive-mappa.")
    if not folder.get("capabilities", {}).get("canAddChildren"):
        raise RuntimeError("A szolgáltatási fiók nem hozhat létre fájlt a megadott backup-mappában.")
    return {
        "id": str(folder.get("id", "")),
        "name": str(folder.get("name", "")),
        "shared_drive": "true" if folder.get("driveId") else "false",
    }


def describe_drive_backup(drive: Any, backup_id: str) -> dict[str, str]:
    if not backup_id:
        raise RuntimeError("A backup azonosítója hiányzik.")
    file = drive.files().get(
        fileId=backup_id,
        fields="id,name,mimeType,createdTime,webViewLink,trashed",
        supportsAllDrives=True,
    ).execute()
    if file.get("trashed") or file.get("mimeType") != "application/vnd.google-apps.spreadsheet":
        raise RuntimeError("A megadott backup nem elérhető Google Sheets-másolat.")
    return {key: str(file.get(key, "")) for key in ("id", "name", "createdTime", "webViewLink")}


def create_drive_backup(drive: Any, production_id: str, title: str, folder_id: str | None = None) -> dict[str, str]:
    body: dict[str, Any] = {"name": title}
    if folder_id:
        body["parents"] = [folder_id]
    copied = drive.files().copy(
        fileId=production_id,
        body=body,
        fields="id,name,createdTime,webViewLink",
        supportsAllDrives=True,
    ).execute()
    if not copied.get("id"):
        raise RuntimeError("A Drive-backup nem adott vissza fájlazonosítót.")
    return {key: str(copied.get(key, "")) for key in ("id", "name", "createdTime", "webViewLink")}


def verify_existing_backup(
    service: Any,
    drive: Any,
    backup_id: str,
    production_id: str,
    configured_master_tab: str,
    expected_hashes: dict[str, str],
) -> dict[str, Any]:
    """Accept a human-owned copy only when it is the exact production snapshot."""
    if backup_id == production_id:
        raise RuntimeError("A backup nem lehet azonos a production Sheettel.")
    backup = describe_drive_backup(drive, backup_id)
    backup_meta = metadata(service, backup_id)
    backup_master = find_master_tab(backup_meta, configured_master_tab)
    backup_rows, backup_hashes = stable_read(
        service, backup_id, source_titles(backup_master), "A megadott Drive-backup"
    )
    del backup_rows
    if backup_hashes != expected_hashes:
        raise RuntimeError(
            "A megadott Drive-backup nem egyezik a visszaállítás előtti production-állapottal."
        )
    return {**backup, "verified_semantic_hashes": backup_hashes, "backup_source": "human_owned_copy"}


def rollback(service: Any, spreadsheet_id: str, before: dict[str, list[list[Any]]], titles: dict[str, str], created_tabs: list[int]) -> None:
    existing_titles = {name: title for name, title in titles.items() if name in before}
    write_snapshot(service, spreadsheet_id, before, existing_titles)
    if created_tabs:
        service.spreadsheets().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={"requests": [{"deleteSheet": {"sheetId": sheet_id}} for sheet_id in created_tabs]},
        ).execute()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staging-spreadsheet-id", required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--acknowledge-no-email-send", action="store_true")
    parser.add_argument("--backup-title", default="Budai Tánc production backup before verified staging restore")
    parser.add_argument("--backup-folder-id", help="Kötelező Drive-mentés célmappája")
    parser.add_argument(
        "--existing-backup-id",
        help="Másik felhasználó által készített, a szolgáltatási fiókkal megosztott Drive-másolat",
    )
    args = parser.parse_args()
    if args.backup_folder_id and args.existing_backup_id:
        parser.error("A --backup-folder-id és az --existing-backup-id egyszerre nem használható.")

    config = load_config(None, None, None, None, None, require_csv_path=False)
    service = build_service(config.service_account_json)
    production_meta = metadata(service, config.spreadsheet_id)
    production_master = find_master_tab(production_meta, config.tab_name)
    production_titles = source_titles(production_master)
    staging_meta = metadata(service, args.staging_spreadsheet_id)
    staging_master = find_master_tab(staging_meta, config.tab_name)
    staging_titles = source_titles(staging_master)
    staging_source, staging_hashes = stable_read(service, args.staging_spreadsheet_id, staging_titles, "A staging Sheet")
    staging_content_hashes = content_hashes(staging_source)
    staging_mismatches = known_good_mismatches(staging_content_hashes)
    if staging_mismatches:
        failed_report = {
            "generated_at": datetime.now(UTC).isoformat(),
            "mode": "verified_staging_restore_preflight",
            "production_spreadsheet_id": config.spreadsheet_id,
            "staging_spreadsheet_id": args.staging_spreadsheet_id,
            "production_write": False,
            "real_email_send": False,
            "staging_hashes": staging_hashes,
            "staging_content_hashes": staging_content_hashes,
            "historical_raw_email_output_hash": HISTORICAL_RAW_EMAIL_OUTPUT_HASH,
            "staging_known_good_mismatches": staging_mismatches,
        }
        write_report(args.report, failed_report)
        raise RuntimeError(
            "A staging Sheet nem egyezik a rögzített ismert jó állapottal: "
            + json.dumps(staging_mismatches, ensure_ascii=False)
        )
    production_before, production_hashes = stable_read(service, config.spreadsheet_id, production_titles, "A production Sheet")
    restored_email_rows, preserved_send_evidence = overlay_production_send_evidence(
        staging_source[EMAIL_OUTPUT_TAB],
        production_before[EMAIL_OUTPUT_TAB],
    )
    restoration_source = {**staging_source, EMAIL_OUTPUT_TAB: restored_email_rows}
    # Google Sheets typed checkboxes read back as TRUE/FALSE even when the
    # verified source contains Python-style True/False. Keep every other
    # value strict, but use the established canonical checkbox form here.
    restoration_hashes = content_hashes(restoration_source)
    report: dict[str, Any] = {
        "generated_at": datetime.now(UTC).isoformat(),
        "mode": "verified_staging_restore" if args.execute else "verified_staging_restore_preflight",
        "production_spreadsheet_id": config.spreadsheet_id,
        "staging_spreadsheet_id": args.staging_spreadsheet_id,
        "production_preflight_hashes": production_hashes,
        "staging_hashes": staging_hashes,
        "staging_content_hashes": staging_content_hashes,
        "historical_raw_email_output_hash": HISTORICAL_RAW_EMAIL_OUTPUT_HASH,
        "preserved_post_migration_send_evidence": preserved_send_evidence,
        "projected_restoration_hashes": restoration_hashes,
        "real_email_send": False,
        "production_write": False,
    }
    if not args.execute:
        write_report(args.report, report)
        print(json.dumps(report, ensure_ascii=False, sort_keys=True))
        return 0
    if not args.acknowledge_no_email_send:
        raise RuntimeError("Éles visszaállításhoz kötelező az --acknowledge-no-email-send kapcsoló.")
    if args.staging_spreadsheet_id == config.spreadsheet_id:
        raise RuntimeError("A staging Sheet nem lehet azonos a production Sheettel.")

    drive = build_drive_service(config.service_account_json)
    backup_title = f"{args.backup_title} {datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}"
    try:
        if args.existing_backup_id:
            backup = verify_existing_backup(
                service,
                drive,
                args.existing_backup_id,
                config.spreadsheet_id,
                config.tab_name,
                production_hashes,
            )
        else:
            backup_folder = verify_backup_folder(drive, args.backup_folder_id) if args.backup_folder_id else None
            if backup_folder:
                report["backup_destination"] = backup_folder
            backup = create_drive_backup(drive, config.spreadsheet_id, backup_title, args.backup_folder_id)
            backup["backup_source"] = "service_account_copy"
            if backup_folder:
                backup["folder_id"] = backup_folder["id"]
                backup["folder_name"] = backup_folder["name"]
                backup["folder_shared_drive"] = backup_folder["shared_drive"]
    except Exception as error:
        report.update({
            "production_write": False,
            "migration_succeeded": False,
            "backup_succeeded": False,
            "error_type": type(error).__name__,
        })
        write_report(args.report, report)
        raise RuntimeError("A kötelező Drive-backup sikertelen; production-írás nem történt.") from error
    # A backup közben sem fogadunk el köztes production-módosítást.
    latest_before, latest_hashes = stable_read(service, config.spreadsheet_id, production_titles, "A production Sheet")
    if latest_hashes != production_hashes:
        raise RuntimeError("A production Sheet a preflight és a backup között megváltozott; nincs írás.")

    created_tabs: list[int] = []
    try:
        created_tabs = ensure_target_tabs(service, config.spreadsheet_id, production_meta, restoration_source, production_titles)
        write_snapshot(service, config.spreadsheet_id, restoration_source, production_titles)
        removed_filter = remove_basic_filter(service, config.spreadsheet_id, production_meta, production_master)
        restored, _restored_raw_hashes = stable_read(service, config.spreadsheet_id, production_titles, "A visszaállított production Sheet")
        restored_hashes = content_hashes(restored)
        if restored_hashes != restoration_hashes:
            raise RuntimeError("A visszaírt production Sheet hash-e eltér az ellenőrzött helyreállítási céltól.")
        validation = validate_target(restored)
    except Exception as error:
        rollback(service, config.spreadsheet_id, latest_before, production_titles, created_tabs)
        rollback_snapshot, rollback_hashes = stable_read(service, config.spreadsheet_id, production_titles, "A rollback utáni production Sheet")
        if rollback_hashes != hashes(latest_before):
            raise RuntimeError("A visszaállítás és a rollback is hibás; a Drive-backuphoz kell visszatérni.") from error
        report.update({"production_write": True, "migration_succeeded": False, "rollback_succeeded": True, "drive_backup": backup, "error_type": type(error).__name__})
        write_report(args.report, report)
        raise RuntimeError("A visszaállítás hibás volt; a Sheet-értékek automatikusan visszaálltak.") from error

    report.update({
        "production_write": True,
        "migration_succeeded": True,
        "rollback_required": False,
        "drive_backup": backup,
        "written_semantic_hashes": restored_hashes,
        "removed_partial_basic_filter": removed_filter,
        "target_validation": validation,
    })
    write_report(args.report, report)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
