import assert from "node:assert/strict";

import {
  appendStartRow,
  assertNoPartialBasicFilter,
  buildAppendOnlyImportPlan,
  validateMasterRows,
} from "./src/recovery-integrity.js";

const masterHeader = [
  "Közlemény", "Tanfolyam neve", "Nap és terem", "Óra ideje", "Táncpedagógusok",
  "Jelentkező (növendék) neve", "Jelentkezés ideje", "Tanfolyamon részvétel kezdete / naptár",
  "Próbaórára jelentkezés", "I. féléves tandíj", "I. féléves tandíjfizetés dátuma",
  "I. tagsági kiállítva", "Egyéb megjegyzés", "Más óraszámban jár", "Születési dátum",
  "Lakcím", "Telefon", "E-mail cím", "Törvényes képviselő, szülő neve", "Kerület Kártya száma",
  "Kerület Kártya lejárati dátuma", "Kerület Kártya fotója", "Testvér neve", "Testvér csoportja",
  "Rendelkezik jóváírható összeggel", "Számlázási adatok", "Számlázási email",
];
const emailHeader = [
  "Küldési kulcs", "Bejegyzésazonosító", "Félév / típus", "Sablonverzió", "Címzett", "Tárgy",
  "Szöveges levél", "HTML levél", "Első óra", "Összeg", "Számítás / indok", "Jóváhagyva", "Státusz",
];

const existing = registration("1001", "Régi Növendék", "regi@example.invalid");
const fresh = registration("1002", "Új Növendék", "uj@example.invalid");
const masterRows = [masterHeader, [existing.entryId, ...existing.row]];
const emailRows = [emailHeader, ["1003|ENROLLMENT|1|v1", "1003", "1", "v1", "mar-kikuldve@example.invalid", "", "", "", "", "", "", false, "KÉZBESÍTVE"]];

const plan = await buildAppendOnlyImportPlan({
  csvText: "complete gravity forms export",
  registrations: [existing, fresh],
  masterRows,
  emailRows,
});
assert.deepEqual(plan.new_entry_ids, ["1002"]);
assert.deepEqual(plan.skipped_existing_master, ["1001"]);
assert.deepEqual(plan.existing_master_not_in_csv, []);
assert.equal(plan.csv_scope, "complete_export");
assert.equal(plan.append_start_row, 3);
assert.match(plan.plan_hash, /^[a-f0-9]{64}$/);

const repeatPlan = await buildAppendOnlyImportPlan({
  csvText: "complete gravity forms export",
  registrations: [existing, fresh],
  masterRows,
  emailRows,
});
assert.equal(plan.plan_hash, repeatPlan.plan_hash, "a terv ugyanabból a CSV-ből és snapshotból determinisztikus");

await assert.rejects(
  buildAppendOnlyImportPlan({ csvText: "duplicate", registrations: [existing, fresh, fresh], masterRows, emailRows }),
  /Duplikált Gravity Forms ID/i,
);

const changedExisting = registration("1001", "Régi Növendék", "mas@example.invalid");
const existingIsSkipped = await buildAppendOnlyImportPlan({
  csvText: "existing row changed upstream",
  registrations: [changedExisting, fresh],
  masterRows,
  emailRows,
});
assert.deepEqual(existingIsSkipped.new_entry_ids, ["1002"]);
assert.deepEqual(existingIsSkipped.skipped_existing_master, ["1001"], "a létező ID-t mindig kihagyjuk");

const freshOnlyPlan = await buildAppendOnlyImportPlan({
  csvText: "new registrations only",
  registrations: [fresh],
  masterRows,
  emailRows,
});
assert.deepEqual(freshOnlyPlan.new_entry_ids, ["1002"]);
assert.deepEqual(freshOnlyPlan.existing_master_not_in_csv, ["1001"]);
assert.equal(freshOnlyPlan.csv_scope, "new_records_only", "a friss ID-kra szűkített CSV append-only importálható");

assert.throws(
  () => validateMasterRows([masterHeader, ["id-van-de-nev-nincs"]]),
  /ID és növendéknév/i,
);
assert.equal(appendStartRow([...masterRows, [], []]), 3, "az append nem tölthet be belső vagy látszólag üres sort");

assert.throws(
  () => assertNoPartialBasicFilter({ sheets: [{ properties: { title: "Főlap" }, basicFilter: { range: { startRowIndex: 0, startColumnIndex: 1, endColumnIndex: 35 } } }] }, "Főlap", 27),
  /részleges/i,
);
assert.doesNotThrow(
  () => assertNoPartialBasicFilter({ sheets: [{ properties: { title: "Főlap" }, basicFilter: { range: { startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 27 } } }] }, "Főlap", 27),
);

console.log("Recovery integrity tests passed.");

function registration(entryId, studentName, email) {
  const row = Array.from({ length: 26 }, () => "");
  row[0] = "TESZT TÁNC";
  row[1] = "Hajós terem";
  row[2] = "PÉNTEK 17:00";
  row[3] = "Teszt Tanár";
  row[4] = studentName;
  row[5] = "2026-08-26 12:00:00";
  row[6] = "2026-09-01";
  row[7] = "nem";
  row[13] = "2015-02-03";
  row[16] = email;
  row[17] = "Szülő Anna";
  return { entryId, studentName, row, trialDate: "" };
}
