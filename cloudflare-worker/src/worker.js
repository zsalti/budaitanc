import * as XLSX from "xlsx";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.readonly",
].join(" ");
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const WEBHOOK_PATH = "/webhooks/gravity-forms";
const IMPORT_PATH_PREFIX = "/import/";
const SYNC_PATH_PREFIX = "/sync/";
const PAYMENTS_PATH_PREFIX = "/payments/";
const MASTER_MANUAL_START = 8; // I:L before the Közlemény column is inserted.
const MASTER_MANUAL_END = 12;

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

    const syncToken = getProtectedPathToken(url.pathname, SYNC_PATH_PREFIX);
    if (syncToken !== null) {
      return handleSync(request, env, syncToken);
    }

    const paymentToken = getProtectedPathToken(url.pathname, PAYMENTS_PATH_PREFIX);
    if (paymentToken !== null) {
      return handlePaymentsImport(request, env, paymentToken);
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
      const result = await writeRegistrationsToTargets(accessToken, pipeline, [registration]);
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
    const result = await writeRegistrationsToTargets(accessToken, pipeline, registrations);
    return html(importResultPage(result, registrations.length));
  } catch (error) {
    console.error("CSV import failed", error);
    return html(importPage(error.message || "Az import nem sikerült.", 400), 400);
  }
}

async function handlePaymentsImport(request, env, token) {
  if (!env.PAYMENT_IMPORT_TOKEN || !safeEqual(token, env.PAYMENT_IMPORT_TOKEN)) {
    return json({ error: "not_found" }, 404);
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    let payload = {};
    const raw = await request.text();
    if (raw.trim()) payload = JSON.parse(raw);
    const pipeline = getPipeline(env, text(payload.pipeline_id) || defaultPipelineId(env));
    const source = getPaymentSource(env, pipeline.pipeline_id);
    const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT);
    const transactions = await downloadPaymentTransactions(accessToken, source);
    const result = await importPayments(accessToken, pipeline, transactions);
    return json({ status: "ok", pipeline_id: pipeline.pipeline_id, ...result });
  } catch (error) {
    console.error("Payment import failed", error);
    return json({ error: "payment_import_failed", message: error.message || "Ismeretlen hiba." }, 500);
  }
}

function getImportToken(pathname) {
  return getProtectedPathToken(pathname, IMPORT_PATH_PREFIX);
}

function getProtectedPathToken(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const token = pathname.slice(prefix.length).replace(/\/$/, "");
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

async function handleSync(request, env, token) {
  if (!env.SYNC_ADMIN_TOKEN || !safeEqual(token, env.SYNC_ADMIN_TOKEN)) {
    return json({ error: "not_found" }, 404);
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    let payload = {};
    const raw = await request.text();
    if (raw.trim()) payload = JSON.parse(raw);
    const pipeline = getPipeline(env, text(payload.pipeline_id) || defaultPipelineId(env));
    if (!pipeline.staff_target) throw new Error("Ehhez a pipeline-hoz nincs munkatársi Sheet beállítva.");

    const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT);
    const result = await syncStaffTarget(accessToken, pipeline);
    return json({ status: "ok", pipeline_id: pipeline.pipeline_id, ...result });
  } catch (error) {
    console.error("Staff Sheet sync failed", error);
    return json({ error: "sync_failed" }, 500);
  }
}

function getPaymentSource(env, pipelineId) {
  if (!env.PAYMENTS_SOURCE_CONFIG_JSON) throw new Error("Hiányzik a PAYMENTS_SOURCE_CONFIG_JSON beállítás.");
  const config = JSON.parse(env.PAYMENTS_SOURCE_CONFIG_JSON);
  const sources = Array.isArray(config) ? config : (config.sources || [config]);
  const source = sources.find((item) => item.pipeline_id === pipelineId);
  if (!source?.drive_file_id) throw new Error(`Nincs banki Excel-forrás beállítva ehhez: ${pipelineId}`);
  return source;
}

async function downloadPaymentTransactions(accessToken, source) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(source.drive_file_id)}?alt=media`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`A banki Excel letöltése nem sikerült: ${response.status}`);
  const workbook = XLSX.read(await response.arrayBuffer(), { type: "array", cellDates: false });
  const sheetName = source.sheet_name || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`Nem található a banki Excel munkalapja: ${sheetName}`);
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  if (!rows.length) throw new Error("A banki Excel nem tartalmaz adat-sort.");
  return Promise.all(rows.map((row, index) => paymentFromRow(row, source.columns, index + 2)));
}

async function paymentFromRow(row, columns = {}, sourceRow) {
  const get = (key, aliases) => valueForColumn(row, columns[key] || aliases);
  const transactionId = get("transaction_id", ["Tranzakcióazonosító", "Transaction ID"]);
  const bookingDate = get("booking_date", ["Könyvelési dátum", "Booking date"]);
  const message = get("message", ["Közlemény", "Közlemények", "Message", "Remittance information"]);
  if (!bookingDate) throw new Error(`Hiányzik a könyvelési dátum a banki Excel ${sourceRow}. sorából.`);
  const payment = {
    transactionId,
    bookingDate,
    valueDate: get("value_date", ["Értéknap", "Value date"]),
    amount: get("amount", ["Összeg", "Amount"]),
    currency: get("currency", ["Deviza", "Currency"]),
    senderName: get("sender_name", ["Feladó neve", "Sender name"]),
    senderAccount: get("sender_account", ["Feladó számlaszáma", "Sender account"]),
    message,
    sourceRow,
  };
  payment.sourceKey = transactionId ? `id:${transactionId}` : `hash:${await paymentFingerprint(payment)}`;
  return payment;
}

function valueForColumn(row, aliases) {
  const lookup = new Map(Object.keys(row).map((header) => [normalizeHeader(header), row[header]]));
  for (const alias of aliases || []) {
    const value = lookup.get(normalizeHeader(alias));
    if (value !== undefined) return text(value);
  }
  return "";
}

async function paymentFingerprint(payment) {
  const value = [payment.bookingDate, payment.valueDate, payment.amount, payment.currency, payment.senderName, payment.senderAccount, payment.message]
    .map(normalizeForMatch).join("|");
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function importPayments(accessToken, pipeline, transactions) {
  const masterRows = await readSheetRows(accessToken, pipeline.spreadsheet_id, pipeline.tab_name, "A:Z");
  if (text(masterRows[0]?.[0]) !== "Közlemény") throw new Error("A fő Sheet első oszlopa nem Közlemény.");
  const paymentSheets = await ensurePaymentSheets(accessToken, pipeline.spreadsheet_id);
  const logRows = await readSheetRows(accessToken, pipeline.spreadsheet_id, paymentSheets.log, "A:K");
  const pendingRows = await readSheetRows(accessToken, pipeline.spreadsheet_id, paymentSheets.pending, "A:K");
  const registrations = masterRows.slice(1).map((row, index) => registrationForPayment(row, index + 2, pipeline.tab_name)).filter(Boolean);
  const registrationsByReference = new Map(registrations.map((item) => [item.reference, item]));
  const knownSources = new Set(logRows.slice(1).map((row) => text(row[0])).filter(Boolean));
  const pendingBySource = new Map(pendingRows.slice(1).map((row, index) => [text(row[0]), { row, rowIndex: index + 2 }]).filter(([key]) => key));

  const masterWrites = [];
  const logWrites = [];
  const pendingWrites = [];
  const summary = { new_transactions: 0, booked: 0, already_recorded: 0, pending: 0, duplicates: 0, manually_resolved: 0 };

  for (const pending of pendingBySource.values()) {
    const manualReference = text(pending.row[8]);
    if (!manualReference || !registrationsByReference.has(manualReference) || text(pending.row[9]).startsWith("Könyvelve")) continue;
    const registration = registrationsByReference.get(manualReference);
    const status = bookPaymentIfNeeded(registration, text(pending.row[1]), masterWrites);
    pendingWrites.push({ range: `${quoteSheetName(paymentSheets.pending)}!J${pending.rowIndex}:K${pending.rowIndex}`, values: [["Könyvelve kézzel", new Date().toISOString()]] });
    updateLogStatusWrite(logRows, paymentSheets.log, text(pending.row[0]), "Könyvelve kézzel", manualReference, logWrites);
    summary.manually_resolved += 1;
    if (status === "booked") summary.booked += 1; else summary.already_recorded += 1;
  }

  let logRowIndex = logRows.length + 1;
  let pendingRowIndex = pendingRows.length + 1;
  for (const payment of transactions) {
    if (knownSources.has(payment.sourceKey)) { summary.duplicates += 1; continue; }
    summary.new_transactions += 1;
    const candidates = extractReferences(payment.message);
    const matches = candidates.map((reference) => registrationsByReference.get(reference)).filter(Boolean);
    let status;
    let matchedReference = "";
    if (matches.length === 1) {
      matchedReference = matches[0].reference;
      const result = bookPaymentIfNeeded(matches[0], payment.bookingDate, masterWrites);
      status = result === "booked" ? "Könyvelve" : "Már rögzített";
      if (result === "booked") summary.booked += 1; else summary.already_recorded += 1;
    } else {
      status = matches.length > 1 ? "Többértelmű" : "Függő";
      const suggestions = nameSuggestions(payment.senderName, registrations);
      pendingWrites.push({
        range: `${quoteSheetName(paymentSheets.pending)}!A${pendingRowIndex}:K${pendingRowIndex}`,
        values: [[payment.sourceKey, payment.bookingDate, payment.amount, payment.currency, payment.senderName, payment.senderAccount, payment.message, suggestions.join(" | "), "", status, ""]],
      });
      pendingRowIndex += 1;
      summary.pending += 1;
    }
    logWrites.push({
      range: `${quoteSheetName(paymentSheets.log)}!A${logRowIndex}:K${logRowIndex}`,
      values: [[payment.sourceKey, payment.bookingDate, payment.amount, payment.currency, payment.senderName, payment.senderAccount, payment.message, candidates.join(", "), matchedReference, status, new Date().toISOString()]],
    });
    logRowIndex += 1;
  }

  if (masterWrites.length) await writeSheetRanges(accessToken, pipeline.spreadsheet_id, masterWrites);
  if (logWrites.length) await writeSheetRanges(accessToken, pipeline.spreadsheet_id, logWrites);
  if (pendingWrites.length) await writeSheetRanges(accessToken, pipeline.spreadsheet_id, pendingWrites);
  return summary;
}

function registrationForPayment(row, rowIndex, masterTab) {
  const reference = text(row[0]);
  if (!reference) return null;
  return { reference, rowIndex, masterTab, studentName: text(row[5]), parentName: text(row[17]), paidDate: text(row[9]) };
}

function bookPaymentIfNeeded(registration, bookingDate, masterWrites) {
  if (registration.paidDate) return "already_recorded";
  masterWrites.push({ range: `${quoteSheetName(registration.masterTab)}!J${registration.rowIndex}`, values: [[bookingDate]] });
  registration.paidDate = bookingDate;
  return "booked";
}

function extractReferences(message) {
  return [...new Set((text(message).match(/(?<!\d)\d{1,7}(?!\d)/g) || []))];
}

function nameSuggestions(senderName, registrations) {
  const surname = normalizedSurname(senderName);
  if (!surname) return [];
  const matches = [];
  for (const registration of registrations) {
    const reasons = [];
    if (normalizedSurname(registration.studentName) === surname) reasons.push("Vezetéknév egyezik a növendék nevével");
    if (normalizedSurname(registration.parentName) === surname) reasons.push("Vezetéknév egyezik a szülő/gondviselő nevével");
    if (reasons.length) matches.push(`${registration.studentName} (${registration.reference}) — ${reasons.join(", ")}`);
  }
  return matches.slice(0, 3);
}

function normalizedSurname(name) { return normalizeForMatch(name).split(" ").filter(Boolean)[0] || ""; }
function normalizeHeader(value) { return normalizeForMatch(value).replace(/[^a-z0-9]/g, ""); }
function normalizeForMatch(value) { return text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim(); }

function updateLogStatusWrite(logRows, logTab, sourceKey, status, matchedReference, writes) {
  const index = logRows.findIndex((row, rowIndex) => rowIndex > 0 && text(row[0]) === sourceKey);
  if (index >= 0) writes.push({ range: `${quoteSheetName(logTab)}!I${index + 1}:K${index + 1}`, values: [[matchedReference, status, new Date().toISOString()]] });
}

async function ensurePaymentSheets(accessToken, spreadsheetId) {
  const log = "Befizetések napló";
  const pending = "Függő befizetések";
  const metadata = await getSpreadsheetMetadata(accessToken, spreadsheetId);
  const titles = new Set((metadata.sheets || []).map((sheet) => sheet.properties?.title));
  const missing = [log, pending].filter((title) => !titles.has(title));
  if (missing.length) {
    const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
    await googleFetch(`${baseUrl}:batchUpdate`, accessToken, {
      method: "POST",
      body: JSON.stringify({ requests: missing.map((title) => ({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } })) }),
    });
  }
  const headers = {
    [log]: ["Forrásazonosító", "Könyvelési dátum", "Összeg", "Deviza", "Feladó neve", "Feladó számlaszáma", "Eredeti közlemény", "Kinyert közleményjelöltek", "Párosított közlemény", "Státusz", "Feldolgozva"],
    [pending]: ["Forrásazonosító", "Könyvelési dátum", "Összeg", "Deviza", "Feladó neve", "Feladó számlaszáma", "Eredeti közlemény", "Javaslatok", "Kézzel hozzárendelt közlemény", "Státusz", "Feldolgozva"],
  };
  for (const title of [log, pending]) {
    const rows = await readSheetRows(accessToken, spreadsheetId, title, "A1:K1");
    if (!rows.length || !text(rows[0]?.[0])) await writeSheetRanges(accessToken, spreadsheetId, [{ range: `${quoteSheetName(title)}!A1:K1`, values: [headers[title]] }]);
  }
  return { log, pending };
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

async function writeRegistrationsToTargets(accessToken, pipeline, registrations) {
  const masterResult = await upsertMasterRegistrations(accessToken, pipeline, registrations);
  if (pipeline.staff_target) {
    await upsertStaffRegistrations(accessToken, pipeline.staff_target, registrations);
  }
  return masterResult;
}

async function upsertMasterRegistrations(accessToken, pipeline, registrations) {
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(pipeline.spreadsheet_id)}`;
  const readRange = encodeURIComponent(`${quoteSheetName(pipeline.tab_name)}!A:Z`);
  const current = await googleFetch(`${baseUrl}/values/${readRange}`, accessToken);
  const rows = current.values || [];
  const mutableRows = rows.map((row) => [...row]);
  const results = [];
  const data = [];

  for (const registration of registrations) {
    const rowIndex = findMasterRow(mutableRows, registration);
    while (mutableRows.length < rowIndex) mutableRows.push([]);
    const existing = mutableRows[rowIndex - 1] || [];
    const merged = mergeMasterRow(existing, registration);
    mutableRows[rowIndex - 1] = merged;
    data.push({ range: `${quoteSheetName(pipeline.tab_name)}!A${rowIndex}:I${rowIndex}`, values: [merged.slice(0, 9)] });
    data.push({ range: `${quoteSheetName(pipeline.tab_name)}!N${rowIndex}:Z${rowIndex}`, values: [merged.slice(13, 26)] });
    results.push({ rowIndex, type: existing[5] ? "updated" : "created", studentName: registration.studentName });
  }

  await googleFetch(`${baseUrl}/values:batchUpdate`, accessToken, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "RAW", data }),
  });
  return { results };
}

function mergeMasterRow(existing, registration) {
  const merged = Array.from({ length: 26 }, (_, index) => existing[index] || "");
  merged[0] = registration.entryId || merged[0];
  registration.row.forEach((value, index) => {
    const targetIndex = index + 1;
    if (index < MASTER_MANUAL_START || index >= MASTER_MANUAL_END) merged[targetIndex] = value;
  });
  return merged;
}

function findMasterRow(rows, registration) {
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] || [];
    if (registration.entryId && text(row[0]) === registration.entryId) return index + 1;
    if (text(row[5]) === registration.studentName && text(row[6]) === registration.submittedAt) return index + 1;
  }
  for (let index = 1; index < rows.length; index += 1) if (!text(rows[index]?.[5])) return index + 1;
  return Math.max(2, rows.length + 1);
}

function staffRowFromRegistration(registration) {
  return [registration.entryId, ...registration.row.slice(0, 7)];
}

async function upsertStaffRegistrations(accessToken, target, registrations) {
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(target.spreadsheet_id)}`;
  const readRange = encodeURIComponent(`${quoteSheetName(target.tab_name)}!A:H`);
  const current = await googleFetch(`${baseUrl}/values/${readRange}`, accessToken);
  const rows = current.values || [];
  const mutableRows = rows.map((row) => [...row]);
  const data = [];

  for (const registration of registrations) {
    const rowIndex = findStaffRow(mutableRows, registration.entryId);
    while (mutableRows.length < rowIndex) mutableRows.push([]);
    mutableRows[rowIndex - 1] = staffRowFromRegistration(registration);
    data.push({ range: `${quoteSheetName(target.tab_name)}!A${rowIndex}:H${rowIndex}`, values: [mutableRows[rowIndex - 1]] });
  }

  if (data.length) {
    await googleFetch(`${baseUrl}/values:batchUpdate`, accessToken, {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "RAW", data }),
    });
  }
}

function findStaffRow(rows, entryId) {
  for (let index = 1; index < rows.length; index += 1) {
    if (entryId && text(rows[index]?.[0]) === entryId) return index + 1;
  }
  for (let index = 1; index < rows.length; index += 1) if (!text(rows[index]?.[5])) return index + 1;
  return Math.max(2, rows.length + 1);
}

async function syncStaffTarget(accessToken, pipeline) {
  const masterRows = await readSheetRows(accessToken, pipeline.spreadsheet_id, pipeline.tab_name, "A:Z");
  if (text(masterRows[0]?.[0]) !== "Közlemény") {
    throw new Error("A fő Sheet első oszlopának Közleménynek kell lennie.");
  }

  const registrations = masterRows.slice(1)
    .filter((row) => text(row[0]) && text(row[5]))
    .map((row) => ({ entryId: text(row[0]), studentName: text(row[5]), submittedAt: text(row[6]), row: row.slice(1, 26) }));
  const target = pipeline.staff_target;
  const staffRows = await readSheetRows(accessToken, target.spreadsheet_id, target.tab_name, "A:H");
  const masterIds = new Set(registrations.map((registration) => registration.entryId));
  const mutableRows = staffRows.map((row) => [...row]);
  const data = [];
  let created = 0;
  let updated = 0;

  for (const registration of registrations) {
    const existingIndex = mutableRows.findIndex((row, index) => index > 0 && text(row?.[0]) === registration.entryId);
    const rowIndex = existingIndex >= 0 ? existingIndex + 1 : findStaffRow(mutableRows, registration.entryId);
    while (mutableRows.length < rowIndex) mutableRows.push([]);
    mutableRows[rowIndex - 1] = staffRowFromRegistration(registration);
    data.push({ range: `${quoteSheetName(target.tab_name)}!A${rowIndex}:H${rowIndex}`, values: [mutableRows[rowIndex - 1]] });
    if (existingIndex >= 0) updated += 1;
    else created += 1;
  }

  if (data.length) {
    const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(target.spreadsheet_id)}`;
    await googleFetch(`${baseUrl}/values:batchUpdate`, accessToken, {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "RAW", data }),
    });
  }

  const deleteRows = staffRows
    .map((row, index) => ({ row, index }))
    .filter(({ row, index }) => index > 0 && text(row?.[0]) && !masterIds.has(text(row[0])))
    .map(({ index }) => index + 1)
    .sort((left, right) => right - left);
  if (deleteRows.length) await deleteRowsByIndex(accessToken, target, deleteRows);

  return { created, updated, deleted: deleteRows.length, total: registrations.length };
}

async function readSheetRows(accessToken, spreadsheetId, tabName, columns) {
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  const range = encodeURIComponent(`${quoteSheetName(tabName)}!${columns}`);
  const result = await googleFetch(`${baseUrl}/values/${range}`, accessToken);
  return result.values || [];
}

async function writeSheetRanges(accessToken, spreadsheetId, data) {
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  await googleFetch(`${baseUrl}/values:batchUpdate`, accessToken, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "RAW", data }),
  });
}

async function getSpreadsheetMetadata(accessToken, spreadsheetId) {
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  return googleFetch(`${baseUrl}?fields=sheets.properties(sheetId,title)`, accessToken);
}

async function deleteRowsByIndex(accessToken, target, rowIndexes) {
  const sheetId = await getSheetId(accessToken, target.spreadsheet_id, target.tab_name);
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(target.spreadsheet_id)}`;
  await googleFetch(`${baseUrl}:batchUpdate`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      requests: rowIndexes.map((rowIndex) => ({
        deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: rowIndex - 1, endIndex: rowIndex } },
      })),
    }),
  });
}

async function getSheetId(accessToken, spreadsheetId, tabName) {
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  const result = await getSpreadsheetMetadata(accessToken, spreadsheetId);
  const sheet = (result.sheets || []).find((item) => item.properties?.title === tabName);
  if (!sheet) throw new Error(`Nem található fül: ${tabName}`);
  return sheet.properties.sheetId;
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
  const claim = base64Url(JSON.stringify({ iss: serviceAccount.client_email, scope: GOOGLE_SCOPES, aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600 }));
  const signed = `${header}.${claim}`;
  const privateKey = await crypto.subtle.importKey("pkcs8", pemToArrayBuffer(serviceAccount.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(signed));
  return `${signed}.${base64Url(signature)}`;
}

async function googleFetch(url, accessToken, options = {}) {
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(options.headers || {}) } });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google API request failed: ${response.status} ${detail.slice(0, 500)}`);
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

export { CSV_HEADERS, extractReferences, findMasterRow, mergeMasterRow, nameSuggestions, normalizeForMatch, parseCsv, parseCsvRegistrations, paymentFromRow, registrationFromCsvRow };
