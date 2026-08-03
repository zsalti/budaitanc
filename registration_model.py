from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class SheetRecord(Protocol):
    trial_date: str

    @property
    def sheet_row(self) -> list[str]: ...

    @property
    def record_key(self) -> tuple[str, str]: ...

    @property
    def display_name(self) -> str: ...


@dataclass
class Registration:
    reference_id: str
    course_name: str
    venue: str
    time: str
    teacher: str
    student_name: str
    submitted_at: str
    start_date: str
    trial_signup: str
    trial_date: str
    birth_date: str
    address: str
    phone: str
    email: str
    parent_name: str
    district_card_number: str
    district_card_expiry: str
    district_card_photo: str
    sibling_name: str
    sibling_group: str
    carryover_amount: str
    billing_address: str
    billing_email: str

    @property
    def sheet_row(self) -> list[str]:
        # A:AA mirrors the active master Sheet. J:N are intentionally blank
        # because they are preserved by the writer as manual/financial fields.
        return [
            self.reference_id,  # A - Közlemény / Gravity Forms ID
            self.course_name,  # B
            self.venue,  # C
            self.time,  # D
            self.teacher,  # E
            self.student_name,  # F
            self.submitted_at,  # G
            self.start_date,  # H
            self.trial_signup,  # I
            "",  # J - I. féléves tandíj
            "",  # K - I. féléves tandíjfizetés dátuma
            "",  # L - I. tagsági kiállítva
            "",  # M - Egyéb megjegyzés
            "",  # N - Más óraszámban jár
            self.birth_date,  # O
            self.address,  # P
            self.phone,  # Q
            self.email,  # R
            self.parent_name,  # S
            self.district_card_number,  # T
            self.district_card_expiry,  # U
            self.district_card_photo,  # V
            self.sibling_name,  # W
            self.sibling_group,  # X
            self.carryover_amount,  # Y
            self.billing_address,  # Z
            self.billing_email,  # AA
        ]

    @property
    def record_key(self) -> tuple[str, str]:
        return (self.reference_id or self.student_name, self.submitted_at)

    @property
    def display_name(self) -> str:
        return self.student_name
