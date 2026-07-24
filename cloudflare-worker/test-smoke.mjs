import assert from "node:assert/strict";
import fs from "node:fs/promises";
import worker, {
  CSV_HEADERS,
  parseCsv,
  parseCsvRegistrations,
} from "./src/worker.js";

const fixture = await fs.readFile(
  new URL("./test-fixtures/dami-registration.csv", import.meta.url),
  "utf8",
);

const serviceAccount = await createTestServiceAccount();
const pipeline = {
  pipeline_id: "tanctanfolyam_jelentkezes",
  adapter: "dance_course_registration",
  spreadsheet_id: "test-spreadsheet",
  tab_name: " TAGOK I FÉLÉV",
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
};

const sheetState = [
  ["Közlemény", "Tanfolyam neve", "Nap és terem", "Óra ideje", "Táncpedagógusok", "Jelentkező (növendék) neve", "Jelentkezés ideje", "Tanfolyamon részvétel kezdete / naptár", "Próbaórára jelentkezés", "I", "J", "K", "L", "Születési dátum", "Lakcím", "Telefon", "E-mail cím", "Törvényes képviselő, szülő neve", "Kerület Kártya száma", "Kerület Kártya lejárati dátuma", "Kerület Kártya fotója", "Testvér neve", "Testvér csoportja", "Rendelkezik jóváírható összeggel", "Számlázási adatok", "Számlázási email"],
];
const staffState = [
  ["Közlemény", "Tanfolyam", "Nap és terem", "Óra ideje", "Táncpedagógusok", "Jelentkező (növendék) neve", "Jelentkezés ideje", "Tanfolyamon részvétel kezdete / naptár"],
];

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  if (url === "https://oauth2.googleapis.com/token") {
    return new Response(JSON.stringify({ access_token: "test-access-token" }), { status: 200 });
  }
  if (url.includes("/values:batchUpdate")) {
    const body = JSON.parse(options.body);
    const state = url.includes("test-staff-spreadsheet") ? staffState : sheetState;
    for (const item of body.data) applyRange(item.range, item.values[0], state);
    return new Response(JSON.stringify({ totalUpdatedCells: body.data.length }), { status: 200 });
  }
  if (url.includes("test-staff-spreadsheet:batchUpdate")) {
    const body = JSON.parse(options.body);
    for (const request of body.requests) {
      const range = request.deleteDimension.range;
      staffState.splice(range.startIndex, range.endIndex - range.startIndex);
    }
    return new Response(JSON.stringify({ replies: [] }), { status: 200 });
  }
  if (url.includes("test-staff-spreadsheet?fields=")) {
    return new Response(JSON.stringify({ sheets: [{ properties: { sheetId: 42, title: "TAGOK 2026-27" } }] }), { status: 200 });
  }
  if (url.includes("/values/")) {
    return new Response(JSON.stringify({ values: url.includes("test-staff-spreadsheet") ? staffState : sheetState }), { status: 200 });
  }
  return originalFetch(input, options);
};

try {
  const parsed = parseCsv(fixture);
  assert.deepEqual(parsed[0]["Bejegyzés azonosító"], "TEST-CODEX-20260723-001");
  assert.equal(CSV_HEADERS.length, 28);
  const registrations = parseCsvRegistrations(parsed);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].row.length, 25);
  assert.equal(registrations[0].row[0], "MODERN TÁNC 10-14 ÉVES /SZERDA BERCZIK TEREM/17.00-18.00/TEST TANÁR");

  const health = await worker.fetch(new Request("https://example.test/healthz"), env);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

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

  sheetState[1][9] = "KEEP-I";
  sheetState[1][10] = "KEEP-J";
  sheetState[1][11] = "KEEP-K";
  sheetState[1][12] = "KEEP-L";
  const changedFixture = fixture.replace("1111 Budapest, Teszt utca 1.", "2222 Budapest, Módosított utca 2.");
  const form2 = new FormData();
  form2.append("file", new Blob([changedFixture], { type: "text/csv" }), "dami-registration.csv");
  const second = await worker.fetch(new Request("https://example.test/import/test-import-token", { method: "POST", body: form2 }), env);
  assert.equal(second.status, 200);
  assert.match(await second.text(), /Új: 0/);
  assert.equal(sheetState.length, 2);
  assert.equal(sheetState[1][14], "2222 Budapest, Módosított utca 2.");
  assert.deepEqual(sheetState[1].slice(9, 13), ["KEEP-I", "KEEP-J", "KEEP-K", "KEEP-L"]);

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
    }),
  }), env);
  assert.equal(webhook.status, 200);
  assert.equal(sheetState[2][1], "MODERN TÁNC 10-14 ÉVES /SZERDA BERCZIK TEREM/17.00-18.00/TEST TANÁR");
  assert.equal(sheetState[2][5], "Codex Webhook Teszt");
  assert.equal(sheetState[2][0], "TEST-WEBHOOK-001");
  assert.equal(staffState[2][0], "TEST-WEBHOOK-001");

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

  console.log("Cloudflare Worker CSV/webhook smoke tests passed.");
} finally {
  globalThis.fetch = originalFetch;
}

function applyRange(range, values, state) {
  const match = range.match(/!([A-Z]+)(\d+):([A-Z]+)\d+$/);
  assert.ok(match, `Unexpected range: ${range}`);
  const startColumn = columnNumber(match[1]);
  const rowIndex = Number(match[2]) - 1;
  while (state.length <= rowIndex) state.push([]);
  const row = state[rowIndex];
  values.forEach((value, offset) => { row[startColumn + offset] = value; });
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
