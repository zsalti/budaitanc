from __future__ import annotations

import argparse
from config import load_config
from google_sheets_sync import build_service, resolve_tab_name, write_registrations
from gravity_forms_csv import load_registrations


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv")
    parser.add_argument("--pipeline")
    parser.add_argument("--spreadsheet-id")
    parser.add_argument("--tab-name")
    parser.add_argument("--service-account-json")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    config = load_config(
        csv_path=args.csv,
        pipeline_id=args.pipeline,
        spreadsheet_id=args.spreadsheet_id,
        tab_name=args.tab_name,
        service_account_json=args.service_account_json,
    )

    registrations = load_registrations(config.csv_path, config.adapter_name)
    service = build_service(config.service_account_json)
    resolved_tab_name = resolve_tab_name(
        service, config.spreadsheet_id, config.tab_name
    )
    updates = write_registrations(
        service=service,
        spreadsheet_id=config.spreadsheet_id,
        tab_name=resolved_tab_name,
        registrations=registrations,
        dry_run=args.dry_run,
    )

    mode = "DRY RUN" if args.dry_run else "UPDATED"
    for row_index, registration in updates:
        print(
            f"{mode} row {row_index}: {registration.display_name} | "
            f"{registration.venue} | {registration.time} | {registration.trial_signup}"
        )


if __name__ == "__main__":
    main()
