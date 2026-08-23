import assert from "node:assert/strict";
import fs from "node:fs/promises";
import * as XLSX from "xlsx";
import worker, {
  CSV_HEADERS,
  EMAIL_EVENT_LOG_HEADERS,
  EMAIL_OUTPUT_HEADERS,
  buildApprovedCorrections,
  emailRevisionHashFromRow,
  extractReferences,
  nameSuggestions,
  parseCsv,
  parseCsvRegistrations,
  partitionManualImportRegistrations,
  paymentFromRow,
} from "./src/worker.js";
import { TEMPLATE_VERSION, brevoTemplateDefinitions, emailSettingsSheetRows } from "./src/email-templates.js";

const fixture = await fs.readFile(
  new URL("./test-fixtures/dami-registration.csv", import.meta.url),
  "utf8",
);
const paymentFixture = await fs.readFile(
  new URL("./test-fixtures/minta-banki-kivonat.xlsx", import.meta.url),
);
const paymentFixtureRun1 = await fs.readFile(
  new URL("./test-fixtures/minta-banki-kivonat-2-run1.xlsx", import.meta.url),
);
const paymentFixtureRun2 = await fs.readFile(
  new URL("./test-fixtures/minta-banki-kivonat-2-run2.xlsx", import.meta.url),
);
const paymentFixtureRun3 = await fs.readFile(
  new URL("./test-fixtures/minta-banki-kivonat-2-run3-reset.xlsx", import.meta.url),
);

const serviceAccount = await createTestServiceAccount();
const pipeline = {
  pipeline_id: "tanctanfolyam_jelentkezes",
  adapter: "dance_course_registration",
  spreadsheet_id: "test-spreadsheet",
  tab_name: " TAGOK I FÉLÉV",
  email_automation: false,
  staff_target: {
    spreadsheet_id: "test-staff-spreadsheet",
    tab_name: "TAGOK 2026-27",
  },
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
};

const sheetState = [
  ["Közlemény", "Tanfolyam neve", "Nap és terem", "Óra ideje", "Táncpedagógusok", "Jelentkező (növendék) neve", "Jelentkezés ideje", "Tanfolyamon részvétel kezdete / naptár", "Próbaórára jelentkezés", "I. féléves tandíj", "I. féléves tandíjfizetés dátuma", "I. tagsági kiállítva", "Egyéb megjegyzés", "Más óraszámban jár", "Születési dátum", "Lakcím", "Telefon", "E-mail cím", "Törvényes képviselő, szülő neve", "Kerület Kártya száma", "Kerület Kártya lejárati dátuma", "Kerület Kártya fotója", "Testvér neve", "Testvér csoportja", "Rendelkezik jóváírható összeggel", "Számlázási adatok", "Számlázási email", "II. féléves tandíj befizetés dátuma"],
];
const staffState = [
  ["Közlemény", "Tanfolyam", "Nap és terem", "Óra ideje", "Táncpedagógusok", "Jelentkező (növendék) neve", "Jelentkezés ideje", "Tanfolyamon részvétel kezdete / naptár", "Belső megjegyzés"],
];
const paymentLogState = [["Forrásazonosító", "Könyvelési dátum", "Összeg", "Deviza", "Feladó neve", "Feladó számlaszáma", "Eredeti közlemény", "Kinyert közleményjelöltek", "Párosított közlemény", "Státusz", "Feldolgozva"]];
const paymentPendingState = [["Forrásazonosító", "Könyvelési dátum", "Összeg", "Deviza", "Feladó neve", "Feladó számlaszáma", "Eredeti közlemény", "Javaslatok", "Kézzel hozzárendelt közlemény", "Státusz", "Feldolgozva"]];
const paymentStateState = [];
const referenceCorrectionsState = [];

// Elszigetelt második banki-import fixture-sorozat (kumulatív import,
// vízjel-reset, jóváhagyott korrekció, névi megerősítés teszteléséhez).
const PAYMENT_STATE_HEADERS_TEST = [
  "Utolsó import ideje", "Fájl sorainak száma", "Feldolgozott új sorok",
  "Utolsó tranzakcióazonosító", "Legkésőbbi könyvelési dátum", "Utolsó sorok ujjlenyomata",
];
const REFERENCE_CORRECTION_HEADERS_TEST = [
  "Hibás közlemény", "Valódi közlemény", "Hibás levél címzettje", "Növendék", "Szülő / kapcsolattartó",
  "Forrás sor", "E-mail kimenet sora", "Állapot", "Indok", "Feldolgozható", "Megjegyzés", "Frissítve",
];
const pipeline2 = {
  pipeline_id: "tanctanfolyam_jelentkezes",
  adapter: "dance_course_registration",
  spreadsheet_id: "test-payments-spreadsheet-2",
  tab_name: " TAGOK I FÉLÉV",
  email_automation: false,
};
const sheetState2 = [
  [...sheetState[0]],
  paymentMasterRow2("5551", "Fehér Dóra", "Fehér Katalin"),
  paymentMasterRow2("5552", "Duplikátum Teszt", "Duplikátum Szülő"),
  paymentMasterRow2("5553", "Palkó Réka", "Palkó Anna"),
  paymentMasterRow2("5554", "Szabó Márk", "Szabó Éva"),
  paymentMasterRow2("5556", "Varga Léna", "Nagy Ilona"),
  paymentMasterRow2("5557", "Kovács Bendegúz", "Kovács Réka"),
  paymentMasterRow2("5558", "Tóth Ambrus", "Tóth Béla"),
  paymentMasterRow2("5559", "Kis Eszter", "Kis Anna"),
];
const paymentLogState2 = [[...paymentLogState[0]]];
const paymentPendingState2 = [[...paymentPendingState[0]]];
const paymentStateState2 = [];
const referenceCorrectionsState2 = [
  [...REFERENCE_CORRECTION_HEADERS_TEST],
  ["8888", "5554", "", "", "", "", "", "JAVASOLT", "", true, "", ""],
  ["7777", "5551", "", "", "", "", "", "JAVASOLT", "", false, "", ""],
  ["6666", "5551", "", "", "", "", "", "JAVASOLT", "", true, "", ""],
  ["6666", "5552", "", "", "", "", "", "JAVASOLT", "", true, "", ""],
];
let masterColumnCount2 = 44;
const driveFileContents = new Map([
  ["test-payment-file", paymentFixture],
  ["folder-file-new", paymentFixtureRun1],
  ["folder-file-old", paymentFixture],
  ["test-payment-file-2", paymentFixtureRun1],
]);
const driveMediaFetches = [];
const driveFolderListRequests = [];
const automationConfigState = [[
  "Tanfolyam kulcs", "GF pontos érték / alias", "Nap", "Kezdés", "Befejezés", "Helyszín", "Tanár", "Heti alkalom", "Perc/alkalom", "Díjkategória", "Kézi elbírálás",
  "", "Félév", "Sáv kezdete", "Sáv vége", "Díjkategória", "Alapár", "Kedvezményes ár", "", "Tanfolyam kulcs", "Dátum", "Típus", "Kezdés", "Befejezés", "Helyszín",
], [
  "TESZT TÁNC", "TESZT TÁNC/PÉNTEK HAJÓS TEREM/17.00-18.00/TESZT TANÁR", "PÉNTEK", "17:00", "18:00", "Hajós terem", "Teszt Tanár", 1, 60, "1x60", false,
  "", 1, "2026-09-03", "2026-09-30", "1x60", 43000, 40850,
]];
const emailOutputState = [[...EMAIL_OUTPUT_HEADERS]];
const emailEventLogState = [[...EMAIL_EVENT_LOG_HEADERS]];
const emailSettingsState = emailSettingsSheetRows();
let masterColumnCount = 44;
let staffColumnCount = 9;
let nextTemplateId = 101;
let emailStatusFormatRequest = null;
let hasReferenceCorrectionsSheet = false;
for (const row of emailSettingsState) {
  if (String(row[0] || "").startsWith("TEMPLATE_")) row[1] = nextTemplateId++;
}

const originalFetch = globalThis.fetch;
const brevoRequests = [];
const templateDefinitionsById = new Map();
for (const row of emailSettingsState) {
  if (!String(row[0] || "").startsWith("TEMPLATE_")) continue;
  const key = String(row[0]).slice("TEMPLATE_".length);
  templateDefinitionsById.set(Number(row[1]), brevoTemplateDefinitions().find((item) => item.key === key));
}
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  const decodedUrl = decodeURIComponent(url);
  if (url === "https://oauth2.googleapis.com/token") {
    return new Response(JSON.stringify({ access_token: "test-access-token" }), { status: 200 });
  }
  if (url === "https://api.brevo.com/v3/smtp/email") {
    brevoRequests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ messageId: "test-brevo-message-id" }), { status: 201 });
  }
  if (url.startsWith("https://api.brevo.com/v3/smtp/templates/")) {
    const id = Number(url.split("/").pop());
    const definition = templateDefinitionsById.get(id);
    return definition
      ? new Response(JSON.stringify({ id, isActive: true, subject: definition.subject, htmlContent: definition.htmlContent }), { status: 200 })
      : new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
  }
  if (url.includes("/values:batchUpdate")) {
    const body = JSON.parse(options.body);
    for (const item of body.data) applyRange(item.range, item.values[0], stateForRange(item.range, url));
    return new Response(JSON.stringify({ totalUpdatedCells: body.data.length }), { status: 200 });
  }
  if (url.includes("test-payments-spreadsheet-2:batchUpdate")) {
    const body = JSON.parse(options.body);
    for (const request of body.requests) {
      if (request.appendDimension?.dimension === "COLUMNS") masterColumnCount2 += request.appendDimension.length;
    }
    return new Response(JSON.stringify({ replies: [] }), { status: 200 });
  }
  if (url.includes("test-staff-spreadsheet:batchUpdate")) {
    const body = JSON.parse(options.body);
    for (const request of body.requests) {
      if (request.deleteDimension) {
        const range = request.deleteDimension.range;
        staffState.splice(range.startIndex, range.endIndex - range.startIndex);
      }
      if (request.appendDimension?.dimension === "COLUMNS") {
        staffColumnCount += request.appendDimension.length;
      }
    }
    return new Response(JSON.stringify({ replies: [] }), { status: 200 });
  }
  if (url.includes("test-spreadsheet:batchUpdate")) {
    const body = JSON.parse(options.body);
    for (const request of body.requests) {
      if (request.appendDimension?.sheetId === 1 && request.appendDimension.dimension === "COLUMNS") {
        masterColumnCount += request.appendDimension.length;
      }
      if (request.addConditionalFormatRule || request.updateConditionalFormatRule) {
        emailStatusFormatRequest = request;
      }
      if (request.addSheet?.properties?.title === "Közlemény eltérések") {
        hasReferenceCorrectionsSheet = true;
      }
    }
    return new Response(JSON.stringify({ replies: [] }), { status: 200 });
  }
  if (url.includes("test-staff-spreadsheet?fields=")) {
    return new Response(JSON.stringify({ sheets: [{ properties: { sheetId: 42, title: "TAGOK 2026-27", gridProperties: { columnCount: staffColumnCount } } }] }), { status: 200 });
  }
  if (url.includes("test-payments-spreadsheet-2?fields=")) {
    return new Response(JSON.stringify({ sheets: [
      { properties: { sheetId: 20, title: " TAGOK I FÉLÉV", gridProperties: { columnCount: masterColumnCount2 } } },
      { properties: { sheetId: 21, title: "Befizetések napló" } },
      { properties: { sheetId: 22, title: "Függő befizetések" } },
      { properties: { sheetId: 23, title: "Befizetés import állapot" } },
      { properties: { sheetId: 24, title: "Közlemény eltérések" } },
    ] }), { status: 200 });
  }
  if (url.includes("test-spreadsheet?fields=")) {
    return new Response(JSON.stringify({ sheets: [
      { properties: { sheetId: 1, title: " TAGOK I FÉLÉV", gridProperties: { columnCount: masterColumnCount } } },
      { properties: { sheetId: 2, title: "Befizetések napló" } },
      { properties: { sheetId: 3, title: "Függő befizetések" } },
      { properties: { sheetId: 4, title: "Automata kalk" } },
      { properties: { sheetId: 5, title: "E-mail kimenet" } },
      { properties: { sheetId: 6, title: "E-mail beállítások" } },
      { properties: { sheetId: 7, title: "E-mail eseménynapló" } },
      { properties: { sheetId: 9, title: "Befizetés import állapot" } },
      ...(hasReferenceCorrectionsSheet ? [{ properties: { sheetId: 8, title: "Közlemény eltérések" } }] : []),
    ] }), { status: 200 });
  }
  if (url.includes(":append")) {
    const body = JSON.parse(options.body);
    const range = decodedUrl.split("/values/")[1].split(":append")[0];
    stateForRange(range, url).push(...body.values);
    return new Response(JSON.stringify({ updates: { updatedRows: body.values.length } }), { status: 200 });
  }
  if (url.includes("www.googleapis.com/drive/v3/files?q=")) {
    driveFolderListRequests.push(url);
    return new Response(JSON.stringify({ files: [
      { id: "folder-file-new", name: "minta-banki-kivonat-2-run1.xlsx", modifiedTime: "2026-08-20T00:00:00.000Z" },
      { id: "folder-file-old", name: "minta-banki-kivonat.xlsx", modifiedTime: "2026-01-01T00:00:00.000Z" },
    ] }), { status: 200 });
  }
  const driveMediaMatch = url.match(/drive\/v3\/files\/([^/?]+)\?alt=media/);
  if (driveMediaMatch) {
    const fileId = decodeURIComponent(driveMediaMatch[1]);
    driveMediaFetches.push(fileId);
    const content = driveFileContents.get(fileId);
    return content ? new Response(content, { status: 200 }) : new Response("", { status: 404 });
  }
  if (url.includes("/values/")) {
    const rangePart = decodedUrl.split("/values/")[1];
    const rows = stateForRange(decodedUrl, url);
    return new Response(JSON.stringify({ values: sliceRangeRows(rangePart, rows) }), { status: 200 });
  }
  return originalFetch(input, options);
};

try {
  const parsed = parseCsv(fixture);
  assert.deepEqual(parsed[0]["Bejegyzés azonosító"], "TEST-CODEX-20260723-001");
  assert.equal(CSV_HEADERS.length, 28);
  const registrations = parseCsvRegistrations(parsed);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].row.length, 26);
  assert.equal(registrations[0].row[0], "MODERN TÁNC 10-14 ÉVES /SZERDA BERCZIK TEREM/17.00-18.00/TEST TANÁR");
  assert.equal(registrations[0].trialDate, "");

  assert.deepEqual(
    partitionManualImportRegistrations(
      [["header"], ["EXISTING-IN-MASTER"]],
      [["header"], ["EXISTING-IN-EMAIL"]],
      [
        { entryId: "EXISTING-IN-MASTER" },
        { entryId: "EXISTING-IN-EMAIL" },
        { entryId: "NEW-ID" },
        { entryId: "NEW-ID" },
      ],
    ),
    {
      newRegistrations: [{ entryId: "NEW-ID" }],
      skippedRegistrations: [
        { entryId: "EXISTING-IN-MASTER" },
        { entryId: "EXISTING-IN-EMAIL" },
        { entryId: "NEW-ID" },
      ],
    },
  );

  const paymentWorkbook = XLSX.read(paymentFixture, { type: "buffer" });
  const paymentRows = XLSX.utils.sheet_to_json(paymentWorkbook.Sheets.Kivonat, { defval: "", raw: false });
  assert.equal(paymentRows.length, 5);
  const payment = await paymentFromRow(paymentRows[0], {}, 2);
  assert.equal(payment.sourceKey, "id:TX-2026-0001");
  assert.deepEqual(extractReferences("Tandíj 9000001 / 9000002, 12345678"), ["9000001", "9000002"]);
  assert.ok(extractReferences("budai táncklub tandíj 1234 18000Ft 2026-08-10").includes("1234"));

  assert.deepEqual(
    [...buildApprovedCorrections(
      [
        ["Hibás közlemény", "Valódi közlemény"],
        ["1111", "2222", "", "", "", "", "", "", "", true],
        ["3333", "4444", "", "", "", "", "", "", "", true],
        ["3333", "5555", "", "", "", "", "", "", "", true],
        ["6666", "7777", "", "", "", "", "", "", "", false],
      ],
      new Map([["2222", {}], ["4444", {}], ["5555", {}], ["7777", {}]]),
    ).entries()],
    [["1111", "2222"]],
  );
  assert.deepEqual(nameSuggestions("KISS Júlia", [
    { reference: "9000001", studentName: "Kiss Beáta", parentName: "Nagy Márta" },
    { reference: "9000002", studentName: "Kovács Lili", parentName: "Kiss János" },
  ]), [
    "Kiss Beáta (9000001) — Vezetéknév egyezik a növendék nevével",
    "Kovács Lili (9000002) — Vezetéknév egyezik a szülő/gondviselő nevével",
  ]);

  const health = await worker.fetch(new Request("https://example.test/healthz"), env);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const setup = await worker.fetch(new Request("https://example.test/emails/setup/test-email-token", {
    method: "POST", body: JSON.stringify({ pipeline_id: pipeline.pipeline_id }),
  }), env);
  assert.equal(setup.status, 200);
  assert.equal(masterColumnCount, 46);
  assert.equal(
    emailStatusFormatRequest.addConditionalFormatRule.rule.booleanRule.condition.values[0].userEnteredValue,
    '=OR($S2=TRUE,$M2="KÉZBESÍTVE",$M2="ELKÜLDVE")',
  );

  const unauthorized = await worker.fetch(new Request("https://example.test/import/wrong"), env);
  assert.equal(unauthorized.status, 404);

  const form1 = new FormData();
  form1.append("file", new Blob([fixture], { type: "text/csv" }), "dami-registration.csv");
  const first = await worker.fetch(new Request("https://example.test/import/test-import-token", { method: "POST", body: form1 }), env);
  assert.equal(first.status, 200);
  assert.match(await first.text(), /Új: 1/);
  assert.equal(sheetState.length, 2);
  assert.equal(sheetState[1][5], "Codex Teszt Dami");
  assert.equal(sheetState[1][0], "TEST-CODEX-20260723-001");
  assert.equal(staffState[1][0], "TEST-CODEX-20260723-001");
  assert.equal(staffState[1][5], "Codex Teszt Dami");

  sheetState[1][9] = "KEEP-FEE";
  sheetState[1][10] = "KEEP-PAYMENT-DATE";
  sheetState[1][11] = "KEEP-MEMBERSHIP";
  sheetState[1][12] = "KEEP-NOTE";
  sheetState[1][13] = "KEEP-ATTENDANCE";
  const changedFixture = fixture.replace("1111 Budapest, Teszt utca 1.", "2222 Budapest, Módosított utca 2.");
  const form2 = new FormData();
  form2.append("file", new Blob([changedFixture], { type: "text/csv" }), "dami-registration.csv");
  const second = await worker.fetch(new Request("https://example.test/import/test-import-token", { method: "POST", body: form2 }), env);
  assert.equal(second.status, 200);
  const secondResult = await second.text();
  assert.match(secondResult, /Új: 0/);
  assert.match(secondResult, /Kihagyva \(már létező Gravity Forms ID\): 1/);
  assert.equal(sheetState.length, 2);
  assert.equal(sheetState[1][15], "1111 Budapest, Teszt utca 1.");
  assert.deepEqual(sheetState[1].slice(9, 14), ["KEEP-FEE", "KEEP-PAYMENT-DATE", "KEEP-MEMBERSHIP", "KEEP-NOTE", "KEEP-ATTENDANCE"]);

  const incomplete = new FormData();
  incomplete.append("file", new Blob(["name,email\nDami,dummy@example.invalid\n"], { type: "text/csv" }), "bad.csv");
  const rejected = await worker.fetch(new Request("https://example.test/import/test-import-token", { method: "POST", body: incomplete }), env);
  assert.equal(rejected.status, 400);
  assert.match(await rejected.text(), /Hiányzó CSV oszlop/);

  const webhook = await worker.fetch(new Request("https://example.test/webhooks/gravity-forms", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BudaiTanc-Secret": "test-webhook-secret" },
    body: JSON.stringify({
      pipeline_id: pipeline.pipeline_id,
      entry_id: "TEST-WEBHOOK-001",
      course_name: "MODERN TÁNC 10-14 ÉVES /SZERDA BERCZIK TEREM/17.00-18.00/TEST TANÁR",
      student_name: "Codex Webhook Teszt",
      submitted_at: "2026-07-23 22:00:00",
      trial_date: "2026-09-18",
    }),
  }), env);
  assert.equal(webhook.status, 200);
  assert.equal(sheetState[2][1], "MODERN TÁNC 10-14 ÉVES /SZERDA BERCZIK TEREM/17.00-18.00/TEST TANÁR");
  assert.equal(sheetState[2][5], "Codex Webhook Teszt");
  assert.equal(sheetState[2][0], "TEST-WEBHOOK-001");
  assert.equal(sheetState[2][33], "2026-09-18");
  assert.equal(staffState[2][0], "TEST-WEBHOOK-001");

  sheetState[1][10] = "2026-09-11";
  sheetState[1][27] = "2027-02-06";
  sheetState[1][12] = "Első óra után telefonos egyeztetés kell.";
  staffState[1][8] = "Kézi belső megjegyzés";
  staffState[1][9] = "RÉGI ELSŐ FÉLÉV";
  staffState[1][10] = "RÉGI MÁSODIK FÉLÉV";
  staffState[1][11] = "RÉGI EGYÉB MEGJEGYZÉS";
  staffState.push(["ORPHAN-ROW", "Törölt", "", "", "", "", "", ""]);
  const sync = await worker.fetch(new Request("https://example.test/sync/test-sync-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pipeline_id: pipeline.pipeline_id }),
  }), { ...env, SYNC_ADMIN_TOKEN: "test-sync-token" });
  assert.equal(sync.status, 200);
  assert.deepEqual(await sync.json(), {
    status: "ok", pipeline_id: pipeline.pipeline_id, created: 0, updated: 2, deleted: 1, total: 2,
  });
  assert.equal(staffState.some((row) => row[0] === "ORPHAN-ROW"), false);
  assert.equal(staffColumnCount, 12);
  assert.equal(staffState[0][9], "I. féléves tandíjfizetés dátuma");
  assert.equal(staffState[0][10], "II. féléves tandíj befizetés dátuma");
  assert.equal(staffState[0][11], "Egyéb megjegyzés");
  assert.equal(staffState[1][8], "Kézi belső megjegyzés");
  assert.equal(staffState[1][9], "2026-09-11");
  assert.equal(staffState[1][10], "2027-02-06");
  assert.equal(staffState[1][11], "Első óra után telefonos egyeztetés kell.");

  sheetState.push(paymentMasterRow("9000001", "Kiss Beáta", "Kiss Júlia"));
  sheetState.push(paymentMasterRow("9000002", "Nagy Bence", "Nagy Béla"));
  const paymentAutomationEnv = {
    ...env,
    PIPELINES_CONFIG_JSON: JSON.stringify({ pipelines: [{ ...pipeline, email_automation: true }] }),
    PAYMENT_IMPORT_TOKEN: "test-payment-token",
    PAYMENTS_SOURCE_CONFIG_JSON: JSON.stringify({ pipeline_id: pipeline.pipeline_id, drive_file_id: "test-payment-file", sheet_name: "Kivonat" }),
  };
  const paymentImport = await worker.fetch(new Request("https://example.test/payments/test-payment-token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pipeline_id: pipeline.pipeline_id }),
  }), paymentAutomationEnv);
  assert.equal(paymentImport.status, 200);
  assert.deepEqual(await paymentImport.json(), {
    status: "ok", pipeline_id: pipeline.pipeline_id, new_transactions: 5, booked: 2, already_recorded: 0, pending: 3, duplicates: 0, manually_resolved: 0,
    corrected_booked: 0, name_confirmed: 0, total_rows: 5, new_rows: 5, skipped_by_watermark: 0, state_reset: false, payment_email_drafts: 2,
  });
  assert.equal(sheetState.find((row) => row[0] === "9000001")[10], "2026-08-10");
  assert.equal(paymentLogState.length, 6);
  assert.equal(paymentPendingState.length, 4);
  assert.match(paymentPendingState[1][7], /Kiss Beáta \(9000001\)/);
  assert.equal(emailOutputState.filter((row) => row[21] === "PAYMENT_RECEIVED").length, 2);

  paymentPendingState[1][8] = "9000002";
  const manualResolution = await worker.fetch(new Request("https://example.test/payments/test-payment-token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pipeline_id: pipeline.pipeline_id }),
  }), paymentAutomationEnv);
  assert.equal(manualResolution.status, 200);
  assert.equal((await manualResolution.json()).manually_resolved, 1);
  assert.equal(paymentPendingState[1][9], "Könyvelve kézzel");
  assert.equal(emailOutputState.filter((row) => row[21] === "PAYMENT_RECEIVED").length, 2);

  // Elszigetelt második banki-import sorozat: Drive-mappa forrás, kumulatív
  // vízjel-alapú inkrementális import, vízjel-reset, jóváhagyott korrekció és
  // névi megerősítés végponttól-végpontig.
  const folderPaymentEnv = {
    ...env,
    PIPELINES_CONFIG_JSON: JSON.stringify({ pipelines: [pipeline2] }),
    PAYMENT_IMPORT_TOKEN: "test-payment-token-2",
    PAYMENTS_SOURCE_CONFIG_JSON: JSON.stringify({ pipeline_id: pipeline2.pipeline_id, drive_folder_id: "test-folder-id", sheet_name: "Kivonat" }),
  };
  const directPaymentEnv2 = {
    ...env,
    PIPELINES_CONFIG_JSON: JSON.stringify({ pipelines: [pipeline2] }),
    PAYMENT_IMPORT_TOKEN: "test-payment-token-2",
    PAYMENTS_SOURCE_CONFIG_JSON: JSON.stringify({ pipeline_id: pipeline2.pipeline_id, drive_file_id: "test-payment-file-2", sheet_name: "Kivonat" }),
  };

  // 0. Mappa-forrás: a Drive files.list mockja két XLSX-et ad vissza eltérő
  // modifiedTime-mal — a Worker a legfrissebbet tölti le. Ez egyben a
  // sorozat első (kumulatív alap-) importja is.
  const run1Import = await worker.fetch(new Request("https://example.test/payments/test-payment-token-2", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pipeline_id: pipeline2.pipeline_id }),
  }), folderPaymentEnv);
  assert.equal(run1Import.status, 200);
  assert.ok(driveFolderListRequests.some((requestUrl) => requestUrl.includes("test-folder-id")));
  assert.equal(driveMediaFetches.at(-1), "folder-file-new");
  const run1Result = await run1Import.json();
  assert.deepEqual(run1Result, {
    status: "ok", pipeline_id: pipeline2.pipeline_id, new_transactions: 4, booked: 2, already_recorded: 0, pending: 2, duplicates: 0, manually_resolved: 0,
    corrected_booked: 0, name_confirmed: 0, total_rows: 4, new_rows: 4, skipped_by_watermark: 0, state_reset: false, payment_email_drafts: 0,
  });
  assert.equal(sheetState2.find((row) => row[0] === "5551")[10], "2026-08-01");
  assert.equal(sheetState2.find((row) => row[0] === "5552")[10], "2026-08-02");
  assert.equal(paymentStateState2[1]?.[1], 4);

  // 1. Inkrementális import: kumulatív fájl (a 4 régi + 6 új sor) — a
  // második futásnál a régiek `duplicates`-ként a vízjel miatt azonnal
  // kimaradnak, csak az új sorok futnak le ténylegesen (`new_rows`).
  // Emellett teszteli a 2., 3. és 6. pontot is: tranzakció-ID nélküli, a
  // korábbival tartalmilag azonos, valóban új sor nem vész el; a
  // jóváhagyott korrekció automatikusan könyvel; a névvel megerősített
  // egyértelmű találat is könyvel.
  driveFileContents.set("test-payment-file-2", paymentFixtureRun2);
  const run2Import = await worker.fetch(new Request("https://example.test/payments/test-payment-token-2", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pipeline_id: pipeline2.pipeline_id }),
  }), directPaymentEnv2);
  assert.equal(run2Import.status, 200);
  const run2Result = await run2Import.json();
  assert.deepEqual(run2Result, {
    status: "ok", pipeline_id: pipeline2.pipeline_id, new_transactions: 6, booked: 2, already_recorded: 1, pending: 3, duplicates: 4, manually_resolved: 0,
    corrected_booked: 1, name_confirmed: 1, total_rows: 10, new_rows: 6, skipped_by_watermark: 4, state_reset: false, payment_email_drafts: 0,
  });
  assert.equal(sheetState2.find((row) => row[0] === "5554")[10], "2026-08-16");
  assert.equal(sheetState2.find((row) => row[0] === "5556")[10], "2026-08-19");
  assert.equal(
    paymentLogState2.some((row) => row[6] === "Hivatkozás 8888" && row[8] === "5554" && row[9] === "Könyvelve javított közleménnyel"),
    true,
  );
  assert.equal(
    paymentLogState2.some((row) => row[6] === "Hivatkozás 7777" && row[9] === "Függő"),
    true,
  );
  assert.equal(
    paymentLogState2.some((row) => row[6] === "Hivatkozás 6666" && row[9] === "Függő"),
    true,
  );
  assert.equal(
    paymentLogState2.some((row) => row[6] === "5556 / 5557" && row[8] === "5556" && row[9] === "Könyvelve névvel megerősítve"),
    true,
  );
  assert.equal(
    paymentLogState2.some((row) => row[6] === "5558 / 5559" && row[9] === "Többértelmű"),
    true,
  );
  const duplicateContentLogRows = paymentLogState2.filter((row) => row[4] === "Duplikátum Küldő");
  assert.equal(duplicateContentLogRows.length, 2, "a két azonos tartalmú, tranzakció-ID nélküli sor mindegyike bekerül a naplóba");
  assert.equal(duplicateContentLogRows[1][9], "Már rögzített");
  assert.equal(paymentStateState2[1]?.[1], 10);

  // 2. Vízjel-reset: a fájl utolsó sora megváltozott (átrendezve/szerkesztve)
  // → a vízjel-ellenőrzés bukik, fallback a teljes dedupra, nincs dupla
  // könyvelés.
  driveFileContents.set("test-payment-file-2", paymentFixtureRun3);
  const run3Import = await worker.fetch(new Request("https://example.test/payments/test-payment-token-2", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pipeline_id: pipeline2.pipeline_id }),
  }), directPaymentEnv2);
  assert.equal(run3Import.status, 200);
  const run3Result = await run3Import.json();
  assert.deepEqual(run3Result, {
    status: "ok", pipeline_id: pipeline2.pipeline_id, new_transactions: 1, booked: 0, already_recorded: 0, pending: 1, duplicates: 9, manually_resolved: 0,
    corrected_booked: 0, name_confirmed: 0, total_rows: 10, new_rows: 1, skipped_by_watermark: 0, state_reset: true, payment_email_drafts: 0,
  });
  assert.equal(sheetState2.find((row) => row[0] === "5551")[10], "2026-08-01");
  assert.equal(sheetState2.find((row) => row[0] === "5556")[10], "2026-08-19");

  const readyRow = Array.from({ length: 46 }, () => "");
  readyRow[0] = "TEST-EMAIL-001";
  readyRow[1] = "TESZT TÁNC/PÉNTEK HAJÓS TEREM/17.00-18.00/TESZT TANÁR";
  readyRow[5] = "Teszt Elek";
  readyRow[6] = "2026-09-15 12:00:00";
  readyRow[8] = "nem";
  readyRow[14] = "2012-05-12";
  readyRow[17] = "recipient@example.invalid";
  readyRow[18] = "Minta Anna";
  sheetState.push(readyRow);
  const legacyManualRow = Array.from({ length: 34 }, () => "");
  legacyManualRow[0] = "LEGACY-MANUAL-001|1|2026-08-03-v1-draft";
  legacyManualRow[1] = "LEGACY-MANUAL-001";
  legacyManualRow[2] = "1";
  legacyManualRow[3] = "2026-08-03-v1-draft";
  legacyManualRow[4] = readyRow[17];
  legacyManualRow[12] = "ELKÜLDVE";
  legacyManualRow[13] = "MANUÁLIS";
  legacyManualRow[18] = true;
  emailOutputState.push(legacyManualRow);
  const legacyMasterRow = [...readyRow];
  legacyMasterRow[0] = "LEGACY-MANUAL-001";
  legacyMasterRow[8] = "igen";
  sheetState.push(legacyMasterRow);
  const drafts = await worker.fetch(new Request("https://example.test/emails/drafts/test-email-token", {
    method: "POST", body: JSON.stringify({ pipeline_id: pipeline.pipeline_id }),
  }), env);
  assert.equal(drafts.status, 200);
  const readyEmail = emailOutputState.find((row) => row[1] === "TEST-EMAIL-001");
  assert.equal(readyEmail[12], "KÜLDHETŐ");
  assert.equal(emailOutputState.filter((row) => row[1] === "LEGACY-MANUAL-001").length, 1);
  assert.equal(legacyManualRow[18], true);

  const mismatchedLegacyMasterRow = [...readyRow];
  mismatchedLegacyMasterRow[0] = "MISMATCHED-LEGACY-001";
  mismatchedLegacyMasterRow[8] = "igen";
  sheetState.push(mismatchedLegacyMasterRow);
  const actualWrongRecipientMasterRow = [...readyRow];
  actualWrongRecipientMasterRow[0] = "ACTUAL-RECIPIENT-001";
  actualWrongRecipientMasterRow[17] = "wrong-recipient@example.invalid";
  sheetState.push(actualWrongRecipientMasterRow);
  const mismatchedLegacyRow = Array.from({ length: 34 }, () => "");
  mismatchedLegacyRow[0] = "MISMATCHED-LEGACY-001|PRÓBA|2026-08-03-v1-draft";
  mismatchedLegacyRow[1] = "MISMATCHED-LEGACY-001";
  mismatchedLegacyRow[2] = "PRÓBA";
  mismatchedLegacyRow[3] = "2026-08-03-v1-draft";
  mismatchedLegacyRow[4] = "wrong-recipient@example.invalid";
  mismatchedLegacyRow[12] = "ELKÜLDVE";
  mismatchedLegacyRow[13] = "MANUÁLIS";
  mismatchedLegacyRow[18] = true;
  emailOutputState.push(mismatchedLegacyRow);
  const correctedMismatchedLegacy = await worker.fetch(new Request("https://example.test/emails/drafts/test-email-token", {
    method: "POST", body: JSON.stringify({ pipeline_id: pipeline.pipeline_id }),
  }), env);
  assert.equal(correctedMismatchedLegacy.status, 200);
  const repairedLegacyDraft = emailOutputState.find((row) => (
    row[1] === "MISMATCHED-LEGACY-001" && row[4] === readyRow[17] && row[18] !== true
  ));
  assert.ok(repairedLegacyDraft);
  assert.equal(mismatchedLegacyRow[4], "wrong-recipient@example.invalid");
  assert.equal(mismatchedLegacyRow[18], true);

  const reconciliation = await worker.fetch(new Request("https://example.test/emails/reconcile/test-email-token", {
    method: "POST", body: JSON.stringify({ pipeline_id: pipeline.pipeline_id }),
  }), env);
  assert.equal(reconciliation.status, 200);
  const reconciliationResult = await reconciliation.json();
  assert.equal(reconciliationResult.status, "ok");
  assert.equal(reconciliationResult.pipeline_id, pipeline.pipeline_id);
  assert.equal(reconciliationResult.suggested, 1);
  assert.ok(reconciliationResult.manual >= 0);
  assert.equal(reconciliationResult.sheet, "Közlemény eltérések");
  assert.deepEqual(referenceCorrectionsState[0].slice(0, 3), ["Hibás közlemény", "Valódi közlemény", "Hibás levél címzettje"]);
  const suggestedCorrection = referenceCorrectionsState.find((row) => row[0] === "MISMATCHED-LEGACY-001" && row[1] === "ACTUAL-RECIPIENT-001");
  assert.ok(suggestedCorrection, JSON.stringify(referenceCorrectionsState));
  assert.deepEqual(suggestedCorrection.slice(0, 5), [
    "MISMATCHED-LEGACY-001", "ACTUAL-RECIPIENT-001", "wrong-recipient@example.invalid", "Teszt Elek", "Minta Anna",
  ]);
  assert.equal(suggestedCorrection[7], "JAVASOLT");
  assert.match(suggestedCorrection[8], /egyértelműen másik forrásrekordhoz/i);

  const ambiguousMasterFirst = [...readyRow];
  ambiguousMasterFirst[0] = "AMBIGUOUS-ENTRY-001";
  ambiguousMasterFirst[17] = "first@example.invalid";
  const ambiguousMasterSecond = [...readyRow];
  ambiguousMasterSecond[0] = "AMBIGUOUS-ENTRY-001";
  ambiguousMasterSecond[17] = "second@example.invalid";
  sheetState.push(ambiguousMasterFirst, ambiguousMasterSecond);
  const ambiguousEmailRow = Array.from({ length: 34 }, () => "");
  ambiguousEmailRow[0] = `AMBIGUOUS-ENTRY-001|ENROLLMENT|1|${TEMPLATE_VERSION}`;
  ambiguousEmailRow[1] = "AMBIGUOUS-ENTRY-001";
  ambiguousEmailRow[4] = "first@example.invalid";
  ambiguousEmailRow[11] = true;
  ambiguousEmailRow[12] = "KÜLDHETŐ";
  emailOutputState.push(ambiguousEmailRow);
  const blockedAmbiguous = await worker.fetch(new Request("https://example.test/emails/drafts/test-email-token", {
    method: "POST", body: JSON.stringify({ pipeline_id: pipeline.pipeline_id }),
  }), env);
  assert.equal(blockedAmbiguous.status, 200);
  assert.equal(ambiguousEmailRow[11], true);
  assert.equal(ambiguousEmailRow[12], "KÜLDHETŐ");
  assert.equal(emailOutputState.filter((row) => row[1] === "AMBIGUOUS-ENTRY-001").length, 1);

  const legacyDraftRow = Array.from({ length: 34 }, () => "");
  legacyDraftRow[0] = "LEGACY-DRAFT-001|ENROLLMENT|1|2026-08-03-v1-draft";
  legacyDraftRow[1] = "LEGACY-DRAFT-001";
  legacyDraftRow[2] = "1";
  legacyDraftRow[3] = "2026-08-03-v1-draft";
  legacyDraftRow[4] = readyRow[17];
  legacyDraftRow[12] = "KÜLDHETŐ";
  emailOutputState.push(legacyDraftRow);
  const legacyDraftMasterRow = [...readyRow];
  legacyDraftMasterRow[0] = "LEGACY-DRAFT-001";
  legacyDraftMasterRow[8] = "nem";
  sheetState.push(legacyDraftMasterRow);
  const refreshedLegacyDraft = await worker.fetch(new Request("https://example.test/emails/drafts/test-email-token", {
    method: "POST", body: JSON.stringify({ pipeline_id: pipeline.pipeline_id }),
  }), env);
  assert.equal(refreshedLegacyDraft.status, 200);
  assert.equal(emailOutputState.filter((row) => row[1] === "LEGACY-DRAFT-001").length, 1);
  assert.equal(legacyDraftRow[0], `LEGACY-DRAFT-001|ENROLLMENT|1|${TEMPLATE_VERSION}`);
  readyEmail[12] = "ELKÜLDVE";
  readyEmail[13] = "MANUÁLIS";
  readyEmail[18] = true;
  readyEmail[19] = "2026-08-04 12:00:00";
  readyEmail[20] = "operator@example.invalid";
  readyRow[7] = "2026-09-18";
  const changedWhileManual = await worker.fetch(new Request("https://example.test/emails/drafts/test-email-token", {
    method: "POST", body: JSON.stringify({ pipeline_id: pipeline.pipeline_id }),
  }), env);
  assert.equal(changedWhileManual.status, 200);
  assert.equal(readyEmail[12], "ELKÜLDÉS UTÁN MÓDOSULT");
  assert.equal(readyEmail[18], true);
  assert.equal(readyEmail[19], "2026-08-04 12:00:00");
  assert.equal(readyEmail[20], "operator@example.invalid");
  readyEmail[11] = true;
  readyEmail[12] = "KÜLDHETŐ";
  const manualBlocked = await worker.fetch(new Request("https://example.test/emails/send/test-email-token", {
    method: "POST", body: JSON.stringify({ pipeline_id: pipeline.pipeline_id }),
  }), env);
  assert.equal((await manualBlocked.json()).sent, 0);
  assert.equal(brevoRequests.length, 0);
  readyEmail[18] = false;
  readyEmail[13] = "";
  readyEmail[11] = true;
  readyEmail[28] = await emailRevisionHashFromRow(readyEmail);
  const send = await worker.fetch(new Request("https://example.test/emails/send/test-email-token", {
    method: "POST", body: JSON.stringify({ pipeline_id: pipeline.pipeline_id }),
  }), env);
  assert.equal(send.status, 200);
  assert.equal((await send.json()).sent, 1);
  assert.equal(brevoRequests.length, 1);
  assert.match(brevoRequests[0].headers["Idempotency-Key"], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(brevoRequests[0].headers["X-Mailin-custom"], `send_key:${readyEmail[0]}`);
  assert.equal(typeof brevoRequests[0].templateId, "number");
  assert.equal(brevoRequests[0].params.student_full_name, "Teszt Elek");
  assert.equal(readyEmail[12], "BREVO FOGADTA");
  assert.equal(readyEmail[13], "test-brevo-message-id");
  const delivery = await worker.fetch(new Request("https://example.test/webhooks/brevo", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BudaiTanc-Brevo-Secret": "test-brevo-webhook-secret" },
    body: JSON.stringify({ event: "delivered", email: readyEmail[4], "message-id": "test-brevo-message-id", ts_event: 1786879000 }),
  }), env);
  assert.equal(delivery.status, 200);
  assert.equal((await delivery.json()).matched, true);
  assert.equal(readyEmail[12], "KÉZBESÍTVE");
  assert.equal(readyEmail[31], "KÉZBESÍTVE");
  assert.equal(emailEventLogState.length, 2);
  const duplicateSend = await worker.fetch(new Request("https://example.test/emails/send/test-email-token", {
    method: "POST", body: JSON.stringify({ pipeline_id: pipeline.pipeline_id }),
  }), env);
  assert.equal((await duplicateSend.json()).sent, 0);
  assert.equal(brevoRequests.length, 1);
  readyRow[7] = "2026-09-25";
  const changedDraft = await worker.fetch(new Request("https://example.test/emails/drafts/test-email-token", {
    method: "POST", body: JSON.stringify({ pipeline_id: pipeline.pipeline_id }),
  }), env);
  assert.equal(changedDraft.status, 200);
  assert.equal(readyEmail[12], "ELKÜLDÉS UTÁN MÓDOSULT");
  assert.equal(readyEmail[11], false);

  console.log("Cloudflare Worker CSV/webhook smoke tests passed.");
} finally {
  globalThis.fetch = originalFetch;
}

function applyRange(range, values, state) {
  const match = range.match(/!([A-Z]+)(\d+)(?::([A-Z]+)\d+)?$/);
  assert.ok(match, `Unexpected range: ${range}`);
  const startColumn = columnNumber(match[1]);
  const rowIndex = Number(match[2]) - 1;
  while (state.length <= rowIndex) state.push([]);
  const row = state[rowIndex];
  values.forEach((value, offset) => { row[startColumn + offset] = value; });
}

function stateForRange(range, url = "") {
  const value = decodeURIComponent(range);
  if (url.includes("test-payments-spreadsheet-2")) {
    if (value.includes("Befizetések napló")) return paymentLogState2;
    if (value.includes("Függő befizetések")) return paymentPendingState2;
    if (value.includes("Befizetés import állapot")) return paymentStateState2;
    if (value.includes("Közlemény eltérések")) return referenceCorrectionsState2;
    return sheetState2;
  }
  if (value.includes("Automata kalk")) return automationConfigState;
  if (value.includes("E-mail kimenet")) return emailOutputState;
  if (value.includes("E-mail beállítások")) return emailSettingsState;
  if (value.includes("E-mail eseménynapló")) return emailEventLogState;
  if (value.includes("Befizetések napló")) return paymentLogState;
  if (value.includes("Függő befizetések")) return paymentPendingState;
  if (value.includes("Befizetés import állapot")) return paymentStateState;
  if (value.includes("Közlemény eltérések")) return referenceCorrectionsState;
  return url.includes("test-staff-spreadsheet") ? staffState : sheetState;
}

function paymentMasterRow(reference, studentName, parentName) {
  const row = Array.from({ length: 46 }, () => "");
  row[0] = reference;
  row[5] = studentName;
  row[6] = "2026-08-01 10:00:00";
  row[14] = "2012-05-12";
  row[17] = `${reference}@example.invalid`;
  row[18] = parentName;
  return row;
}

function paymentMasterRow2(reference, studentName, parentName) {
  return paymentMasterRow(reference, studentName, parentName);
}

function sliceRangeRows(range, rows) {
  const match = String(range).match(/![A-Za-z]*(\d*)(?::[A-Za-z]*(\d*))?$/);
  if (!match) return rows;
  const startRow = match[1] ? Number(match[1]) : 1;
  const endRow = match[2] ? Number(match[2]) : (match[1] ? Number(match[1]) : rows.length);
  return rows.slice(startRow - 1, endRow);
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
