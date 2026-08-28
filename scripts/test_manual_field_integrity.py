from __future__ import annotations

import unittest

from scripts.manual_field_integrity import (
    MANUAL_MASTER_FIELDS,
    validate_manual_field_retention,
)


def sheet_rows(values: dict[str, list[str]]) -> list[list[str]]:
    header = ["Közlemény", *MANUAL_MASTER_FIELDS]
    height = max((len(items) for items in values.values()), default=0)
    rows = [header]
    for row_index in range(height):
        rows.append([
            str(1000 + row_index),
            *[
                items[row_index] if row_index < len(items) else ""
                for field in MANUAL_MASTER_FIELDS
                for items in [values.get(field, [])]
            ],
        ])
    return rows


class ManualFieldIntegrityTest(unittest.TestCase):
    def test_accepts_retained_and_added_values(self) -> None:
        field = "I. féléves tandíjfizetés dátuma"
        before = sheet_rows({field: ["2026.08.24.", ""]})
        after = sheet_rows({field: ["2026.08.24.", "2026.08.27."]})

        report = validate_manual_field_retention(before, after)

        self.assertEqual(report[field], {"before": 1, "after": 2})

    def test_rejects_payment_date_loss(self) -> None:
        field = "I. féléves tandíjfizetés dátuma"
        before = sheet_rows({field: ["2026.08.24.", "2026.08.25."]})
        after = sheet_rows({field: ["", "2026.08.25."]})

        with self.assertRaisesRegex(RuntimeError, "2 -> 1"):
            validate_manual_field_retention(before, after)

    def test_rejects_loss_in_any_manual_field(self) -> None:
        field = "Egyéb megjegyzés"
        before = sheet_rows({field: ["kézi megjegyzés"]})
        after = sheet_rows({field: [""]})

        with self.assertRaisesRegex(RuntimeError, "Egyéb megjegyzés"):
            validate_manual_field_retention(before, after)


if __name__ == "__main__":
    unittest.main()
