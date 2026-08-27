#!/usr/bin/env python3
"""Create a verified Drive backup before an append-only CSV import.

The source tabs are read twice before the Drive copy. The report intentionally
contains only identifiers, hashes, counts and the new backup ID; it contains no
registration data. Pass that ID to the import page's final execution step.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import load_config
from google_sheets_sync import build_drive_service, build_service
from scripts.rehearse_recovery_sheet import read_tab, semantic_hash, trim_rows

EMAIL_OUTPUT_TAB = "E-mail kimenet"


def verify_backup_folder(drive: Any, folder_id: str) -> dict[str, str]:
    """Confirm that the archive folder is writable before copying production."""
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


def find_master_tab(service: Any, spreadsheet_id: str, configured_tab: str) -> str:
    metadata = service.spreadsheets().get(
        spreadsheetId=spreadsheet_id,
        fields="sheets(properties(title))",
    ).execute()
    for sheet in metadata.get("sheets", []):
        title = str(sheet["properties"]["title"])
        if title.strip() == configured_tab.strip():
            return title
    raise RuntimeError("A konfigurált production főlap nem található.")


def stable_snapshot(service: Any, spreadsheet_id: str, master_tab: str) -> tuple[dict[str, list[list[Any]]], dict[str, str]]:
    def read() -> dict[str, list[list[Any]]]:
        return {
            "master": read_tab(service, spreadsheet_id, master_tab),
            "email_output": read_tab(service, spreadsheet_id, EMAIL_OUTPUT_TAB),
        }

    first = read()
    second = read()
    first_hashes = {name: semantic_hash(rows) for name, rows in first.items()}
    second_hashes = {name: semantic_hash(rows) for name, rows in second.items()}
    if first_hashes != second_hashes:
        raise RuntimeError("A production Sheet a két preflight-olvasás között megváltozott.")
    return second, second_hashes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--title", default="Budai Tánc import backup")
    parser.add_argument("--backup-folder-id", help="A Drive-mappa, ahová a másolat kerüljön")
    args = parser.parse_args()

    config = load_config(None, None, None, None, None, require_csv_path=False)
    service = build_service(config.service_account_json)
    master_tab = find_master_tab(service, config.spreadsheet_id, config.tab_name)
    snapshot, hashes = stable_snapshot(service, config.spreadsheet_id, master_tab)
    drive = build_drive_service(config.service_account_json)
    backup_folder = verify_backup_folder(drive, args.backup_folder_id) if args.backup_folder_id else None
    copy_body: dict[str, Any] = {"name": f"{args.title} {datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}"}
    if args.backup_folder_id:
        copy_body["parents"] = [args.backup_folder_id]
    copied = drive.files().copy(
        fileId=config.spreadsheet_id,
        body=copy_body,
        fields="id,name,createdTime,webViewLink",
        supportsAllDrives=True,
    ).execute()
    if not copied.get("id"):
        raise RuntimeError("A Drive-backup nem adott vissza azonosítót.")
    report = {
        "generated_at": datetime.now(UTC).isoformat(),
        "mode": "pre_import_drive_backup",
        "production_spreadsheet_id": config.spreadsheet_id,
        "backup": {key: copied.get(key, "") for key in ("id", "name", "createdTime", "webViewLink")},
        "backup_folder": backup_folder,
        "source_snapshot_hashes": hashes,
        "master_rows_including_header": len(trim_rows(snapshot["master"])),
        "email_rows_including_header": len(trim_rows(snapshot["email_output"])),
        "real_email_send": False,
        "production_write": False,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
