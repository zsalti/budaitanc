import * as XLSX from "xlsx";
import { fileURLToPath } from "node:url";

const rows = [
  { "Tranzakcióazonosító": "TX-2026-0001", "Könyvelési dátum": "2026-08-10", "Értéknap": "2026-08-10", "Összeg": 18000, "Deviza": "HUF", "Feladó neve": "Kiss Anna", "Feladó számlaszáma": "11700000-00000001", "Közlemény": "Tandíj 9000001" },
  { "Tranzakcióazonosító": "TX-2026-0002", "Könyvelési dátum": "2026-08-11", "Értéknap": "2026-08-11", "Összeg": 16000, "Deviza": "HUF", "Feladó neve": "Nagy Béla", "Feladó számlaszáma": "11700000-00000002", "Közlemény": "Közlemény: 9000002" },
  { "Tranzakcióazonosító": "TX-2026-0003", "Könyvelési dátum": "2026-08-12", "Értéknap": "2026-08-12", "Összeg": 18000, "Deviza": "HUF", "Feladó neve": "Kiss Júlia", "Feladó számlaszáma": "11700000-00000003", "Közlemény": "Tandíj, közlemény nélkül" },
  { "Tranzakcióazonosító": "TX-2026-0004", "Könyvelési dátum": "2026-08-13", "Értéknap": "2026-08-13", "Összeg": 18000, "Deviza": "HUF", "Feladó neve": "Tóth Emese", "Feladó számlaszáma": "11700000-00000004", "Közlemény": "Hivatkozás 1234567" },
  { "Tranzakcióazonosító": "TX-2026-0005", "Könyvelési dátum": "2026-08-14", "Értéknap": "2026-08-14", "Összeg": 18000, "Deviza": "HUF", "Feladó neve": "Kovács Kata", "Feladó számlaszáma": "11700000-00000005", "Közlemény": "9000001 / 9000002" },
];

// Kumulatív import- és korrekciós tesztekhez: egy elszigetelt, második banki
// forrás sorozat (run1 → run2 → run3-reset), saját referenciakódokkal, hogy
// a fő teszt-fixture-t (fenti `rows`) ne érintse.
const run1Rows = [
  { "Tranzakcióazonosító": "PV2-0001", "Könyvelési dátum": "2026-08-01", "Értéknap": "2026-08-01", "Összeg": 17000, "Deviza": "HUF", "Feladó neve": "Fehér Dóra", "Feladó számlaszáma": "11700000-00000101", "Közlemény": "Tandíj 5551" },
  { "Tranzakcióazonosító": "", "Könyvelési dátum": "2026-08-02", "Értéknap": "2026-08-02", "Összeg": 17000, "Deviza": "HUF", "Feladó neve": "Duplikátum Küldő", "Feladó számlaszáma": "11700000-00000102", "Közlemény": "Tandíj 5552" },
  { "Tranzakcióazonosító": "PV2-0003", "Könyvelési dátum": "2026-08-03", "Értéknap": "2026-08-03", "Összeg": 17000, "Deviza": "HUF", "Feladó neve": "Ismeretlen Küldő", "Feladó számlaszáma": "11700000-00000103", "Közlemény": "Nincs kód a közleményben" },
  { "Tranzakcióazonosító": "PV2-0004", "Könyvelési dátum": "2026-08-04", "Értéknap": "2026-08-04", "Összeg": 17000, "Deviza": "HUF", "Feladó neve": "Ismeretlen Feladó", "Feladó számlaszáma": "11700000-00000104", "Közlemény": "5553 / 5554" },
];

const run2NewRows = [
  // Ugyanaz a tartalom, mint a run1 2. sora (nincs Tranzakcióazonosító) — egy
  // valóban különálló, azonos adatú új befizetés; a régi tartalom-ujjlenyomat
  // alapú dedup tévesen duplikátumnak venné, a vízjel-alapú pozíciós logika
  // viszont helyesen újnak ismeri fel.
  { "Tranzakcióazonosító": "", "Könyvelési dátum": "2026-08-02", "Értéknap": "2026-08-02", "Összeg": 17000, "Deviza": "HUF", "Feladó neve": "Duplikátum Küldő", "Feladó számlaszáma": "11700000-00000102", "Közlemény": "Tandíj 5552" },
  { "Tranzakcióazonosító": "", "Könyvelési dátum": "2026-08-16", "Értéknap": "2026-08-16", "Összeg": 17000, "Deviza": "HUF", "Feladó neve": "Ismeretlen Küldő", "Feladó számlaszáma": "11700000-00000106", "Közlemény": "Hivatkozás 8888" },
  { "Tranzakcióazonosító": "", "Könyvelési dátum": "2026-08-17", "Értéknap": "2026-08-17", "Összeg": 17000, "Deviza": "HUF", "Feladó neve": "Ismeretlen Küldő", "Feladó számlaszáma": "11700000-00000107", "Közlemény": "Hivatkozás 7777" },
  { "Tranzakcióazonosító": "", "Könyvelési dátum": "2026-08-18", "Értéknap": "2026-08-18", "Összeg": 17000, "Deviza": "HUF", "Feladó neve": "Ismeretlen Küldő", "Feladó számlaszáma": "11700000-00000108", "Közlemény": "Hivatkozás 6666" },
  { "Tranzakcióazonosító": "", "Könyvelési dátum": "2026-08-19", "Értéknap": "2026-08-19", "Összeg": 17000, "Deviza": "HUF", "Feladó neve": "VARGA Léna", "Feladó számlaszáma": "11700000-00000109", "Közlemény": "5556 / 5557" },
  { "Tranzakcióazonosító": "", "Könyvelési dátum": "2026-08-20", "Értéknap": "2026-08-20", "Összeg": 17000, "Deviza": "HUF", "Feladó neve": "Ismeretlen Feladó", "Feladó számlaszáma": "11700000-00000110", "Közlemény": "5558 / 5559" },
];
const run2Rows = [...run1Rows, ...run2NewRows];

// A run3 a run2 utolsó sorát lecseréli (fájl utólag szerkesztve/átrendezve),
// hogy a vízjel-ellenőrzés bukjon, és a fallback teljes dedup fusson.
const run3Rows = [
  ...run2Rows.slice(0, -1),
  { "Tranzakcióazonosító": "", "Könyvelési dátum": "2026-08-21", "Értéknap": "2026-08-21", "Összeg": 17000, "Deviza": "HUF", "Feladó neve": "Módosított Küldő", "Feladó számlaszáma": "11700000-00000111", "Közlemény": "Nincs kód, módosítva" },
];

writeFixture("minta-banki-kivonat.xlsx", rows);
writeFixture("minta-banki-kivonat-2-run1.xlsx", run1Rows);
writeFixture("minta-banki-kivonat-2-run2.xlsx", run2Rows);
writeFixture("minta-banki-kivonat-2-run3-reset.xlsx", run3Rows);

function writeFixture(fileName, data) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data), "Kivonat");
  XLSX.writeFile(workbook, fileURLToPath(new URL(`../test-fixtures/${fileName}`, import.meta.url)));
}
