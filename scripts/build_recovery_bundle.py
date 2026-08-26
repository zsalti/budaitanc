#!/usr/bin/env python3
"""Build a deterministic, read-only recovery bundle for the e-mail incident.

The generated CSV files contain personal data and therefore belong under the
gitignored scratch directory with owner-only permissions. The retained JSON
manifest contains only row numbers, entry IDs, counts, field names and hashes.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

# Make repository modules available when invoked as ``python scripts/...``.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import load_config
from gravity_forms_csv import load_registrations
from google_sheets_sync import build_service, resolve_tab_name


EMAIL_OUTPUT_TAB = "E-mail kimenet"
EMAIL_EVENT_LOG_TAB = "E-mail eseménynapló"
AUTOMATION_CONFIG_TAB = "Automata kalk"
EMAIL_SETTINGS_TAB = "E-mail beállítások"
CANONICAL_COLUMNS = list(range(0, 9)) + list(range(14, 27))
MANUAL_TRANSFER_COLUMNS = [9, 10, 11, 12, 13, 27, 28, 29, 30, 31, 32]
TRIAL_DATE_COLUMN = 33
TOTAL_MASTER_COLUMNS = 46  # A:AT
APPROVED_SOURCE_OVERRIDE_COLUMNS = 34  # A:AH; derived AI columns remain cleared.
EMAIL_OUTPUT_BUILDER = (
    Path(__file__).resolve().parents[1]
    / "cloudflare-worker"
    / "scripts"
    / "build-recovery-email-output.mjs"
)
EMAIL_STATUS_READY = "KÜLDHETŐ"
EMAIL_STATUS_MANUAL = "KÉZI ELBÍRÁLÁS"
EMAIL_STATUS_SENT = "ELKÜLDVE"
EMAIL_STATUS_CHANGED_AFTER_SEND = "ELKÜLDÉS UTÁN MÓDOSULT"
EMAIL_STATUS_ACCEPTED = "BREVO FOGADTA"
EMAIL_STATUS_DELIVERED = "KÉZBESÍTVE"


@dataclass
class ApprovedSourceRecord:
    reference_id: str
    sheet_row: list[str]
    trial_date: str = ""


def text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def normalized(value: Any) -> str:
    return " ".join(text(value).casefold().split())


def value_at(row: list[Any], index: int) -> str:
    return text(row[index] if index < len(row) else "")


def canonical_matches(source_row: list[str], master_row: list[str]) -> bool:
    return all(
        normalized(value_at(source_row, index))
        == normalized(value_at(master_row, index))
        for index in CANONICAL_COLUMNS
    )


def build_reconstruction(
    source_rows: Iterable[Any], master_rows: list[list[str]]
) -> tuple[list[list[str]], list[dict[str, Any]], list[dict[str, Any]]]:
    source_rows = list(source_rows)
    source_ids = [text(row.reference_id) for row in source_rows]
    if any(not entry_id for entry_id in source_ids) or len(source_ids) != len(set(source_ids)):
        raise ValueError("A Gravity Forms-forrás azonosítói hiányosak vagy duplikáltak.")

    master_by_id: dict[str, list[tuple[int, list[str]]]] = defaultdict(list)
    for row_number, row in enumerate(master_rows[1:], start=2):
        entry_id = value_at(row, 0)
        if entry_id:
            master_by_id[entry_id].append((row_number, row))

    reconstructed: list[list[str]] = []
    transfers: list[dict[str, Any]] = []
    quarantines: list[dict[str, Any]] = []
    sorted_sources = sorted(source_rows, key=lambda row: entry_sort_key(text(row.reference_id)))
    for source_index, source in enumerate(sorted_sources, start=2):
        entry_id = text(source.reference_id)
        canonical = list(source.sheet_row)
        rebuilt = (canonical + [""] * TOTAL_MASTER_COLUMNS)[:TOTAL_MASTER_COLUMNS]
        rebuilt[TRIAL_DATE_COLUMN] = text(source.trial_date)
        matches = master_by_id.get(entry_id, [])

        if len(matches) == 1 and canonical_matches(canonical, matches[0][1]):
            master_row_number, master_row = matches[0]
            for column in MANUAL_TRANSFER_COLUMNS:
                rebuilt[column] = value_at(master_row, column)
            transfers.append(
                {
                    "entry_id": entry_id,
                    "source_row": source_index,
                    "master_row": master_row_number,
                }
            )
        else:
            if not matches:
                reason = "missing_from_current_master"
            elif len(matches) > 1:
                reason = "duplicate_current_master_id"
            else:
                reason = "canonical_fields_mismatch"
            quarantines.append(
                {
                    "entry_id": entry_id,
                    "source_row": source_index,
                    "current_master_rows": [row_number for row_number, _ in matches],
                    "reason": reason,
                }
            )
        reconstructed.append(rebuilt)

    return reconstructed, transfers, quarantines


def apply_approved_live_source_overrides(
    source_rows: Iterable[Any],
    master_rows: list[list[str]],
    approved_entry_ids: Iterable[str],
) -> tuple[list[Any], list[dict[str, Any]], list[list[str]]]:
    """Replace explicitly approved source rows with their unique live values.

    This is intentionally opt-in per entry ID. It is used only after an
    operator has resolved a source-fingerprint conflict and declared the live
    identity/course/manual values authoritative for that record.
    """
    records = list(source_rows)
    requested = sorted(
        {text(entry_id) for entry_id in approved_entry_ids if text(entry_id)},
        key=entry_sort_key,
    )
    if not requested:
        return records, [], []

    source_by_id = {text(row.reference_id): row for row in records}
    master_by_id: dict[str, list[tuple[int, list[str]]]] = defaultdict(list)
    for row_number, row in enumerate(master_rows[1:], start=2):
        if value_at(row, 0):
            master_by_id[value_at(row, 0)].append((row_number, row))
    header = (master_rows[0] + [""] * TOTAL_MASTER_COLUMNS)[:TOTAL_MASTER_COLUMNS]
    replacements: dict[str, ApprovedSourceRecord] = {}
    audit: list[dict[str, Any]] = []
    override_rows: list[list[str]] = []
    for entry_id in requested:
        if entry_id not in source_by_id:
            raise RuntimeError(f"A jóváhagyott live override ID nincs a Gravity-forrásban: {entry_id}")
        matches = master_by_id.get(entry_id, [])
        if len(matches) != 1:
            raise RuntimeError(
                f"A jóváhagyott live override ID nem egyedi az éles főlapon: {entry_id}"
            )
        master_row_number, live_row = matches[0]
        approved_row = (
            list(live_row) + [""] * APPROVED_SOURCE_OVERRIDE_COLUMNS
        )[:APPROVED_SOURCE_OVERRIDE_COLUMNS]
        approved_row[0] = entry_id
        original_row = list(source_by_id[entry_id].sheet_row)
        changed_fields = [
            header[index]
            for index in range(min(27, len(header)))
            if normalized(value_at(approved_row, index))
            != normalized(value_at(original_row, index))
        ]
        replacements[entry_id] = ApprovedSourceRecord(
            reference_id=entry_id,
            sheet_row=approved_row,
            trial_date=value_at(approved_row, TRIAL_DATE_COLUMN),
        )
        override_rows.append(approved_row)
        audit.append({
            "entry_id": entry_id,
            "live_master_row": master_row_number,
            "mode": "approved_full_live_source_row",
            "changed_source_fields": changed_fields,
        })

    effective_records = [
        replacements.get(text(row.reference_id), row)
        for row in records
    ]
    return effective_records, audit, override_rows


def write_csv(path: Path, rows: Iterable[Iterable[Any]]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerows(rows)
    os.chmod(path, 0o600)
    return sha256_file(path)


def read_csv(path: Path) -> list[list[str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return [list(row) for row in csv.reader(handle)]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def entry_sort_key(value: str) -> tuple[int, int | str]:
    try:
        return (0, int(value))
    except ValueError:
        return (1, value)


def read_range(service: Any, spreadsheet_id: str, tab: str, columns: str) -> list[list[str]]:
    result = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=spreadsheet_id, range=f"'{tab}'!{columns}")
        .execute()
    )
    return result.get("values", [])


def read_live_snapshot(
    service: Any, spreadsheet_id: str, master_tab: str
) -> tuple[list[list[str]], list[list[str]], list[list[str]], list[list[str]], list[list[str]]]:
    """Return two identical consecutive reads or fail instead of mixing moments."""
    def read_all() -> tuple[list[list[str]], list[list[str]], list[list[str]], list[list[str]], list[list[str]]]:
        return (
            read_range(service, spreadsheet_id, master_tab, "A:AT"),
            read_range(service, spreadsheet_id, EMAIL_OUTPUT_TAB, "A:AH"),
            read_range(service, spreadsheet_id, EMAIL_EVENT_LOG_TAB, "A:I"),
            read_range(service, spreadsheet_id, AUTOMATION_CONFIG_TAB, "A:Y"),
            read_range(service, spreadsheet_id, EMAIL_SETTINGS_TAB, "A:H"),
        )

    for _attempt in range(3):
        first = read_all()
        second = read_all()
        if first == second:
            return first
    raise RuntimeError(
        "Az élő Sheet két egymást követő olvasás között változott; "
        "konzisztens helyreállítási snapshot nem készült."
    )


def build_email_output(
    source_rows: Iterable[Any], config_rows: list[list[str]], settings_rows: list[list[str]]
) -> dict[str, Any]:
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
        ["node", str(EMAIL_OUTPUT_BUILDER)],
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip().splitlines()[-1] if completed.stderr.strip() else "ismeretlen hiba"
        raise RuntimeError(f"Az E-mail kimenet read-only rekonstrukciója sikertelen: {detail}")
    return json.loads(completed.stdout)


def checked(value: Any) -> bool:
    return normalized(value) in {"true", "igaz", "igen", "1"}


def logical_send_key(value: Any) -> tuple[str, str, str] | None:
    parts = text(value).split("|")
    return tuple(parts[:3]) if len(parts) >= 4 and all(parts[:3]) else None


def reconcile_delivery_history(
    headers: list[str],
    active_rows: list[list[Any]],
    archive_rows: list[list[str]],
    event_rows: list[list[str]],
) -> tuple[list[list[Any]], dict[str, Any], list[list[Any]]]:
    """Carry only provable send history into the clean active output.

    Brevo ownership comes from the append-only event log, not the corrupted
    output sheet. Manual sends require a complete marker plus an exact current
    entry-ID and recipient match. Anything weaker stays visible in a separate
    review queue and in the immutable incident archive.
    """

    archive_header = archive_rows[0] if archive_rows else []
    event_header = event_rows[0] if event_rows else []
    if headers[:2] != ["Küldési kulcs", "Bejegyzésazonosító"]:
        raise RuntimeError("Az aktív E-mail kimenet fejléce hibás.")
    if archive_header[:2] != ["Küldési kulcs", "Bejegyzésazonosító"]:
        raise RuntimeError("Az archivált E-mail kimenet fejléce hibás.")
    if event_header[:3] != ["Eseményazonosító", "Brevo messageId", "Küldési kulcs"]:
        raise RuntimeError("Az E-mail eseménynapló fejléce hibás.")

    active_index = {name: index for index, name in enumerate(headers)}
    archive_index = {name: index for index, name in enumerate(archive_header)}
    event_index = {name: index for index, name in enumerate(event_header)}

    def active_value(row: list[Any], name: str) -> str:
        return value_at(row, active_index[name])

    def archive_value(row: list[Any], name: str) -> str:
        return value_at(row, archive_index[name])

    def event_value(row: list[Any], name: str) -> str:
        return value_at(row, event_index[name])

    reconciled = [list(row) for row in active_rows]
    current_by_identity: dict[tuple[str, str], int] = {}
    current_by_intent: dict[tuple[tuple[str, str, str], str], int] = {}
    for index, row in enumerate(reconciled):
        identity = (
            active_value(row, "Bejegyzésazonosító"),
            normalized(active_value(row, "Címzett")),
        )
        intent = logical_send_key(active_value(row, "Küldési kulcs"))
        if not identity[0] or not identity[1] or identity in current_by_identity:
            raise RuntimeError("Az aktív e-mail-identitás hiányos vagy duplikált.")
        if not intent or (intent, identity[1]) in current_by_intent:
            raise RuntimeError("Az aktív e-mail-szándék hiányos vagy duplikált.")
        current_by_identity[identity] = index
        current_by_intent[(intent, identity[1])] = index

    manual_candidates: dict[tuple[str, str], list[tuple[int, list[str]]]] = defaultdict(list)
    manual_review = [[
        "Archív sorszám", "Bejegyzésazonosító", "Egyeztetési ok",
        "Küldési időpont megvan", "Megjegyzés megvan", "Küldési kulcs érvényes",
    ]]
    manual_marked_rows = 0
    for row_number, row in enumerate(archive_rows[1:], start=2):
        if not checked(archive_value(row, "Manuálisan elküldve")):
            continue
        manual_marked_rows += 1
        timestamp_present = bool(archive_value(row, "Manuális küldés időpontja"))
        note_present = bool(archive_value(row, "Manuális küldés megjegyzése / küldője"))
        send_key_valid = logical_send_key(archive_value(row, "Küldési kulcs")) is not None
        stored_entry_id = archive_value(row, "Bejegyzésazonosító")
        safe_entry_id = stored_entry_id if stored_entry_id.isdigit() else ""
        identity = (stored_entry_id, normalized(archive_value(row, "Címzett")))
        if not timestamp_present or not note_present:
            manual_review.append([
                row_number, safe_entry_id, "hiányos kézi küldési bizonyíték",
                timestamp_present, note_present, send_key_valid,
            ])
            continue
        if identity not in current_by_identity:
            manual_review.append([
                row_number, safe_entry_id, "az ID és a címzett nem egyezik egy aktív rekorddal",
                timestamp_present, note_present, send_key_valid,
            ])
            continue
        manual_candidates[identity].append((row_number, row))

    manual_transferred: set[int] = set()
    for identity, candidates in manual_candidates.items():
        if len(candidates) != 1:
            for row_number, row in candidates:
                manual_review.append([
                    row_number,
                    identity[0] if identity[0].isdigit() else "",
                    "több teljes kézi bizonyíték ugyanahhoz az aktív rekordhoz",
                    True,
                    True,
                    logical_send_key(archive_value(row, "Küldési kulcs")) is not None,
                ])
            continue
        _row_number, historical = candidates[0]
        target_index = current_by_identity[identity]
        target = reconciled[target_index]
        historical_status = archive_value(historical, "Státusz")
        target[active_index["Státusz"]] = (
            historical_status
            if historical_status in {EMAIL_STATUS_SENT, EMAIL_STATUS_CHANGED_AFTER_SEND}
            else EMAIL_STATUS_SENT
        )
        target[active_index["Manuálisan elküldve"]] = True
        target[active_index["Manuális küldés időpontja"]] = archive_value(
            historical, "Manuális küldés időpontja"
        )
        target[active_index["Manuális küldés megjegyzése / küldője"]] = archive_value(
            historical, "Manuális küldés megjegyzése / küldője"
        )
        manual_transferred.add(target_index)

    events_by_message: dict[str, list[list[str]]] = defaultdict(list)
    for row in event_rows[1:]:
        message_id = event_value(row, "Brevo messageId")
        if message_id:
            events_by_message[message_id].append(row)

    resolved_brevo: dict[int, tuple[str, list[list[str]]]] = {}
    brevo_control_test_ids = 0
    brevo_unresolved_ids = 0
    for message_id, rows in events_by_message.items():
        ownership = {
            (logical_send_key(event_value(row, "Küldési kulcs")), normalized(event_value(row, "Címzett")))
            for row in rows
            if logical_send_key(event_value(row, "Küldési kulcs"))
            and normalized(event_value(row, "Címzett"))
        }
        if not ownership:
            brevo_control_test_ids += 1
            continue
        if len(ownership) != 1:
            brevo_unresolved_ids += 1
            continue
        owner = next(iter(ownership))
        target_index = current_by_intent.get(owner)
        if target_index is None or target_index in resolved_brevo:
            brevo_unresolved_ids += 1
            continue
        resolved_brevo[target_index] = (message_id, rows)

    for target_index, (message_id, rows) in resolved_brevo.items():
        target = reconciled[target_index]
        accepted = [row for row in rows if normalized(event_value(row, "Esemény")) == normalized("Brevo fogadta")]
        delivered = [row for row in rows if normalized(event_value(row, "Esemény")) == normalized("Kézbesítve")]
        final_event = delivered[-1] if delivered else accepted[-1] if accepted else rows[-1]
        final_status = EMAIL_STATUS_DELIVERED if delivered else EMAIL_STATUS_ACCEPTED
        target[active_index["Státusz"]] = final_status
        target[active_index["Brevo messageId"]] = message_id
        target[active_index["Frissítve"]] = (
            event_value(final_event, "Fogadás ideje") or event_value(final_event, "Esemény ideje")
        )
        target[active_index["Brevo fogadta"]] = (
            event_value(accepted[-1], "Esemény ideje") if accepted else ""
        )
        target[active_index["Kézbesítési állapot"]] = final_status
        target[active_index["Kézbesítési esemény ideje"]] = event_value(final_event, "Esemény ideje")
        target[active_index["Kézbesítési hiba"]] = event_value(final_event, "Ok / részlet")

    status_counts: dict[str, int] = defaultdict(int)
    for row in reconciled:
        status_counts[active_value(row, "Státusz")] += 1
    send_keys = [active_value(row, "Küldési kulcs") for row in reconciled]
    approvals = [checked(active_value(row, "Jóváhagyva")) for row in reconciled]
    historical_indices = manual_transferred | set(resolved_brevo)
    stats = {
        "total": len(reconciled),
        "calculated_send_ready_before_history": sum(
            active_value(row, "Státusz") == EMAIL_STATUS_READY for row in active_rows
        ),
        "calculated_manual_review_before_history": sum(
            active_value(row, "Státusz") == EMAIL_STATUS_MANUAL for row in active_rows
        ),
        "status_counts": dict(sorted(status_counts.items())),
        "send_ready_remaining": status_counts[EMAIL_STATUS_READY],
        "manual_review_remaining": status_counts[EMAIL_STATUS_MANUAL],
        "historically_sent_current_intents": len(historical_indices),
        "manual_marked_archive_rows": manual_marked_rows,
        "manual_sent_transferred": len(manual_transferred),
        "manual_evidence_review_rows": len(manual_review) - 1,
        "brevo_event_message_ids": len(events_by_message),
        "brevo_control_test_message_ids": brevo_control_test_ids,
        "brevo_sent_transferred": len(resolved_brevo),
        "brevo_unresolved_message_ids": brevo_unresolved_ids,
        "brevo_and_manual_overlap": len(manual_transferred & set(resolved_brevo)),
        "approved": sum(approvals),
        "duplicate_send_keys": len(send_keys) - len(set(send_keys)),
    }
    if stats["brevo_unresolved_message_ids"]:
        raise RuntimeError("Nem minden valós Brevo message ID köthető egyetlen aktív rekordhoz.")
    if stats["approved"] or stats["duplicate_send_keys"]:
        raise RuntimeError("A történeti egyeztetés jóváhagyást vagy duplikált kulcsot hozott létre.")
    return reconciled, stats, manual_review


def build_manual_action_queue(
    headers: list[str], rows: list[list[Any]]
) -> list[list[Any]]:
    index = {name: position for position, name in enumerate(headers)}
    queue: list[list[Any]] = [[
        "Bejegyzésazonosító", "Eseménytípus", "Kategória", "Mit kell ellenőrizni",
        "Részletes indok", "Lehetséges lezárás",
    ]]
    rules = [
        (
            "Ismeretlen tanfolyam vagy hiányzó órarend.",
            "Korábbi órarend",
            "Erősítsd meg a tényleges csoportot, napot, időpontot és helyszínt.",
            "Aktuális órarenddel új levél, vagy nincs további küldés.",
        ),
        (
            "A megadott próbaóranapon nincs megtartható foglalkozás.",
            "Próbaóra dátuma",
            "Válassz valóban megtartható próbaóra-dátumot.",
            "Javított próbaóra-levél, vagy nincs további küldés.",
        ),
        (
            "Jóváírás vagy egyedi elszámolás van megadva.",
            "Egyedi elszámolás",
            "Határozd meg a jóváírás utáni végleges összeget és fizetési szöveget.",
            "Kézzel jóváhagyott összeggel új levél, vagy már rendezett.",
        ),
        (
            "Pilates- és Berczik-jelentkezések kézi elbírálásúak.",
            "Berczik/Pilates díjazás",
            "Válaszd ki az alkalmi vagy bérletes konstrukciót és a fizetési tájékoztatást.",
            "Kézzel összeállított levél, vagy már rendezett.",
        ),
    ]
    for row in rows:
        if value_at(row, index["Státusz"]) != EMAIL_STATUS_MANUAL:
            continue
        reason = value_at(row, index["Számítás / indok"])
        category = "Egyéb kézi döntés"
        check = "Ellenőrizd az indokot és dönts a további küldésről."
        resolution = "Javítás után új levél, vagy nincs további küldés."
        for prefix, candidate_category, candidate_check, candidate_resolution in rules:
            if reason.startswith(prefix):
                category = candidate_category
                check = candidate_check
                resolution = candidate_resolution
                break
        queue.append([
            value_at(row, index["Bejegyzésazonosító"]),
            value_at(row, index["Eseménytípus"]),
            category,
            check,
            reason,
            resolution,
        ])
    return queue


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gravity-csv", type=Path, required=True)
    parser.add_argument("--scratch-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument(
        "--offline",
        action="store_true",
        help="Rebuild only from the previously captured scratch snapshot.",
    )
    parser.add_argument(
        "--approved-live-entry-id",
        action="append",
        default=[],
        help="Entry ID whose unique live source row was explicitly approved by the operator.",
    )
    parser.add_argument(
        "--approval-id",
        help="Recorded approval identifier for any --approved-live-entry-id overrides.",
    )
    args = parser.parse_args()
    if args.approved_live_entry_id and not args.approval_id:
        parser.error("--approved-live-entry-id esetén --approval-id is kötelező.")

    files = {
        "master_before": args.scratch_dir / "master-before.csv",
        "email_output_archive": args.scratch_dir / "email-output-archive.csv",
        "email_event_archive": args.scratch_dir / "email-event-archive.csv",
        "automation_config": args.scratch_dir / "automation-config.csv",
        "email_settings": args.scratch_dir / "email-settings.csv",
        "master_reconstruction": args.scratch_dir / "master-reconstruction.csv",
        "email_output_reconstruction": args.scratch_dir / "email-output-reconstruction.csv",
        "email_output_incident_archive": args.scratch_dir / "email-output-incident-archive.csv",
        "email_manual_history_review": args.scratch_dir / "email-manual-history-review.csv",
        "email_manual_action_queue": args.scratch_dir / "email-manual-action-queue.csv",
        "approved_source_overrides": args.scratch_dir / "approved-source-overrides.csv",
    }
    if args.offline:
        required = [
            files["master_before"], files["email_output_archive"],
            files["email_event_archive"], files["automation_config"], files["email_settings"],
        ]
        missing = [str(path) for path in required if not path.is_file()]
        if missing:
            raise RuntimeError("Hiányzó fagyasztott snapshot-fájl(ok): " + ", ".join(missing))
        master_rows = read_csv(files["master_before"])
        email_rows = read_csv(files["email_output_archive"])
        event_rows = read_csv(files["email_event_archive"])
        config_rows = read_csv(files["automation_config"])
        settings_rows = read_csv(files["email_settings"])
        adapter_name = "dance_course_registration"
    else:
        config = load_config(
            csv_path=None,
            pipeline_id=None,
            spreadsheet_id=None,
            tab_name=None,
            service_account_json=None,
            require_csv_path=False,
        )
        service = build_service(config.service_account_json)
        master_tab = resolve_tab_name(
            service, config.spreadsheet_id, config.tab_name
        )
        master_rows, email_rows, event_rows, config_rows, settings_rows = read_live_snapshot(
            service, config.spreadsheet_id, master_tab
        )
        adapter_name = config.adapter_name
    if value_at(master_rows[0] if master_rows else [], 0) != "Közlemény":
        raise RuntimeError("A fő Sheet fejéce hiányzik vagy hibás.")
    if value_at(email_rows[0] if email_rows else [], 0) != "Küldési kulcs":
        raise RuntimeError("Az E-mail kimenet fejéce hiányzik vagy hibás.")

    source_rows = load_registrations(args.gravity_csv, adapter_name)
    source_rows, approved_overrides, approved_override_rows = apply_approved_live_source_overrides(
        source_rows,
        master_rows,
        args.approved_live_entry_id,
    )
    reconstructed, transfers, quarantines = build_reconstruction(
        source_rows, master_rows
    )
    reconstructed_email = build_email_output(
        source_rows, config_rows, settings_rows
    )
    reconciled_email_rows, delivery_history, manual_history_review = reconcile_delivery_history(
        reconstructed_email["headers"],
        reconstructed_email["rows"],
        email_rows,
        event_rows,
    )
    incident_email_archive = [
        email_rows[0],
        *[row for row in email_rows[1:] if value_at(row, 0)],
    ]
    manual_action_queue = build_manual_action_queue(
        reconstructed_email["headers"], reconciled_email_rows
    )
    header = (master_rows[0] + [""] * TOTAL_MASTER_COLUMNS)[:TOTAL_MASTER_COLUMNS]
    args.scratch_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(args.scratch_dir, 0o700)

    if args.offline:
        snapshot_hashes = {
            name: sha256_file(files[name])
            for name in ["master_before", "email_output_archive", "email_event_archive", "automation_config", "email_settings"]
        }
    else:
        snapshot_hashes = {
            "master_before": write_csv(files["master_before"], master_rows),
            "email_output_archive": write_csv(files["email_output_archive"], email_rows),
            "email_event_archive": write_csv(files["email_event_archive"], event_rows),
            "automation_config": write_csv(files["automation_config"], config_rows),
            "email_settings": write_csv(files["email_settings"], settings_rows),
        }
    hashes = {
        **snapshot_hashes,
        "approved_source_overrides": write_csv(
            files["approved_source_overrides"],
            [header[:APPROVED_SOURCE_OVERRIDE_COLUMNS], *approved_override_rows],
        ),
        "master_reconstruction": write_csv(
            files["master_reconstruction"], [header, *reconstructed]
        ),
        "email_output_reconstruction": write_csv(
            files["email_output_reconstruction"],
            [reconstructed_email["headers"], *reconciled_email_rows],
        ),
        "email_output_incident_archive": write_csv(
            files["email_output_incident_archive"], incident_email_archive
        ),
        "email_manual_history_review": write_csv(
            files["email_manual_history_review"], manual_history_review
        ),
        "email_manual_action_queue": write_csv(
            files["email_manual_action_queue"], manual_action_queue
        ),
    }
    reason_counts: dict[str, int] = defaultdict(int)
    for item in quarantines:
        reason_counts[item["reason"]] += 1
    manifest = {
        "mode": "read_only",
        "snapshot_mode": "offline_replay" if args.offline else "consistent_live_capture",
        "source_export": {
            "filename": args.gravity_csv.name,
            "sha256": sha256_file(args.gravity_csv),
        },
        "source_records": len(source_rows),
        "approved_source_override_approval_id": args.approval_id or "",
        "approved_source_overrides": approved_overrides,
        "current_master_rows": sum(
            bool(value_at(row, 0)) for row in master_rows[1:]
        ),
        "current_email_output_rows": sum(
            bool(value_at(row, 0)) for row in email_rows[1:]
        ),
        "current_email_event_rows": sum(
            bool(value_at(row, 0)) for row in event_rows[1:]
        ),
        "reconstructed_master_rows": len(reconstructed),
        "calculated_email_output_before_history": reconstructed_email["counts"],
        "reconstructed_email_output": delivery_history,
        "manual_action_rows": len(manual_action_queue) - 1,
        "manual_field_transfer_rows": len(transfers),
        "quarantined_manual_transfer_rows": len(quarantines),
        "quarantine_reason_counts": dict(sorted(reason_counts.items())),
        "manual_transfer_columns": [header[index] for index in MANUAL_TRANSFER_COLUMNS],
        "derived_columns_cleared": header[34:46],
        "files": {
            name: {"filename": path.name, "sha256": hashes[name]}
            for name, path in files.items()
        },
        "manual_transfers": transfers,
        "manual_transfer_quarantine": quarantines,
    }
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                key: manifest[key]
                for key in [
                    "source_records",
                    "current_master_rows",
                    "current_email_output_rows",
                    "reconstructed_master_rows",
                    "manual_field_transfer_rows",
                    "quarantined_manual_transfer_rows",
                    "quarantine_reason_counts",
                ]
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
