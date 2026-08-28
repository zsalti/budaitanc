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
  SYNC_ADMIN_TOKEN: "test-sync-token",
  IMPORT_BACKUP_SOURCE_CONFIG_JSON: JSON.stringify({ sources: [{
    pipeline_id: pipeline.pipeline_id, folder_id: "test-backup-folder", max_age_minutes: 60,
  }] }),
  IMPORT_EMERGENCY_ADMIN_TOKEN: "test-emergency-token",
  BREVO_API_KEY: "test-brevo-key",
  BREVO_SENDER_EMAIL: "sender@example.invalid",
  BREVO_WEBHOOK_SECRET: "test-brevo-webhook-secret",
  RECOVERY_MAINTENANCE_MODE: "off",
};

const masterHeader = [
  "Közlemény", "Tanfolyam neve", "Nap és terem", "Óra ideje", "Táncpedagógusok", "Jelentkező (növendék) neve", "Jelentkezés ideje", "Tanfolyamon részvétel kezdete / naptár", "Próbaórára jelentkezés", "I. féléves tandíj", "I. féléves tandíjfizetés dátuma", "I. tagsági kiállítva", "Egyéb megjegyzés", "Más óraszámban jár", "Születési dátum", "Lakcím", "Telefon", "E-mail cím", "Törvényes képviselő, szülő neve", "Kerület Kártya száma", "Kerület Kártya lejárati dátuma", "Kerület Kártya fotója", "Testvér neve", "Testvér csoportja", "Rendelkezik jóváírható összeggel", "Számlázási adatok", "Számlázási email", "II. féléves tandíj befizetés dátuma",
];
const masterState = [masterHeader];
const staffState = [[...masterHeader.slice(0, 8)]];
let staffBackupState = staffState.map((row) => [...row]);
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
const backupCreatedAt = new Date(Date.now() - 60_000).toISOString();
const newestBackupCreatedAt = new Date().toISOString();
const staleBackupCreatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
let backupCandidates = [];
const backupDetails = new Map([
  ["test-backup", { createdTime: backupCreatedAt, parents: ["test-backup-folder"], snapshot: "matching" }],
  ["test-backup-corrupt", { createdTime: newestBackupCreatedAt, parents: ["test-backup-folder"], snapshot: "corrupt" }],
  ["test-backup-stale", { createdTime: staleBackupCreatedAt, parents: ["test-backup-folder"], snapshot: "matching" }],
  ["test-backup-foreign", { createdTime: newestBackupCreatedAt, parents: ["other-folder"], snapshot: "matching" }],
  ["test-staff-backup", { createdTime: backupCreatedAt, parents: ["test-backup-folder"], snapshot: "staff_matching" }],
  ["test-staff-backup-corrupt", { createdTime: newestBackupCreatedAt, parents: ["test-backup-folder"], snapshot: "staff_corrupt" }],
  ["test-staff-backup-stale", { createdTime: staleBackupCreatedAt, parents: ["test-backup-folder"], snapshot: "staff_matching" }],
  ["test-staff-backup-foreign", { createdTime: newestBackupCreatedAt, parents: ["other-folder"], snapshot: "staff_matching" }],
]);

globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  const decoded = decodeURIComponent(url);
  if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "test-access-token" }), { status: 200 });
  if (url.includes("https://www.googleapis.com/drive/v3/files?") && decoded.includes("'test-backup-folder' in parents")) {
    return new Response(JSON.stringify({ files: backupCandidates.map((id) => ({ id, ...backupDetails.get(id) })) }), { status: 200 });
  }
  if (url.includes("https://www.googleapis.com/drive/v3/files/test-backup-folder?")) {
    return new Response(JSON.stringify({ id: "test-backup-folder", mimeType: "application/vnd.google-apps.folder", trashed: false }), { status: 200 });
  }
  const backupMatch = url.match(/https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^?]+)/);
  if (backupMatch && backupDetails.has(decodeURIComponent(backupMatch[1]))) {
    const id = decodeURIComponent(backupMatch[1]);
    const detail = backupDetails.get(id);
    return new Response(JSON.stringify({ id, mimeType: "application/vnd.google-apps.spreadsheet", trashed: false, ...detail }), { status: 200 });
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
  if (url.includes("test-staff-spreadsheet?fields=")) {
    return new Response(JSON.stringify({ sheets: [
      { properties: { sheetId: 7, title: pipeline.staff_target.tab_name, gridProperties: { rowCount: 1000, columnCount: 26 } } },
    ] }), { status: 200 });
  }
  if (url.includes("test-staff-backup") && url.includes("?fields=")) {
    return new Response(JSON.stringify({ sheets: [
      { properties: { sheetId: 7, title: pipeline.staff_target.tab_name, gridProperties: { rowCount: 1000, columnCount: 26 } } },
    ] }), { status: 200 });
  }
  if (url.includes("test-backup") && url.includes("?fields=")) {
    return new Response(JSON.stringify({ sheets: [
      { properties: { sheetId: 1, title: pipeline.tab_name, gridProperties: { rowCount: 1000, columnCount: 46 } } },
      { properties: { sheetId: 2, title: "E-mail kimenet", gridProperties: { rowCount: 1000, columnCount: 34 } } },
    ] }), { status: 200 });
  }
  if (url.includes("/values:batchUpdate")) {
    for (const item of JSON.parse(options.body).data) applyRange(item.range, item.values[0]);
    return new Response(JSON.stringify({}), { status: 200 });
  }
  if (url.includes("test-spreadsheet:batchUpdate")) return new Response(JSON.stringify({ replies: [] }), { status: 200 });
  if (url.includes("test-staff-spreadsheet:batchUpdate")) {
    const requests = JSON.parse(options.body).requests || [];
    for (const request of requests) {
      const range = request.deleteDimension?.range;
      if (range?.dimension === "ROWS") staffState.splice(range.startIndex, range.endIndex - range.startIndex);
    }
    return new Response(JSON.stringify({ replies: [] }), { status: 200 });
  }
  if (url.includes("/values/")) return new Response(JSON.stringify({ values: stateForRead(decoded) }), { status: 200 });
  throw new Error(`Unhandled fetch: ${url}`);
};

try {
  assert.equal((await worker.fetch(new Request("https://example.test/healthz"), env)).status, 200);

  const payment = await worker.fetch(new Request("https://example.test/payments/correct-token", { method: "POST" }), { ...env, PAYMENT_IMPORT_TOKEN: "correct-token" });
  assert.equal(payment.status, 410);
  assert.equal((await payment.json()).error, "disabled");
  const sync = await worker.fetch(new Request("https://example.test/sync/wrong-token", { method: "POST" }), env);
  assert.equal(sync.status, 404);
  const webhook = await worker.fetch(new Request("https://example.test/webhooks/gravity-forms", {
    method: "POST", headers: { "Content-Type": "application/json", "X-BudaiTanc-Secret": env.WEBHOOK_SHARED_SECRET }, body: JSON.stringify({}),
  }), env);
  assert.equal(webhook.status, 410);

  const planned = await importRequest("plan", fixture);
  assert.equal(planned.status, 200);
  const plannedHtml = await planned.text();
  assert.match(plannedHtml, /Import előnézet/);
  assert.doesNotMatch(plannedHtml, /name="backup_id"/, "a normál import UI nem kérhet kézi backup-ID-t");
  assert.match(plannedHtml, /automatikusan választ friss, ellenőrzött backupot/i);
  const planHash = plannedHtml.match(/name="plan_hash" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(planHash);
  assert.equal(masterState.length, 1, "a dry run nem írhat");
  assert.equal(emailState.length, 1, "az import nem készíthet piszkozatot");

  const locked = await importRequest("execute", fixture, planHash, { ...env, RECOVERY_MAINTENANCE_MODE: "on" });
  assert.equal(locked.status, 503);
  assert.equal(masterState.length, 1);

  backupCandidates = ["test-backup-corrupt"];
  const corruptBackup = await importRequest("execute", fixture, planHash);
  assert.equal(corruptBackup.status, 400);
  assert.match(await corruptBackup.text(), /Nincs friss, sértetlen/i);
  assert.equal(masterState.length, 1, "sérült backup mellett nincs import");

  backupCandidates = ["test-backup-stale"];
  const staleBackup = await importRequest("execute", fixture, planHash);
  assert.equal(staleBackup.status, 400);
  assert.match(await staleBackup.text(), /Nincs friss, sértetlen/i);
  assert.equal(masterState.length, 1, "régi backup mellett nincs import");

  backupCandidates = ["test-backup-foreign"];
  const foreignBackup = await importRequest("execute", fixture, planHash);
  assert.equal(foreignBackup.status, 400);
  assert.match(await foreignBackup.text(), /Nincs friss, sértetlen/i);
  assert.equal(masterState.length, 1, "idegen mappából származó backup mellett nincs import");

  const legacyManualBackup = await importRequest("execute", fixture, planHash, env, "test-backup");
  assert.equal(legacyManualBackup.status, 400);
  assert.match(await legacyManualBackup.text(), /nem fogad kézzel megadott backup-ID-t/i);
  assert.equal(masterState.length, 1, "normál import kézi backup-ID-val sem írhat");

  const deniedEmergencyOverride = await emergencyImportRequest(planHash);
  assert.equal(deniedEmergencyOverride.status, 400);
  assert.match(await deniedEmergencyOverride.text(), /X-Import-Emergency-Token/i);
  assert.equal(masterState.length, 1, "a kézi vészfelülbírálás külön admin token nélkül sem írhat");

  backupCandidates = ["test-backup-corrupt", "test-backup"];
  const executed = await importRequest("execute", fixture, planHash);
  assert.equal(executed.status, 200);
  const executedHtml = await executed.text();
  assert.match(executedHtml, /E-mail-piszkozat vagy Brevo-küldés: 0/);
  assert.match(executedHtml, /Automatikusan kiválasztott, igazolt Drive-backup: <code>test-backup<\/code>/);
  const draftGrant = executedHtml.match(/name="draft_grant" value="([^"]+)"/)?.[1];
  assert.ok(draftGrant, "a frissen importált ID-khoz időkorlátos piszkozatjogosultság készül");
  assert.equal(masterState.length, 2);
  assert.equal(masterState[1][0], "TEST-CODEX-20260723-001");
  assert.equal(masterState[1][5], "Codex Teszt Dami");

  const syncPreview = await syncRequest({ mode: "preview" });
  assert.equal(syncPreview.status, 200);
  const syncPreviewResult = await syncPreview.json();
  assert.equal(syncPreviewResult.status, "preview");
  assert.equal(syncPreviewResult.created, 1, "az előnézet felismeri a még hiányzó munkatársi sort");
  assert.equal(syncPreviewResult.updated, 0);
  assert.equal(syncPreviewResult.deleted, 0);
  assert.equal(syncPreviewResult.added_columns.length, 3, "a hiányzó, kézi pénzügyi oszlopokat csak tervezi");
  assert.equal(staffState.length, 1, "az előnézet nem ír a munkatársi Sheetbe");

  const syncLocked = await syncRequest({ mode: "execute", plan_hash: syncPreviewResult.plan_hash }, { ...env, RECOVERY_MAINTENANCE_MODE: "on" });
  assert.equal(syncLocked.status, 503, "a karbantartási zár az execute módot megállítja");
  assert.equal(staffState.length, 1);

  backupCandidates = ["test-staff-backup-stale"];
  const staleSyncBackup = await syncRequest({ mode: "execute", plan_hash: syncPreviewResult.plan_hash });
  assert.equal(staleSyncBackup.status, 500);
  assert.match((await staleSyncBackup.json()).message, /Nincs friss, sértetlen/i);
  assert.equal(staffState.length, 1, "régi backup mellett nincs szinkron");

  backupCandidates = ["test-staff-backup-foreign"];
  const foreignSyncBackup = await syncRequest({ mode: "execute", plan_hash: syncPreviewResult.plan_hash });
  assert.equal(foreignSyncBackup.status, 500);
  assert.match((await foreignSyncBackup.json()).message, /Nincs friss, sértetlen/i);
  assert.equal(staffState.length, 1, "idegen backup mellett nincs szinkron");

  backupCandidates = ["test-staff-backup-corrupt"];
  const corruptSyncBackup = await syncRequest({ mode: "execute", plan_hash: syncPreviewResult.plan_hash });
  assert.equal(corruptSyncBackup.status, 500);
  assert.match((await corruptSyncBackup.json()).message, /Nincs friss, sértetlen/i);
  assert.equal(staffState.length, 1, "sérült backup mellett nincs szinkron");

  const legacyManualSyncBackup = await syncRequest({
    mode: "execute", plan_hash: syncPreviewResult.plan_hash, backup_id: "test-staff-backup",
  });
  assert.equal(legacyManualSyncBackup.status, 500);
  assert.match((await legacyManualSyncBackup.json()).message, /nem fogad kézzel megadott backup-ID-t/i);
  assert.equal(staffState.length, 1, "a normál szinkron kézi backup-ID-val sem írhat");

  const deniedSyncEmergencyOverride = await emergencySyncRequest(syncPreviewResult.plan_hash);
  assert.equal(deniedSyncEmergencyOverride.status, 500);
  assert.match((await deniedSyncEmergencyOverride.json()).message, /X-Import-Emergency-Token/i);
  assert.equal(staffState.length, 1, "a kézi vészfelülbírálás külön admin token nélkül sem írhat");

  backupCandidates = ["test-staff-backup-corrupt", "test-staff-backup"];
  const syncExecuted = await syncRequest({ mode: "execute", plan_hash: syncPreviewResult.plan_hash });
  assert.equal(syncExecuted.status, 200);
  const syncExecutedResult = await syncExecuted.json();
  assert.equal(syncExecutedResult.created, 1);
  assert.equal(syncExecutedResult.backup.id, "test-staff-backup");
  assert.equal(syncExecutedResult.backup.selection, "automatic");
  assert.equal(staffState[1][0], "TEST-CODEX-20260723-001");
  assert.equal(staffState[1][5], "Codex Teszt Dami");
  assert.deepEqual(staffState[0].slice(8, 11), [
    "I. féléves tandíjfizetés dátuma", "II. féléves tandíj befizetés dátuma", "Egyéb megjegyzés",
  ], "a végrehajtás csak jóváhagyott tervből hozza létre a szinkronoszlopokat");

  staffState.push(["TEST-CODEX-STALE-001", "Régi", "sor"]);
  const staleSyncPreview = await syncRequest({ mode: "preview" });
  assert.equal(staleSyncPreview.status, 200);
  const staleSyncPreviewResult = await staleSyncPreview.json();
  assert.equal(staleSyncPreviewResult.deleted, 1, "a preview kimutatja a törlendő, fő Sheetből hiányzó sort");
  assert.equal(staffState.length, 3, "a preview törlésmentes");
  const deleteWithoutConfirmation = await syncRequest({
    mode: "execute", plan_hash: staleSyncPreviewResult.plan_hash,
  });
  assert.equal(deleteWithoutConfirmation.status, 409, "törlés külön megerősítés nélkül nem indulhat");
  assert.equal(staffState.length, 3);
  staffBackupState = staffState.map((row) => [...row]);
  backupCandidates = ["test-staff-backup"];
  const confirmedDelete = await syncRequest({
    mode: "execute", plan_hash: staleSyncPreviewResult.plan_hash, allow_deletes: true,
  });
  assert.equal(confirmedDelete.status, 200);
  assert.equal(staffState.length, 2, "a jóváhagyott törlés a friss tervből, visszaolvasással zárul");
  assert.equal(staffState.some((row) => row[0] === "TEST-CODEX-STALE-001"), false);

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

  const historicalId = "TEST-CODEX-HISTORY-001";
  masterState.push(masterState[1].map((value) => value));
  masterState.at(-1)[0] = historicalId;
  masterState.at(-1)[5] = "Korábbi Bizonyíték";
  masterState.at(-1)[17] = "uj-cimzett@example.invalid";
  masterState.at(-1)[44] = "";
  masterState.at(-1)[45] = "";
  const historicalEvidence = Array.from({ length: EMAIL_OUTPUT_HEADERS.length }, () => "");
  historicalEvidence[0] = `${historicalId}|ENROLLMENT|2|v1`;
  historicalEvidence[1] = historicalId;
  historicalEvidence[2] = "2";
  historicalEvidence[3] = "v1";
  historicalEvidence[4] = "regi-cimzett@example.invalid";
  historicalEvidence[12] = "KÉZBESÍTVE";
  historicalEvidence[13] = "historical-message-id";
  historicalEvidence[21] = "ENROLLMENT";
  emailState.push(historicalEvidence);
  const emailRowsBeforeHistoricalDraft = emailState.length;
  const historicalDraft = await worker.fetch(new Request("https://example.test/emails/drafts/test-email-token", {
    method: "POST", body: JSON.stringify({ pipeline_id: pipeline.pipeline_id, entry_ids: [historicalId] }),
  }), env);
  assert.equal(historicalDraft.status, 200);
  const historicalResult = await historicalDraft.json();
  assert.equal(historicalResult.manual, 1, "korábbi küldési bizonyíték más címzettnél is letiltja az új piszkozatot");
  assert.equal(emailState.length, emailRowsBeforeHistoricalDraft, "történeti küldési bizonyíték mellé nem kerülhet második e-mail-sor");
  assert.equal(brevoRequests.length, 0, "történeti bizonyíték ellenőrzése sem küldhet Brevo-levelet");

  console.log("Cloudflare Worker recovery smoke tests passed.");
} finally {
  globalThis.fetch = originalFetch;
}

async function importRequest(mode, csv, planHash = "", selectedEnv = env, legacyBackupId = "") {
  const form = new FormData();
  form.append("mode", mode);
  if (planHash) form.append("plan_hash", planHash);
  if (mode === "execute" && legacyBackupId) form.append("backup_id", legacyBackupId);
  form.append("file", new Blob([csv], { type: "text/csv" }), "gravity.csv");
  return worker.fetch(new Request("https://example.test/import/test-import-token", { method: "POST", body: form }), selectedEnv);
}

async function importDraftRequest(draftGrant) {
  const form = new FormData();
  form.append("mode", "drafts");
  form.append("draft_grant", draftGrant);
  return worker.fetch(new Request("https://example.test/import/test-import-token", { method: "POST", body: form }), env);
}

async function emergencyImportRequest(planHash) {
  const form = new FormData();
  form.append("mode", "execute");
  form.append("plan_hash", planHash);
  form.append("backup_override_id", "test-backup");
  form.append("file", new Blob([fixture], { type: "text/csv" }), "gravity.csv");
  return worker.fetch(new Request("https://example.test/import/test-import-token", {
    method: "POST",
    headers: { "X-Import-Backup-Override": "emergency" },
    body: form,
  }), env);
}

async function syncRequest(payload, selectedEnv = env, headers = {}) {
  return worker.fetch(new Request("https://example.test/sync/test-sync-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ pipeline_id: pipeline.pipeline_id, ...payload }),
  }), selectedEnv);
}

async function emergencySyncRequest(planHash) {
  return syncRequest({
    mode: "execute",
    plan_hash: planHash,
    backup_override_id: "test-staff-backup",
  }, env, { "X-Import-Backup-Override": "emergency" });
}

function stateForRead(url) {
  if (url.includes("test-staff-backup-corrupt")) return [["Sérült backup"]];
  if (url.includes("test-staff-backup")) return staffBackupState;
  if (url.includes("test-backup-corrupt") && url.includes("E-mail kimenet")) return [["Sérült backup"]];
  if (url.includes("test-staff-spreadsheet")) return staffState;
  if (url.includes("Tanfolyamok")) return configState;
  if (url.includes("E-mail kimenet")) return emailState;
  if (url.includes("E-mail beállítások")) return settingsState;
  if (url.includes("E-mail eseménynapló")) return [[...EMAIL_EVENT_LOG_HEADERS]];
  return masterState;
}

function applyRange(range, values) {
  const match = String(range).match(/!([A-Z]+)(\d+)(?::([A-Z]+)\d+)?$/);
  assert.ok(match, `Unexpected range: ${range}`);
  const state = range.includes("E-mail kimenet") ? emailState : (range.includes(pipeline.staff_target.tab_name) ? staffState : masterState);
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
