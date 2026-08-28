"""Fail-closed checks for operator-maintained master Sheet fields."""

from __future__ import annotations

from typing import Any, Iterable


MANUAL_MASTER_FIELDS = (
    "I. féléves tandíj",
    "I. féléves tandíjfizetés dátuma",
    "I. tagsági kiállítva",
    "Egyéb megjegyzés",
    "Más óraszámban jár",
    "Egyéb pénügyi",
    "II. féléves tandíj",
    "II. féléves tandíj befizetés dátuma",
    "II. féléves tandíjértesítő",
    "Számlázási adatok",
    "Számlázási email",
)


def normalized_header(value: Any) -> str:
    return " ".join(str(value or "").strip().casefold().split())


def nonempty_manual_field_counts(
    rows: list[list[Any]], fields: Iterable[str] = MANUAL_MASTER_FIELDS,
) -> dict[str, int]:
    if not rows:
        raise RuntimeError("A fő Sheet nem tartalmaz fejlécet.")
    header = {normalized_header(value): index for index, value in enumerate(rows[0])}
    indexes: dict[str, int] = {}
    missing: list[str] = []
    for field in fields:
        index = header.get(normalized_header(field))
        if index is None:
            missing.append(field)
        else:
            indexes[field] = index
    if missing:
        raise RuntimeError("Hiányzó kézi fő Sheet fejléc: " + ", ".join(missing))
    return {
        field: sum(
            bool(str(row[index]).strip())
            for row in rows[1:]
            if index < len(row) and row[index] is not None
        )
        for field, index in indexes.items()
    }


def validate_manual_field_retention(
    before_rows: list[list[Any]], after_rows: list[list[Any]],
) -> dict[str, dict[str, int]]:
    before = nonempty_manual_field_counts(before_rows)
    after = nonempty_manual_field_counts(after_rows)
    losses = {
        field: {"before": before[field], "after": after[field]}
        for field in MANUAL_MASTER_FIELDS
        if after[field] < before[field]
    }
    if losses:
        detail = "; ".join(
            f"{field}: {counts['before']} -> {counts['after']}"
            for field, counts in losses.items()
        )
        raise RuntimeError(
            "A helyreállítási cél kézi pénzügyi vagy megjegyzés adatot veszítene: "
            + detail
        )
    return {
        field: {"before": before[field], "after": after[field]}
        for field in MANUAL_MASTER_FIELDS
    }
