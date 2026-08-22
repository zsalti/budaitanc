import * as XLSX from "xlsx";
import { AUTOMATION_STATUS, calculateRegistration, formatDate, parseAutomationConfig } from "./fee-engine.js";
import {
  EMAIL_EVENT,
  TEMPLATE_VERSION,
  brevoTemplateDefinitions,
  buildEmailDraft,
  defaultEmailSettings,
  emailSettingsSheetRows,
  parseEmailSettings,
} from "./email-templates.js";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.readonly",
].join(" ");
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const WEBHOOK_PATH = "/webhooks/gravity-forms";
const IMPORT_PATH_PREFIX = "/import/";
const SYNC_PATH_PREFIX = "/sync/";
const PAYMENTS_PATH_PREFIX = "/payments/";
const EMAIL_DRAFTS_PATH_PREFIX = "/emails/drafts/";
const EMAIL_SEND_PATH_PREFIX = "/emails/send/";
const EMAIL_SETUP_PATH_PREFIX = "/emails/setup/";
const BREVO_WEBHOOK_PATH = "/webhooks/brevo";
const AUTOMATION_CONFIG_TAB = "Automata kalk";
const EMAIL_OUTPUT_TAB = "E-mail kimenet";
const EMAIL_SETTINGS_TAB = "E-mail beállítások";
const EMAIL_EVENT_LOG_TAB = "E-mail eseménynapló";
const TRIAL_DATE_COLUMN = "AH";
const AUTOMATION_START_COLUMN = "AI";
const AUTOMATION_END_COLUMN = "AR";
const CONTACT_FIRST_NAME_COLUMN = "AS";
const STUDENT_FIRST_NAME_COLUMN = "AT";
const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";
const BREVO_TEMPLATE_URL = "https://api.brevo.com/v3/smtp/templates";
const STAFF_BASE_SYNC_COLUMN_COUNT = 8;
const STAFF_ADDITIONAL_SYNC_HEADERS = [
  "I. féléves tandíjfizetés dátuma",
  "II. féléves tandíj befizetés dátuma",
  "Egyéb megjegyzés",
];
const inFlightSends = new Set();

const EMAIL_COLUMN = Object.freeze({
  SEND_KEY: 0, ENTRY_ID: 1, PERIOD: 2, TEMPLATE_VERSION: 3, TO: 4, SUBJECT: 5, PLAIN: 6, HTML: 7,
  FIRST_CLASS: 8, AMOUNT: 9, EXPLANATION: 10, APPROVED: 11, STATUS: 12, MESSAGE_ID: 13,
  ERROR: 14, SOURCE_HASH: 15, UPDATED_AT: 16, ACCEPTED_AT: 17, MANUAL_SENT: 18,
  MANUAL_SENT_AT: 19, MANUAL_SENT_BY: 20, EVENT_TYPE: 21, AUDIENCE_TYPE: 22, VENUE_CODE: 23,
  TEMPLATE_KEY: 24, TEMPLATE_ID: 25, PARAMS_JSON: 26, REVISION_HASH: 27, APPROVED_HASH: 28,
  APPROVED_AT: 29, APPROVED_BY: 30, DELIVERY_STATUS: 31, DELIVERY_AT: 32, DELIVERY_ERROR: 33,
});

export const EMAIL_OUTPUT_HEADERS = [
  "Küldési kulcs", "Bejegyzésazonosító", "Félév / típus", "Sablonverzió", "Címzett", "Tárgy",
  "Szöveges levél", "HTML levél", "Első óra", "Összeg", "Számítás / indok", "Jóváhagyva",
  "Státusz", "Brevo messageId", "Hiba", "Forrás hash", "Frissítve", "Brevo fogadta", "Manuálisan elküldve",
  "Manuális küldés időpontja", "Manuális küldés megjegyzése / küldője", "Eseménytípus", "Címzett típusa",
  "Helyszínkód", "Sablonkulcs", "Brevo templateId", "Paraméterek JSON", "Revízió hash",
  "Jóváhagyott hash", "Jóváhagyás időpontja", "Jóváhagyó", "Kézbesítési állapot",
  "Kézbesítési esemény ideje", "Kézbesítési hiba",
];

export const EMAIL_EVENT_LOG_HEADERS = [
  "Eseményazonosító", "Brevo messageId", "Küldési kulcs", "Esemény", "Címzett", "Esemény ideje",
  "Fogadás ideje", "Ok / részlet", "Nyers típus",
];
// Registration data ends at I. Imports preserve J:N in the master Sheet:
// J is calculated by the fee engine; K:N contain payment/admin fields.
const MASTER_MANUAL_START = 8;
const MASTER_MANUAL_END = 13;

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

    const draftToken = getProtectedPathToken(url.pathname, EMAIL_DRAFTS_PATH_PREFIX);
    if (draftToken !== null) {
      return handleEmailDraftRefresh(request, env, draftToken);
    }

    const sendToken = getProtectedPathToken(url.pathname, EMAIL_SEND_PATH_PREFIX);
    if (sendToken !== null) {
      return handleApprovedEmailSend(request, env, sendToken);
    }

    const setupToken = getProtectedPathToken(url.pathname, EMAIL_SETUP_PATH_PREFIX);
    if (setupToken !== null) {
      return handleEmailSetup(request, env, setupToken);
    }

    if (url.pathname === BREVO_WEBHOOK_PATH) {
      return handleBrevoWebhook(request, env);
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
        automation: result.automation?.[0] || null,
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
    const { newRegistrations, skippedRegistrations } = await filterManualImportRegistrations(
      accessToken,
      pipeline,
      registrations,
    );
    const result = newRegistrations.length
      ? await writeRegistrationsToTargets(accessToken, pipeline, newRegistrations)
      : { results: [] };
    result.skipped = skippedRegistrations;
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

async function handleEmailDraftRefresh(request, env, token) {
  if (!env.EMAIL_ADMIN_TOKEN || !safeEqual(token, env.EMAIL_ADMIN_TOKEN)) {
    return json({ error: "not_found" }, 404);
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const payload = await optionalJson(request);
    const pipeline = getPipeline(env, text(payload.pipeline_id) || defaultPipelineId(env));
    const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT);
    const automation = await refreshEmailDrafts(accessToken, pipeline, null);
    return json({ status: "ok", pipeline_id: pipeline.pipeline_id, ...automation });
  } catch (error) {
    console.error("Email draft refresh failed", error);
    return json({ error: "email_draft_refresh_failed", message: error.message || "Ismeretlen hiba." }, 500);
  }
}

async function handleApprovedEmailSend(request, env, token) {
  if (!env.EMAIL_ADMIN_TOKEN || !safeEqual(token, env.EMAIL_ADMIN_TOKEN)) {
    return json({ error: "not_found" }, 404);
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const payload = await optionalJson(request);
    const pipeline = getPipeline(env, text(payload.pipeline_id) || defaultPipelineId(env));
    const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT);
    const result = await sendApprovedEmails(accessToken, pipeline, env);
    return json({ status: "ok", pipeline_id: pipeline.pipeline_id, ...result });
  } catch (error) {
    console.error("Approved email send failed", error);
    return json({ error: "email_send_failed", message: error.message || "Ismeretlen hiba." }, 500);
  }
}

async function handleEmailSetup(request, env, token) {
  if (!env.EMAIL_ADMIN_TOKEN || !safeEqual(token, env.EMAIL_ADMIN_TOKEN)) {
    return json({ error: "not_found" }, 404);
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const payload = await optionalJson(request);
    const pipeline = getPipeline(env, text(payload.pipeline_id) || defaultPipelineId(env));
    const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT);
    const result = await ensureEmailInfrastructure(accessToken, pipeline);
    return json({ status: "ok", pipeline_id: pipeline.pipeline_id, ...result });
  } catch (error) {
    console.error("Email infrastructure setup failed", error);
    return json({ error: "email_setup_failed", message: error.message || "Ismeretlen hiba." }, 500);
  }
}

async function handleBrevoWebhook(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!env.BREVO_WEBHOOK_SECRET
      || !safeEqual(request.headers.get("X-BudaiTanc-Brevo-Secret") || "", env.BREVO_WEBHOOK_SECRET)) {
    return json({ error: "unauthorized" }, 401);
  }
  let payload;
  try { payload = await request.json(); }
  catch { return json({ error: "invalid_json" }, 400); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json({ error: "invalid_payload" }, 400);

  try {
    const pipelineId = text(env.BREVO_PIPELINE_ID) || defaultPipelineId(env);
    const pipeline = getPipeline(env, pipelineId);
    const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT);
    const result = await recordBrevoEvent(accessToken, pipeline, payload);
    return json({ status: "ok", ...result });
  } catch (error) {
    console.error("Brevo webhook processing failed", error);
    return json({ error: "brevo_webhook_failed", message: error.message || "Ismeretlen hiba." }, 500);
  }
}

async function optionalJson(request) {
  const raw = await request.text();
  return raw.trim() ? JSON.parse(raw) : {};
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
    return json({ error: "sync_failed", message: error.message || "Ismeretlen hiba." }, 500);
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
  const masterRows = await readSheetRows(accessToken, pipeline.spreadsheet_id, pipeline.tab_name, "A:AA");
  if (text(masterRows[0]?.[0]) !== "Közlemény") throw new Error("A fő Sheet első oszlopa nem Közlemény.");
  const paymentColumns = paymentColumnIndexes(masterRows[0]);
  const paymentSheets = await ensurePaymentSheets(accessToken, pipeline.spreadsheet_id);
  const logRows = await readSheetRows(accessToken, pipeline.spreadsheet_id, paymentSheets.log, "A:K");
  const pendingRows = await readSheetRows(accessToken, pipeline.spreadsheet_id, paymentSheets.pending, "A:K");
  const registrations = masterRows.slice(1).map((row, index) => registrationForPayment(row, index + 2, pipeline.tab_name, paymentColumns)).filter(Boolean);
  const registrationsByReference = new Map(registrations.map((item) => [item.reference, item]));
  const knownSources = new Set(logRows.slice(1).map((row) => text(row[0])).filter(Boolean));
  const pendingBySource = new Map(pendingRows.slice(1).map((row, index) => [text(row[0]), { row, rowIndex: index + 2 }]).filter(([key]) => key));

  const masterWrites = [];
  const logWrites = [];
  const pendingWrites = [];
  const summary = { new_transactions: 0, booked: 0, already_recorded: 0, pending: 0, duplicates: 0, manually_resolved: 0 };
  const bookedReferences = new Set();

  for (const pending of pendingBySource.values()) {
    const manualReference = text(pending.row[8]);
    if (!manualReference || !registrationsByReference.has(manualReference) || text(pending.row[9]).startsWith("Könyvelve")) continue;
    const registration = registrationsByReference.get(manualReference);
    const status = bookPaymentIfNeeded(registration, text(pending.row[1]), masterWrites);
    pendingWrites.push({ range: `${quoteSheetName(paymentSheets.pending)}!J${pending.rowIndex}:K${pending.rowIndex}`, values: [["Könyvelve kézzel", new Date().toISOString()]] });
    updateLogStatusWrite(logRows, paymentSheets.log, text(pending.row[0]), "Könyvelve kézzel", manualReference, logWrites);
    summary.manually_resolved += 1;
    if (status === "booked") {
      summary.booked += 1;
      bookedReferences.add(registration.reference);
    } else summary.already_recorded += 1;
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
      if (result === "booked") {
        summary.booked += 1;
        bookedReferences.add(matches[0].reference);
      } else summary.already_recorded += 1;
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
  if (bookedReferences.size && pipeline.email_automation !== false) {
    const drafts = await refreshPaymentEmailDrafts(accessToken, pipeline, bookedReferences);
    summary.payment_email_drafts = drafts.processed;
  } else {
    summary.payment_email_drafts = 0;
  }
  return summary;
}

function paymentColumnIndexes(header) {
  const indexOf = (name) => header.findIndex((value) => text(value) === name);
  const paymentDate = indexOf("I. féléves tandíjfizetés dátuma");
  const studentName = indexOf("Jelentkező (növendék) neve");
  const parentName = indexOf("Törvényes képviselő, szülő neve");
  if (paymentDate < 0 || studentName < 0 || parentName < 0) {
    throw new Error("Hiányzik egy szükséges fő Sheet fejléc: jelentkező neve, szülő neve vagy I. féléves tandíjfizetés dátuma.");
  }
  return { paymentDate, studentName, parentName };
}

function registrationForPayment(row, rowIndex, masterTab, columns) {
  const reference = text(row[0]);
  if (!reference) return null;
  return {
    reference, rowIndex, masterTab,
    studentName: text(row[columns.studentName]),
    parentName: text(row[columns.parentName]),
    paidDate: text(row[columns.paymentDate]),
    paymentDateColumn: columns.paymentDate,
  };
}

function bookPaymentIfNeeded(registration, bookingDate, masterWrites) {
  if (registration.paidDate) return "already_recorded";
  masterWrites.push({ range: `${quoteSheetName(registration.masterTab)}!${columnLetter(registration.paymentDateColumn)}${registration.rowIndex}`, values: [[bookingDate]] });
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
function columnLetter(index) { let number = index + 1; let result = ""; while (number > 0) { const remainder = (number - 1) % 26; result = String.fromCharCode(65 + remainder) + result; number = Math.floor((number - 1) / 26); } return result; }

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

async function filterManualImportRegistrations(accessToken, pipeline, registrations) {
  const [masterRows, emailRows] = await Promise.all([
    readSheetRows(accessToken, pipeline.spreadsheet_id, pipeline.tab_name, "A:A"),
    pipeline.email_automation === false
      ? Promise.resolve([])
      : readSheetRows(accessToken, pipeline.spreadsheet_id, EMAIL_OUTPUT_TAB, "B:B"),
  ]);
  return partitionManualImportRegistrations(masterRows, emailRows, registrations);
}

function partitionManualImportRegistrations(masterRows, emailRows, registrations) {
  const knownEntryIds = new Set([
    ...masterRows.slice(1).map((row) => text(row[0])),
    ...emailRows.slice(1).map((row) => text(row[0])),
  ].filter(Boolean));
  const newRegistrations = [];
  const skippedRegistrations = [];

  for (const registration of registrations) {
    if (knownEntryIds.has(registration.entryId)) {
      skippedRegistrations.push(registration);
      continue;
    }
    knownEntryIds.add(registration.entryId);
    newRegistrations.push(registration);
  }
  return { newRegistrations, skippedRegistrations };
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
    trialDate: text(row["Próbaóra dátuma"]),
    row: [
      courseName, course.venue, course.time, course.teacher, studentName, submittedAt,
      text(row["Részvétel kezdete"]), normalizeTrial(row["Próba órára jelentkezés"]),
      "", "", "", "", "", text(row["Születési dátum"]), text(row["Lakcím"]), text(row["Telefon"]),
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
    entryId: text(payload.entry_id), studentName, submittedAt, trialDate: text(payload.trial_date),
    row: [courseName, course.venue || text(payload.venue), course.time || text(payload.time), course.teacher || text(payload.teacher), studentName, submittedAt,
      text(payload.start_date), normalizeTrial(payload.trial_signup), "", "", "", "", "", text(payload.birth_date), text(payload.address), text(payload.phone),
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
  if (pipeline.email_automation === false) return masterResult;
  const entryIds = new Set(registrations.map((registration) => registration.entryId).filter(Boolean));
  try {
    const automation = await refreshEmailDrafts(accessToken, pipeline, entryIds);
    return { ...masterResult, automation: automation.results };
  } catch (error) {
    console.error("Registration saved, but email automation failed", error);
    const message = `Automatizmus futási hiba: ${error.message || "ismeretlen hiba"}`;
    await markAutomationErrors(accessToken, pipeline, masterResult.results, message);
    return { ...masterResult, automation: masterResult.results.map((item, index) => ({ entry_id: registrations[index]?.entryId || "", row_index: item.rowIndex, status: AUTOMATION_STATUS.ERROR, reason: message })) };
  }
}

async function upsertMasterRegistrations(accessToken, pipeline, registrations) {
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(pipeline.spreadsheet_id)}`;
  const readRange = encodeURIComponent(`${quoteSheetName(pipeline.tab_name)}!A:AA`);
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
    data.push({ range: `${quoteSheetName(pipeline.tab_name)}!O${rowIndex}:AA${rowIndex}`, values: [merged.slice(14, 27)] });
    data.push({ range: `${quoteSheetName(pipeline.tab_name)}!${TRIAL_DATE_COLUMN}${rowIndex}`, values: [[registration.trialDate || ""]] });
    results.push({ rowIndex, type: existing[5] ? "updated" : "created", studentName: registration.studentName });
  }

  await googleFetch(`${baseUrl}/values:batchUpdate`, accessToken, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "RAW", data }),
  });
  return { results };
}

function mergeMasterRow(existing, registration) {
  const merged = Array.from({ length: 27 }, (_, index) => existing[index] || "");
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
  const masterRows = await readSheetRows(accessToken, pipeline.spreadsheet_id, pipeline.tab_name, "A:ZZ");
  if (text(masterRows[0]?.[0]) !== "Közlemény") {
    throw new Error("A fő Sheet első oszlopának Közleménynek kell lennie.");
  }
  const additionalSyncColumns = requiredHeaderIndexes(
    masterRows[0],
    STAFF_ADDITIONAL_SYNC_HEADERS,
    "fő Sheet",
  );

  const registrations = masterRows.slice(1)
    .filter((row) => text(row[0]) && text(row[5]))
    .map((row) => ({
      entryId: text(row[0]),
      studentName: text(row[5]),
      submittedAt: text(row[6]),
      row: row.slice(1),
      additionalSyncValues: additionalSyncColumns.map((columnIndex) => text(row[columnIndex])),
    }));
  const target = pipeline.staff_target;
  const staffRows = await readSheetRows(accessToken, target.spreadsheet_id, target.tab_name, "A:ZZ");
  const staffAdditionalSyncColumns = await ensureStaffAdditionalSyncColumns(
    accessToken,
    target,
    staffRows,
  );
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
    staffAdditionalSyncColumns.forEach((columnIndex, valueIndex) => {
      data.push({
        range: `${quoteSheetName(target.tab_name)}!${columnLetter(columnIndex)}${rowIndex}`,
        values: [[registration.additionalSyncValues[valueIndex]]],
      });
    });
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

function requiredHeaderIndexes(header, names, sheetDescription) {
  const indexes = names.map((name) => headerIndex(header, name));
  const missing = names.filter((_name, index) => indexes[index] < 0);
  if (missing.length) {
    throw new Error(`Hiányzó kötelező ${sheetDescription} fejléc: ${missing.join(", ")}.`);
  }
  return indexes;
}

function headerIndex(header, name) {
  const expected = normalizeHeader(name);
  return header.findIndex((value) => normalizeHeader(value) === expected);
}

async function ensureStaffAdditionalSyncColumns(accessToken, target, staffRows) {
  const header = [...(staffRows[0] || [])];
  const addedColumns = [];
  const indexes = STAFF_ADDITIONAL_SYNC_HEADERS.map((name) => {
    const existingIndex = headerIndex(header, name);
    if (existingIndex >= 0) return existingIndex;

    const newIndex = Math.max(header.length, STAFF_BASE_SYNC_COLUMN_COUNT);
    header[newIndex] = name;
    addedColumns.push({ name, index: newIndex });
    return newIndex;
  });

  if (!addedColumns.length) return indexes;

  await ensureSheetColumnCapacity(accessToken, target, header.length);
  await writeSheetRanges(accessToken, target.spreadsheet_id, addedColumns.map(({ name, index }) => ({
    range: `${quoteSheetName(target.tab_name)}!${columnLetter(index)}1`,
    values: [[name]],
  })));
  return indexes;
}

async function ensureSheetColumnCapacity(accessToken, target, requiredColumnCount) {
  const metadata = await getSpreadsheetMetadata(accessToken, target.spreadsheet_id);
  const sheet = (metadata.sheets || []).find((item) => item.properties?.title === target.tab_name);
  if (!sheet) throw new Error(`Nem található fül: ${target.tab_name}`);

  const currentColumnCount = sheet.properties?.gridProperties?.columnCount || 0;
  if (currentColumnCount >= requiredColumnCount) return;

  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(target.spreadsheet_id)}`;
  await googleFetch(`${baseUrl}:batchUpdate`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      requests: [{
        appendDimension: {
          sheetId: sheet.properties.sheetId,
          dimension: "COLUMNS",
          length: requiredColumnCount - currentColumnCount,
        },
      }],
    }),
  });
}

async function ensureEmailInfrastructure(accessToken, pipeline) {
  const metadata = await getSpreadsheetMetadata(accessToken, pipeline.spreadsheet_id);
  const titles = new Set((metadata.sheets || []).map((sheet) => sheet.properties?.title));
  const requiredTabs = [EMAIL_OUTPUT_TAB, EMAIL_SETTINGS_TAB, EMAIL_EVENT_LOG_TAB];
  const missing = requiredTabs.filter((title) => !titles.has(title));
  if (missing.length) {
    const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(pipeline.spreadsheet_id)}`;
    await googleFetch(`${baseUrl}:batchUpdate`, accessToken, {
      method: "POST",
      body: JSON.stringify({ requests: missing.map((title) => ({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } })) }),
    });
  }

  // The master registration Sheet predates the two helper columns (AS:AT).
  // Values API writes do not grow an existing sheet grid, so explicitly add
  // columns before writing their headers. This is idempotent: a wider grid is
  // left untouched.
  const masterSheet = (metadata.sheets || []).find((sheet) => sheet.properties?.title === pipeline.tab_name);
  const requiredMasterColumnCount = spreadsheetColumnNumber(STUDENT_FIRST_NAME_COLUMN);
  const currentMasterColumnCount = Number(masterSheet?.properties?.gridProperties?.columnCount || 0);
  if (masterSheet && currentMasterColumnCount > 0 && currentMasterColumnCount < requiredMasterColumnCount) {
    const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(pipeline.spreadsheet_id)}`;
    await googleFetch(`${baseUrl}:batchUpdate`, accessToken, {
      method: "POST",
      body: JSON.stringify({
        requests: [{
          appendDimension: {
            sheetId: masterSheet.properties.sheetId,
            dimension: "COLUMNS",
            length: requiredMasterColumnCount - currentMasterColumnCount,
          },
        }],
      }),
    });
  }

  const writes = [
    { range: `${quoteSheetName(EMAIL_OUTPUT_TAB)}!A1:AH1`, values: [EMAIL_OUTPUT_HEADERS] },
    { range: `${quoteSheetName(EMAIL_EVENT_LOG_TAB)}!A1:I1`, values: [EMAIL_EVENT_LOG_HEADERS] },
    { range: `${quoteSheetName(pipeline.tab_name)}!${CONTACT_FIRST_NAME_COLUMN}1:${STUDENT_FIRST_NAME_COLUMN}1`, values: [["E-mail kapcsolattartó keresztnév", "E-mail növendék keresztnév"]] },
  ];
  const settingsRows = missing.includes(EMAIL_SETTINGS_TAB)
    ? []
    : await readSheetRows(accessToken, pipeline.spreadsheet_id, EMAIL_SETTINGS_TAB, "A:H");
  if (!settingsRows.length || text(settingsRows[0]?.[0]) !== "Kulcs") {
    const defaults = emailSettingsSheetRows();
    writes.push({ range: `${quoteSheetName(EMAIL_SETTINGS_TAB)}!A1:H${defaults.length}`, values: defaults });
  }
  await writeSheetRanges(accessToken, pipeline.spreadsheet_id, writes);
  await ensureEmailOutputStatusFormatting(accessToken, pipeline.spreadsheet_id, metadata);
  return { created_tabs: missing, output_columns: EMAIL_OUTPUT_HEADERS.length, settings_initialized: !settingsRows.length };
}

async function ensureEmailOutputStatusFormatting(accessToken, spreadsheetId, metadata) {
  const emailSheet = (metadata.sheets || []).find((sheet) => sheet.properties?.title === EMAIL_OUTPUT_TAB);
  if (!emailSheet) return;

  const greenFormat = {
    backgroundColor: { red: 0.8509804, green: 0.9411765, blue: 0.827451 },
    backgroundColorStyle: { rgbColor: { red: 0.8509804, green: 0.9411765, blue: 0.827451 } },
  };
  const statusFormula = 'OR($S2=TRUE,$M2="KÉZBESÍTVE",$M2="ELKÜLDVE")';
  const existingRules = emailSheet.conditionalFormats || [];
  const ruleIndex = existingRules.findIndex((rule) =>
    rule.booleanRule?.condition?.type === "CUSTOM_FORMULA"
    && rule.booleanRule.condition.values?.some((value) => text(value.userEnteredValue).includes("$S2=TRUE")),
  );
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  const rule = {
    ranges: [{
      sheetId: emailSheet.properties.sheetId,
      startRowIndex: 1,
      startColumnIndex: 0,
      endColumnIndex: EMAIL_OUTPUT_HEADERS.length,
    }],
    booleanRule: {
      condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=${statusFormula}` }] },
      format: ruleIndex >= 0 ? existingRules[ruleIndex].booleanRule?.format || greenFormat : greenFormat,
    },
  };
  const request = ruleIndex >= 0
    ? { updateConditionalFormatRule: { sheetId: emailSheet.properties.sheetId, index: ruleIndex, rule } }
    : { addConditionalFormatRule: { index: 0, rule } };
  await googleFetch(`${baseUrl}:batchUpdate`, accessToken, {
    method: "POST",
    body: JSON.stringify({ requests: [request] }),
  });
}

async function loadEmailSettings(accessToken, pipeline) {
  const metadata = await getSpreadsheetMetadata(accessToken, pipeline.spreadsheet_id);
  const exists = (metadata.sheets || []).some((sheet) => sheet.properties?.title === EMAIL_SETTINGS_TAB);
  if (!exists) return { settings: defaultEmailSettings(), configured: false };
  const rows = await readSheetRows(accessToken, pipeline.spreadsheet_id, EMAIL_SETTINGS_TAB, "A:H");
  if (text(rows[0]?.[0]) !== "Kulcs") return { settings: defaultEmailSettings(), configured: false };
  return { settings: parseEmailSettings(rows), configured: true };
}

async function refreshEmailDrafts(accessToken, pipeline, entryIds = null) {
  const [masterRows, configRows, emailRows, emailSettings] = await Promise.all([
    readSheetRows(accessToken, pipeline.spreadsheet_id, pipeline.tab_name, "A:AT"),
    readSheetRows(accessToken, pipeline.spreadsheet_id, AUTOMATION_CONFIG_TAB, "A:Y"),
    readSheetRows(accessToken, pipeline.spreadsheet_id, EMAIL_OUTPUT_TAB, "A:AH"),
    loadEmailSettings(accessToken, pipeline),
  ]);
  if (text(masterRows[0]?.[0]) !== "Közlemény") throw new Error("A fő Sheet első oszlopa nem Közlemény.");
  if (text(configRows[0]?.[0]) !== "Tanfolyam kulcs") throw new Error("Az Automata kalk órarend-fejléce hiányzik.");
  if (text(emailRows[0]?.[0]) !== "Küldési kulcs") throw new Error("Az E-mail kimenet fejléce hiányzik.");

  const config = parseAutomationConfig(configRows);
  const mutableEmailRows = emailRows.map((row) => [...row]);
  const writes = [];
  const results = [];
  const now = new Date().toISOString();

  for (let index = 1; index < masterRows.length; index += 1) {
    const row = masterRows[index] || [];
    const entryId = text(row[0]);
    if (!entryId || !text(row[5]) || (entryIds && !entryIds.has(entryId))) continue;
    const registration = registrationFromMasterRow(row);
    const calculation = calculateRegistration(registration, config);
    const mainRow = index + 1;
    const firstClassValue = calculation.firstClass ? `${formatDate(calculation.firstClass.date)} ${calculation.firstClass.startTime}` : "";
    const eventType = calculation.isTrial ? EMAIL_EVENT.TRIAL : EMAIL_EVENT.ENROLLMENT;
    const draft = calculation.status === AUTOMATION_STATUS.READY
      ? buildEmailDraft(registration, calculation, emailSettings.settings, eventType)
      : emptyEmailDraft(eventType);
    const sourceHash = await sha256(JSON.stringify({
      registration,
      calculation: serializableCalculation(calculation),
      eventType,
      templateVersion: TEMPLATE_VERSION,
      templateKey: draft.templateKey,
      templateId: draft.templateId,
      params: draft.params,
      settingsConfigured: emailSettings.configured,
    }));
    const automationValues = [
      firstClassValue, calculation.semester || "", calculation.feeBand || "", calculation.feeCategory || "",
      calculation.discount || "", calculation.status,
      [calculation.manualReason, draft.manualReason, draft.configurationWarning].filter(Boolean).join(" "),
      sourceHash, TEMPLATE_VERSION, now,
    ];
    if (calculation.status === AUTOMATION_STATUS.READY && calculation.isTrial && !text(registration.trialDate)) {
      writes.push({ range: `${quoteSheetName(pipeline.tab_name)}!${TRIAL_DATE_COLUMN}${mainRow}`, values: [[formatDate(calculation.firstClass.date)]] });
    }
    writes.push({ range: `${quoteSheetName(pipeline.tab_name)}!${AUTOMATION_START_COLUMN}${mainRow}:${AUTOMATION_END_COLUMN}${mainRow}`, values: [automationValues] });
    if (calculation.status === AUTOMATION_STATUS.READY && !calculation.isTrial && calculation.fee) {
      const feeColumn = calculation.semester === 2 ? "AC" : "J";
      writes.push({ range: `${quoteSheetName(pipeline.tab_name)}!${feeColumn}${mainRow}`, values: [[calculation.fee]] });
    }
    if (!text(registration.contactFirstName) && draft.contactFirstName) {
      writes.push({ range: `${quoteSheetName(pipeline.tab_name)}!${CONTACT_FIRST_NAME_COLUMN}${mainRow}`, values: [[draft.contactFirstName]] });
    }
    if (!text(registration.studentFirstName) && draft.studentFirstName) {
      writes.push({ range: `${quoteSheetName(pipeline.tab_name)}!${STUDENT_FIRST_NAME_COLUMN}${mainRow}`, values: [[draft.studentFirstName]] });
    }

    const periodKey = emailPeriodKey(registration, calculation);
    const sendKey = `${entryId}|${eventType}|${periodKey}|${TEMPLATE_VERSION}`;
    if (hasLegacyManualEmailHistory(mutableEmailRows, entryId)) {
      results.push({
        entry_id: entryId,
        row_index: mainRow,
        event_type: eventType,
        status: AUTOMATION_STATUS.MANUAL,
        reason: "Korábbi rendszerben manuálisan elküldve; automatikus piszkozat nem készül.",
        fee: calculation.fee || "",
        first_class: firstClassValue,
      });
      continue;
    }
    const existingIndex = findExistingEmailRowIndex(mutableEmailRows, sendKey, entryId, eventType, periodKey);
    const existing = existingIndex >= 0 ? mutableEmailRows[existingIndex] : [];
    if (existingIndex >= 0 && text(existing[EMAIL_COLUMN.SEND_KEY]) !== sendKey && isChecked(existing[EMAIL_COLUMN.MANUAL_SENT])) {
      results.push({
        entry_id: entryId,
        row_index: mainRow,
        event_type: eventType,
        status: AUTOMATION_STATUS.MANUAL,
        reason: "Korábban manuálisan elküldve; új automatikus piszkozat nem készül.",
        fee: calculation.fee || "",
        first_class: firstClassValue,
      });
      continue;
    }
    if (text(existing[15]) !== sourceHash) {
      const manualSent = isChecked(existing[18]);
      const baseStatus = calculation.status === AUTOMATION_STATUS.READY
        && !draft.manualReason && draft.templateId
        ? AUTOMATION_STATUS.READY
        : AUTOMATION_STATUS.MANUAL;
      const queueStatus = isFinalEmailStatus(text(existing[12])) || manualSent
        ? AUTOMATION_STATUS.CHANGED_AFTER_SEND
        : baseStatus;
      const explanation = [
        calculation.explanation || calculation.manualReason,
        draft.manualReason,
        draft.configurationWarning,
        emailSettings.configured ? "" : "Az E-mail beállítások fül még nincs inicializálva; kódalapú alapértékek láthatók.",
      ].filter(Boolean).join(" ");
      const queueRow = [
        sendKey, entryId, periodKey, TEMPLATE_VERSION, registration.email, draft.subject, draft.plain, draft.html,
        firstClassValue, calculation.fee || "", explanation, false,
        queueStatus, text(existing[13]), "", sourceHash, now, text(existing[17]),
        manualSent, text(existing[19]), text(existing[20]),
        eventType, draft.audienceType, draft.venueCode, draft.templateKey, draft.templateId,
        draft.params ? JSON.stringify(draft.params) : "", "", "", "", "", "", "", "",
      ];
      queueRow[EMAIL_COLUMN.REVISION_HASH] = await emailRevisionHashFromRow(queueRow);
      const queueRowIndex = existingIndex >= 0 ? existingIndex + 1 : firstEmptyRow(mutableEmailRows, 1);
      while (mutableEmailRows.length < queueRowIndex) mutableEmailRows.push([]);
      mutableEmailRows[queueRowIndex - 1] = queueRow;
      writes.push({ range: `${quoteSheetName(EMAIL_OUTPUT_TAB)}!A${queueRowIndex}:AH${queueRowIndex}`, values: [queueRow] });
    }

    const finalReason = [calculation.manualReason, draft.manualReason, draft.configurationWarning].filter(Boolean).join(" ");
    const resultStatus = calculation.status === AUTOMATION_STATUS.READY && !finalReason
      ? AUTOMATION_STATUS.READY
      : AUTOMATION_STATUS.MANUAL;
    results.push({ entry_id: entryId, row_index: mainRow, event_type: eventType, status: resultStatus, reason: finalReason, fee: calculation.fee || "", first_class: firstClassValue });
  }

  if (writes.length) await writeSheetRanges(accessToken, pipeline.spreadsheet_id, writes);
  return {
    processed: results.length,
    ready: results.filter((item) => item.status === AUTOMATION_STATUS.READY).length,
    manual: results.filter((item) => item.status === AUTOMATION_STATUS.MANUAL).length,
    results,
  };
}

function emptyEmailDraft(eventType) {
  return {
    subject: "", plain: "", html: "", eventType, audienceType: "", venueCode: "", templateKey: "",
    templateId: "", params: null, contactFirstName: "", studentFirstName: "", manualReason: "", configurationWarning: "",
  };
}

async function refreshPaymentEmailDrafts(accessToken, pipeline, entryIds) {
  const [masterRows, emailRows, emailSettings] = await Promise.all([
    readSheetRows(accessToken, pipeline.spreadsheet_id, pipeline.tab_name, "A:AT"),
    readSheetRows(accessToken, pipeline.spreadsheet_id, EMAIL_OUTPUT_TAB, "A:AH"),
    loadEmailSettings(accessToken, pipeline),
  ]);
  if (text(masterRows[0]?.[0]) !== "Közlemény") throw new Error("A fő Sheet első oszlopa nem Közlemény.");
  if (text(emailRows[0]?.[0]) !== "Küldési kulcs") throw new Error("Az E-mail kimenet fejléce hiányzik.");

  const mutableEmailRows = emailRows.map((row) => [...row]);
  const writes = [];
  const results = [];
  const now = new Date().toISOString();

  for (let index = 1; index < masterRows.length; index += 1) {
    const row = masterRows[index] || [];
    const entryId = text(row[0]);
    if (!entryId || !entryIds.has(entryId)) continue;
    const registration = registrationFromMasterRow(row);
    if (!registration.paidDate) continue;
    const draft = buildEmailDraft(registration, {}, emailSettings.settings, EMAIL_EVENT.PAYMENT_RECEIVED);
    const sourceHash = await sha256(JSON.stringify({
      registration,
      paidDate: registration.paidDate,
      eventType: EMAIL_EVENT.PAYMENT_RECEIVED,
      templateVersion: TEMPLATE_VERSION,
      templateKey: draft.templateKey,
      templateId: draft.templateId,
      params: draft.params,
      settingsConfigured: emailSettings.configured,
    }));
    const periodKey = "PAYMENT_RECEIVED|1";
    const sendKey = `${entryId}|${periodKey}|${TEMPLATE_VERSION}`;
    if (hasLegacyManualEmailHistory(mutableEmailRows, entryId)) {
      results.push({
        entry_id: entryId,
        status: AUTOMATION_STATUS.MANUAL,
        reason: "Korábbi rendszerben manuálisan elküldve; automatikus piszkozat nem készül.",
      });
      continue;
    }
    const existingIndex = findExistingEmailRowIndex(
      mutableEmailRows, sendKey, entryId, EMAIL_EVENT.PAYMENT_RECEIVED, periodKey,
    );
    const existing = existingIndex >= 0 ? mutableEmailRows[existingIndex] : [];
    if (existingIndex >= 0 && text(existing[EMAIL_COLUMN.SEND_KEY]) !== sendKey && isChecked(existing[EMAIL_COLUMN.MANUAL_SENT])) {
      results.push({
        entry_id: entryId,
        status: AUTOMATION_STATUS.MANUAL,
        reason: "Korábban manuálisan elküldve; új automatikus piszkozat nem készül.",
      });
      continue;
    }
    if (text(existing[EMAIL_COLUMN.SOURCE_HASH]) === sourceHash) {
      results.push({ entry_id: entryId, status: text(existing[EMAIL_COLUMN.STATUS]), reason: text(existing[EMAIL_COLUMN.EXPLANATION]) });
      continue;
    }

    const manualSent = isChecked(existing[EMAIL_COLUMN.MANUAL_SENT]);
    const baseStatus = !draft.manualReason && draft.templateId ? AUTOMATION_STATUS.READY : AUTOMATION_STATUS.MANUAL;
    const queueStatus = isFinalEmailStatus(text(existing[EMAIL_COLUMN.STATUS])) || manualSent
      ? AUTOMATION_STATUS.CHANGED_AFTER_SEND
      : baseStatus;
    const explanation = [
      `Befizetés könyvelve: ${registration.paidDate}.`, draft.manualReason, draft.configurationWarning,
      emailSettings.configured ? "" : "Az E-mail beállítások fül még nincs inicializálva; kódalapú alapértékek láthatók.",
    ].filter(Boolean).join(" ");
    const queueRow = [
      sendKey, entryId, periodKey, TEMPLATE_VERSION, registration.email, draft.subject, draft.plain, draft.html,
      "", text(row[9]), explanation, false, queueStatus, text(existing[EMAIL_COLUMN.MESSAGE_ID]), "", sourceHash,
      now, text(existing[EMAIL_COLUMN.ACCEPTED_AT]), manualSent, text(existing[EMAIL_COLUMN.MANUAL_SENT_AT]),
      text(existing[EMAIL_COLUMN.MANUAL_SENT_BY]), EMAIL_EVENT.PAYMENT_RECEIVED, draft.audienceType, "", draft.templateKey,
      draft.templateId, JSON.stringify(draft.params || {}), "", "", "", "", "", "", "",
    ];
    queueRow[EMAIL_COLUMN.REVISION_HASH] = await emailRevisionHashFromRow(queueRow);
    const queueRowIndex = existingIndex >= 0 ? existingIndex + 1 : firstEmptyRow(mutableEmailRows, 1);
    while (mutableEmailRows.length < queueRowIndex) mutableEmailRows.push([]);
    mutableEmailRows[queueRowIndex - 1] = queueRow;
    writes.push({ range: `${quoteSheetName(EMAIL_OUTPUT_TAB)}!A${queueRowIndex}:AH${queueRowIndex}`, values: [queueRow] });
    const mainRow = index + 1;
    if (!registration.contactFirstName && draft.contactFirstName) {
      writes.push({ range: `${quoteSheetName(pipeline.tab_name)}!${CONTACT_FIRST_NAME_COLUMN}${mainRow}`, values: [[draft.contactFirstName]] });
    }
    if (!registration.studentFirstName && draft.studentFirstName) {
      writes.push({ range: `${quoteSheetName(pipeline.tab_name)}!${STUDENT_FIRST_NAME_COLUMN}${mainRow}`, values: [[draft.studentFirstName]] });
    }
    results.push({ entry_id: entryId, status: queueStatus, reason: explanation });
  }

  if (writes.length) await writeSheetRanges(accessToken, pipeline.spreadsheet_id, writes);
  return { processed: results.length, results };
}

async function markAutomationErrors(accessToken, pipeline, results, message) {
  const now = new Date().toISOString();
  const data = results.map((item) => ({
    range: `${quoteSheetName(pipeline.tab_name)}!AN${item.rowIndex}:AR${item.rowIndex}`,
    values: [[AUTOMATION_STATUS.ERROR, message, "", TEMPLATE_VERSION, now]],
  }));
  if (data.length) await writeSheetRanges(accessToken, pipeline.spreadsheet_id, data);
}

function registrationFromMasterRow(row) {
  return {
    entryId: text(row[0]), courseRaw: text(row[1]), studentName: text(row[5]), submittedAt: text(row[6]),
    startDate: text(row[7]), trialSignup: text(row[8]), alternateAttendance: text(row[13]), email: text(row[17]),
    birthDate: text(row[14]),
    parentName: text(row[18]), districtCardNumber: text(row[19]), districtCardExpiry: text(row[20]),
    siblingName: text(row[22]), siblingGroup: text(row[23]), carryoverAmount: text(row[24]) || text(row[27]),
    trialDate: text(row[33]), paidDate: text(row[10]),
    contactFirstName: text(row[44]), studentFirstName: text(row[45]),
  };
}

function serializableCalculation(calculation) {
  return { ...calculation, firstClass: calculation.firstClass ? { ...calculation.firstClass, date: formatDate(calculation.firstClass.date) } : null };
}

function emailPeriodKey(registration, calculation) {
  if (normalizeForMatch(registration.trialSignup) === "igen") return "PRÓBA";
  if (calculation.semester) return String(calculation.semester);
  const candidate = text(registration.startDate) || text(registration.submittedAt);
  const month = Number((candidate.match(/^\d{4}[-./](\d{1,2})/) || [])[1]);
  return month >= 2 && month <= 5 ? "2" : "1";
}

function findExistingEmailRowIndex(rows, sendKey, entryId, eventType, periodKey) {
  const exactIndex = rows.findIndex((emailRow, emailIndex) => emailIndex > 0 && text(emailRow[EMAIL_COLUMN.SEND_KEY]) === sendKey);
  if (exactIndex >= 0) return exactIndex;

  // A template version change must refresh the existing draft, not append a
  // second row for the same registration and email event. Manually sent rows
  // remain authoritative too: refreshEmailDrafts will mark them as changed
  // after send instead of replacing their sending history.
  return rows.findIndex((emailRow, emailIndex) => (
    emailIndex > 0
    && text(emailRow[EMAIL_COLUMN.ENTRY_ID]) === entryId
    && emailEventTypeFromRow(emailRow) === eventType
    && emailPeriodKeyFromRow(emailRow) === periodKey
  ));
}

function hasLegacyManualEmailHistory(rows, entryId) {
  return rows.some((emailRow, emailIndex) => (
    emailIndex > 0
    && isChecked(emailRow[EMAIL_COLUMN.MANUAL_SENT])
    && text(emailRow[EMAIL_COLUMN.ENTRY_ID]) === entryId
    && text(emailRow[EMAIL_COLUMN.TEMPLATE_VERSION]) !== TEMPLATE_VERSION
  ));
}

function emailEventTypeFromRow(row) {
  const explicitEventType = text(row[EMAIL_COLUMN.EVENT_TYPE]);
  if (explicitEventType) return explicitEventType;
  const keyParts = text(row[EMAIL_COLUMN.SEND_KEY]).split("|");
  if (keyParts[1] === EMAIL_EVENT.PAYMENT_RECEIVED || keyParts[1] === "PAYMENT_RECEIVED") return EMAIL_EVENT.PAYMENT_RECEIVED;
  return keyParts[1] === "PRÓBA" ? EMAIL_EVENT.TRIAL : EMAIL_EVENT.ENROLLMENT;
}

function emailPeriodKeyFromRow(row) {
  const explicitPeriodKey = text(row[EMAIL_COLUMN.PERIOD]);
  if (explicitPeriodKey) return explicitPeriodKey;
  const keyParts = text(row[EMAIL_COLUMN.SEND_KEY]).split("|");
  return keyParts[1] === "PAYMENT_RECEIVED" ? `${keyParts[1]}|${keyParts[2] || ""}` : text(keyParts[1]);
}

function firstEmptyRow(rows, keyColumn) {
  for (let index = 1; index < rows.length; index += 1) if (!text(rows[index]?.[keyColumn - 1])) return index + 1;
  return Math.max(2, rows.length + 1);
}

async function emailRevisionHashFromRow(row) {
  const fields = [
    EMAIL_COLUMN.TO, EMAIL_COLUMN.SUBJECT, EMAIL_COLUMN.PLAIN, EMAIL_COLUMN.HTML,
    EMAIL_COLUMN.TEMPLATE_VERSION, EMAIL_COLUMN.SOURCE_HASH, EMAIL_COLUMN.EVENT_TYPE,
    EMAIL_COLUMN.AUDIENCE_TYPE, EMAIL_COLUMN.VENUE_CODE, EMAIL_COLUMN.TEMPLATE_KEY,
    EMAIL_COLUMN.TEMPLATE_ID, EMAIL_COLUMN.PARAMS_JSON,
  ].map((index) => text(row[index]));
  return sha256(fields.join("\u001f"));
}

function isFinalEmailStatus(status) {
  return [
    AUTOMATION_STATUS.ACCEPTED, AUTOMATION_STATUS.DELIVERED, AUTOMATION_STATUS.SENT,
    AUTOMATION_STATUS.SOFT_BOUNCE, AUTOMATION_STATUS.HARD_BOUNCE, AUTOMATION_STATUS.BLOCKED,
    AUTOMATION_STATUS.INVALID, AUTOMATION_STATUS.SUPPRESSED,
  ].includes(status);
}

async function recordBrevoEvent(accessToken, pipeline, payload) {
  const [eventRows, emailRows] = await Promise.all([
    readSheetRows(accessToken, pipeline.spreadsheet_id, EMAIL_EVENT_LOG_TAB, "A:I"),
    readSheetRows(accessToken, pipeline.spreadsheet_id, EMAIL_OUTPUT_TAB, "A:AH"),
  ]);
  if (text(eventRows[0]?.[0]) !== "Eseményazonosító") throw new Error("Az E-mail eseménynapló fejléce hiányzik.");
  if (text(emailRows[0]?.[0]) !== "Küldési kulcs") throw new Error("Az E-mail kimenet fejléce hiányzik.");

  const rawEvent = normalizeBrevoEvent(payload.event || payload.type);
  const messageId = text(payload["message-id"] || payload.messageId || payload.message_id);
  const recipient = text(payload.email || payload.recipient);
  const eventAt = brevoEventTimestamp(payload);
  const sendKeyFromPayload = brevoSendKey(payload);
  const eventId = await sha256(JSON.stringify({
    brevoId: text(payload.id || payload.event_id), messageId, rawEvent, recipient, eventAt,
  }));
  if (eventRows.slice(1).some((row) => text(row[0]) === eventId
      || (messageId && text(row[1]) === messageId && text(row[8]) === rawEvent))) {
    return { duplicate: true, event: rawEvent, matched: false };
  }

  let emailIndex = -1;
  if (sendKeyFromPayload) {
    emailIndex = emailRows.findIndex((row, index) => index > 0 && text(row[EMAIL_COLUMN.SEND_KEY]) === sendKeyFromPayload);
  }
  if (emailIndex < 0 && messageId) {
    emailIndex = emailRows.findIndex((row, index) => index > 0 && text(row[EMAIL_COLUMN.MESSAGE_ID]) === messageId);
  }
  const matchedRow = emailIndex >= 0 ? emailRows[emailIndex] : [];
  const sendKey = text(matchedRow[EMAIL_COLUMN.SEND_KEY]) || sendKeyFromPayload;
  const reason = text(payload.reason || payload.description || payload.response || payload.error);
  const receivedAt = new Date().toISOString();
  const eventRow = [eventId, messageId, sendKey, brevoEventLabel(rawEvent), recipient, eventAt, receivedAt, reason, rawEvent];
  const writes = [];

  const mappedStatus = brevoStatus(rawEvent) || AUTOMATION_STATUS.NEEDS_REVIEW;
  if (emailIndex >= 0 && mappedStatus) {
    const currentStatus = text(matchedRow[EMAIL_COLUMN.STATUS]);
    const nextStatus = brevoNextStatus(currentStatus, mappedStatus);
    if (nextStatus !== currentStatus || reason) {
      const rowIndex = emailIndex + 1;
      const deliveryError = isBrevoFailureStatus(nextStatus) ? (reason || brevoEventLabel(rawEvent)) : "";
      writes.push({
        range: `${quoteSheetName(EMAIL_OUTPUT_TAB)}!M${rowIndex}:O${rowIndex}`,
        values: [[nextStatus, messageId || text(matchedRow[EMAIL_COLUMN.MESSAGE_ID]), deliveryError]],
      });
      writes.push({
        range: `${quoteSheetName(EMAIL_OUTPUT_TAB)}!AF${rowIndex}:AH${rowIndex}`,
        values: [[nextStatus, eventAt || receivedAt, deliveryError]],
      });
    }
  }

  // A Brevo több eseményt is küldhet egyszerre. Az append endpoint atomi, míg
  // a "következő üres sor" alapú írásnál a párhuzamos Worker-kérések ugyanazt
  // a sort választhatták volna, és felülírták volna egymást.
  await Promise.all([
    appendSheetRows(accessToken, pipeline.spreadsheet_id, EMAIL_EVENT_LOG_TAB, [eventRow]),
    writes.length ? writeSheetRanges(accessToken, pipeline.spreadsheet_id, writes) : Promise.resolve(),
  ]);
  return { duplicate: false, event: rawEvent, matched: emailIndex >= 0, send_key: sendKey, status: mappedStatus || "" };
}

function brevoSendKey(payload) {
  const candidates = [
    payload["X-Mailin-custom"], payload["x-mailin-custom"], payload.custom_header,
    payload.headers?.["X-Mailin-custom"], payload.headers?.["x-mailin-custom"],
  ];
  for (const candidate of candidates) {
    const match = text(candidate).match(/(?:^|[|;,\s])send_key:([^;,]+?)(?=$|[;,])/i);
    if (match) return match[1].trim();
    const simple = text(candidate).match(/^send_key:(.+)$/i);
    if (simple) return simple[1].trim();
  }
  return "";
}

function brevoEventTimestamp(payload) {
  const raw = payload.ts_event || payload.ts || payload.timestamp;
  if (Number.isFinite(Number(raw)) && Number(raw) > 0) {
    const milliseconds = Number(raw) > 10_000_000_000 ? Number(raw) : Number(raw) * 1000;
    return new Date(milliseconds).toISOString();
  }
  const parsed = Date.parse(text(payload.date));
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString();
}

function brevoStatus(event) {
  const statuses = {
    request: AUTOMATION_STATUS.ACCEPTED,
    delivered: AUTOMATION_STATUS.DELIVERED,
    soft_bounce: AUTOMATION_STATUS.SOFT_BOUNCE,
    hard_bounce: AUTOMATION_STATUS.HARD_BOUNCE,
    blocked: AUTOMATION_STATUS.BLOCKED,
    invalid: AUTOMATION_STATUS.INVALID,
    spam: AUTOMATION_STATUS.SUPPRESSED,
    unsubscribed: AUTOMATION_STATUS.SUPPRESSED,
  };
  return statuses[event] || "";
}

function normalizeBrevoEvent(value) {
  return text(value).replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_").toLowerCase();
}

function brevoEventLabel(event) {
  return ({
    request: "Brevo fogadta", delivered: "Kézbesítve", soft_bounce: "Puha visszapattanás",
    hard_bounce: "Kemény visszapattanás", blocked: "Blokkolva", invalid: "Érvénytelen cím",
    spam: "Spamként jelölve", unsubscribed: "Leiratkozás",
  })[event] || event || "Ismeretlen Brevo-esemény";
}

function isBrevoFailureStatus(status) {
  return [
    AUTOMATION_STATUS.SOFT_BOUNCE, AUTOMATION_STATUS.HARD_BOUNCE, AUTOMATION_STATUS.BLOCKED,
    AUTOMATION_STATUS.INVALID, AUTOMATION_STATUS.SUPPRESSED,
  ].includes(status);
}

function brevoNextStatus(current, incoming) {
  if (current === AUTOMATION_STATUS.DELIVERED) return current;
  if (isBrevoFailureStatus(current)
      && [AUTOMATION_STATUS.ACCEPTED, AUTOMATION_STATUS.NEEDS_REVIEW].includes(incoming)) return current;
  return incoming;
}

async function sendApprovedEmails(accessToken, pipeline, env) {
  if (!env.BREVO_API_KEY || !env.BREVO_SENDER_EMAIL) throw new Error("Hiányzik a BREVO_API_KEY vagy a BREVO_SENDER_EMAIL Worker secret.");
  await refreshEmailDrafts(accessToken, pipeline, null);
  const rows = await readSheetRows(accessToken, pipeline.spreadsheet_id, EMAIL_OUTPUT_TAB, "A:AH");
  if (text(rows[0]?.[0]) !== "Küldési kulcs") throw new Error("Az E-mail kimenet fejléce hiányzik.");
  let accepted = 0;
  let skipped = 0;
  let failed = 0;
  let needsReview = 0;
  const verifiedTemplates = new Map();
  const suppressedRecipients = new Set(rows.slice(1)
    .filter((row) => [
      AUTOMATION_STATUS.HARD_BOUNCE, AUTOMATION_STATUS.BLOCKED,
      AUTOMATION_STATUS.INVALID, AUTOMATION_STATUS.SUPPRESSED,
    ].includes(text(row[EMAIL_COLUMN.STATUS])))
    .map((row) => text(row[EMAIL_COLUMN.TO]).toLowerCase())
    .filter(Boolean));

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] || [];
    const sendKey = text(row[EMAIL_COLUMN.SEND_KEY]);
    const approved = isChecked(row[EMAIL_COLUMN.APPROVED]);
    const status = text(row[EMAIL_COLUMN.STATUS]);
    const manualSent = isChecked(row[EMAIL_COLUMN.MANUAL_SENT]);
    if (!sendKey || !approved || manualSent || isFinalEmailStatus(status) || status === AUTOMATION_STATUS.NEEDS_REVIEW) {
      if (sendKey) skipped += 1;
      continue;
    }
    // APPROVED is the durable "claimed for sending" marker. If a Worker dies
    // after Brevo accepted the message but before the final Sheet write, a
    // later click must not send the row again automatically.
    if (status !== AUTOMATION_STATUS.READY) { skipped += 1; continue; }
    if (inFlightSends.has(sendKey)) { skipped += 1; continue; }

    const rowIndex = index + 1;
    if (suppressedRecipients.has(text(row[EMAIL_COLUMN.TO]).toLowerCase())) {
      const message = "A címhez korábbi hard bounce, blokkolás, érvénytelen cím vagy letiltás tartozik; automatikus küldés leállítva.";
      await writeSheetRanges(accessToken, pipeline.spreadsheet_id, [
        { range: `${quoteSheetName(EMAIL_OUTPUT_TAB)}!L${rowIndex}:O${rowIndex}`, values: [[false, AUTOMATION_STATUS.SUPPRESSED, text(row[EMAIL_COLUMN.MESSAGE_ID]), message]] },
        { range: `${quoteSheetName(EMAIL_OUTPUT_TAB)}!AF${rowIndex}:AH${rowIndex}`, values: [[AUTOMATION_STATUS.SUPPRESSED, new Date().toISOString(), message]] },
      ]);
      skipped += 1;
      continue;
    }
    inFlightSends.add(sendKey);
    try {
      if (!text(row[EMAIL_COLUMN.TO]) || !text(row[EMAIL_COLUMN.SUBJECT]) || !text(row[EMAIL_COLUMN.PLAIN]) || !text(row[EMAIL_COLUMN.HTML])) {
        throw new Error("Hiányzik a címzett, tárgy vagy levéltörzs.");
      }
      if (!text(row[EMAIL_COLUMN.TEMPLATE_ID]) || !text(row[EMAIL_COLUMN.PARAMS_JSON])) {
        throw new Error("Hiányzik a Brevo template ID vagy a paraméterek JSON értéke.");
      }
      if (/{{|}}|{%|%}/.test([row[EMAIL_COLUMN.SUBJECT], row[EMAIL_COLUMN.PLAIN], row[EMAIL_COLUMN.HTML]].join("\n"))) {
        throw new Error("Feloldatlan merge tag maradt a jóváhagyott levélben.");
      }
      const currentRevisionHash = await emailRevisionHashFromRow(row);
      if (currentRevisionHash !== text(row[EMAIL_COLUMN.REVISION_HASH])
          || currentRevisionHash !== text(row[EMAIL_COLUMN.APPROVED_HASH])) {
        await writeSheetRanges(accessToken, pipeline.spreadsheet_id, [
          { range: `${quoteSheetName(EMAIL_OUTPUT_TAB)}!L${rowIndex}:M${rowIndex}`, values: [[false, AUTOMATION_STATUS.MANUAL]] },
          { range: `${quoteSheetName(EMAIL_OUTPUT_TAB)}!O${rowIndex}`, values: [["A jóváhagyott revízió nem egyezik a jelenlegi levéllel; új jóváhagyás szükséges."]] },
          { range: `${quoteSheetName(EMAIL_OUTPUT_TAB)}!AC${rowIndex}:AE${rowIndex}`, values: [["", "", ""]] },
        ]);
        skipped += 1;
        continue;
      }
      let params;
      try { params = JSON.parse(text(row[EMAIL_COLUMN.PARAMS_JSON])); }
      catch { throw new Error("A Brevo paraméterek JSON értéke hibás."); }
      await verifyBrevoTemplate(env, {
        templateId: Number(row[EMAIL_COLUMN.TEMPLATE_ID]),
        templateKey: text(row[EMAIL_COLUMN.TEMPLATE_KEY]),
      }, verifiedTemplates);
      await writeSheetRanges(accessToken, pipeline.spreadsheet_id, [
        { range: `${quoteSheetName(EMAIL_OUTPUT_TAB)}!L${rowIndex}:M${rowIndex}`, values: [[false, AUTOMATION_STATUS.APPROVED]] },
      ]);
      const brevo = await sendBrevoEmail(env, {
        to: text(row[EMAIL_COLUMN.TO]),
        toName: params.recipient_first_name || "",
        templateId: Number(row[EMAIL_COLUMN.TEMPLATE_ID]),
        params,
        eventType: text(row[EMAIL_COLUMN.EVENT_TYPE]),
        sendKey,
      });
      const timestamp = new Date().toISOString();
      await writeSheetRanges(accessToken, pipeline.spreadsheet_id, [
        { range: `${quoteSheetName(EMAIL_OUTPUT_TAB)}!M${rowIndex}:R${rowIndex}`, values: [[AUTOMATION_STATUS.ACCEPTED, brevo.messageId || "", "", text(row[EMAIL_COLUMN.SOURCE_HASH]), timestamp, timestamp]] },
        { range: `${quoteSheetName(EMAIL_OUTPUT_TAB)}!AF${rowIndex}:AH${rowIndex}`, values: [[AUTOMATION_STATUS.ACCEPTED, timestamp, ""]] },
      ]);
      accepted += 1;
    } catch (error) {
      failed += 1;
      const failureStatus = error.uncertain ? AUTOMATION_STATUS.NEEDS_REVIEW : AUTOMATION_STATUS.ERROR;
      if (error.uncertain) needsReview += 1;
      await writeSheetRanges(accessToken, pipeline.spreadsheet_id, [
        { range: `${quoteSheetName(EMAIL_OUTPUT_TAB)}!M${rowIndex}:O${rowIndex}`, values: [[failureStatus, "", error.message || "Ismeretlen hiba."]] },
        { range: `${quoteSheetName(EMAIL_OUTPUT_TAB)}!AF${rowIndex}:AH${rowIndex}`, values: [[failureStatus, new Date().toISOString(), error.message || "Ismeretlen hiba."]] },
      ]);
    } finally {
      inFlightSends.delete(sendKey);
    }
  }
  return { accepted, sent: accepted, skipped, failed, needs_review: needsReview };
}

async function verifyBrevoTemplate(env, template, cache) {
  const cacheKey = `${template.templateId}|${template.templateKey}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const expected = brevoTemplateDefinitions().find((item) => item.key === template.templateKey);
  if (!expected) throw new Error(`Ismeretlen helyi Brevo-sablonkulcs: ${template.templateKey || "(üres)"}.`);
  const response = await fetch(`${BREVO_TEMPLATE_URL}/${encodeURIComponent(template.templateId)}`, {
    headers: { accept: "application/json", "api-key": env.BREVO_API_KEY },
  });
  if (!response.ok) throw new Error(`A Brevo-sablon visszaellenőrzése sikertelen (${response.status}): ${(await response.text()).slice(0, 300)}`);
  const actual = await response.json();
  if (!actual.isActive) throw new Error(`A Brevo-sablon inaktív: ${template.templateKey} (${template.templateId}).`);
  if (text(actual.subject) !== expected.subject || text(actual.htmlContent) !== text(expected.htmlContent)) {
    throw new Error(`A Brevo-sablon tartalma eltér a jóváhagyott repository-verziótól: ${template.templateKey} (${template.templateId}).`);
  }
  cache.set(cacheKey, actual);
  return actual;
}

async function sendBrevoEmail(env, message) {
  const idempotencyKey = await deterministicUuid(message.sendKey);
  let response;
  try {
    response = await fetch(BREVO_SEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": env.BREVO_API_KEY },
      body: JSON.stringify({
        sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME || "Budai Táncklub" },
        to: [{ email: message.to, name: message.toName || undefined }],
        templateId: message.templateId,
        params: message.params,
        replyTo: env.BREVO_REPLY_TO_EMAIL ? { email: env.BREVO_REPLY_TO_EMAIL } : undefined,
        tags: ["budai-tancklub", text(message.eventType).toLowerCase()].filter(Boolean),
        headers: { "Idempotency-Key": idempotencyKey, "X-Mailin-custom": `send_key:${message.sendKey}` },
      }),
    });
  } catch (cause) {
    const error = new Error(`Brevo küldési eredmény bizonytalan: ${cause.message || "hálózati hiba"}`);
    error.uncertain = true;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`Brevo küldési hiba (${response.status}): ${(await response.text()).slice(0, 300)}`);
    error.uncertain = response.status >= 500;
    throw error;
  }
  return response.json();
}

async function deterministicUuid(value) {
  const hex = await sha256(value);
  const chars = hex.slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = ["8", "9", "a", "b"][parseInt(chars[16], 16) % 4];
  const compact = chars.join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

async function sha256(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value))));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

async function appendSheetRows(accessToken, spreadsheetId, tabName, values) {
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  const range = encodeURIComponent(`${quoteSheetName(tabName)}!A:I`);
  await googleFetch(`${baseUrl}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, accessToken, {
    method: "POST",
    body: JSON.stringify({ values }),
  });
}

async function getSpreadsheetMetadata(accessToken, spreadsheetId) {
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  return googleFetch(`${baseUrl}?fields=sheets(properties(sheetId,title,gridProperties(columnCount)),conditionalFormats)`, accessToken);
}

function spreadsheetColumnNumber(column) {
  return [...String(column)].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
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
function isChecked(value) { return value === true || ["true", "igen", "1"].includes(text(value).toLowerCase()); }
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
  const skipped = result.skipped?.length || 0;
  return `<!doctype html><meta charset="utf-8"><title>Import kész</title><style>body{font:16px system-ui;max-width:680px;margin:48px auto;padding:0 20px}main{border:1px solid #ddd;border-radius:12px;padding:24px}</style><main><h1>Import elkészült</h1><p>${count} rekord feldolgozva.</p><ul><li>Új: ${created}</li><li>Kihagyva (már létező Gravity Forms ID): ${skipped}</li></ul><p>A Google Sheet frissítése befejeződött.</p></main>`;
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }

export {
  CSV_HEADERS, brevoSendKey, brevoStatus, emailRevisionHashFromRow, extractReferences, findMasterRow,
  mergeMasterRow, nameSuggestions, normalizeForMatch, parseCsv, parseCsvRegistrations,
  partitionManualImportRegistrations, paymentFromRow, recordBrevoEvent, registrationFromCsvRow,
};
