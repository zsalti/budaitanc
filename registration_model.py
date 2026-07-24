from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class SheetRecord(Protocol):
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
        # Columns follow the current Google Sheet layout after inserting
        # the course name as column A and "Próbaórára jelentkezés" after start date.
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
            "",  # J - I. féléves tandíjfizetés dátuma
            "",  # K - I. tagsági kiállítva
            "",  # L - Egyéb megjegyzés
            "",  # M - Más óraszámban jár
            self.birth_date,  # N
            self.address,  # O
            self.phone,  # P
            self.email,  # Q
            self.parent_name,  # R
            self.district_card_number,  # S
            self.district_card_expiry,  # T
            self.district_card_photo,  # U
            self.sibling_name,  # V
            self.sibling_group,  # W
            self.carryover_amount,  # X
            self.billing_address,  # Y
            self.billing_email,  # Z
        ]

    @property
    def record_key(self) -> tuple[str, str]:
        return (self.reference_id or self.student_name, self.submitted_at)

    @property
    def display_name(self) -> str:
        return self.student_name
