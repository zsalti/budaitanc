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

const recoveryAliases = [
  ["JAZZ BALETT IFJÚSÁGI-FELNŐTT 15 ÉVES KORTÓL", "JAZZ TÁNC IFJÚSÁGI-FELNŐTT 15 ÉVES KORTÓL"],
  ["KLASSZIKUS BALETT ISKOLÁS ALSÓ TAGOZAT", "KLASSZIKUS BALETT ISKOLÁS ALSÓ TAGOZATOS"],
  ["KLASSZIKUS BALETT ISKOLÁS FELSŐ TAGOZAT", "ISKOLÁS FELSŐ TAGOZATOS"],
  ["KLASSZIKUS-MODERN BALETTHALADÓ KÖZÉPISKOLÁS ÉS FELNŐTT", "HALADÓ KLASSZIKUS-MODERN BALETT KÖZÉPISKOLÁS ÉS FELNŐTT 14+"],
  ["KLASSZIKUS BALETT SPICCTECHNIKA KÖZÉPISKOLÁS ÉS FELNŐTT", "KLASSZIKUS BALETT SPICCTECHNIKA KÖZÉPISKOLÁS ÉS FELNŐTT 14+"],
  ["KLASSZIKUS BALETT KEZDŐ ÉS ÚJRAKEZDŐ KÖZÉPISKOLÁS ÉS FELNŐTT 14+", "KEZDŐ ÉS ÚJRAKEZDŐ KLASSZIKUS BALETT KÖZÉPISKOLÁS ÉS FELNŐTT 14+"],
  ["KORTÁRS TÁNCMŰHELY HALADÓ 14+", "KORTÁRS TÁNCMŰHELY HALADÓ 14-20 ÉVESEK"],
  ["MODERN TÁNC 12-15 ÉVES", "MODERN TÁNC 10-14 ÉVES"],
  ["MŰVÉSZI TORNA ÓVODÁS KEZDŐ 4+", "MŰVÉSZI TORNA ÓVODÁS KEZDŐ 4-5 ÉVESEK"],
  ["MŰVÉSZI TORNA HALADÓ ÓVODÁS 5-7 ÉVESEK", "MŰVÉSZI TORNA 5-7 ÉVESEK HALADÓ"],
  ["MŰVÉSZI TORNA ISKOLÁS 1. ISKOLA ALSÓ TAGOZAT, 6-7 ÉVESEK", "MŰVÉSZI TORNA KISISKOLÁS 1. (6-7 ÉVESEK)"],
  ["MŰVÉSZI ISKOLÁS 2. HALADÓ ALSÓ TAGOZAT 8-9 ÉVESEK", "MŰVÉSZI TORNA ISKOLÁS 2. HALADÓ (ALSÓ TAGOZAT)"],
  ["MŰVÉSZI TORNA HALADÓ IFJÚSÁGI ÉS FELNŐTT", "MŰVÉSZI TORNA IFJÚSÁGI ÉS FELNŐTT"],
  ["NÉPTÁNC ÓVODÁS 4+", "NÉPTÁNC ÓVODÁS"],
];
for (const [sourceName, targetName] of recoveryAliases) {
  const targetConfig = parseAutomationConfig([
    [targetName, "", "SZERDA", "17:00", "18:00", "Hajós terem", "Tanár", 1, 60, "1x60", false],
  ]);
  const result = calculateRegistration({
    ...base,
    courseRaw: `${sourceName}/SZERDA HAJÓS TEREM/17.00-18.00/TANÁR`,
    trialSignup: "igen",
    trialDate: "",
  }, targetConfig);
  assert.equal(result.status, AUTOMATION_STATUS.READY, `${sourceName} -> ${targetName}`);
}

const sziranyiConfig = parseAutomationConfig([
  ["MODERN TÁNC 10-14 ÉVES", "", "SZERDA", "15:30", "16:45", "Hajós terem", "Szirányi Laura", 2, 75, "2x75", false],
  ["MODERN TÁNC 10-14 ÉVES", "", "PÉNTEK", "15:15", "16:30", "Hajós terem", "Szirányi Laura", 2, 75, "2x75", false],
]);
const sziranyiResult = calculateRegistration({
  ...base,
  courseRaw: "MODERN TÁNC 12-15 ÉVES /SZERDA ÉS PÉNTEK HAJÓS TEREM/SZERDA 15.30-16.45 ÉS PÉNTEK 15.15-16.30 /SZIRÁNYI LAURA",
  trialSignup: "igen",
  trialDate: "",
}, sziranyiConfig);
assert.equal(sziranyiResult.status, AUTOMATION_STATUS.READY);
assert.equal(sziranyiResult.firstClass.date.toISOString().slice(0, 10), "2026-09-16");

const renamedSziranyiConfig = parseAutomationConfig([
  ["MODERN TÁNC 12-15 ÉVES", "", "SZERDA", "15:30", "16:45", "Hajós terem", "Szirányi Laura", 2, 75, "2x75", false],
  ["MODERN TÁNC 12-15 ÉVES", "", "PÉNTEK", "15:15", "16:30", "Hajós terem", "Szirányi Laura", 2, 75, "2x75", false],
]);
const historicalSziranyiResult = calculateRegistration({
  ...base,
  courseRaw: "MODERN TÁNC 10-14 ÉVES /SZERDA HAJÓS TEREM/15.30-16.45 ÉS PÉNTEK HAJÓS TEREM /15.15-16.30 /SZIRÁNYI LAURA",
  trialSignup: "igen",
  trialDate: "",
}, renamedSziranyiConfig);
assert.equal(historicalSziranyiResult.status, AUTOMATION_STATUS.READY);
assert.equal(historicalSziranyiResult.firstClass.date.toISOString().slice(0, 10), "2026-09-16");

const conflictingSchedule = calculateRegistration({
  ...base,
  courseRaw: "JAZZ BALETT IFJÚSÁGI-FELNŐTT 15 ÉVES KORTÓL/KEDD HAJÓS TEREM ÉS PÉNTEK BERCZIK TEREM/16.30-18.00/TANÁR",
  trialSignup: "igen",
}, parseAutomationConfig([
  ["JAZZ TÁNC IFJÚSÁGI-FELNŐTT 15 ÉVES KORTÓL", "", "HÉTFŐ", "16:30", "18:00", "Hajós terem", "Tanár", 2, 90, "2x90", false],
  ["JAZZ TÁNC IFJÚSÁGI-FELNŐTT 15 ÉVES KORTÓL", "", "CSÜTÖRTÖK", "16:30", "18:00", "Ágnes terem", "Tanár", 2, 90, "2x90", false],
]));
assert.equal(conflictingSchedule.status, AUTOMATION_STATUS.MANUAL);
assert.match(conflictingSchedule.manualReason, /ismeretlen tanfolyam|hiányzó órarend/i);

const artisticGymnasticsConfig = parseAutomationConfig([
  ["MŰVÉSZI TORNA ÓVODÁS 5-6 ÉVESEK", "", "SZERDA", "16:00", "17:00", "Hajós terem", "Tanár", 1, 60, "2x60", false],
  ["MŰVÉSZI TORNA ÓVODÁS 5-6 ÉVESEK", "", "SZOMBAT", "09:00", "10:00", "Hajós terem", "Tanár", 2, 60, "2x60", false],
  ["", "", "", "", "", "", "", "", "", "", "", "", 1, "2026-09-03", "2026-09-30", "1x60", 43000, 40850],
  ["", "", "", "", "", "", "", "", "", "", "", "", 1, "2026-09-03", "2026-09-30", "2x60", 60000, 57000],
]);
const artisticGymnasticsResult = calculateRegistration({
  ...base,
  courseRaw: "MŰVÉSZI TORNA ÓVODÁS 5-6 ÉVESEK/SZERDA HAJÓS TEREM/16.00-17.00/TANÁR",
  submittedAt: "2026-09-15",
  trialSignup: "nem",
}, artisticGymnasticsConfig);
assert.equal(artisticGymnasticsResult.status, AUTOMATION_STATUS.READY);
assert.equal(artisticGymnasticsResult.feeCategory, "1x60");
assert.equal(artisticGymnasticsResult.fee, 43000);

const staleFrequencyConfig = parseAutomationConfig([
  ["EGY SZERDAI ÓRA", "", "SZERDA", "18:15", "19:00", "Hajós terem", "Tanár", 2, 45, "2x45", false],
  ["", "", "", "", "", "", "", "", "", "", "", "", 1, "2026-09-03", "2026-09-30", "1x45", 39000, 37050],
]);
const staleFrequencyResult = calculateRegistration({
  ...base,
  courseRaw: "EGY SZERDAI ÓRA/SZERDA HAJÓS TEREM/18.15-19.00/TANÁR",
  submittedAt: "2026-09-15",
}, staleFrequencyConfig);
assert.equal(staleFrequencyResult.status, AUTOMATION_STATUS.READY);
assert.equal(staleFrequencyResult.feeCategory, "1x45");
assert.equal(staleFrequencyResult.fee, 39000);

const alternateAttendance = calculateRegistration({
  ...base,
  alternateAttendance: "heti 1",
}, noException);
assert.equal(alternateAttendance.status, AUTOMATION_STATUS.MANUAL);
assert.match(alternateAttendance.manualReason, /eltérő óraszám|alternatív részvétel/i);

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
const manualTrialCourse = calculateRegistration({
  ...base,
  courseRaw: "PILATES/KEDD ÁGNES TEREM/18.30-19.30/TANÁR",
  trialSignup: "igen",
}, noException);
assert.equal(manualTrialCourse.status, AUTOMATION_STATUS.MANUAL);
assert.equal(manualTrialCourse.isTrial, true, "a kézi elbírálású próba sem válhat beiratkozási e-mail-szándékká");

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
