from __future__ import annotations

import unittest
from dataclasses import dataclass

from scripts.build_recovery_bundle import (
    apply_approved_live_source_overrides,
    build_reconstruction,
    reconcile_delivery_history,
)


EMAIL_HEADERS = [
    "Küldési kulcs", "Bejegyzésazonosító", "Félév / típus", "Sablonverzió", "Címzett",
    "Tárgy", "Szöveges levél", "HTML levél", "Első óra", "Összeg", "Számítás / indok",
    "Jóváhagyva", "Státusz", "Brevo messageId", "Hiba", "Forrás hash", "Frissítve",
    "Brevo fogadta", "Manuálisan elküldve", "Manuális küldés időpontja",
    "Manuális küldés megjegyzése / küldője", "Eseménytípus", "Címzett típusa",
    "Helyszínkód", "Sablonkulcs", "Brevo templateId", "Paraméterek JSON", "Revízió hash",
    "Jóváhagyott hash", "Jóváhagyás időpontja", "Jóváhagyó", "Kézbesítési állapot",
    "Kézbesítési esemény ideje", "Kézbesítési hiba",
]
EVENT_HEADERS = [
    "Eseményazonosító", "Brevo messageId", "Küldési kulcs", "Esemény", "Címzett",
    "Esemény ideje", "Fogadás ideje", "Ok / részlet", "Nyers típus",
]


@dataclass
class Source:
    reference_id: str
    sheet_row: list[str]
    trial_date: str = ""


class RecoveryBundleTest(unittest.TestCase):
    def test_only_exact_canonical_match_transfers_manual_fields(self) -> None:
        header = [f"column-{index}" for index in range(46)]
        exact = source("1001", "Exact Student", "exact@example.invalid")
        shifted = source("1002", "Canonical Student", "canonical@example.invalid")
        exact_master = list(exact.sheet_row) + [""] * 19
        exact_master[10] = "2026-08-20"
        exact_master[12] = "operator note"
        exact_master[44] = "stale helper"
        shifted_master = list(shifted.sheet_row) + [""] * 19
        shifted_master[5] = "Wrong Student"
        shifted_master[10] = "must not transfer"

        rows, transfers, quarantines = build_reconstruction(
            [shifted, exact], [header, exact_master, shifted_master]
        )

        self.assertEqual([row[0] for row in rows], ["1001", "1002"])
        self.assertEqual(rows[0][10], "2026-08-20")
        self.assertEqual(rows[0][12], "operator note")
        self.assertEqual(rows[0][44], "", "derived helper fields must be cleared")
        self.assertEqual(rows[1][10], "")
        self.assertEqual(len(transfers), 1)
        self.assertEqual(transfers[0]["entry_id"], "1001")
        self.assertEqual(quarantines[0]["reason"], "canonical_fields_mismatch")

    def test_duplicate_current_id_is_quarantined(self) -> None:
        item = source("1001", "Exact Student", "exact@example.invalid")
        master = list(item.sheet_row) + [""] * 19
        rows, transfers, quarantines = build_reconstruction(
            [item], [[f"column-{index}" for index in range(46)], master, master]
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(transfers, [])
        self.assertEqual(quarantines[0]["reason"], "duplicate_current_master_id")

    def test_explicit_live_override_replaces_source_and_preserves_manual_fields(self) -> None:
        original = source("1001", "Canonical Student", "canonical@example.invalid")
        live = list(original.sheet_row) + [""] * 19
        live[5] = "Operator Approved Student"
        live[9] = "approved fee"
        live[12] = "approved note"
        live[17] = "approved@example.invalid"
        header = [f"column-{index}" for index in range(46)]

        effective, audit, override_rows = apply_approved_live_source_overrides(
            [original], [header, live], ["1001"]
        )
        rows, transfers, quarantines = build_reconstruction(effective, [header, live])

        self.assertEqual(effective[0].sheet_row[5], "Operator Approved Student")
        self.assertEqual(effective[0].sheet_row[17], "approved@example.invalid")
        self.assertEqual(rows[0][9], "approved fee")
        self.assertEqual(rows[0][12], "approved note")
        self.assertEqual(rows[0][44], "", "derived helper fields must stay cleared")
        self.assertEqual(transfers[0]["entry_id"], "1001")
        self.assertEqual(quarantines, [])
        self.assertEqual(audit[0]["mode"], "approved_full_live_source_row")
        self.assertEqual(len(override_rows[0]), 34)

    def test_provable_manual_and_brevo_history_are_carried_forward(self) -> None:
        manual = email_row("1001", "ENROLLMENT", "1", "manual@example.invalid")
        brevo = email_row("1002", "TRIAL", "PRÓBA", "brevo@example.invalid")

        archived_manual = list(manual)
        archived_manual[12] = "ELKÜLDVE"
        archived_manual[18] = "TRUE"
        archived_manual[19] = "2026-08-20T10:00:00Z"
        archived_manual[20] = "operator"

        event_rows = [
            EVENT_HEADERS,
            event_row("accepted", "message-1002", brevo[0], "Brevo fogadta", brevo[4], "2026-08-20T11:00:00Z"),
            event_row("delivered", "message-1002", brevo[0], "Kézbesítve", brevo[4], "2026-08-20T11:01:00Z"),
            event_row("test", "control-test", "", "Kézbesítve", "test@example.invalid", "2026-08-20T11:02:00Z"),
        ]

        rows, stats, review = reconcile_delivery_history(
            EMAIL_HEADERS,
            [manual, brevo],
            [EMAIL_HEADERS, archived_manual],
            event_rows,
        )

        self.assertEqual(rows[0][12], "ELKÜLDVE")
        self.assertEqual(rows[0][18], True)
        self.assertEqual(rows[1][12], "KÉZBESÍTVE")
        self.assertEqual(rows[1][13], "message-1002")
        self.assertEqual(rows[1][31], "KÉZBESÍTVE")
        self.assertEqual(stats["manual_sent_transferred"], 1)
        self.assertEqual(stats["brevo_sent_transferred"], 1)
        self.assertEqual(stats["brevo_control_test_message_ids"], 1)
        self.assertEqual(stats["historically_sent_current_intents"], 2)
        self.assertEqual(len(review), 1)


def source(entry_id: str, student: str, email: str) -> Source:
    row = [""] * 27
    row[0] = entry_id
    row[1] = "COURSE/WEDNESDAY ROOM/17.00-18.00/TEACHER"
    row[5] = student
    row[6] = "2026-08-20"
    row[14] = "2015-02-03"
    row[17] = email
    row[18] = "Parent"
    return Source(entry_id, row)


def email_row(entry_id: str, event: str, period: str, recipient: str) -> list[object]:
    row: list[object] = [""] * len(EMAIL_HEADERS)
    row[0] = f"{entry_id}|{event}|{period}|v3"
    row[1] = entry_id
    row[2] = period
    row[3] = "v3"
    row[4] = recipient
    row[11] = False
    row[12] = "KÜLDHETŐ"
    row[18] = False
    row[21] = event
    return row


def event_row(
    event_id: str,
    message_id: str,
    send_key: str,
    event: str,
    recipient: str,
    event_at: str,
) -> list[str]:
    return [event_id, message_id, send_key, event, recipient, event_at, event_at, "", event]


if __name__ == "__main__":
    unittest.main()
