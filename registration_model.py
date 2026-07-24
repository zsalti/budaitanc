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
            self.course_name,  # A
            self.venue,  # B
            self.time,  # C
            self.teacher,  # D
            self.student_name,  # E
            self.submitted_at,  # F
            self.start_date,  # G
            self.trial_signup,  # H
            "",  # I - I. féléves tandíjfizetés dátuma
            "",  # J - I. tagsági kiállítva
            "",  # K - Egyéb megjegyzés
            "",  # L - Más óraszámban jár
            self.birth_date,  # M
            self.address,  # N
            self.phone,  # O
            self.email,  # P
            self.parent_name,  # Q
            self.district_card_number,  # R
            self.district_card_expiry,  # S
            self.district_card_photo,  # T
            self.sibling_name,  # U
            self.sibling_group,  # V
            self.carryover_amount,  # W
            self.billing_address,  # X
            self.billing_email,  # Y
        ]

    @property
    def record_key(self) -> tuple[str, str]:
        return (self.student_name, self.submitted_at)

    @property
    def display_name(self) -> str:
        return self.student_name
