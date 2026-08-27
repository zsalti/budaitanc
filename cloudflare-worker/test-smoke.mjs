import assert from "node:assert/strict";
import fs from "node:fs/promises";

import worker, { EMAIL_EVENT_LOG_HEADERS, EMAIL_OUTPUT_HEADERS } from "./src/worker.js";
import { emailSettingsSheetRows } from "./src/email-templates.js";

const fixture = await fs.readFile(new URL("./test-fixtures/dami-registration.csv", import.meta.url), "utf8");
const serviceAccount = await createTestServiceAccount();
const pipeline = {
  pipeline_id: "tanctanfolyam_jelentkezes",
  adapter: "dance_course_registration",
  spreadsheet_id: "test-spreadsheet",
  tab_name: " TAGOK I FÉLÉV",
  email_automation: true,
  staff_target: { spreadsheet_id: "test-staff-spreadsheet", tab_name: "TAGOK 2026-27" },
};
const env = {
  IMPORT_ADMIN_TOKEN: "test-import-token",
  WEBHOOK_SHARED_SECRET: "test-webhook-secret",
  GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT: JSON.stringify(serviceAccount),
  PIPELINES_CONFIG_JSON: JSON.stringify({ pipelines: [pipeline] }),
  EMAIL_ADMIN_TOKEN: "test-email-token",
  BREVO_API_KEY: "test-brevo-key",
  BREVO_SENDER_EMAIL: "sender@example.invalid",
  BREVO_WEBHOOK_SECRET: "test-brevo-webhook-secret",
  RECOVERY_MAINTENANCE_MODE: "off",
};

const masterHeader = [
  "Közlemény", "Tanfolyam neve", "Nap és terem", "Óra ideje", "Táncpedagógusok", "Jelentkező (növendék) neve", "Jelentkezés ideje", "Tanfolyamon részvétel kezdete / naptár", "Próbaórára jelentkezés", "I. féléves tandíj", "I. féléves tandíjfizetés dátuma", "I. tagsági kiállítva", "Egyéb megjegyzés", "Más óraszámban jár", "Születési dátum", "Lakcím", "Telefon", "E-mail cím", "Törvényes képviselő, szülő neve", "Kerület Kártya száma", "Kerület Kártya lejárati dátuma", "Kerület Kártya fotója", "Testvér neve", "Testvér csoportja", "Rendelkezik jóváírható összeggel", "Számlázási adatok", "Számlázási email",
];
const masterState = [masterHeader];
const emailState = [[...EMAIL_OUTPUT_HEADERS]];
const configState = [[
  "Tanfolyam kulcs", "GF pontos érték / alias", "Nap", "Kezdés", "Befejezés", "Helyszín", "Tanár", "Heti alkalom", "Perc/alkalom", "Díjkategória", "Kézi elbírálás",
  "", "Félév", "Sáv kezdete", "Sáv vége", "Díjkategória", "Alapár", "Kedvezményes ár", "", "Tanfolyam kulcs", "Dátum", "Típus", "Kezdés", "Befejezés", "Helyszín",
], [
  "MODERN TÁNC 10-14 ÉVES", "MODERN TÁNC 10-14 ÉVES /SZERDA BERCZIK TEREM/17.00-18.00/TEST TANÁR", "SZERDA", "17:00", "18:00", "Berczik terem", "Test Tanár", 1, 60, "1x60", false,
  "", 1, "2026-09-01", "2026-12-31", "1x60", 43000, 40850,
]];
const settingsState = emailSettingsSheetRows();
let templateId = 101;
for (const row of settingsState) if (String(row[0] || "").startsWith("TEMPLATE_")) row[1] = templateId++;
let partialFilter = false;
const originalFetch = globalThis.fetch;
const brevoRequests = [];

globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  const decoded = decodeURIComponent(url);
  if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "test-access-token" }), { status: 200 });
  if (url.includes("https://www.googleapis.com/drive/v3/files/test-backup")) {
    return new Response(JSON.stringify({ id: "test-backup", mimeType: "application/vnd.google-apps.spreadsheet", createdTime: "2026-08-26T19:23:56Z", trashed: false }), { status: 200 });
  }
  if (url === "https://api.brevo.com/v3/smtp/email") {
    brevoRequests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ messageId: "unexpected" }), { status: 201 });
  }
  if (url.includes("test-spreadsheet?fields=")) {
    return new Response(JSON.stringify({ sheets: [
      { properties: { sheetId: 1, title: pipeline.tab_name, gridProperties: { rowCount: 1000, columnCount: 46 } }, ...(partialFilter ? { basicFilter: { range: { startRowIndex: 0, startColumnIndex: 1, endColumnIndex: 35 } } } : {}) },
      { properties: { sheetId: 2, title: "E-mail kimenet", gridProperties: { rowCount: 1000, columnCount: 34 } } },
      { properties: { sheetId: 3, title: "Tanfolyamok", gridProperties: { rowCount: 1000, columnCount: 25 } } },
      { properties: { sheetId: 4, title: "E-mail beállítások", gridProperties: { rowCount: 1000, columnCount: 8 } } },
      { properties: { sheetId: 5, title: "E-mail eseménynapló", gridProperties: { rowCount: 1000, columnCount: 9 } } },
    ] }), { status: 200 });
  }
  if (url.includes("/values:batchUpdate")) {
    for (const item of JSON.parse(options.body).data) applyRange(item.range, item.values[0]);
    return new Response(JSON.stringify({}), { status: 200 });
  }
  if (url.includes("test-spreadsheet:batchUpdate")) return new Response(JSON.stringify({ replies: [] }), { status: 200 });
  if (url.includes("/values/")) return new Response(JSON.stringify({ values: stateForRead(decoded) }), { status: 200 });
  throw new Error(`Unhandled fetch: ${url}`);
};

try {
  assert.equal((await worker.fetch(new Request("https://example.test/healthz"), env)).status, 200);

  const payment = await worker.fetch(new Request("https://example.test/payments/correct-token", { method: "POST" }), { ...env, PAYMENT_IMPORT_TOKEN: "correct-token" });
  assert.equal(payment.status, 410);
  assert.equal((await payment.json()).error, "disabled");
  const sync = await worker.fetch(new Request("https://example.test/sync/correct-token", { method: "POST" }), { ...env, SYNC_ADMIN_TOKEN: "correct-token" });
  assert.equal(sync.status, 410);
  const webhook = await worker.fetch(new Request("https://example.test/webhooks/gravity-forms", {
    method: "POST", headers: { "Content-Type": "application/json", "X-BudaiTanc-Secret": env.WEBHOOK_SHARED_SECRET }, body: JSON.stringify({}),
  }), env);
  assert.equal(webhook.status, 410);

  const planned = await importRequest("plan", fixture);
  assert.equal(planned.status, 200);
  const plannedHtml = await planned.text();
  assert.match(plannedHtml, /Import előnézet/);
  const planHash = plannedHtml.match(/name="plan_hash" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(planHash);
  assert.equal(masterState.length, 1, "a dry run nem írhat");
  assert.equal(emailState.length, 1, "az import nem készíthet piszkozatot");

  const locked = await importRequest("execute", fixture, planHash, { ...env, RECOVERY_MAINTENANCE_MODE: "on" });
  assert.equal(locked.status, 503);
  assert.equal(masterState.length, 1);

  const missingBackup = await importRequest("execute", fixture, planHash, env, "");
  assert.equal(missingBackup.status, 400);
  assert.match(await missingBackup.text(), /Drive-backup/i);
  const executed = await importRequest("execute", fixture, planHash);
  assert.equal(executed.status, 200);
  const executedHtml = await executed.text();
  assert.match(executedHtml, /E-mail-piszkozat vagy Brevo-küldés: 0/);
  const draftGrant = executedHtml.match(/name="draft_grant" value="([^"]+)"/)?.[1];
  assert.ok(draftGrant, "a frissen importált ID-khoz időkorlátos piszkozatjogosultság készül");
  assert.equal(masterState.length, 2);
  assert.equal(masterState[1][0], "TEST-CODEX-20260723-001");
  assert.equal(masterState[1][5], "Codex Teszt Dami");

  const importedDrafts = await importDraftRequest(draftGrant);
  assert.equal(importedDrafts.status, 200);
  assert.match(await importedDrafts.text(), /E-mail-piszkozatok elkészültek/);
  assert.equal(emailState.length, 2);
  assert.equal(emailState[1][11], false, "az importból indított piszkozat nem kapcsolhat be jóváhagyást");
  assert.equal(brevoRequests.length, 0, "az importból indított piszkozat nem küldhet Brevo-levelet");

  const freshOnlyFixture = fixture
    .replace("TEST-CODEX-20260723-001", "TEST-CODEX-20260723-002")
    .replace("Codex Teszt Dami", "Codex Teszt Új");
  const freshOnly = await importRequest("plan", freshOnlyFixture);
  assert.equal(freshOnly.status, 200, "a csak új ID-kat tartalmazó CSV előnézete sikeres");
  assert.match(await freshOnly.text(), /CSV-ből hiányzó, érintetlenül maradó korábbi ID-k: 1/);
  assert.equal(masterState.length, 2, "a részleges CSV előnézete sem írhat");

  const repeated = await importRequest("plan", fixture);
  assert.equal(repeated.status, 200);
  assert.match(await repeated.text(), /Új, append-only rekord: 0/);
  assert.equal(masterState.length, 2, "ismételt teljes import nem írhat");

  const changed = await importRequest("plan", fixture.replace("1111 Budapest, Teszt utca 1.", "2222 Budapest, Módosított utca 2."));
  assert.equal(changed.status, 200, "a létező ID eltérő adatával is csak kihagyás történik");
  assert.match(await changed.text(), /Kihagyott, már létező ID a CSV-ben: 1/);
  partialFilter = true;
  const filtered = await importRequest("plan", fixture);
  assert.equal(filtered.status, 400);
  assert.match(await filtered.text(), /részleges/i);
  partialFilter = false;

  const implicitDrafts = await worker.fetch(new Request("https://example.test/emails/drafts/test-email-token", {
    method: "POST", body: JSON.stringify({ pipeline_id: pipeline.pipeline_id }),
  }), env);
  assert.equal(implicitDrafts.status, 500);
  const drafts = await worker.fetch(new Request("https://example.test/emails/drafts/test-email-token", {
    method: "POST", body: JSON.stringify({ pipeline_id: pipeline.pipeline_id, entry_ids: ["TEST-CODEX-20260723-001"] }),
  }), env);
  assert.equal(drafts.status, 200);
  assert.equal(emailState.length, 2);
  assert.equal(emailState[1][1], "TEST-CODEX-20260723-001");
  assert.equal(emailState[1][11], false, "piszkozat nem kapcsolhat be jóváhagyást");
  assert.equal(brevoRequests.length, 0, "piszkozat nem küldhet Brevo-levelet");

  console.log("Cloudflare Worker recovery smoke tests passed.");
} finally {
  globalThis.fetch = originalFetch;
}

async function importRequest(mode, csv, planHash = "", selectedEnv = env, backupId = "test-backup") {
  const form = new FormData();
  form.append("mode", mode);
  if (planHash) form.append("plan_hash", planHash);
  if (mode === "execute" && backupId) form.append("backup_id", backupId);
  form.append("file", new Blob([csv], { type: "text/csv" }), "gravity.csv");
  return worker.fetch(new Request("https://example.test/import/test-import-token", { method: "POST", body: form }), selectedEnv);
}

async function importDraftRequest(draftGrant) {
  const form = new FormData();
  form.append("mode", "drafts");
  form.append("draft_grant", draftGrant);
  return worker.fetch(new Request("https://example.test/import/test-import-token", { method: "POST", body: form }), env);
}

function stateForRead(url) {
  if (url.includes("Tanfolyamok")) return configState;
  if (url.includes("E-mail kimenet")) return emailState;
  if (url.includes("E-mail beállítások")) return settingsState;
  if (url.includes("E-mail eseménynapló")) return [[...EMAIL_EVENT_LOG_HEADERS]];
  return masterState;
}

function applyRange(range, values) {
  const match = String(range).match(/!([A-Z]+)(\d+)(?::([A-Z]+)\d+)?$/);
  assert.ok(match, `Unexpected range: ${range}`);
  const state = range.includes("E-mail kimenet") ? emailState : masterState;
  const startColumn = columnNumber(match[1]);
  const rowIndex = Number(match[2]) - 1;
  while (state.length <= rowIndex) state.push([]);
  values.forEach((value, index) => { state[rowIndex][startColumn + index] = value; });
}

function columnNumber(column) {
  return [...column].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

async function createTestServiceAccount() {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g).join("\n");
  return { client_email: "test@example.invalid", private_key: `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n` };
}
