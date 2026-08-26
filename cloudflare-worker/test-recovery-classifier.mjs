import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildRecoveryEmailRows, classifyRecoverySource } from "./src/recovery-classifier.js";
import { emailSettingsSheetRows } from "./src/email-templates.js";

const configRows = [[
  "Tanfolyam kulcs", "GF pontos érték / alias", "Nap", "Kezdés", "Befejezés", "Helyszín", "Tanár", "Heti alkalom", "Perc/alkalom", "Díjkategória", "Kézi elbírálás",
  "", "Félév", "Sáv kezdete", "Sáv vége", "Díjkategória", "Alapár", "Kedvezményes ár", "", "Tanfolyam kulcs", "Dátum", "Típus", "Kezdés", "Befejezés", "Helyszín",
], [
  "TESZT TÁNC", "TESZT TÁNC/Hajós terem/PÉNTEK 17.00-18.00/Teszt Tanár", "PÉNTEK", "17:00", "18:00", "Hajós terem", "Teszt Tanár", 1, 60, "1x60", false,
  "", 1, "2026-09-03", "2026-09-30", "1x60", 43000, 40850,
]];

const settingsRows = emailSettingsSheetRows();
let nextTemplateId = 101;
for (const row of settingsRows) {
  if (String(row[0] || "").startsWith("TEMPLATE_")) row[1] = nextTemplateId++;
}

const registrations = [
  sourceRegistration("1001", "Teszt Elek", "Szülő Anna", "ready@example.invalid", "2015-02-03"),
  sourceRegistration("1002", "Minta Béla", "", "manual@example.invalid", "2015-02-03"),
];

const first = classifyRecoverySource({ registrations, configRows, settingsRows });
const second = classifyRecoverySource({ registrations: [...registrations].reverse(), configRows, settingsRows });

assert.deepEqual(first, second, "a manifest nem függhet a forrássorok sorrendjétől");
assert.equal(first.source_records, 2);
assert.equal(first.expected_intent_rows, 2);
assert.equal(first.send_ready, 1);
assert.equal(first.manual_review, 1);
assert.equal(first.records[0].entry_id, "1001");
assert.equal(first.records[0].classification, "send_ready");
assert.match(first.records[1].reason, /hiányzik a szülő/i);

const serialized = JSON.stringify(first);
for (const forbidden of ["Teszt Elek", "Szülő Anna", "ready@example.invalid", "Minta Béla", "manual@example.invalid"]) {
  assert.equal(serialized.includes(forbidden), false, `személyes adat került a manifestbe: ${forbidden}`);
}

assert.throws(
  () => classifyRecoverySource({ registrations: [registrations[0], registrations[0]], configRows, settingsRows }),
  /duplikáltak.*1001/i,
);

const emailOutput = await buildRecoveryEmailRows({ registrations, configRows, settingsRows });
assert.equal(emailOutput.counts.total, 2);
assert.equal(emailOutput.counts.send_ready, 1);
assert.equal(emailOutput.counts.manual_review, 1);
assert.equal(emailOutput.counts.approved, 0);
assert.equal(emailOutput.counts.duplicate_send_keys, 0);
assert.equal(emailOutput.rows[0].length, 34);
assert.equal(emailOutput.rows[0][11], false);
assert.equal(emailOutput.rows[0][12], "KÜLDHETŐ");
assert.match(emailOutput.rows[0][0], /^1001\|ENROLLMENT\|1\|/);
assert.match(emailOutput.rows[0][15], /^[a-f0-9]{64}$/);
assert.match(emailOutput.rows[0][33], /^[a-f0-9]{64}$/);

const chunkedCliOutput = await runChunkedCli({
  registrations: [sourceRegistration("1003", "Minta Zóra", "Szülő Ágnes", "utf8@example.invalid", "2015-02-03")],
  configRows,
  settingsRows,
});
assert.match(chunkedCliOutput.rows[0][6], /Zóra/);
assert.match(chunkedCliOutput.rows[0][6], /Ágnes/);
assert.equal(chunkedCliOutput.rows[0][6].includes("�"), false, "a CLI megsértette az UTF-8 bemenetet");

console.log("Recovery classifier tests passed.");

async function runChunkedCli(payload) {
  const cliPath = fileURLToPath(new URL("./scripts/build-recovery-email-output.mjs", import.meta.url));
  const child = spawn(process.execPath, [cliPath], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  for (const byte of bytes) {
    child.stdin.write(Buffer.from([byte]));
    await new Promise((resolve) => setImmediate(resolve));
  }
  child.stdin.end();

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, stderr);
  return JSON.parse(stdout);
}

function sourceRegistration(entryId, studentName, parentName, email, birthDate) {
  const row = Array.from({ length: 27 }, () => "");
  row[0] = entryId;
  row[1] = "TESZT TÁNC/Hajós terem/PÉNTEK 17.00-18.00/Teszt Tanár";
  row[5] = studentName;
  row[6] = "2026-08-20";
  row[7] = "2026-09-04";
  row[8] = "nem";
  row[14] = birthDate;
  row[17] = email;
  row[18] = parentName;
  return { entryId, sheetRow: row, trialDate: "" };
}
