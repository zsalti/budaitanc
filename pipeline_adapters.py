from __future__ import annotations

from registration_model import Registration, SheetRecord


def _parse_course(raw: str) -> tuple[str, str, str]:
    parts = [part.strip() for part in raw.split("/") if part.strip()]
    if len(parts) < 4:
        raise ValueError(f"Unexpected course value: {raw!r}")

    venue = parts[1]
    teacher = parts[-1]
    time = ", ".join(parts[2:-1]).replace(" ÉS PÉNTEK ", ", PÉNTEK ")
    return venue, time, teacher


def _normalize_trial(value: str) -> str:
    normalized = value.strip().lower()
    if normalized in {"igen", "nem"}:
        return normalized
    return ""


def _parse_billing(raw: str) -> tuple[str, str]:
    normalized = raw.strip()
    if not normalized:
        return "", ""

    lines = [line.strip() for line in normalized.splitlines() if line.strip()]
    if len(lines) == 1:
        return lines[0], ""
    return " | ".join(lines[:-1]), lines[-1]


def csv_row_to_dance_course_registration(row: dict[str, str]) -> Registration:
    course_name = row["Választott tanfolyam"].strip()
    venue, time, teacher = _parse_course(course_name)
    billing_address, billing_email = _parse_billing(
        row["Kérek számlát az alábbi adatokkal"]
    )
    return Registration(
        reference_id=row.get("Bejegyzés azonosító", "").strip(),
        course_name=course_name,
        venue=venue,
        time=time,
        teacher=teacher,
        student_name=row["Jelentkező (növendék) neve"].strip(),
        submitted_at=row["Bejegyzés dátuma"].strip(),
        start_date=row["Részvétel kezdete"].strip(),
        trial_signup=_normalize_trial(row["Próba órára jelentkezés"]),
        trial_date=row.get("Próbaóra dátuma", "").strip(),
        birth_date=row["Születési dátum"].strip(),
        address=row["Lakcím"].strip(),
        phone=row["Telefon"].strip(),
        email=row["E-mail cím"].strip(),
        parent_name=row["Törvényes képviselő, szülő neve"].strip(),
        district_card_number=row["Kerület Kártya száma"].strip(),
        district_card_expiry=row["Kerület Kártya lejárati dátuma"].strip(),
        district_card_photo=row["Kerület Kártya fotója"].strip(),
        sibling_name=row["Testvér neve"].strip(),
        sibling_group=row["Testvér csoportja"].strip(),
        carryover_amount=row["Rendelkezik jóváírható összeggel"].strip(),
        billing_address=billing_address,
        billing_email=billing_email,
    )


def webhook_payload_to_dance_course_registration(payload: dict) -> Registration:
    return Registration(
        reference_id=str(payload.get("entry_id", "")).strip(),
        course_name=str(payload.get("course_name", "")).strip(),
        venue=str(payload.get("venue", "")).strip(),
        time=str(payload.get("time", "")).strip(),
        teacher=str(payload.get("teacher", "")).strip(),
        student_name=str(payload.get("student_name", "")).strip(),
        submitted_at=str(payload.get("submitted_at", "")).strip(),
        start_date=str(payload.get("start_date", "")).strip(),
        trial_signup=_normalize_trial(str(payload.get("trial_signup", ""))),
        trial_date=str(payload.get("trial_date", "")).strip(),
        birth_date=str(payload.get("birth_date", "")).strip(),
        address=str(payload.get("address", "")).strip(),
        phone=str(payload.get("phone", "")).strip(),
        email=str(payload.get("email", "")).strip(),
        parent_name=str(payload.get("parent_name", "")).strip(),
        district_card_number=str(payload.get("district_card_number", "")).strip(),
        district_card_expiry=str(payload.get("district_card_expiry", "")).strip(),
        district_card_photo=str(payload.get("district_card_photo", "")).strip(),
        sibling_name=str(payload.get("sibling_name", "")).strip(),
        sibling_group=str(payload.get("sibling_group", "")).strip(),
        carryover_amount=str(payload.get("carryover_amount", "")).strip(),
        billing_address=str(payload.get("billing_address", "")).strip(),
        billing_email=str(payload.get("billing_email", "")).strip(),
    )


CSV_ADAPTERS = {
    "dance_course_registration": csv_row_to_dance_course_registration,
}

WEBHOOK_ADAPTERS = {
    "dance_course_registration": webhook_payload_to_dance_course_registration,
}


def record_from_csv_row(adapter_name: str, row: dict[str, str]) -> SheetRecord:
    try:
        adapter = CSV_ADAPTERS[adapter_name]
    except KeyError as exc:
        raise ValueError(f"Unknown CSV adapter: {adapter_name}") from exc
    return adapter(row)


def record_from_webhook_payload(adapter_name: str, payload: dict) -> SheetRecord:
    try:
        adapter = WEBHOOK_ADAPTERS[adapter_name]
    except KeyError as exc:
        raise ValueError(f"Unknown webhook adapter: {adapter_name}") from exc
    return adapter(payload)
