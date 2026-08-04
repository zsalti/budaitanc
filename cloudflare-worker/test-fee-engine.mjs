import assert from "node:assert/strict";
import { AUTOMATION_STATUS, TRIAL_FEE, calculateRegistration, parseAutomationConfig } from "./src/fee-engine.js";

const configRows = [[
  "Tanfolyam kulcs", "GF pontos érték / alias", "Nap", "Kezdés", "Befejezés", "Helyszín", "Tanár", "Heti alkalom", "Perc/alkalom", "Díjkategória", "Kézi elbírálás", "", "Félév", "Sáv kezdete", "Sáv vége", "Díjkategória", "Alapár", "Kedvezményes ár", "", "Tanfolyam kulcs", "Dátum", "Típus", "Kezdés", "Befejezés", "Helyszín",
], [
  "TESZT TÁNC", "TESZT TÁNC/PÉNTEK HAJÓS TEREM/17.00-18.00/TESZT TANÁR", "PÉNTEK", "17:00", "18:00", "Hajós terem", "Teszt Tanár", 1, 60, "1x60", false,
  "", 1, "2026-09-03", "2026-09-15", "1x60", 43000, 40850,
], [
  "TESZT TÁNC", "TESZT TÁNC/PÉNTEK HAJÓS TEREM/17.00-18.00/TESZT TANÁR", "PÉNTEK", "17:00", "18:00", "Hajós terem", "Teszt Tanár", 1, 60, "1x60", false,
  "", 1, "2026-09-16", "2026-09-30", "1x60", 38222, 36311,
], [
  "TESZT TÁNC", "", "PÉNTEK", "17:00", "18:00", "Hajós terem", "Teszt Tanár", 1, 60, "1x60", false,
  "", 2, "2027-02-01", "2027-02-15", "1x60", 43000, 40850,
], [
  "", "", "", "", "", "", "", "", "", "", "",
  "", "", "", "", "", "", "", "", "TESZT TÁNC", "2026-09-18", "ELMARAD",
]];

const config = parseAutomationConfig(configRows);
const base = {
  courseRaw: "TESZT TÁNC/PÉNTEK HAJÓS TEREM/17.00-18.00/TESZT TANÁR",
  studentName: "Teszt Elek", parentName: "Minta Anna", email: "test@example.invalid",
  submittedAt: "2026-09-15 12:00:00", startDate: "", trialSignup: "nem", trialDate: "",
  siblingName: "", siblingGroup: "", districtCardNumber: "", districtCardExpiry: "",
  carryoverAmount: "Nem", alternateAttendance: "",
};

const afterCancelledClass = calculateRegistration(base, config);
assert.equal(afterCancelledClass.status, AUTOMATION_STATUS.READY);
assert.equal(afterCancelledClass.firstClass.date.toISOString().slice(0, 10), "2026-09-25");
assert.equal(afterCancelledClass.fee, 38222);

const noException = parseAutomationConfig(configRows.slice(0, 4));
const boundary = calculateRegistration(base, noException);
assert.equal(boundary.firstClass.date.toISOString().slice(0, 10), "2026-09-18");
assert.equal(boundary.feeBand, "2026-09-16–2026-09-30");

const summerSignup = calculateRegistration({ ...base, submittedAt: "2026-07-15", startDate: "" }, noException);
assert.equal(summerSignup.firstClass.date.toISOString().slice(0, 10), "2026-09-04");
assert.equal(summerSignup.feeBand, "2026-09-03–2026-09-15");

const aliasConfig = parseAutomationConfig([["KLASSZIKUS BALETT ÓVODÁS 4,5 ÉVES KORTÓL", "", "KEDD", "17:15", "18:00", "Berczik terem", "Tanár", 2, 45, "2x45", false]]);
const aliasResult = calculateRegistration({ ...base, courseRaw: "KLASSZIKUS BALETT GYERMEK 6-8 ÉVESEK/KEDD, CSÜTÖRTÖK BERCZIK TEREM/17.15-18.00/TANÁR", trialSignup: "igen", trialDate: "" }, aliasConfig);
assert.equal(aliasResult.status, AUTOMATION_STATUS.READY);
assert.equal(aliasResult.firstClass.date.toISOString().slice(0, 10), "2026-09-15");

const sibling = calculateRegistration({ ...base, siblingName: "Teszt Béla", siblingGroup: "Péntek" }, noException);
assert.equal(sibling.fee, 36311);
assert.match(sibling.discount, /Testvér/);

const both = calculateRegistration({
  ...base, siblingName: "Teszt Béla", siblingGroup: "Péntek", districtCardNumber: "12345", districtCardExpiry: "2028-01-01",
}, noException);
assert.equal(both.fee, 36311);
assert.match(both.discount, /egyszeri 5%/);

const invalidDiscount = calculateRegistration({ ...base, districtCardNumber: "12345" }, noException);
assert.equal(invalidDiscount.status, AUTOMATION_STATUS.MANUAL);

const trial = calculateRegistration({ ...base, trialSignup: "igen", trialDate: "2026-09-18" }, noException);
assert.equal(trial.fee, TRIAL_FEE);
assert.equal(trial.fee, 2600);

const invalidTrial = calculateRegistration({ ...base, trialSignup: "igen", trialDate: "2026-09-17" }, noException);
assert.equal(invalidTrial.status, AUTOMATION_STATUS.MANUAL);

const manualCourse = calculateRegistration({ ...base, courseRaw: "PILATES/KEDD ÁGNES TEREM/18.30-19.30/TANÁR" }, noException);
assert.equal(manualCourse.status, AUTOMATION_STATUS.MANUAL);

const semesterTwo = calculateRegistration({ ...base, submittedAt: "2027-02-01", startDate: "2027-02-01" }, noException);
assert.equal(semesterTwo.semester, 2);
assert.equal(semesterTwo.fee, 43000);

const weekdays = ["VASÁRNAP", "HÉTFŐ", "KEDD", "SZERDA", "CSÜTÖRTÖK", "PÉNTEK", "SZOMBAT"];
const categories = ["1x45", "2x45", "1x60", "2x60", "1x75", "2x75", "1x90", "2x90"];
const periods = [
  [1, "2026-09-03", "2026-09-15"], [1, "2026-09-16", "2026-09-30"],
  [1, "2026-10-01", "2026-10-15"], [1, "2026-10-16", "2026-10-31"],
  [1, "2026-11-01", "2026-11-15"], [1, "2026-11-16", "2026-11-30"],
  [1, "2026-12-01", "2026-12-15"], [1, "2026-12-16", "2027-01-15"],
  [1, "2027-01-16", "2027-01-31"], [2, "2027-02-01", "2027-02-15"],
  [2, "2027-02-16", "2027-02-28"], [2, "2027-03-01", "2027-03-15"],
  [2, "2027-03-16", "2027-03-31"], [2, "2027-04-01", "2027-04-15"],
  [2, "2027-04-16", "2027-04-30"], [2, "2027-05-01", "2027-05-15"],
  [2, "2027-05-16", "2027-05-31"],
];
const matrixRows = [];
for (const category of categories) {
  for (const weekday of weekdays) matrixRows.push([`${category} TESZT`, "", weekday, "10:00", "11:00", "Teszt terem", "Teszt tanár", Number(category[0]), Number(category.slice(2)), category, false]);
  periods.forEach(([semester, start, end], index) => {
    const row = Array(18).fill("");
    row.splice(12, 6, semester, start, end, category, 10000 + index, 9500 + index);
    matrixRows.push(row);
  });
}
const matrixConfig = parseAutomationConfig(matrixRows);
for (const category of categories) {
  periods.forEach(([semester, start, end], index) => {
    const result = calculateRegistration({ ...base, courseRaw: `${category} TESZT/X/10.00-11.00/Y`, submittedAt: start, startDate: start }, matrixConfig);
    assert.equal(result.status, AUTOMATION_STATUS.READY, `${category} ${start}`);
    assert.equal(result.semester, semester, `${category} ${start}`);
    assert.equal(result.feeBand, `${start}–${end}`, `${category} ${start}`);
    assert.equal(result.fee, 10000 + index, `${category} ${start}`);
  });
}

console.log("Fee engine tests passed.");
