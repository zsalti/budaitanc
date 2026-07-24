const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const WEBHOOK_PATH = "/webhooks/gravity-forms";
const IMPORT_PATH_PREFIX = "/import/";
const TECHNICAL_ENTRY_ID_COLUMN = 25; // Z; A:Y is the visible 25-column table.

const CSV_HEADERS = [
  "Jelentkező (növendék) neve",
  "Születési dátum",
  "Lakcím",
  "Telefon",
  "E-mail cím",
  "Törvényes képviselő, szülő neve",
  "Kerület Kártya száma",
  "Kerület Kártya lejárati dátuma",
  "Kerület Kártya fotója",
  "Testvér neve",
  "Testvér csoportja",
  "Választott tanfolyam",
  "Rendelkezik jóváírható összeggel",
  "Részvétel kezdete",
  "Próba órára jelentkezés",
  "Próbaóra dátuma",
  "Kérek számlát az alábbi adatokkal",
  "Készítette: (Felhasználói Id)",
  "Bejegyzés azonosító",
  "Bejegyzés dátuma",
  "Date Updated",
  "Forrás URL",
  "Tranzakciós Id",
  "Fizetendő összeg",
  "Fizetési dátum",
  "Fizetés állapota",
  "Cikk azonosító",
  "User Agent (Felhasználói Ügynök)",
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") return json({ status: "ok" });

    const importToken = getImportToken(url.pathname);
    if (importToken !== null) {
      return handleImport(request, env, importToken);
    }

    if (url.pathname !== WEBHOOK_PATH) return json({ error: "not_found" }, 404);
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (!env.WEBHOOK_SHARED_SECRET ||
        !safeEqual(request.headers.get("X-BudaiTanc-Secret") || "", env.WEBHOOK_SHARED_SECRET)) {
      return json({ error: "unauthorized" }, 401);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return json({ error: "invalid_payload" }, 400);
    }

    try {
      const pipeline = getPipeline(env, text(payload.pipeline_id));
      const registration = registrationFromPayload(pipeline.adapter, payload);
      const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT);
      const result = await upsertRegistrations(accessToken, pipeline, [registration]);
      return json({
        status: "ok",
        pipeline_id: text(payload.pipeline_id),
        row_index: result.results[0].rowIndex,
        student_name: registration.studentName,
      });
    } catch (error) {
      console.error("Webhook processing failed", error);
      return json({ error: "processing_failed" }, 500);
    }
  },
};

async function handleImport(request, env, token) {
  if (!env.IMPORT_ADMIN_TOKEN || !safeEqual(token, env.IMPORT_ADMIN_TOKEN)) {
    return json({ error: "not_found" }, 404);
  }
  if (request.method === "GET") return html(importPage());
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file.text !== "function") {
      return html(importPage("Nem található CSV fájl.", 400), 400);
    }
    const csvText = await file.text();
    const parsed = parseCsv(csvText);
    const registrations = parseCsvRegistrations(parsed);
    const pipeline = getPipeline(env, text(form.get("pipeline_id")) || defaultPipelineId(env));
    const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT);
    const result = await upsertRegistrations(accessToken, pipeline, registrations);
    return html(importResultPage(result, registrations.length));
  } catch (error) {
    console.error("CSV import failed", error);
    return html(importPage(error.message || "Az import nem sikerült.", 400), 400);
  }
}

function getImportToken(pathname) {
  if (!pathname.startsWith(IMPORT_PATH_PREFIX)) return null;
  const token = pathname.slice(IMPORT_PATH_PREFIX.length).replace(/\/$/, "");
  return token || null;
}

function defaultPipelineId(env) {
  const pipelines = parsePipelines(env.PIPELINES_CONFIG_JSON);
  const ids = Object.keys(pipelines);
  if (ids.length !== 1) throw new Error("A pipeline_id mező kötelező több pipeline esetén.");
  return ids[0];
}

function getPipeline(env, pipelineId) {
  const pipelines = parsePipelines(env.PIPELINES_CONFIG_JSON);
  const pipeline = pipelines[pipelineId];
  if (!pipeline) throw new Error(`Ismeretlen pipeline: ${pipelineId || "(üres)"}`);
  return pipeline;
}

function parsePipelines(rawConfig) {
  if (!rawConfig) throw new Error("Missing PIPELINES_CONFIG_JSON");
  const parsed = JSON.parse(rawConfig);
  const list = Array.isArray(parsed) ? parsed : parsed.pipelines;
  if (!Array.isArray(list)) throw new Error("Invalid pipeline config");
  return Object.fromEntries(list.map((pipeline) => {
    if (!pipeline.pipeline_id || !pipeline.adapter || !pipeline.spreadsheet_id || !pipeline.tab_name) {
      throw new Error("Pipeline is missing a required field");
    }
    return [pipeline.pipeline_id, pipeline];
  }));
}

function parseCsv(csvText) {
  const textValue = csvText.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < textValue.length; i += 1) {
    const char = textValue[i];
    const next = textValue[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  if (quoted) throw new Error("A CSV idézőjelei hibásak.");
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) throw new Error("A CSV üres.");

  const header = rows[0].map((value) => value.trim());
  const missing = CSV_HEADERS.filter((name) => !header.includes(name));
  if (missing.length) throw new Error(`Hiányzó CSV oszlop(ok): ${missing.join(", ")}`);
  return rows.slice(1).filter((values) => values.some((value) => value.trim())).map((values, index) => {
    const record = Object.fromEntries(header.map((name, column) => [name, values[column] || ""]));
    record.__row = index + 2;
    return record;
  });
}

function parseCsvRegistrations(rows) {
  const errors = [];
  const registrations = [];
  for (const row of rows) {
    try { registrations.push(registrationFromCsvRow(row)); }
    catch (error) { errors.push(`CSV ${row.__row}: ${error.message}`); }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  if (!registrations.length) throw new Error("A CSV nem tartalmaz adat-sort.");
  return registrations;
}

function registrationFromCsvRow(row) {
  const courseName = text(row["Választott tanfolyam"]);
  const course = parseCourse(courseName);
  const studentName = text(row["Jelentkező (növendék) neve"]);
  const submittedAt = text(row["Bejegyzés dátuma"]);
  const entryId = text(row["Bejegyzés azonosító"]);
  if (!studentName || !submittedAt || !entryId || !courseName) {
    throw new Error("Kötelező: név, tanfolyam, bejegyzés azonosító és bejegyzés dátuma.");
  }
  return {
    entryId,
    studentName,
    submittedAt,
    row: [
      courseName, course.venue, course.time, course.teacher, studentName, submittedAt,
      text(row["Részvétel kezdete"]), normalizeTrial(row["Próba órára jelentkezés"]),
      "", "", "", "", text(row["Születési dátum"]), text(row["Lakcím"]), text(row["Telefon"]),
      text(row["E-mail cím"]), text(row["Törvényes képviselő, szülő neve"]), text(row["Kerület Kártya száma"]),
      text(row["Kerület Kártya lejárati dátuma"]), text(row["Kerület Kártya fotója"]), text(row["Testvér neve"]),
      text(row["Testvér csoportja"]), text(row["Rendelkezik jóváírható összeggel"]), parseBilling(row["Kérek számlát az alábbi adatokkal"])[0],
      parseBilling(row["Kérek számlát az alábbi adatokkal"])[1],
    ],
  };
}

function registrationFromPayload(adapter, payload) {
  if (adapter !== "dance_course_registration") throw new Error(`Unsupported adapter: ${adapter}`);
  const courseName = text(payload.course_name);
  const course = parseCourse(courseName || [text(payload.venue), text(payload.time), text(payload.teacher)].join("/"));
  const studentName = text(payload.student_name);
  const submittedAt = text(payload.submitted_at);
  if (!studentName || !submittedAt) throw new Error("Webhook payloadból hiányzik a név vagy a beküldési idő.");
  return {
    entryId: text(payload.entry_id), studentName, submittedAt,
    row: [courseName, course.venue || text(payload.venue), course.time || text(payload.time), course.teacher || text(payload.teacher), studentName, submittedAt,
      text(payload.start_date), normalizeTrial(payload.trial_signup), "", "", "", "", text(payload.birth_date), text(payload.address), text(payload.phone),
      text(payload.email), text(payload.parent_name), text(payload.district_card_number), text(payload.district_card_expiry), text(payload.district_card_photo),
      text(payload.sibling_name), text(payload.sibling_group), text(payload.carryover_amount), text(payload.billing_address), text(payload.billing_email)],
  };
}

function parseCourse(raw) {
  const parts = text(raw).split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 4) throw new Error(`Érvénytelen tanfolyam: ${raw}`);
  return { venue: parts[1], teacher: parts[parts.length - 1], time: parts.slice(2, -1).join(", ").replace(" ÉS PÉNTEK ", ", PÉNTEK ") };
}

function parseBilling(raw) {
  const lines = text(raw).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return [lines[0] || "", ""];
  return [lines.slice(0, -1).join(" | "), lines[lines.length - 1]];
}

async function upsertRegistrations(accessToken, pipeline, registrations) {
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(pipeline.spreadsheet_id)}`;
  const readRange = encodeURIComponent(`${quoteSheetName(pipeline.tab_name)}!A:Z`);
  const current = await googleFetch(`${baseUrl}/values/${readRange}`, accessToken);
  const rows = current.values || [];
  const mutableRows = rows.map((row) => [...row]);
  const results = [];
  const data = [];

  for (const registration of registrations) {
    const rowIndex = findTargetRow(mutableRows, registration);
    while (mutableRows.length < rowIndex) mutableRows.push([]);
    const existing = mutableRows[rowIndex - 1] || [];
    const merged = mergeRow(existing, registration);
    mutableRows[rowIndex - 1] = merged;
    data.push({ range: `${quoteSheetName(pipeline.tab_name)}!A${rowIndex}:H${rowIndex}`, values: [merged.slice(0, 8)] });
    data.push({ range: `${quoteSheetName(pipeline.tab_name)}!M${rowIndex}:Z${rowIndex}`, values: [merged.slice(12, 26)] });
    results.push({ rowIndex, type: existing[4] ? "updated" : "created", studentName: registration.studentName });
  }

  await googleFetch(`${baseUrl}/values:batchUpdate`, accessToken, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "RAW", data }),
  });
  return { results };
}

function mergeRow(existing, registration) {
  const merged = Array.from({ length: 26 }, (_, index) => existing[index] || "");
  registration.row.forEach((value, index) => { if (index < 8 || index >= 12) merged[index] = value; });
  merged[TECHNICAL_ENTRY_ID_COLUMN] = registration.entryId || merged[TECHNICAL_ENTRY_ID_COLUMN];
  return merged;
}

function findTargetRow(rows, registration) {
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] || [];
    if (registration.entryId && text(row[TECHNICAL_ENTRY_ID_COLUMN]) === registration.entryId) return index + 1;
    if (text(row[4]) === registration.studentName && text(row[5]) === registration.submittedAt) return index + 1;
  }
  for (let index = 1; index < rows.length; index += 1) if (!text(rows[index]?.[4])) return index + 1;
  return Math.max(2, rows.length + 1);
}

async function getGoogleAccessToken(rawServiceAccount) {
  if (!rawServiceAccount) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT");
  const serviceAccount = JSON.parse(rawServiceAccount);
  const now = Math.floor(Date.now() / 1000);
  const assertion = await createJwt(serviceAccount, now);
  const response = await fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  if (!response.ok) throw new Error(`Google token request failed: ${response.status}`);
  const result = await response.json();
  if (!result.access_token) throw new Error("Google token response has no access token");
  return result.access_token;
}

async function createJwt(serviceAccount, now) {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(JSON.stringify({ iss: serviceAccount.client_email, scope: SHEETS_SCOPE, aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600 }));
  const signed = `${header}.${claim}`;
  const privateKey = await crypto.subtle.importKey("pkcs8", pemToArrayBuffer(serviceAccount.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(signed));
  return `${signed}.${base64Url(signature)}`;
}

async function googleFetch(url, accessToken, options = {}) {
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(options.headers || {}) } });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google Sheets request failed: ${response.status} ${detail.slice(0, 500)}`);
  }
  return response.json();
}

function pemToArrayBuffer(pem) {
  const base64 = text(pem).replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(base64); const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function quoteSheetName(name) { return `'${String(name ?? "").replace(/'/g, "''")}'`; }
function normalizeTrial(value) { const normalized = text(value).toLowerCase(); return normalized === "igen" || normalized === "nem" ? normalized : ""; }
function text(value) { return value == null ? "" : String(value).trim(); }
function base64Url(value) { const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function safeEqual(left, right) { if (left.length !== right.length) return false; let result = 0; for (let i = 0; i < left.length; i += 1) result |= left.charCodeAt(i) ^ right.charCodeAt(i); return result === 0; }
function json(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }); }
function html(body, status = 200) { return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } }); }

function importPage(message = "", status = 200) {
  return `<!doctype html><meta charset="utf-8"><title>Rényike nénike tánctanfolyam import muri</title><style>body{font:16px system-ui;max-width:680px;margin:48px auto;padding:0 20px}main{border:1px solid #ddd;border-radius:12px;padding:24px}input,button{font:inherit;margin-top:12px}button{padding:10px 16px;cursor:pointer}.error{color:#a00;white-space:pre-wrap}</style><main><h1>Rényike nénike tánctanfolyam import muri</h1><p>Tölts fel szépen egy csv fájlt, amit innen szedsz le: <a href="https://kult2.hu/wp-admin/admin.php?page=gf_export" target="_blank" rel="noopener noreferrer">https://kult2.hu/wp-admin/admin.php?page=gf_export</a></p>${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}<form method="post" enctype="multipart/form-data"><input type="file" name="file" accept=".csv,text/csv" required><br><button>Importálás</button></form></main>`;
}

function importResultPage(result, count) {
  const created = result.results.filter((item) => item.type === "created").length;
  const updated = result.results.filter((item) => item.type === "updated").length;
  return `<!doctype html><meta charset="utf-8"><title>Import kész</title><style>body{font:16px system-ui;max-width:680px;margin:48px auto;padding:0 20px}main{border:1px solid #ddd;border-radius:12px;padding:24px}</style><main><h1>Import elkészült</h1><p>${count} rekord feldolgozva.</p><ul><li>Új: ${created}</li><li>Frissített: ${updated}</li></ul><p>A Google Sheet frissítése befejeződött.</p></main>`;
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }

export { CSV_HEADERS, findTargetRow, mergeRow, parseCsv, parseCsvRegistrations, registrationFromCsvRow };
