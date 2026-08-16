import assert from "node:assert/strict";
import {
  AUDIENCE_TYPE,
  EMAIL_EVENT,
  TEMPLATE_KEY,
  brevoTemplateDefinitions,
  buildEmailDraft,
  classifyAudience,
  defaultEmailSettings,
  emailSettingsSheetRows,
  parseEmailSettings,
} from "./src/email-templates.js";

const settings = defaultEmailSettings();
Object.values(TEMPLATE_KEY).forEach((key, index) => { settings.templateIds[key] = 100 + index; });

const parentRegistration = {
  entryId: "TEST-PARENT-001",
  courseRaw: "TESZT TÁNC/PÉNTEK HAJÓS TEREM/17.00-18.00/TESZT TANÁR",
  studentName: "Teszt Béla",
  parentName: "Teszt Anna",
  birthDate: "2015-04-12",
  submittedAt: "2026-08-16 10:00:00",
  email: "zsalti.r+parent_for_child@gmail.com",
};
const adultRegistration = {
  ...parentRegistration,
  entryId: "TEST-ADULT-001",
  studentName: "Teszt Béla",
  parentName: "",
  birthDate: "1988-04-12",
  email: "zsalti.r+adult_self@gmail.com",
};

assert.deepEqual(classifyAudience(parentRegistration), { type: AUDIENCE_TYPE.PARENT_FOR_CHILD, age: 11, manualReason: "" });
assert.deepEqual(classifyAudience(adultRegistration), { type: AUDIENCE_TYPE.ADULT_SELF, age: 38, manualReason: "" });
assert.match(classifyAudience({ ...parentRegistration, parentName: "" }).manualReason, /Kiskorú/);
assert.match(classifyAudience({ ...adultRegistration, parentName: "Más Mária" }).manualReason, /Nagykorú/);
assert.match(classifyAudience({ ...adultRegistration, birthDate: "" }).manualReason, /születési/);

const venues = [
  { code: "kapas", value: "Hajós terem", address: /Kapás u\. 55/ },
  { code: "agnesterem", value: "Ágnes terem", address: /Margit krt\. 48/ },
];
const audiences = [
  { code: "parent_for_child", registration: parentRegistration, expected: /gyermekét|Teszt Béla|Béla/ },
  { code: "adult_self", registration: adultRegistration, expected: /Önt|jelentkezését|beiratkozását/ },
];

let scenarioCount = 0;
for (const venue of venues) {
  for (const audience of audiences) {
    for (const eventType of [EMAIL_EVENT.TRIAL, EMAIL_EVENT.ENROLLMENT]) {
      const calculation = {
        isTrial: eventType === EMAIL_EVENT.TRIAL,
        fee: eventType === EMAIL_EVENT.TRIAL ? 2600 : 43000,
        semester: 1,
        firstClass: { date: new Date("2026-09-18T00:00:00Z"), startTime: "17:00", venue: venue.value },
      };
      const draft = buildEmailDraft(audience.registration, calculation, settings, eventType);
      assert.equal(draft.manualReason, "", `${venue.code}+${audience.code}+${eventType}`);
      assert.equal(draft.sendReady, true);
      assert.match(draft.plain, venue.address);
      assert.match(draft.plain, audience.expected);
      assert.doesNotMatch(draft.plain, /{{|}}|{%|%}/);
      assert.doesNotMatch(draft.html, /{{|}}|{%|%}/);
      assert.ok(draft.templateId);
      scenarioCount += 1;
    }
  }
}

for (const audience of audiences) {
  const draft = buildEmailDraft(audience.registration, {}, settings, EMAIL_EVENT.PAYMENT_RECEIVED);
  assert.equal(draft.manualReason, "", `payment+${audience.code}`);
  assert.equal(draft.sendReady, true);
  assert.match(draft.plain, /Köszönjük szépen az utalást/);
  assert.match(draft.plain, audience.registration.parentName ? /mutassák be/ : /mutassa be/);
  scenarioCount += 1;
}

assert.equal(scenarioCount, 10);
const noTemplate = buildEmailDraft(parentRegistration, {
  isTrial: true, fee: 2600,
  firstClass: { date: new Date("2026-09-18T00:00:00Z"), startTime: "17:00", venue: "Hajós terem" },
});
assert.equal(noTemplate.sendReady, false);
assert.match(noTemplate.configurationWarning, /template ID/);

const parsedSettings = parseEmailSettings(emailSettingsSheetRows());
assert.equal(parsedSettings.signature.name, "Rényi-Szirányi Laura");
assert.equal(parsedSettings.venues.length, 2);
assert.equal(parsedSettings.bankAccountNumber, "12001008-01351837-00100005");

const definitions = brevoTemplateDefinitions();
assert.equal(definitions.length, 6);
assert.equal(new Set(definitions.map((item) => item.key)).size, 6);
definitions.forEach((definition) => {
  assert.match(definition.htmlContent, /{{params\./);
  assert.match(definition.templateName, /2026-08-16-v2/);
});

console.log("Email template tests passed (10 scenarios). ");
