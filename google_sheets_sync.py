from __future__ import annotations

import json
from typing import Iterable

import google.auth
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

from registration_model import SheetRecord


SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


def build_service(service_account_json: str | None):
    if service_account_json:
        if service_account_json.lstrip().startswith("{"):
            credentials = Credentials.from_service_account_info(
                json.loads(service_account_json), scopes=SCOPES
            )
        else:
            credentials = Credentials.from_service_account_file(
                service_account_json, scopes=SCOPES
            )
    else:
        credentials, _project_id = google.auth.default(scopes=SCOPES)
    return build("sheets", "v4", credentials=credentials)


def resolve_tab_name(service, spreadsheet_id: str, requested_tab_name: str) -> str:
    metadata = (
        service.spreadsheets()
        .get(spreadsheetId=spreadsheet_id, fields="sheets(properties(title))")
        .execute()
    )
    titles = [sheet["properties"]["title"] for sheet in metadata.get("sheets", [])]

    if requested_tab_name in titles:
        return requested_tab_name

    normalized_requested = requested_tab_name.strip()
    for title in titles:
        if title.strip() == normalized_requested:
            return title

    raise ValueError(
        f"Could not resolve tab name {requested_tab_name!r}. Available tabs: {titles}"
    )


def read_existing_rows(service, spreadsheet_id: str, tab_name: str) -> list[list[str]]:
    result = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=spreadsheet_id, range=f"'{tab_name}'!A:Z")
        .execute()
    )
    return result.get("values", [])


def find_next_empty_row(existing_rows: list[list[str]], min_row: int = 2) -> int:
    row_index = min_row
    while row_index <= len(existing_rows):
        row = existing_rows[row_index - 1] if row_index - 1 < len(existing_rows) else []
        student_name = row[5].strip() if len(row) > 5 else ""
        if not student_name:
            return row_index
        row_index += 1
    return len(existing_rows) + 1


def find_existing_registration_row(
    existing_rows: list[list[str]], registration: SheetRecord
) -> int | None:
    for row_index, row in enumerate(existing_rows, start=1):
        if row_index == 1:
            continue
        reference_id = row[0].strip() if row else ""
        student_name = row[5].strip() if len(row) > 5 else ""
        submitted_at = row[6].strip() if len(row) > 6 else ""
        if registration.record_key[0] and reference_id == registration.record_key[0]:
            return row_index
        if not registration.record_key[0] and (student_name, submitted_at) == registration.record_key:
            return row_index
    return None


def write_registrations(
    service,
    spreadsheet_id: str,
    tab_name: str,
    registrations: Iterable[SheetRecord],
    dry_run: bool,
) -> list[tuple[int, SheetRecord]]:
    existing_rows = read_existing_rows(service, spreadsheet_id, tab_name)
    pending_updates = prepare_updates(existing_rows, registrations)

    if dry_run:
        return pending_updates

    data = []
    for row_index, registration in pending_updates:
        existing = existing_rows[row_index - 1] if row_index - 1 < len(existing_rows) else []
        merged = list(registration.sheet_row)
        for column in range(9, 13):
            if column < len(existing):
                merged[column] = existing[column]
        data.append(
            {
                "range": f"'{tab_name}'!A{row_index}:Z{row_index}",
                "values": [merged],
            }
        )
    (
        service.spreadsheets()
        .values()
        .batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={"valueInputOption": "RAW", "data": data},
        )
        .execute()
    )
    return pending_updates


def prepare_updates(
    existing_rows: list[list[str]], registrations: Iterable[SheetRecord]
) -> list[tuple[int, SheetRecord]]:
    pending_updates: list[tuple[int, SheetRecord]] = []
    mutable_rows = [list(row) for row in existing_rows]

    for registration in registrations:
        target_row = find_existing_registration_row(mutable_rows, registration)
        if target_row is None:
            target_row = find_next_empty_row(mutable_rows)

        while len(mutable_rows) < target_row:
            mutable_rows.append([])
        existing = mutable_rows[target_row - 1]
        merged = list(registration.sheet_row)
        for column in range(9, 13):
            if column < len(existing):
                merged[column] = existing[column]
        mutable_rows[target_row - 1] = merged
        pending_updates.append((target_row, registration))

    return pending_updates
