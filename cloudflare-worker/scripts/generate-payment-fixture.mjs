import * as XLSX from "xlsx";
import { fileURLToPath } from "node:url";

const rows = [
  { "Tranzakcióazonosító": "TX-2026-0001", "Könyvelési dátum": "2026-08-10", "Értéknap": "2026-08-10", "Összeg": 18000, "Deviza": "HUF", "Feladó neve": "Kiss Anna", "Feladó számlaszáma": "11700000-00000001", "Közlemény": "Tandíj 9000001" },
  { "Tranzakcióazonosító": "TX-2026-0002", "Könyvelési dátum": "2026-08-11", "Értéknap": "2026-08-11", "Összeg": 16000, "Deviza": "HUF", "Feladó neve": "Nagy Béla", "Feladó számlaszáma": "11700000-00000002", "Közlemény": "Közlemény: 9000002" },
  { "Tranzakcióazonosító": "TX-2026-0003", "Könyvelési dátum": "2026-08-12", "Értéknap": "2026-08-12", "Összeg": 18000, "Deviza": "HUF", "Feladó neve": "Kiss Júlia", "Feladó számlaszáma": "11700000-00000003", "Közlemény": "Tandíj, közlemény nélkül" },
  { "Tranzakcióazonosító": "TX-2026-0004", "Könyvelési dátum": "2026-08-13", "Értéknap": "2026-08-13", "Összeg": 18000, "Deviza": "HUF", "Feladó neve": "Tóth Emese", "Feladó számlaszáma": "11700000-00000004", "Közlemény": "Hivatkozás 1234567" },
  { "Tranzakcióazonosító": "TX-2026-0005", "Könyvelési dátum": "2026-08-14", "Értéknap": "2026-08-14", "Összeg": 18000, "Deviza": "HUF", "Feladó neve": "Kovács Kata", "Feladó számlaszáma": "11700000-00000005", "Közlemény": "9000001 / 9000002" }
];

const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "Kivonat");
XLSX.writeFile(workbook, fileURLToPath(new URL("../test-fixtures/minta-banki-kivonat.xlsx", import.meta.url)));
