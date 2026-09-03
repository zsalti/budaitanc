import assert from "node:assert/strict";
import fs from "node:fs/promises";

import worker, {
  EMAIL_EVENT_LOG_HEADERS,
  EMAIL_OUTPUT_HEADERS,
  findStaffAppendRow,
  indexedStaffRows,
  planStaffSyncColumns,
  registrationFromCsvRow,
  staffRegistrationWriteRanges,
} from "./src/worker.js";
import { emailSettingsSheetRows } from "./src/email-templates.js";

const fixture = await fs.readFile(new URL("./test-fixtures/dami-registration.csv", import.meta.url), "utf8");
const flexibleCourseRegistration = registrationFromCsvRow({
  "Jelentkező (növendék) neve": "Formátum Teszt",
  "Választott tanfolyam": "HONLAPRÓL VÁLASZTOTT TANFOLYAM",
  "Bejegyzés azonosító": "TEST-FLEXIBLE-COURSE",
  "Bejegyzés dátuma": "2026-09-01 12:00:00",
});
assert.deepEqual(flexibleCourseRegistration.row.slice(0, 4), ["HONLAPRÓL VÁLASZTOTT TANFOLYAM", "", "", ""],
  "a nem üres tanfolyam eltérő szövegformátuma nem állíthatja meg az importot");
assert.throws(() => registrationFromCsvRow({
  "Jelentkező (növendék) neve": "Hiányzó Tanfolyam Teszt",
  "Bejegyzés azonosító": "TEST-MISSING-COURSE",
  "Bejegyzés dátuma": "2026-09-01 12:00:00",
}), /Kötelező: név, tanfolyam/,
  "az üres tanfolyam továbbra sem kerülhet be a nyilvántartásba");

const staffHeaderWithLocalColumns = [
  "Közlemény", "Tanfolyam neve", "Munkatársi saját mező", "Nap és terem", "Óra ideje",
  "Táncpedagógusok", "Jelentkező (növendék) neve", "Jelentkezés ideje",
  "Tanfolyamon részvétel kezdete / naptár", "I. féléves tandíjfizetés dátuma",
  "Másik munkatársi mező", "II. féléves tandíj befizetés dátuma", "Egyéb megjegyzés",
];
const staffColumnPlan = planStaffSyncColumns([staffHeaderWithLocalColumns]);
assert.deepEqual(staffColumnPlan.indexes, [0, 1, 3, 4, 5, 6, 7, 8, 9],
  "a szinkron fejléc alapján ugorja át a munkatársi tulajdonú oszlopokat");
assert.deepEqual(
  staffRegistrationWriteRanges(
    { tab_name: "TAGOK 2026-27" },
    { syncValues: ["Fő Sheet tanfolyam", "2026-09-01"] },
    7,
    [1, 9],
    ["preserve", "fill_if_blank"],
    ["1001", "Munkatársi tanfolyam"],
  ),
  [{ range: "'TAGOK 2026-27'!J7:J7", values: [["2026-09-01"]] }],
  "meglévő sorban kizárólag az üres első tandíjfizetési dátum tölthető ki",
);
assert.deepEqual(
  staffRegistrationWriteRanges(
    { tab_name: "TAGOK 2026-27" },
    { syncValues: ["1001", "Tanfolyam", "Hétfő"] },
    7,
    [0, 1, 3],
  ),
  [
    { range: "'TAGOK 2026-27'!A7:B7", values: [["1001", "Tanfolyam"]] },
    { range: "'TAGOK 2026-27'!D7:D7", values: [["Hétfő"]] },
  ],
  "az írási tartomány nem fedheti le a közé ékelt munkatársi oszlopot",
);
assert.deepEqual(
  staffRegistrationWriteRanges(
    { tab_name: "TAGOK 2026-27" },
    { syncValues: ["2026-09-01"] },
    7,
    [8],
    ["fill_if_blank"],
    [],
  ),
  [{ range: "'TAGOK 2026-27'!I7:I7", values: [["2026-09-01"]] }],
  "az üres munkatársi I oszlop átveszi a fő Sheet kitöltött dátumát",
);
assert.deepEqual(
  staffRegistrationWriteRanges(
    { tab_name: "TAGOK 2026-27" },
    { syncValues: [""] },
    7,
    [8],
    ["fill_if_blank"],
    ["", "", "", "", "", "", "", "", "2026-08-31"],
  ),
  [],
  "a kitöltött munkatársi I oszlopot az üres fő-Sheet érték nem törölheti",
);
assert.deepEqual(
  staffRegistrationWriteRanges(
    { tab_name: "TAGOK 2026-27" },
    { syncValues: ["2026-09-01"] },
    7,
    [8],
    ["fill_if_blank"],
    ["", "", "", "", "", "", "", "", "2026-08-31"],
  ),
  [],
  "a kitöltött munkatársi I oszlopot eltérő fő-Sheet dátum sem írhatja felül",
);
assert.equal(findStaffAppendRow([
  staffHeaderWithLocalColumns,
  ["1001"],
  [],
  ["1002"],
]), 5, "az új munkatársi rekord a belső üres sor helyett a lista végére kerül");
assert.equal(findStaffAppendRow([
  staffHeaderWithLocalColumns,
  ["1001"],
  ["", "", "munkatársi alapérték"],
  ["", "", "munkatársi alapérték"],
]), 3, "a következő rekord az utolsó ID után kerül, a céloldali alapértéket megőrző sorba");
assert.equal(
  indexedStaffRows([
    staffHeaderWithLocalColumns,
    ["1001"],
    ["", "", "munkatársi alapérték"],
  ], staffColumnPlan.indexes).size,
  1,
  "a kizárólag munkatársi oszlopban előkészített sor nem lehet szinkronhiba",
);
assert.throws(
  () => indexedStaffRows([
    staffHeaderWithLocalColumns,
    ["1001"],
    ["", "félig kitöltött tanfolyam"],
  ], staffColumnPlan.indexes),
  /szinkronmezőhöz Közlemény ID kötelező/,
  "ID nélküli részleges szinkronadat mellett a folyamatnak írás nélkül meg kell állnia",
);
assert.throws(
  () => planStaffSyncColumns([[...staffHeaderWithLocalColumns, "Tanfolyam"]]),
  /Nem egyedi munkatársi Sheet fejléc: Tanfolyam/,
  "a kétértelmű célfejléc mellett a szinkronnak írás nélkül meg kell állnia",
);
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
    refresh_backup_id: "test-backup-slot",
  }] }),
  IMPORT_EMERGENCY_ADMIN_TOKEN: "test-emergency-token",
  BREVO_API_KEY: "test-brevo-key",
  BREVO_SENDER_EMAIL: "sender@example.invalid",
  BREVO_WEBHOOK_SECRET: "test-brevo-webhook-secret",
  RECOVERY_MAINTENANCE_MODE: "off",
};
const noRefreshEnv = {
  ...env,
  IMPORT_BACKUP_SOURCE_CONFIG_JSON: JSON.stringify({ sources: [{
    pipeline_id: pipeline.pipeline_id, folder_id: "test-backup-folder", max_age_minutes: 60,
  }] }),
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
let backupSlotMasterState = [["Régi backup"]];
let backupSlotEmailState = [["Régi backup"]];
const originalFetch = globalThis.fetch;
const brevoRequests = [];
const backupCreatedAt = new Date(Date.now() - 60_000).toISOString();
const newestBackupCreatedAt = new Date().toISOString();
const staleBackupCreatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
let backupCandidates = [];
const backupDetails = new Map([
  ["test-backup", { createdTime: backupCreatedAt, modifiedTime: backupCreatedAt, parents: ["test-backup-folder"], capabilities: { canEdit: true }, snapshot: "matching" }],
  ["test-backup-corrupt", { createdTime: newestBackupCreatedAt, modifiedTime: newestBackupCreatedAt, parents: ["test-backup-folder"], capabilities: { canEdit: true }, snapshot: "corrupt" }],
  ["test-backup-stale", { createdTime: staleBackupCreatedAt, modifiedTime: staleBackupCreatedAt, parents: ["test-backup-folder"], capabilities: { canEdit: true }, snapshot: "matching" }],
  ["test-backup-foreign", { createdTime: newestBackupCreatedAt, modifiedTime: newestBackupCreatedAt, parents: ["other-folder"], capabilities: { canEdit: true }, snapshot: "matching" }],
  ["test-backup-slot", { createdTime: staleBackupCreatedAt, modifiedTime: staleBackupCreatedAt, parents: ["test-backup-folder"], capabilities: { canEdit: true }, snapshot: "slot" }],
  ["test-staff-backup", { createdTime: backupCreatedAt, modifiedTime: backupCreatedAt, parents: ["test-backup-folder"], capabilities: { canEdit: true }, snapshot: "staff-matching" }],
  ["test-staff-backup-stale", { createdTime: staleBackupCreatedAt, modifiedTime: staleBackupCreatedAt, parents: ["test-backup-folder"], capabilities: { canEdit: true }, snapshot: "staff-matching" }],
  ["test-staff-backup-mismatch", { createdTime: newestBackupCreatedAt, modifiedTime: newestBackupCreatedAt, parents: ["test-backup-folder"], capabilities: { canEdit: true }, snapshot: "staff-mismatch" }],
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
  if (url.includes("test-backup-slot/values:batchClear")) {
    backupSlotMasterState = [];
    backupSlotEmailState = [];
    return new Response(JSON.stringify({ clearedRanges: [] }), { status: 200 });
  }
  if (url.includes("test-backup-slot/values:batchUpdate")) {
    for (const item of JSON.parse(options.body).data) {
      if (item.range.includes("E-mail kimenet")) backupSlotEmailState = item.values.map((row) => [...row]);
      else backupSlotMasterState = item.values.map((row) => [...row]);
    }
    backupDetails.get("test-backup-slot").modifiedTime = new Date().toISOString();
    return new Response(JSON.stringify({}), { status: 200 });
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

  const importScreen = await worker.fetch(new Request("https://example.test/import/test-import-token"), env);
  assert.equal(importScreen.status, 200);
  const importScreenHtml = await importScreen.text();
  assert.match(importScreenHtml, /Új jelentkezések hozzáadása/);
  assert.match(importScreenHtml, /let selectedFile = null/);
  assert.match(importScreenHtml, /data\.set\("file", selectedFile, selectedFile\.name\)/,
    "a böngészőnek ugyanazt az egyszer kiválasztott fájlt kell továbbadnia");

  const planned = await importRequest("plan", fixture);
  assert.equal(planned.status, 200);
  const plannedHtml = await planned.text();
  assert.match(plannedHtml, /A fájl rendben van/);
  assert.doesNotMatch(plannedHtml, /name="backup_id"/, "a normál import UI nem kérhet kézi backup-ID-t");
  const plannedMain = plannedHtml.match(/<main>([\s\S]*?)<\/main>/)?.[1] || "";
  assert.doesNotMatch(plannedMain, /type="file"/,
    "az előnézet nem kérheti be másodszor ugyanazt a fájlt");
  assert.doesNotMatch(plannedMain, /append-only|terv hash|Drive-backup|production|Sheet-pillanatkép/i,
    "a felhasználói képernyő nem mutathat belső governance-szöveget");
  assert.match(plannedMain, /data-reuses-file/);
  const planHash = plannedHtml.match(/name="plan_hash" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(planHash);
  assert.equal(masterState.length, 1, "a dry run nem írhat");
  assert.equal(emailState.length, 1, "az import nem készíthet piszkozatot");

  const locked = await importRequest("execute", fixture, planHash, { ...env, RECOVERY_MAINTENANCE_MODE: "on" });
  assert.equal(locked.status, 503);
  assert.equal(masterState.length, 1);

  backupCandidates = ["test-backup-corrupt"];
  const corruptBackup = await importRequest("execute", fixture, planHash, noRefreshEnv);
  assert.equal(corruptBackup.status, 400);
  assert.match(await corruptBackup.text(), /Most nem tudjuk biztonságosan elindítani az importot/i);
  assert.equal(masterState.length, 1, "sérült backup mellett nincs import");

  backupCandidates = ["test-backup-stale"];
  const staleBackup = await importRequest("execute", fixture, planHash, noRefreshEnv);
  assert.equal(staleBackup.status, 400);
  assert.match(await staleBackup.text(), /Most nem tudjuk biztonságosan elindítani az importot/i);
  assert.equal(masterState.length, 1, "régi backup mellett nincs import");

  backupCandidates = ["test-backup-foreign"];
  const foreignBackup = await importRequest("execute", fixture, planHash, noRefreshEnv);
  assert.equal(foreignBackup.status, 400);
  assert.match(await foreignBackup.text(), /Most nem tudjuk biztonságosan elindítani az importot/i);
  assert.equal(masterState.length, 1, "idegen mappából származó backup mellett nincs import");

  const legacyManualBackup = await importRequest("execute", fixture, planHash, env, "test-backup");
  assert.equal(legacyManualBackup.status, 400);
  assert.match(await legacyManualBackup.text(), /Most nem tudjuk biztonságosan elindítani az importot/i);
  assert.equal(masterState.length, 1, "normál import kézi backup-ID-val sem írhat");

  const deniedEmergencyOverride = await emergencyImportRequest(planHash);
  assert.equal(deniedEmergencyOverride.status, 400);
  assert.match(await deniedEmergencyOverride.text(), /Most nem tudjuk biztonságosan elindítani az importot/i);
  assert.equal(masterState.length, 1, "a kézi vészfelülbírálás külön admin token nélkül sem írhat");

  backupCandidates = ["test-backup-corrupt"];
  const executed = await importRequest("execute", fixture, planHash);
  assert.equal(executed.status, 200);
  const executedHtml = await executed.text();
  assert.match(executedHtml, /1 új jelentkezés bekerült/);
  assert.match(executedHtml, /e-mailt sem küldtünk/i);
  assert.doesNotMatch(executedHtml.match(/<main>([\s\S]*?)<\/main>/)?.[1] || "", /Drive-backup|terv hash|Brevo/i);
  assert.deepEqual(backupSlotMasterState, [masterHeader],
    "az automatikusan frissített backupnak az import előtti főlapot kell megőriznie");
  assert.deepEqual(backupSlotEmailState, [[...EMAIL_OUTPUT_HEADERS]],
    "az automatikusan frissített backupnak az import előtti e-mail-lapot kell megőriznie");
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
  assert.equal(syncPreviewResult.added_columns.length, 1, "csak a hiányzó első tandíjfizetési dátumot tervezi");
  assert.equal(syncPreviewResult.synced_columns.length, 9, "az előnézet megmutatja a szűk írási engedélylistát");
  assert.equal(syncPreviewResult.new_row_columns.length, 9,
    "az új sorokon az azonosító alapmezők és az első tandíjdátum tölthető ki");
  assert.deepEqual(syncPreviewResult.existing_row_columns, ["I. féléves tandíjfizetés dátuma"],
    "meglévő soron más mező nem írható");
  assert.deepEqual(syncPreviewResult.conditional_columns, ["I. féléves tandíjfizetés dátuma"],
    "az előnézet jelzi a csak üres célcellába írható oszlopot");
  assert.equal(staffState.length, 1, "az előnézet nem ír a munkatársi Sheetbe");

  const syncLocked = await syncRequest({ mode: "execute", plan_hash: syncPreviewResult.plan_hash }, { ...env, RECOVERY_MAINTENANCE_MODE: "on" });
  assert.equal(syncLocked.status, 503, "a karbantartási zár az execute módot megállítja");
  assert.equal(staffState.length, 1);

  const staleSyncBackup = await syncRequest({
    mode: "execute", plan_hash: syncPreviewResult.plan_hash, backup_id: "test-staff-backup-stale",
  });
  assert.equal(staleSyncBackup.status, 500, "régi munkatársi Sheet backup mellett nincs írás");
  assert.equal(staffState.length, 1);

  const mismatchingSyncBackup = await syncRequest({
    mode: "execute", plan_hash: syncPreviewResult.plan_hash, backup_id: "test-staff-backup-mismatch",
  });
  assert.equal(mismatchingSyncBackup.status, 500, "eltérő munkatársi Sheet backup mellett nincs írás");
  assert.equal(staffState.length, 1);

  const syncExecuted = await syncRequest({
    mode: "execute", plan_hash: syncPreviewResult.plan_hash, backup_id: "test-staff-backup",
  });
  assert.equal(syncExecuted.status, 200);
  const syncExecutedResult = await syncExecuted.json();
  assert.equal(syncExecutedResult.created, 1);
  assert.equal(staffState[1][0], "TEST-CODEX-20260723-001");
  assert.equal(staffState[1][5], "Codex Teszt Dami");
  assert.deepEqual(staffState[0].slice(8, 9), [
    "I. féléves tandíjfizetés dátuma",
  ], "a végrehajtás csak az engedélyezett szinkronoszlopot hozza létre");

  staffState[1][8] = "2026-08-31";
  staffState[0][9] = "Egyéb megjegyzés";
  staffState[1][1] = "Munkatársi tanfolyamnév";
  staffState[1][9] = "Munkatársi megjegyzés";
  masterState[1][10] = "2026-09-01";
  staffBackupState = staffState.map((row) => [...row]);
  const preservedPaymentPreview = await syncRequest({ mode: "preview" });
  const preservedPaymentResult = await preservedPaymentPreview.json();
  assert.equal(preservedPaymentResult.updated, 0,
    "a kitöltött munkatársi I oszlop eltérése nem lehet felülírandó frissítés");
  assert.equal(staffState[1][8], "2026-08-31");
  assert.equal(staffState[1][1], "Munkatársi tanfolyamnév");
  assert.equal(staffState[1][9], "Munkatársi megjegyzés");

  staffState[1][8] = "";
  staffBackupState = staffState.map((row) => [...row]);
  const fillPaymentPreview = await syncRequest({ mode: "preview" });
  const fillPaymentResult = await fillPaymentPreview.json();
  assert.equal(fillPaymentResult.updated, 1,
    "az üres munkatársi I oszlop kitöltése jelenjen meg az előnézetben");
  const fillPaymentExecution = await syncRequest({
    mode: "execute", plan_hash: fillPaymentResult.plan_hash, backup_id: "test-staff-backup",
  });
  assert.equal(fillPaymentExecution.status, 200);
  assert.equal(staffState[1][8], "2026-09-01",
    "az üres munkatársi I oszlop megkapja a fő Sheet dátumát");
  assert.equal(staffState[1][1], "Munkatársi tanfolyamnév",
    "a feltételes I-frissítés nem írhatja át a meglévő alapmezőket");
  assert.equal(staffState[1][9], "Munkatársi megjegyzés",
    "a feltételes I-frissítés nem írhatja át az Egyéb megjegyzést");

  staffState.push(["TEST-CODEX-STALE-001", "Régi", "sor"]);
  staffBackupState = staffState.map((row) => [...row]);
  const staleSyncPreview = await syncRequest({ mode: "preview" });
  assert.equal(staleSyncPreview.status, 200);
  const staleSyncPreviewResult = await staleSyncPreview.json();
  assert.equal(staleSyncPreviewResult.deleted, 0, "a munkatársi szinkron nem tervezhet sortörlést");
  assert.deepEqual(staleSyncPreviewResult.staff_only_entry_ids, ["TEST-CODEX-STALE-001"],
    "a preview figyelmeztetésként mutatja a csak munkatársi lapon lévő ID-t");
  assert.equal(staffState.length, 3, "a preview törlésmentes");
  const preserveStaffOnly = await syncRequest({
    mode: "execute", plan_hash: staleSyncPreviewResult.plan_hash, backup_id: "test-staff-backup",
  });
  assert.equal(preserveStaffOnly.status, 200);
  assert.equal(staffState.length, 3);
  const ignoredDeleteRequest = await syncRequest({
    mode: "execute", plan_hash: staleSyncPreviewResult.plan_hash, backup_id: "test-staff-backup", allow_deletes: true,
  });
  assert.equal(ignoredDeleteRequest.status, 200);
  assert.equal(staffState.length, 3, "még egy régi allow_deletes kérés sem törölhet munkatársi sort");
  assert.equal(staffState.some((row) => row[0] === "TEST-CODEX-STALE-001"), true);

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
  assert.match(await freshOnly.text(), /1 új jelentkezést találtunk/);
  assert.equal(masterState.length, 2, "a részleges CSV előnézete sem írhat");

  const repeated = await importRequest("plan", fixture);
  assert.equal(repeated.status, 200);
  assert.match(await repeated.text(), /Nincs új jelentkezés ebben a fájlban/);
  assert.equal(masterState.length, 2, "ismételt teljes import nem írhat");

  const changed = await importRequest("plan", fixture.replace("1111 Budapest, Teszt utca 1.", "2222 Budapest, Módosított utca 2."));
  assert.equal(changed.status, 200, "a létező ID eltérő adatával is csak kihagyás történik");
  assert.match(await changed.text(), /1 jelentkezés már szerepel a táblázatban/);
  partialFilter = true;
  const filtered = await importRequest("plan", fixture);
  assert.equal(filtered.status, 400);
  assert.match(await filtered.text(), /szűrés vagy rendezés/i);
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

async function syncRequest(payload, selectedEnv = env) {
  return worker.fetch(new Request("https://example.test/sync/test-sync-token", {
    method: "POST", body: JSON.stringify({ pipeline_id: pipeline.pipeline_id, ...payload }),
  }), selectedEnv);
}

function stateForRead(url) {
  if (url.includes("test-staff-backup-mismatch")) return [[...masterHeader.slice(0, 8)], ["TEST-CODEX-BACKUP-MISMATCH"]];
  if (url.includes("test-staff-backup")) return staffBackupState;
  if (url.includes("test-backup-slot")) {
    return url.includes("E-mail kimenet") ? backupSlotEmailState : backupSlotMasterState;
  }
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
