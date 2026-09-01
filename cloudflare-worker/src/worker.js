import * as XLSX from "xlsx";
import { AUTOMATION_STATUS, calculateRegistration, formatDate, parseAutomationConfig } from "./fee-engine.js";
import {
  appendStartRow,
  assertNoPartialBasicFilter,
  buildAppendOnlyImportPlan,
  semanticHash,
  sourceMatchesMaster,
  validateEmailRows,
  validateMasterRows,
} from "./recovery-integrity.js";
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
const EMAIL_RECONCILIATION_PATH_PREFIX = "/emails/reconcile/";
const EMAIL_SEND_PATH_PREFIX = "/emails/send/";
const EMAIL_SETUP_PATH_PREFIX = "/emails/setup/";
const BREVO_WEBHOOK_PATH = "/webhooks/brevo";
const AUTOMATION_CONFIG_TAB = "Tanfolyamok";
const EMAIL_OUTPUT_TAB = "E-mail kimenet";
const REFERENCE_CORRECTIONS_TAB = "Közlemény eltérések";
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
const DEFAULT_IMPORT_BACKUP_MAX_AGE_MINUTES = 60;
const DEFAULT_STAFF_SYNC_BACKUP_MAX_AGE_MINUTES = 60;
const inFlightSends = new Set();
const inFlightBrevoEvents = new Map();

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
      return disabledEndpoint("A befizetések érkeztetése a helyreállítás alatt ki van kapcsolva.");
    }

    const draftToken = getProtectedPathToken(url.pathname, EMAIL_DRAFTS_PATH_PREFIX);
    if (draftToken !== null) {
      return handleEmailDraftRefresh(request, env, draftToken);
    }

    const reconciliationToken = getProtectedPathToken(url.pathname, EMAIL_RECONCILIATION_PATH_PREFIX);
    if (reconciliationToken !== null) {
      return handleEmailReferenceReconciliation(request, env, reconciliationToken);
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

    return disabledEndpoint("A Gravity Forms webhook a helyreállítás alatt ki van kapcsolva; csak a kézi CSV-importtal azonos integritási kapu után térhet vissza.");
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
    const requestedMode = text(form.get("mode")).toLowerCase() || "plan";
    if (!["plan", "execute", "drafts"].includes(requestedMode)) {
      return html(importPage("Ez a művelet már nem érvényes. Nyisd meg újra az importoldalt."), 400);
    }
    if (requestedMode === "drafts") {
      if (recoveryMaintenanceEnabled(env)) return maintenanceHtmlResponse();
      const grant = await verifyImportDraftGrant(env, text(form.get("draft_grant")));
      const pipeline = getPipeline(env, grant.pipelineId);
      const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT);
      const automation = await refreshEmailDrafts(accessToken, pipeline, grant.entryIds);
      return html(importDraftResultPage(automation));
    }

    const file = form.get("file");
    if (!file || typeof file.text !== "function") {
      return html(importPage("Válassz ki egy CSV-fájlt."), 400);
    }
    const csvText = await file.text();
    const parsed = parseCsv(csvText);
    const registrations = parseCsvRegistrations(parsed);
    const pipeline = getPipeline(env, text(form.get("pipeline_id")) || defaultPipelineId(env));
    const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT);
    const snapshot = await readImportSnapshot(accessToken, pipeline);
    const plan = await buildAppendOnlyImportPlan({
      csvText,
      registrations,
      masterRows: snapshot.masterRows,
      emailRows: snapshot.emailRows,
    });
    if (requestedMode === "plan") return html(importPlanPage(plan, registrations.length));
    if (recoveryMaintenanceEnabled(env)) return maintenanceHtmlResponse();
    if (!safeEqual(text(form.get("plan_hash")), plan.plan_hash)) {
      return html(importPage("Közben megváltoztak az adatok. Ellenőrizd újra a fájlt."), 409);
    }
    const backup = await resolveImportBackupForExecution(request, env, accessToken, pipeline, snapshot, form);

    // A terv egy gyors, megelőző olvasás. Közvetlenül írás előtt még egyszer
    // teljesen újraépítjük; bármilyen köztes Sheet-változás megakasztja a futást.
    const executionSnapshot = await readImportSnapshot(accessToken, pipeline);
    const executionPlan = await buildAppendOnlyImportPlan({
      csvText,
      registrations,
      masterRows: executionSnapshot.masterRows,
      emailRows: executionSnapshot.emailRows,
    });
    if (!safeEqual(plan.plan_hash, executionPlan.plan_hash)) {
      return html(importPage("Közben megváltoztak az adatok. Ellenőrizd újra a fájlt."), 409);
    }
    const result = await appendOnlyMasterRegistrations(
      accessToken,
      pipeline,
      executionSnapshot.masterRows,
      executionPlan,
    );
    console.info("CSV import completed", JSON.stringify({
      pipeline_id: pipeline.pipeline_id,
      filename: text(file.name),
      rows: registrations.length,
      written: result.results.length,
      recovered_from_email_history: executionPlan.recovered_from_email_history.length,
      skipped_existing_master: executionPlan.skipped_existing_master.length,
      plan_hash: executionPlan.plan_hash,
    }));
    const draftGrant = executionPlan.new_entry_ids.length
      ? await issueImportDraftGrant(env, pipeline.pipeline_id, executionPlan.new_entry_ids)
      : "";
    return html(importResultPage(result, registrations.length, executionPlan, backup, draftGrant));
  } catch (error) {
    console.error("CSV import failed", error);
    return html(importPage(importErrorMessage(error)), 400);
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
    const download = await downloadPaymentTransactions(accessToken, source);
    const result = await importPayments(accessToken, pipeline, download, source);
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
  if (recoveryMaintenanceEnabled(env)) return maintenanceResponse();
  try {
    const payload = await optionalJson(request);
    const pipeline = getPipeline(env, text(payload.pipeline_id) || defaultPipelineId(env));
    const entryIds = parseRequestedEntryIds(payload.entry_ids);
    const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT);
    const automation = await refreshEmailDrafts(accessToken, pipeline, entryIds);
    return json({ status: "ok", pipeline_id: pipeline.pipeline_id, ...automation });
  } catch (error) {
    console.error("Email draft refresh failed", error);
    return json({ error: "email_draft_refresh_failed", message: error.message || "Ismeretlen hiba." }, 500);
  }
}

// Ez kizárólag a történeti E-mail kimenet és a jelenlegi fő Sheet közötti
// eltéréseket írja egy külön munkalapra. Nem készít piszkozatot, nem módosít
// e-mail sort, és semmilyen jóváhagyási mezőhöz nem nyúl.
async function handleEmailReferenceReconciliation(request, env, token) {
  if (!env.EMAIL_ADMIN_TOKEN || !safeEqual(token, env.EMAIL_ADMIN_TOKEN)) {
    return json({ error: "not_found" }, 404);
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (recoveryMaintenanceEnabled(env)) return maintenanceResponse();
  try {
    const payload = await optionalJson(request);
    const pipeline = getPipeline(env, text(payload.pipeline_id) || defaultPipelineId(env));
    const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT);
    const result = await reconcileEmailReferences(accessToken, pipeline);
    return json({ status: "ok", pipeline_id: pipeline.pipeline_id, ...result });
  } catch (error) {
    console.error("Email reference reconciliation failed", error);
    return json({ error: "email_reference_reconciliation_failed", message: error.message || "Ismeretlen hiba." }, 500);
  }
}

async function handleApprovedEmailSend(request, env, token) {
  if (!env.EMAIL_ADMIN_TOKEN || !safeEqual(token, env.EMAIL_ADMIN_TOKEN)) {
    return json({ error: "not_found" }, 404);
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (recoveryMaintenanceEnabled(env)) return maintenanceResponse();
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
  if (recoveryMaintenanceEnabled(env)) return maintenanceResponse();
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
  if (recoveryMaintenanceEnabled(env)) return maintenanceResponse();
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

function parseRequestedEntryIds(value) {
  if (!Array.isArray(value)) {
    throw new Error("Az e-mail-piszkozatokhoz kötelező az épp importált ID-k entry_ids tömbje.");
  }
  const entryIds = [...new Set(value.map((entryId) => text(entryId)).filter(Boolean))];
  if (!entryIds.length) throw new Error("Nincs megadott importált ID az e-mail-piszkozatokhoz.");
  if (entryIds.length !== value.length) {
    throw new Error("Az e-mail-piszkozatokhoz megadott ID-k üresek vagy duplikáltak.");
  }
  return new Set(entryIds);
}

async function issueImportDraftGrant(env, pipelineId, entryIds) {
  const payload = JSON.stringify({
    pipeline_id: pipelineId,
    entry_ids: [...entryIds],
    expires_at: Math.floor(Date.now() / 1000) + 15 * 60,
  });
  return `${base64Url(payload)}.${await hmacSha256(env.IMPORT_ADMIN_TOKEN, payload)}`;
}

async function verifyImportDraftGrant(env, grant) {
  const [encodedPayload, signature, ...extra] = text(grant).split(".");
  if (!encodedPayload || !signature || extra.length) {
    throw new Error("A piszkozatkészítő jogosultság hiányzik vagy sérült. Indíts új import-előnézetet.");
  }
  let payload;
  try {
    const padded = encodedPayload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encodedPayload.length / 4) * 4, "=");
    payload = new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
  } catch {
    throw new Error("A piszkozatkészítő jogosultság olvashatatlan. Indíts új import-előnézetet.");
  }
  if (!safeEqual(signature, await hmacSha256(env.IMPORT_ADMIN_TOKEN, payload))) {
    throw new Error("A piszkozatkészítő jogosultság érvénytelen. Indíts új import-előnézetet.");
  }
  let parsed;
  try { parsed = JSON.parse(payload); }
  catch { throw new Error("A piszkozatkészítő jogosultság hibás. Indíts új import-előnézetet."); }
  if (!parsed || typeof parsed !== "object" || !text(parsed.pipeline_id)
      || Number(parsed.expires_at) < Math.floor(Date.now() / 1000)) {
    throw new Error("A piszkozatkészítő jogosultság lejárt. Készíts új import-előnézetet.");
  }
  return { pipelineId: text(parsed.pipeline_id), entryIds: parseRequestedEntryIds(parsed.entry_ids) };
}

async function hmacSha256(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function recoveryMaintenanceEnabled(env) {
  // A deploy alapértelmezésben zárva indul. A visszaállítás utáni, külön
  // ellenőrzött újraindítás állíthatja csak explicit \"off\" értékre.
  return text(env.RECOVERY_MAINTENANCE_MODE).toLowerCase() !== "off";
}

function maintenanceResponse() {
  return json({
    error: "maintenance_mode",
    message: "A regisztrációs helyreállítás karbantartási módja aktív; production-írás nem engedélyezett.",
  }, 503);
}

function maintenanceHtmlResponse() {
  return html(importPage("Az import most rövid ideig szünetel. Próbáld meg később."), 503);
}

function disabledEndpoint(message) {
  return json({ error: "disabled", message }, 410);
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
    const mode = text(payload.mode).toLowerCase() || "preview";
    if (!["preview", "execute"].includes(mode)) {
      return json({ error: "invalid_mode", message: "A munkatársi Sheet-szinkron módja csak preview vagy execute lehet." }, 400);
    }
    const pipeline = getPipeline(env, text(payload.pipeline_id) || defaultPipelineId(env));
    if (!pipeline.staff_target) throw new Error("Ehhez a pipeline-hoz nincs munkatársi Sheet beállítva.");

    const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT);
    const plan = await buildStaffSyncPlan(accessToken, pipeline);
    if (mode === "preview") {
      return json({ status: "preview", pipeline_id: pipeline.pipeline_id, ...staffSyncPlanSummary(plan) });
    }
    if (recoveryMaintenanceEnabled(env)) return maintenanceResponse();
    if (!safeEqual(text(payload.plan_hash), plan.plan_hash)) {
      return json({
        error: "stale_plan",
        message: "A munkatársi Sheet az előnézet óta megváltozott. Készíts új előnézetet.",
      }, 409);
    }
    if (plan.deleteRows.length && payload.allow_deletes !== true) {
      return json({
        error: "delete_confirmation_required",
        message: "Az előnézet törlendő munkatársi sorokat talált. A végrehajtáshoz külön törlési jóváhagyás kell.",
        ...staffSyncPlanSummary(plan),
      }, 409);
    }
    const backup = await verifyStaffSyncBackup(
      accessToken,
      pipeline.staff_target.spreadsheet_id,
      plan,
      text(payload.backup_id),
    );
    // A preview nem jogosít fel vak írásra: közvetlenül a végrehajtás előtt
    // újraolvassuk mindkét Sheetet, és csak ugyanazt a tervet fogadjuk el.
    const executionPlan = await buildStaffSyncPlan(accessToken, pipeline);
    if (!safeEqual(plan.plan_hash, executionPlan.plan_hash)) {
      return json({
        error: "stale_plan",
        message: "A munkatársi vagy fő Sheet az előnézet óta megváltozott. Készíts új előnézetet.",
      }, 409);
    }
    const result = await syncStaffTarget(accessToken, pipeline, executionPlan, {
      allowDeletes: payload.allow_deletes === true,
    });
    return json({
      status: "ok",
      pipeline_id: pipeline.pipeline_id,
      plan_hash: executionPlan.plan_hash,
      backup,
      ...result,
    });
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
  if (!source?.drive_file_id && !source?.drive_folder_id) {
    throw new Error(`Nincs banki Excel-forrás beállítva ehhez: ${pipelineId}`);
  }
  return source;
}

async function resolveLatestDriveFile(accessToken, folderId) {
  const query = `'${folderId}' in parents and trashed=false and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&orderBy=modifiedTime desc&fields=${encodeURIComponent("files(id,name,modifiedTime)")}&pageSize=1`;
  const result = await googleFetch(url, accessToken);
  const file = (result.files || [])[0];
  if (!file) throw new Error("A megadott Drive-mappában nincs feldolgozható banki XLSX fájl.");
  return file;
}

async function downloadPaymentTransactions(accessToken, source) {
  let fileId = source.drive_file_id;
  let file = null;
  if (!fileId) {
    file = await resolveLatestDriveFile(accessToken, source.drive_folder_id);
    fileId = file.id;
  }
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`A banki Excel letöltése nem sikerült: ${response.status}`);
  const workbook = XLSX.read(await response.arrayBuffer(), { type: "array", cellDates: false });
  const sheetName = source.sheet_name || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`Nem található a banki Excel munkalapja: ${sheetName}`);
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  if (!rows.length) throw new Error("A banki Excel nem tartalmaz adat-sort.");
  const transactions = await Promise.all(rows.map((row, index) => paymentFromRow(row, source.columns, index + 2)));
  return {
    transactions,
    rowCount: rows.length,
    file: file ? { id: file.id, name: file.name, modifiedTime: file.modifiedTime } : null,
  };
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
  payment.fingerprint = await paymentFingerprint(payment);
  payment.sourceKey = transactionId ? `id:${transactionId}` : `hash:${payment.fingerprint}`;
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

async function importPayments(accessToken, pipeline, download, source = {}) {
  const { transactions } = download;
  const masterRows = await readSheetRows(accessToken, pipeline.spreadsheet_id, pipeline.tab_name, "A:AA");
  if (text(masterRows[0]?.[0]) !== "Közlemény") throw new Error("A fő Sheet első oszlopa nem Közlemény.");
  const paymentColumns = paymentColumnIndexes(masterRows[0]);
  const paymentSheets = await ensurePaymentSheets(accessToken, pipeline.spreadsheet_id);
  const logRows = await readSheetRows(accessToken, pipeline.spreadsheet_id, paymentSheets.log, "A:K");
  const pendingRows = await readSheetRows(accessToken, pipeline.spreadsheet_id, paymentSheets.pending, "A:K");
  const correctionRows = await ensureReferenceCorrectionsSheet(accessToken, pipeline.spreadsheet_id);
  const previousState = await readImportState(accessToken, pipeline.spreadsheet_id, paymentSheets.state);
  const registrations = masterRows.slice(1).map((row, index) => registrationForPayment(row, index + 2, pipeline.tab_name, paymentColumns)).filter(Boolean);
  const registrationsByReference = new Map(registrations.map((item) => [item.reference, item]));
  const approvedCorrections = buildApprovedCorrections(correctionRows, registrationsByReference);
  const knownSources = new Set(logRows.slice(1).map((row) => text(row[0])).filter(Boolean));
  const pendingBySource = new Map(pendingRows.slice(1).map((row, index) => [text(row[0]), { row, rowIndex: index + 2 }]).filter(([key]) => key));
  const watermark = determineImportStart(previousState, transactions);

  const masterWrites = [];
  const logWrites = [];
  const pendingWrites = [];
  const summary = {
    new_transactions: 0, booked: 0, already_recorded: 0, pending: 0, duplicates: 0, manually_resolved: 0,
    corrected_booked: 0, name_confirmed: 0,
    total_rows: transactions.length, new_rows: 0, skipped_by_watermark: 0, state_reset: watermark.reset,
  };
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
  for (let index = 0; index < transactions.length; index += 1) {
    const payment = transactions[index];
    if (watermark.trusted && index < watermark.startIndex) {
      summary.duplicates += 1;
      summary.skipped_by_watermark += 1;
      continue;
    }
    const isHashBased = payment.sourceKey.startsWith("hash:");
    const dedupApplies = !isHashBased || !watermark.trusted;
    if (dedupApplies && knownSources.has(payment.sourceKey)) { summary.duplicates += 1; continue; }
    summary.new_transactions += 1;

    const candidates = extractReferences(payment.message, source.reference_length);
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
    } else if (matches.length === 0) {
      const correctionTargets = new Set(
        candidates.filter((reference) => approvedCorrections.has(reference)).map((reference) => approvedCorrections.get(reference)),
      );
      if (correctionTargets.size === 1) {
        const target = registrationsByReference.get([...correctionTargets][0]);
        matchedReference = target.reference;
        const result = bookPaymentIfNeeded(target, payment.bookingDate, masterWrites);
        status = result === "booked" ? "Könyvelve javított közleménnyel" : "Már rögzített";
        if (result === "booked") {
          summary.booked += 1;
          summary.corrected_booked += 1;
          bookedReferences.add(target.reference);
        } else summary.already_recorded += 1;
      } else {
        status = "Függő";
      }
    } else {
      const surname = normalizedSurname(payment.senderName);
      const nameMatches = surname
        ? matches.filter((registration) => normalizedSurname(registration.studentName) === surname || normalizedSurname(registration.parentName) === surname)
        : [];
      if (nameMatches.length === 1) {
        matchedReference = nameMatches[0].reference;
        const result = bookPaymentIfNeeded(nameMatches[0], payment.bookingDate, masterWrites);
        status = result === "booked" ? "Könyvelve névvel megerősítve" : "Már rögzített";
        if (result === "booked") {
          summary.booked += 1;
          summary.name_confirmed += 1;
          bookedReferences.add(nameMatches[0].reference);
        } else summary.already_recorded += 1;
      } else {
        status = "Többértelmű";
      }
    }

    if (status === "Függő" || status === "Többértelmű") {
      const suggestions = nameSuggestions(payment.senderName, registrations);
      const suggestionsText = `${suggestions.length ? `${suggestions.join(" | ")} ` : ""}(könyvelés: ${payment.bookingDate})`;
      pendingWrites.push({
        range: `${quoteSheetName(paymentSheets.pending)}!A${pendingRowIndex}:K${pendingRowIndex}`,
        values: [[payment.sourceKey, payment.bookingDate, payment.amount, payment.currency, payment.senderName, payment.senderAccount, payment.message, suggestionsText, "", status, ""]],
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
  summary.new_rows = summary.new_transactions;

  if (masterWrites.length) await writeSheetRanges(accessToken, pipeline.spreadsheet_id, masterWrites);
  if (logWrites.length) await writeSheetRanges(accessToken, pipeline.spreadsheet_id, logWrites);
  if (pendingWrites.length) await writeSheetRanges(accessToken, pipeline.spreadsheet_id, pendingWrites);
  await writeSheetRanges(accessToken, pipeline.spreadsheet_id, [importStateWrite(paymentSheets.state, transactions, summary.new_rows)]);
  if (bookedReferences.size && pipeline.email_automation !== false) {
    const drafts = await refreshPaymentEmailDrafts(accessToken, pipeline, bookedReferences);
    summary.payment_email_drafts = drafts.processed;
  } else {
    summary.payment_email_drafts = 0;
  }
  return summary;
}

function determineImportStart(state, transactions) {
  if (!state || !state.rowCount) return { startIndex: 0, trusted: false, reset: false };
  if (state.rowCount > transactions.length) return { startIndex: 0, trusted: false, reset: true };
  const checkCount = Math.min(2, state.rowCount, state.lastRowFingerprints.length);
  if (!checkCount) return { startIndex: 0, trusted: false, reset: true };
  for (let i = 1; i <= checkCount; i += 1) {
    const rowIndex = state.rowCount - i;
    const expected = state.lastRowFingerprints[state.lastRowFingerprints.length - i];
    if (!expected || !transactions[rowIndex] || transactions[rowIndex].fingerprint !== expected) {
      return { startIndex: 0, trusted: false, reset: true };
    }
  }
  return { startIndex: state.rowCount, trusted: true, reset: false };
}

function buildApprovedCorrections(correctionRows, registrationsByReference) {
  const candidateTargets = new Map();
  correctionRows.slice(1).forEach((row) => {
    if (!isChecked(row[9])) return;
    const erroneous = text(row[0]);
    const correct = text(row[1]);
    if (!erroneous || !correct || !registrationsByReference.has(correct)) return;
    if (!candidateTargets.has(erroneous)) candidateTargets.set(erroneous, new Set());
    candidateTargets.get(erroneous).add(correct);
  });
  const approved = new Map();
  for (const [erroneous, targets] of candidateTargets) {
    if (targets.size === 1) approved.set(erroneous, [...targets][0]);
  }
  return approved;
}

async function readImportState(accessToken, spreadsheetId, stateTab) {
  const rows = await readSheetRows(accessToken, spreadsheetId, stateTab, "A2:F2");
  const row = rows[0];
  if (!row || !text(row[0]) || !Number(row[1])) return null;
  return {
    lastImportAt: text(row[0]),
    rowCount: Number(row[1]) || 0,
    newRows: Number(row[2]) || 0,
    lastTransactionId: text(row[3]),
    latestBookingDate: text(row[4]),
    lastRowFingerprints: text(row[5]) ? text(row[5]).split("|").filter(Boolean) : [],
  };
}

function importStateWrite(stateTab, transactions, newRowsCount) {
  const tail = transactions.slice(-2);
  const last = transactions[transactions.length - 1];
  const latestBookingDate = transactions.reduce((latest, payment) => (payment.bookingDate > latest ? payment.bookingDate : latest), "");
  return {
    range: `${quoteSheetName(stateTab)}!A2:F2`,
    values: [[
      new Date().toISOString(),
      transactions.length,
      newRowsCount,
      last?.transactionId || "",
      latestBookingDate,
      tail.map((payment) => payment.fingerprint).join("|"),
    ]],
  };
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

function extractReferences(message, expectedLength) {
  const all = [...new Set((text(message).match(/(?<!\d)\d{1,7}(?!\d)/g) || []))];
  if (!expectedLength) return all;
  const filtered = all.filter((reference) => reference.length === expectedLength);
  return filtered.length ? filtered : all;
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

const PAYMENT_STATE_TAB = "Befizetés import állapot";
const PAYMENT_STATE_HEADERS = [
  "Utolsó import ideje", "Fájl sorainak száma", "Feldolgozott új sorok",
  "Utolsó tranzakcióazonosító", "Legkésőbbi könyvelési dátum", "Utolsó sorok ujjlenyomata",
];

async function ensurePaymentSheets(accessToken, spreadsheetId) {
  const log = "Befizetések napló";
  const pending = "Függő befizetések";
  const state = PAYMENT_STATE_TAB;
  const metadata = await getSpreadsheetMetadata(accessToken, spreadsheetId);
  const titles = new Set((metadata.sheets || []).map((sheet) => sheet.properties?.title));
  const missing = [log, pending, state].filter((title) => !titles.has(title));
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
    [state]: PAYMENT_STATE_HEADERS,
  };
  const lastColumns = { [log]: "K", [pending]: "K", [state]: "F" };
  for (const title of [log, pending, state]) {
    const lastColumn = lastColumns[title];
    const rows = await readSheetRows(accessToken, spreadsheetId, title, `A1:${lastColumn}1`);
    if (!rows.length || !text(rows[0]?.[0])) {
      await writeSheetRanges(accessToken, spreadsheetId, [{ range: `${quoteSheetName(title)}!A1:${lastColumn}1`, values: [headers[title]] }]);
    }
  }
  return { log, pending, state };
}

const REFERENCE_CORRECTION_HEADERS = [
  "Hibás közlemény", "Valódi közlemény", "Hibás levél címzettje", "Növendék", "Szülő / kapcsolattartó",
  "Forrás sor", "E-mail kimenet sora", "Állapot", "Indok", "Feldolgozható", "Megjegyzés", "Frissítve",
];

async function ensureReferenceCorrectionsSheet(accessToken, spreadsheetId) {
  const metadata = await getSpreadsheetMetadata(accessToken, spreadsheetId);
  const exists = (metadata.sheets || []).some((sheet) => sheet.properties?.title === REFERENCE_CORRECTIONS_TAB);
  if (!exists) {
    const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
    await googleFetch(`${baseUrl}:batchUpdate`, accessToken, {
      method: "POST",
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: REFERENCE_CORRECTIONS_TAB, gridProperties: { frozenRowCount: 1 } } } }] }),
    });
  }
  const rows = await readSheetRows(accessToken, spreadsheetId, REFERENCE_CORRECTIONS_TAB, "A:L");
  if (!rows.length || !text(rows[0]?.[0])) {
    await writeSheetRanges(accessToken, spreadsheetId, [{
      range: `${quoteSheetName(REFERENCE_CORRECTIONS_TAB)}!A1:L1`, values: [REFERENCE_CORRECTION_HEADERS],
    }]);
    return [REFERENCE_CORRECTION_HEADERS];
  }
  if (text(rows[0]?.[0]) !== REFERENCE_CORRECTION_HEADERS[0]) {
    throw new Error(`A ${REFERENCE_CORRECTIONS_TAB} fejlécének első oszlopa hibás.`);
  }
  return rows;
}

async function reconcileEmailReferences(accessToken, pipeline) {
  const [masterRows, emailRows, correctionRows] = await Promise.all([
    readSheetRows(accessToken, pipeline.spreadsheet_id, pipeline.tab_name, "A:AT"),
    readSheetRows(accessToken, pipeline.spreadsheet_id, EMAIL_OUTPUT_TAB, "A:AH"),
    ensureReferenceCorrectionsSheet(accessToken, pipeline.spreadsheet_id),
  ]);
  if (text(masterRows[0]?.[0]) !== "Közlemény") throw new Error("A fő Sheet első oszlopa nem Közlemény.");
  if (text(emailRows[0]?.[0]) !== "Küldési kulcs") throw new Error("Az E-mail kimenet fejléce hiányzik.");

  const registrationsByEmail = new Map();
  masterRows.slice(1).forEach((row, index) => {
    const email = normalizeEmail(row[17]);
    const reference = text(row[0]);
    if (!email || !reference) return;
    const registration = {
      reference, email: text(row[17]), studentName: text(row[5]), parentName: text(row[18]), rowIndex: index + 2,
    };
    registrationsByEmail.set(email, [...(registrationsByEmail.get(email) || []), registration]);
  });

  // A kezelő a két utolsó oszlopban dönthet a javaslat használhatóságáról és
  // írhat megjegyzést. Ezeket egy újrafuttatás sosem írja felül.
  const previousByKey = new Map(correctionRows.slice(1).map((row) => [
    referenceCorrectionKey(row[0], row[2], row[1]), row,
  ]));
  const rows = [];
  const emittedKeys = new Set();
  let suggested = 0;
  let manual = 0;
  emailRows.slice(1).forEach((emailRow, index) => {
    const erroneousReference = text(emailRow[EMAIL_COLUMN.ENTRY_ID]);
    const recipient = text(emailRow[EMAIL_COLUMN.TO]);
    if (!erroneousReference || !recipient) return;
    const matches = registrationsByEmail.get(normalizeEmail(recipient)) || [];
    if (matches.length === 1 && matches[0].reference === erroneousReference) return;

    let correctReference = "";
    let studentName = "";
    let parentName = "";
    let sourceRow = "";
    let status = "KÉZI ELBÍRÁLÁS";
    let reason = "A címzett nem található egyértelműen a jelenlegi forrásban.";
    if (matches.length === 1) {
      ({ reference: correctReference, studentName, parentName, rowIndex: sourceRow } = matches[0]);
      status = "JAVASOLT";
      reason = "Az E-mail kimenet címzettje egyértelműen másik forrásrekordhoz tartozik.";
    } else if (matches.length > 1) {
      reason = "A címzett több forrásrekordban szerepel; automatikus megfeleltetés nem készül.";
    }
    const key = referenceCorrectionKey(erroneousReference, recipient, correctReference);
    if (emittedKeys.has(key)) return;
    emittedKeys.add(key);
    if (status === "JAVASOLT") suggested += 1;
    else manual += 1;
    const previous = previousByKey.get(key) || [];
    rows.push([
      erroneousReference, correctReference, recipient, studentName, parentName, sourceRow, index + 2,
      status, reason, previous[9] || false, previous[10] || "", new Date().toISOString(),
    ]);
  });

  if (rows.length) {
    await writeSheetRanges(accessToken, pipeline.spreadsheet_id, rows.map((row, index) => ({
      range: `${quoteSheetName(REFERENCE_CORRECTIONS_TAB)}!A${index + 2}:L${index + 2}`, values: [row],
    })));
  }
  return { total: rows.length, suggested, manual, sheet: REFERENCE_CORRECTIONS_TAB };
}

function normalizeEmail(value) { return text(value).toLowerCase(); }
function referenceCorrectionKey(erroneousReference, recipient, correctReference) {
  return [text(erroneousReference), normalizeEmail(recipient), text(correctReference)].join("|");
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

async function readImportSnapshot(accessToken, pipeline) {
  const [metadata, masterRows, emailRows] = await Promise.all([
    getSpreadsheetMetadata(accessToken, pipeline.spreadsheet_id),
    readSheetRows(accessToken, pipeline.spreadsheet_id, pipeline.tab_name, "A:AT"),
    readSheetRows(accessToken, pipeline.spreadsheet_id, EMAIL_OUTPUT_TAB, "A:AH"),
  ]);
  const master = validateMasterRows(masterRows);
  validateEmailRows(emailRows);
  assertNoPartialBasicFilter(metadata, pipeline.tab_name, master.header.length);
  return { metadata, masterRows, emailRows };
}

async function readImportBackupSnapshot(accessToken, pipeline) {
  const [masterRows, emailRows] = await Promise.all([
    readSheetRows(accessToken, pipeline.spreadsheet_id, pipeline.tab_name, "A:AT"),
    readSheetRows(accessToken, pipeline.spreadsheet_id, EMAIL_OUTPUT_TAB, "A:AH"),
  ]);
  validateMasterRows(masterRows);
  validateEmailRows(emailRows);
  return { masterRows, emailRows };
}

async function appendOnlyMasterRegistrations(accessToken, pipeline, beforeRows, plan) {
  if (!plan.newRegistrations.length) {
    return { results: [], verification: { old_records_unchanged: true, appended_records: 0 } };
  }
  const startRow = appendStartRow(beforeRows);
  if (startRow !== plan.append_start_row) {
    throw new Error("Az import append kezdősora eltér az elfogadott tervtől.");
  }
  const data = plan.newRegistrations.flatMap((registration, offset) => {
    const rowIndex = startRow + offset;
    const row = [registration.entryId, ...registration.row];
    return [
      { range: `${quoteSheetName(pipeline.tab_name)}!A${rowIndex}:I${rowIndex}`, values: [row.slice(0, 9)] },
      { range: `${quoteSheetName(pipeline.tab_name)}!O${rowIndex}:AA${rowIndex}`, values: [row.slice(14, 27)] },
      { range: `${quoteSheetName(pipeline.tab_name)}!${TRIAL_DATE_COLUMN}${rowIndex}`, values: [[registration.trialDate || ""]] },
    ];
  });
  await writeSheetRanges(accessToken, pipeline.spreadsheet_id, data);

  const afterRows = await readSheetRows(accessToken, pipeline.spreadsheet_id, pipeline.tab_name, "A:AT");
  await verifyAppendOnlyImport(beforeRows, afterRows, plan);
  return {
    results: plan.newRegistrations.map((registration, offset) => ({
      rowIndex: startRow + offset,
      type: "created",
      studentName: registration.studentName,
    })),
    verification: {
      old_records_unchanged: true,
      appended_records: plan.newRegistrations.length,
    },
  };
}

async function verifyImportBackup(accessToken, productionSpreadsheetId, backupId) {
  if (!backupId) throw new Error("Hiányzik a Drive-backup azonosítója.");
  if (backupId === productionSpreadsheetId) throw new Error("A backup nem lehet azonos a production Sheettel.");
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(backupId)}?fields=${encodeURIComponent("id,name,mimeType,createdTime,modifiedTime,trashed,parents,capabilities(canEdit)")}&supportsAllDrives=true`;
  const backup = await googleFetch(url, accessToken);
  if (backup.trashed || backup.mimeType !== "application/vnd.google-apps.spreadsheet") {
    throw new Error("A megadott backup nem elérhető Google Sheets Drive-másolat.");
  }
  return {
    id: text(backup.id),
    snapshot_at: text(backup.modifiedTime) || text(backup.createdTime),
    parent_ids: Array.isArray(backup.parents) ? backup.parents.map(text).filter(Boolean) : [],
    can_edit: backup.capabilities?.canEdit === true,
  };
}

async function verifyStaffSyncBackup(accessToken, staffSpreadsheetId, plan, backupId) {
  const backup = await verifyImportBackup(accessToken, staffSpreadsheetId, backupId);
  const snapshotAtMillis = Date.parse(backup.snapshot_at);
  if (!Number.isFinite(snapshotAtMillis)) {
    throw new Error("A munkatársi Sheet backup frissítési ideje érvénytelen.");
  }
  const ageMinutes = (Date.now() - snapshotAtMillis) / 60_000;
  if (ageMinutes < -5 || ageMinutes > DEFAULT_STAFF_SYNC_BACKUP_MAX_AGE_MINUTES) {
    throw new Error(`A munkatársi Sheet backup nem elég friss (${Math.max(0, Math.round(ageMinutes))} perc; legfeljebb ${DEFAULT_STAFF_SYNC_BACKUP_MAX_AGE_MINUTES} perc lehet).`);
  }
  const backupRows = await readSheetRows(accessToken, backup.id, plan.target.tab_name, "A:ZZ");
  if (!safeEqual(await semanticHash(backupRows), plan.staff_snapshot_sha256)) {
    throw new Error("A munkatársi Sheet backup tartalma nem egyezik az előnézetkori állapottal.");
  }
  return backup;
}

function importBackupSource(env, pipeline) {
  if (!env.IMPORT_BACKUP_SOURCE_CONFIG_JSON) {
    throw new Error("Hiányzik az IMPORT_BACKUP_SOURCE_CONFIG_JSON. Normál importhoz nincs konfigurált, megbízható Drive backup-forrás.");
  }
  let parsed;
  try { parsed = JSON.parse(env.IMPORT_BACKUP_SOURCE_CONFIG_JSON); }
  catch { throw new Error("Az IMPORT_BACKUP_SOURCE_CONFIG_JSON nem érvényes JSON."); }
  const sources = Array.isArray(parsed) ? parsed : parsed.sources;
  if (!Array.isArray(sources)) {
    throw new Error("Az IMPORT_BACKUP_SOURCE_CONFIG_JSON sources tömbje hiányzik.");
  }
  const source = sources.find((item) => text(item?.pipeline_id) === pipeline.pipeline_id);
  if (!source || !text(source.folder_id)) {
    throw new Error(`Nincs konfigurált Drive backup-forrás ehhez a pipeline-hoz: ${pipeline.pipeline_id}.`);
  }
  const maxAgeMinutes = Number(source.max_age_minutes ?? DEFAULT_IMPORT_BACKUP_MAX_AGE_MINUTES);
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes < 1 || maxAgeMinutes > 24 * 60) {
    throw new Error("A backup-forrás max_age_minutes értéke 1 és 1440 közötti egész perc legyen.");
  }
  const refreshBackupId = text(source.refresh_backup_id);
  if (refreshBackupId === pipeline.spreadsheet_id) {
    throw new Error("A frissíthető backup nem lehet azonos a production Sheettel.");
  }
  return { folderId: text(source.folder_id), maxAgeMinutes, refreshBackupId };
}

async function resolveImportBackupForExecution(request, env, accessToken, pipeline, snapshot, form) {
  const legacyBackupId = text(form.get("backup_id"));
  const overrideBackupId = text(form.get("backup_override_id"));
  if (legacyBackupId && !overrideBackupId) {
    throw new Error("A normál import nem fogad kézzel megadott backup-ID-t. A Worker a konfigurált Drive-forrásból választ mentést.");
  }
  if (overrideBackupId) {
    return resolveEmergencyImportBackupOverride(request, env, accessToken, pipeline, snapshot, overrideBackupId);
  }
  return resolveAutomaticImportBackup(accessToken, env, pipeline, snapshot);
}

async function resolveAutomaticImportBackup(accessToken, env, pipeline, snapshot) {
  const source = importBackupSource(env, pipeline);
  await verifyImportBackupFolder(accessToken, source.folderId);
  const candidates = await listImportBackupCandidates(accessToken, source.folderId);
  for (const candidate of candidates) {
    try {
      const backup = await verifyImportBackup(accessToken, pipeline.spreadsheet_id, candidate.id);
      return await validateImportBackupForSnapshot(accessToken, pipeline, snapshot, backup, source, {
        requireConfiguredFolder: true,
        selection: "automatic",
      });
    } catch (error) {
      console.warn("Rejected automatic import backup", JSON.stringify({
        pipeline_id: pipeline.pipeline_id,
        backup_id: text(candidate.id),
        reason: error.message || "ismeretlen",
      }));
    }
  }
  if (source.refreshBackupId) {
    return refreshAutomaticImportBackup(accessToken, pipeline, snapshot, source);
  }
  throw new Error("Nincs friss, sértetlen és a production Sheettel egyező Drive-backup a konfigurált forrásban. Az import nem indult el.");
}

async function refreshAutomaticImportBackup(accessToken, pipeline, snapshot, source) {
  const backup = await verifyImportBackup(accessToken, pipeline.spreadsheet_id, source.refreshBackupId);
  if (!backup.parent_ids.includes(source.folderId)) {
    throw new Error("A frissíthető Drive-backup nem a konfigurált backup-mappában van.");
  }
  if (!backup.can_edit) {
    throw new Error("A frissíthető Drive-backup nem szerkeszthető.");
  }

  const metadata = await getSpreadsheetMetadata(accessToken, backup.id);
  const masterTitle = findSheetTitle(metadata, pipeline.tab_name);
  const emailTitle = findSheetTitle(metadata, EMAIL_OUTPUT_TAB);
  if (!masterTitle || !emailTitle) {
    throw new Error("A frissíthető Drive-backupból hiányzik a főlap vagy az e-mail-lap.");
  }

  await clearSheetRanges(accessToken, backup.id, [
    `${quoteSheetName(masterTitle)}!A:AT`,
    `${quoteSheetName(emailTitle)}!A:AH`,
  ]);
  await writeSheetRanges(accessToken, backup.id, [
    {
      range: `${quoteSheetName(masterTitle)}!A1:AT${snapshot.masterRows.length}`,
      values: snapshot.masterRows,
    },
    {
      range: `${quoteSheetName(emailTitle)}!A1:AH${snapshot.emailRows.length}`,
      values: snapshot.emailRows,
    },
  ]);

  const refreshed = { ...backup, snapshot_at: new Date().toISOString() };
  const validated = await validateImportBackupForSnapshot(accessToken, pipeline, snapshot, refreshed, source, {
    requireConfiguredFolder: true,
    selection: "automatic_refreshed_slot",
  });
  console.info("Refreshed automatic import backup", JSON.stringify({
    pipeline_id: pipeline.pipeline_id,
    backup_id: backup.id,
  }));
  return validated;
}

async function resolveEmergencyImportBackupOverride(request, env, accessToken, pipeline, snapshot, backupId) {
  if (text(request.headers.get("X-Import-Emergency-Token")) === "" || !env.IMPORT_EMERGENCY_ADMIN_TOKEN
      || !safeEqual(text(request.headers.get("X-Import-Emergency-Token")), env.IMPORT_EMERGENCY_ADMIN_TOKEN)) {
    throw new Error("A kézi backup-ID csak érvényes X-Import-Emergency-Token admin felülbírálással használható.");
  }
  if (text(request.headers.get("X-Import-Backup-Override")) !== "emergency") {
    throw new Error("A kézi backup-ID-hez X-Import-Backup-Override: emergency jelölés szükséges.");
  }
  const backup = await verifyImportBackup(accessToken, pipeline.spreadsheet_id, backupId);
  return validateImportBackupForSnapshot(accessToken, pipeline, snapshot, backup, {
    maxAgeMinutes: DEFAULT_IMPORT_BACKUP_MAX_AGE_MINUTES,
  }, {
    requireConfiguredFolder: false,
    selection: "emergency_override",
  });
}

async function verifyImportBackupFolder(accessToken, folderId) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=${encodeURIComponent("id,mimeType,trashed")}&supportsAllDrives=true`;
  const folder = await googleFetch(url, accessToken);
  if (folder.trashed || folder.mimeType !== "application/vnd.google-apps.folder") {
    throw new Error("A konfigurált backup-forrás nem elérhető Google Drive-mappa.");
  }
}

async function listImportBackupCandidates(accessToken, folderId) {
  const query = `'${folderId}' in parents and trashed=false and mimeType='application/vnd.google-apps.spreadsheet'`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&orderBy=modifiedTime desc&fields=${encodeURIComponent("files(id,createdTime,modifiedTime,mimeType,trashed,parents)")}&pageSize=50&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const result = await googleFetch(url, accessToken);
  return (Array.isArray(result.files) ? result.files : [])
    .sort((left, right) => Date.parse(text(right.modifiedTime || right.createdTime)) - Date.parse(text(left.modifiedTime || left.createdTime)));
}

async function validateImportBackupForSnapshot(accessToken, pipeline, snapshot, backup, source, options) {
  const snapshotAtMillis = Date.parse(backup.snapshot_at);
  if (!Number.isFinite(snapshotAtMillis)) throw new Error("A Drive-backup frissítési ideje érvénytelen.");
  const ageMinutes = (Date.now() - snapshotAtMillis) / 60_000;
  if (ageMinutes < -5 || ageMinutes > source.maxAgeMinutes) {
    throw new Error(`A Drive-backup nem elég friss (${Math.max(0, Math.round(ageMinutes))} perc; legfeljebb ${source.maxAgeMinutes} perc lehet).`);
  }
  if (options.requireConfiguredFolder && !backup.parent_ids.includes(source.folderId)) {
    throw new Error("A Drive-backup nem a konfigurált, megbízható backup-forrásból származik.");
  }
  const backupPipeline = { ...pipeline, spreadsheet_id: backup.id };
  const backupSnapshot = await readImportBackupSnapshot(accessToken, backupPipeline);
  const [expectedMasterHash, expectedEmailHash, backupMasterHash, backupEmailHash] = await Promise.all([
    semanticHash(snapshot.masterRows),
    semanticHash(snapshot.emailRows),
    semanticHash(backupSnapshot.masterRows),
    semanticHash(backupSnapshot.emailRows),
  ]);
  if (!safeEqual(expectedMasterHash, backupMasterHash) || !safeEqual(expectedEmailHash, backupEmailHash)) {
    throw new Error("A Drive-backup tartalma nem egyezik a jelenlegi production Sheet-pillanatképpel.");
  }
  return {
    id: backup.id,
    snapshot_at: backup.snapshot_at,
    selection: options.selection,
    source_folder_id: options.requireConfiguredFolder ? source.folderId : "",
  };
}

async function verifyAppendOnlyImport(beforeRows, afterRows, plan) {
  const before = validateMasterRows(beforeRows);
  const after = validateMasterRows(afterRows);
  const afterById = new Map(after.records.map((record) => [record.entryId, record]));
  for (const record of before.records) {
    const actual = afterById.get(record.entryId);
    if (!actual || await semanticHash([actual.row]) !== await semanticHash([record.row])) {
      throw new Error(`Az import módosított vagy elveszített egy régi rekordot: ${record.entryId}.`);
    }
  }
  const expectedNewIds = new Set(plan.newRegistrations.map((registration) => registration.entryId));
  const actualNewIds = after.records
    .map((record) => record.entryId)
    .filter((entryId) => !before.entryIds.has(entryId));
  if (actualNewIds.length !== expectedNewIds.size || actualNewIds.some((entryId) => !expectedNewIds.has(entryId))) {
    throw new Error("Az import után a fő Sheetben nem pontosan a tervezett új ID-k jelentek meg.");
  }
  for (const registration of plan.newRegistrations) {
    const record = afterById.get(registration.entryId);
    if (!record || record.rowIndex < plan.append_start_row || !sourceMatchesMaster(registration, record.row)) {
      throw new Error(`Az importált rekord visszaolvasása eltér: ${registration.entryId}.`);
    }
  }
}

function partitionManualImportRegistrations(masterRows, emailRows, registrations) {
  const masterEntryIds = new Set(masterRows.slice(1).map((row) => text(row[0])).filter(Boolean));
  const emailEntryIds = new Set(emailRows.slice(1).map((row) => text(row[0])).filter(Boolean));
  const seenInputEntryIds = new Set();
  const newRegistrations = [];
  const recoveredRegistrations = [];
  const skippedExistingMaster = [];
  const skippedDuplicateInFile = [];

  for (const registration of registrations) {
    if (seenInputEntryIds.has(registration.entryId)) {
      skippedDuplicateInFile.push(registration);
      continue;
    }
    seenInputEntryIds.add(registration.entryId);
    if (masterEntryIds.has(registration.entryId)) {
      skippedExistingMaster.push(registration);
      continue;
    }
    if (emailEntryIds.has(registration.entryId)) recoveredRegistrations.push(registration);
    newRegistrations.push(registration);
  }
  return { newRegistrations, recoveredRegistrations, skippedExistingMaster, skippedDuplicateInFile };
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
  if (parts.length < 4) return { venue: "", teacher: "", time: "" };
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

async function buildStaffSyncPlan(accessToken, pipeline) {
  const masterRows = await readSheetRows(accessToken, pipeline.spreadsheet_id, pipeline.tab_name, "A:ZZ");
  const master = validateMasterRows(masterRows);
  const additionalSyncColumns = requiredHeaderIndexes(
    master.header,
    STAFF_ADDITIONAL_SYNC_HEADERS,
    "fő Sheet",
  );

  const registrations = master.records
    .map(({ row }) => ({
      entryId: text(row[0]),
      studentName: text(row[5]),
      submittedAt: text(row[6]),
      row: row.slice(1),
      additionalSyncValues: additionalSyncColumns.map((columnIndex) => text(row[columnIndex])),
    }));
  const target = pipeline.staff_target;
  const staffRows = await readSheetRows(accessToken, target.spreadsheet_id, target.tab_name, "A:ZZ");
  if (text(staffRows[0]?.[0]) !== "Közlemény") {
    throw new Error("A munkatársi Sheet első oszlopának Közleménynek kell lennie.");
  }
  const staffAdditionalColumnPlan = planStaffAdditionalSyncColumns(staffRows);
  const staffByEntryId = indexedStaffRows(staffRows);
  const masterIds = new Set(registrations.map((registration) => registration.entryId));
  const mutableRows = staffRows.map((row) => [...row]);
  const writes = [];
  const createdEntryIds = [];
  const updatedEntryIds = [];
  let unchanged = 0;

  for (const registration of registrations) {
    const existing = staffByEntryId.get(registration.entryId);
    const rowIndex = existing ? existing.rowIndex : findVacantStaffRow(mutableRows);
    if (existing && staffRegistrationMatches(existing.row, registration, staffAdditionalColumnPlan.indexes)) {
      unchanged += 1;
      continue;
    }
    while (mutableRows.length < rowIndex) mutableRows.push([]);
    mutableRows[rowIndex - 1] = staffRowFromRegistration(registration);
    writes.push(...staffRegistrationWriteRanges(target, registration, rowIndex, staffAdditionalColumnPlan.indexes));
    if (existing) updatedEntryIds.push(registration.entryId);
    else createdEntryIds.push(registration.entryId);
  }

  const deleteRows = staffRows
    .map((row, index) => ({ row, index }))
    .filter(({ row, index }) => index > 0 && text(row?.[0]) && !masterIds.has(text(row[0])))
    .map(({ index }) => index + 1)
    .sort((left, right) => right - left);

  const planPayload = {
    pipeline_id: pipeline.pipeline_id,
    master_snapshot_sha256: await semanticHash(masterRows),
    staff_snapshot_sha256: await semanticHash(staffRows),
    created_entry_ids: createdEntryIds,
    updated_entry_ids: updatedEntryIds,
    unchanged,
    delete_rows: deleteRows,
    added_columns: staffAdditionalColumnPlan.addedColumns,
  };
  return {
    target,
    registrations,
    writes,
    deleteRows,
    ...staffAdditionalColumnPlan,
    created: createdEntryIds.length,
    updated: updatedEntryIds.length,
    unchanged,
    total: registrations.length,
    staff_snapshot_sha256: planPayload.staff_snapshot_sha256,
    plan_hash: await sha256(JSON.stringify(planPayload)),
  };
}

function staffSyncPlanSummary(plan) {
  return {
    plan_hash: plan.plan_hash,
    created: plan.created,
    updated: plan.updated,
    unchanged: plan.unchanged,
    deleted: plan.deleteRows.length,
    total: plan.total,
    added_columns: plan.addedColumns.map(({ name }) => name),
    requires_delete_confirmation: plan.deleteRows.length > 0,
  };
}

function indexedStaffRows(staffRows) {
  const byEntryId = new Map();
  for (let index = 1; index < staffRows.length; index += 1) {
    const row = staffRows[index] || [];
    if (!row.some((value) => text(value))) continue;
    const entryId = text(row[0]);
    if (!entryId) {
      throw new Error(`A munkatársi Sheet ${index + 1}. sora nem biztonságos: nem üres sorhoz Közlemény ID kötelező.`);
    }
    if (byEntryId.has(entryId)) throw new Error(`Duplikált ID a munkatársi Sheetben: ${entryId}.`);
    byEntryId.set(entryId, { row, rowIndex: index + 1 });
  }
  return byEntryId;
}

function planStaffAdditionalSyncColumns(staffRows) {
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
  return { indexes, addedColumns, requiredColumnCount: header.length };
}

function staffRegistrationMatches(row, registration, additionalColumnIndexes) {
  const base = staffRowFromRegistration(registration);
  if (base.some((value, index) => text(row[index]) !== text(value))) return false;
  return additionalColumnIndexes.every((columnIndex, valueIndex) => (
    text(row[columnIndex]) === text(registration.additionalSyncValues[valueIndex])
  ));
}

function staffRegistrationWriteRanges(target, registration, rowIndex, additionalColumnIndexes) {
  const values = [{
    range: `${quoteSheetName(target.tab_name)}!A${rowIndex}:H${rowIndex}`,
    values: [staffRowFromRegistration(registration)],
  }];
  additionalColumnIndexes.forEach((columnIndex, valueIndex) => {
    values.push({
      range: `${quoteSheetName(target.tab_name)}!${columnLetter(columnIndex)}${rowIndex}`,
      values: [[registration.additionalSyncValues[valueIndex]]],
    });
  });
  return values;
}

function findVacantStaffRow(rows) {
  for (let index = 1; index < rows.length; index += 1) {
    if (!(rows[index] || []).some((value) => text(value))) return index + 1;
  }
  return Math.max(2, rows.length + 1);
}

async function syncStaffTarget(accessToken, pipeline, plan, { allowDeletes = false } = {}) {
  if (plan.deleteRows.length && !allowDeletes) {
    throw new Error("A munkatársi Sheetből való törléshez külön jóváhagyás kell.");
  }
  await applyStaffAdditionalSyncColumns(accessToken, plan.target, plan);
  if (plan.writes.length) await writeSheetRanges(accessToken, plan.target.spreadsheet_id, plan.writes);
  if (plan.deleteRows.length) await deleteRowsByIndex(accessToken, plan.target, plan.deleteRows);
  await verifyStaffSyncTarget(accessToken, plan);
  return staffSyncPlanSummary(plan);
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

async function applyStaffAdditionalSyncColumns(accessToken, target, plan) {
  if (!plan.addedColumns.length) return;
  await ensureSheetColumnCapacity(accessToken, target, plan.requiredColumnCount);
  await writeSheetRanges(accessToken, target.spreadsheet_id, plan.addedColumns.map(({ name, index }) => ({
    range: `${quoteSheetName(target.tab_name)}!${columnLetter(index)}1`,
    values: [[name]],
  })));
}

async function verifyStaffSyncTarget(accessToken, plan) {
  const rows = await readSheetRows(accessToken, plan.target.spreadsheet_id, plan.target.tab_name, "A:ZZ");
  if (text(rows[0]?.[0]) !== "Közlemény") throw new Error("A munkatársi Sheet írás után elvesztette a Közlemény fejlécet.");
  const byEntryId = indexedStaffRows(rows);
  for (const registration of plan.registrations) {
    const actual = byEntryId.get(registration.entryId);
    if (!actual || !staffRegistrationMatches(actual.row, registration, plan.indexes)) {
      throw new Error(`A munkatársi Sheet visszaolvasása eltér: ${registration.entryId}.`);
    }
  }
  if (plan.deleteRows.length) {
    const masterIds = new Set(plan.registrations.map((registration) => registration.entryId));
    const unexpected = [...byEntryId.keys()].filter((entryId) => !masterIds.has(entryId));
    if (unexpected.length) throw new Error("A jóváhagyott törlés után maradt fő Sheetből hiányzó munkatársi sor.");
  }
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
  const emailRows = await readSheetRows(
    accessToken, pipeline.spreadsheet_id, EMAIL_OUTPUT_TAB, "A:AH",
  );
  const checkboxRows = await ensureEmailOutputCheckboxValidation(
    accessToken, pipeline.spreadsheet_id, 2, emailRows.length,
  );
  return {
    created_tabs: missing,
    output_columns: EMAIL_OUTPUT_HEADERS.length,
    settings_initialized: !settingsRows.length,
    checkbox_rows: checkboxRows,
  };
}

async function ensureEmailOutputStatusFormatting(accessToken, spreadsheetId, metadata) {
  const emailSheet = (metadata.sheets || []).find((sheet) => sheet.properties?.title === EMAIL_OUTPUT_TAB);
  if (!emailSheet) return;

  const greenFormat = {
    backgroundColor: { red: 0.8509804, green: 0.9411765, blue: 0.827451 },
    backgroundColorStyle: { rgbColor: { red: 0.8509804, green: 0.9411765, blue: 0.827451 } },
  };
  const statusFormula = 'OR(AND($N2<>"",$N2<>"MANUÁLIS",OR($M2="BREVO FOGADTA",$M2="KÉZBESÍTVE")),AND(OR($S2=TRUE,$S2="TRUE",$S2="IGAZ",$S2="IGEN",$S2=1),OR($M2="ELKÜLDVE",$M2="ELKÜLDÉS UTÁN MÓDOSULT")))';
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

async function ensureEmailOutputCheckboxValidation(
  accessToken, spreadsheetId, startRow, endRow,
) {
  if (!Number.isInteger(startRow) || !Number.isInteger(endRow) || endRow < startRow) return 0;
  const metadata = await getSpreadsheetMetadata(accessToken, spreadsheetId);
  const emailSheet = (metadata.sheets || []).find(
    (sheet) => sheet.properties?.title === EMAIL_OUTPUT_TAB,
  );
  if (!emailSheet) throw new Error(`Hiányzó lap: ${EMAIL_OUTPUT_TAB}`);
  const rule = {
    condition: { type: "BOOLEAN" },
    strict: true,
    showCustomUi: true,
  };
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  await googleFetch(`${baseUrl}:batchUpdate`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      requests: [EMAIL_COLUMN.APPROVED, EMAIL_COLUMN.MANUAL_SENT].map((columnIndex) => ({
        setDataValidation: {
          range: {
            sheetId: emailSheet.properties.sheetId,
            startRowIndex: startRow - 1,
            endRowIndex: endRow,
            startColumnIndex: columnIndex,
            endColumnIndex: columnIndex + 1,
          },
          rule,
          filteredRowsIncluded: true,
        },
      })),
    }),
  });
  return endRow - startRow + 1;
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
  if (!(entryIds instanceof Set) || !entryIds.size) {
    throw new Error("Az e-mail-piszkozatok kizárólag név szerint megadott, frissen importált ID-khoz készülhetnek.");
  }
  const [masterRows, configRows, emailRows, emailSettings, metadata] = await Promise.all([
    readSheetRows(accessToken, pipeline.spreadsheet_id, pipeline.tab_name, "A:AT"),
    readSheetRows(accessToken, pipeline.spreadsheet_id, AUTOMATION_CONFIG_TAB, "A:Y"),
    readSheetRows(accessToken, pipeline.spreadsheet_id, EMAIL_OUTPUT_TAB, "A:AH"),
    loadEmailSettings(accessToken, pipeline),
    getSpreadsheetMetadata(accessToken, pipeline.spreadsheet_id),
  ]);
  const master = validateMasterRows(masterRows);
  validateEmailRows(emailRows);
  assertNoPartialBasicFilter(metadata, pipeline.tab_name, master.header.length);
  if (text(configRows[0]?.[0]) !== "Tanfolyam kulcs") throw new Error("A Tanfolyamok központi órarend-fejléce hiányzik.");

  const config = parseAutomationConfig(configRows);
  const mutableEmailRows = emailRows.map((row) => [...row]);
  const writes = [];
  const emailCheckboxRows = [];
  const results = [];
  const now = new Date().toISOString();
  const duplicateEntryIds = duplicateMasterEntryIds(masterRows);

  for (let index = 1; index < masterRows.length; index += 1) {
    const row = masterRows[index] || [];
    const entryId = text(row[0]);
    if (!entryId || !text(row[5]) || (entryIds && !entryIds.has(entryId))) continue;
    const registration = registrationFromMasterRow(row);
    if (duplicateEntryIds.has(entryId)) {
      results.push({
        entry_id: entryId,
        row_index: index + 1,
        status: AUTOMATION_STATUS.MANUAL,
        reason: "A Közlemény azonosító több forrásrekordban szerepel; automatikus e-mail-készítés letiltva.",
        fee: "",
        first_class: "",
      });
      continue;
    }
    const calculation = calculateRegistration(registration, config);
    const canonicalRegistration = {
      ...registration,
      contactFirstName: "",
      studentFirstName: "",
    };
    const canonicalDraft = buildEmailDraft(
      canonicalRegistration,
      calculation,
      emailSettings.settings,
      calculation.isTrial ? EMAIL_EVENT.TRIAL : EMAIL_EVENT.ENROLLMENT,
    );
    const identityReason = staleFirstNameReason(registration, canonicalDraft);
    if (identityReason) {
      results.push({
        entry_id: entryId,
        row_index: index + 1,
        status: AUTOMATION_STATUS.MANUAL,
        reason: identityReason,
        fee: "",
        first_class: "",
      });
      continue;
    }
    const mainRow = index + 1;
    const firstClassValue = calculation.firstClass ? `${formatDate(calculation.firstClass.date)} ${calculation.firstClass.startTime}` : "";
    const eventType = calculation.isTrial ? EMAIL_EVENT.TRIAL : EMAIL_EVENT.ENROLLMENT;
    const draft = calculation.status === AUTOMATION_STATUS.READY
      ? canonicalDraft
      : emptyEmailDraft(eventType);
    const sourceHash = await sha256(JSON.stringify({
      registration: canonicalRegistration,
      calculation: serializableCalculation(calculation),
      eventType,
      templateVersion: TEMPLATE_VERSION,
      templateKey: draft.templateKey,
      templateId: draft.templateId,
      params: draft.params,
      settingsConfigured: emailSettings.configured,
    }));
    const automationContent = [
      firstClassValue, calculation.semester || "", calculation.feeBand || "", calculation.feeCategory || "",
      calculation.discount || "", calculation.status,
      [calculation.manualReason, draft.manualReason, draft.configurationWarning].filter(Boolean).join(" "),
      sourceHash, TEMPLATE_VERSION,
    ];
    const currentAutomationContent = row.slice(34, 43);
    const unchangedAutomation = sameSheetValues(currentAutomationContent, automationContent);
    const automationValues = [
      ...automationContent,
      unchangedAutomation && text(row[43]) ? text(row[43]) : now,
    ];
    if (calculation.status === AUTOMATION_STATUS.READY && calculation.isTrial && !text(registration.trialDate)) {
      writes.push({ range: `${quoteSheetName(pipeline.tab_name)}!${TRIAL_DATE_COLUMN}${mainRow}`, values: [[formatDate(calculation.firstClass.date)]] });
    }
    if (!sameSheetValues(row.slice(34, 44), automationValues)) {
      writes.push({ range: `${quoteSheetName(pipeline.tab_name)}!${AUTOMATION_START_COLUMN}${mainRow}:${AUTOMATION_END_COLUMN}${mainRow}`, values: [automationValues] });
    }
    if (calculation.status === AUTOMATION_STATUS.READY && !calculation.isTrial && calculation.fee) {
      const feeColumn = calculation.semester === 2 ? "AC" : "J";
      const feeIndex = calculation.semester === 2 ? 28 : 9;
      if (text(row[feeIndex]) !== text(calculation.fee)) {
        writes.push({ range: `${quoteSheetName(pipeline.tab_name)}!${feeColumn}${mainRow}`, values: [[calculation.fee]] });
      }
    }
    if (!text(registration.contactFirstName) && draft.contactFirstName) {
      writes.push({ range: `${quoteSheetName(pipeline.tab_name)}!${CONTACT_FIRST_NAME_COLUMN}${mainRow}`, values: [[draft.contactFirstName]] });
    }
    if (!text(registration.studentFirstName) && draft.studentFirstName) {
      writes.push({ range: `${quoteSheetName(pipeline.tab_name)}!${STUDENT_FIRST_NAME_COLUMN}${mainRow}`, values: [[draft.studentFirstName]] });
    }

    const periodKey = emailPeriodKey(registration, calculation);
    const sendKey = `${entryId}|${eventType}|${periodKey}|${TEMPLATE_VERSION}`;
    if (hasPriorEmailSendEvidence(mutableEmailRows, entryId)) {
      results.push({
        entry_id: entryId,
        row_index: mainRow,
        event_type: eventType,
        status: AUTOMATION_STATUS.MANUAL,
        reason: "Korábbi Brevo- vagy kézi küldési bizonyíték létezik ehhez az ID-hoz; második levél nem készül.",
        fee: calculation.fee || "",
        first_class: firstClassValue,
      });
      continue;
    }
    const existingMatch = findExistingEmailRow(
      mutableEmailRows, sendKey, entryId, eventType, periodKey, registration.email,
    );
    if (existingMatch.manualReason) {
      results.push({
        entry_id: entryId,
        row_index: mainRow,
        event_type: eventType,
        status: AUTOMATION_STATUS.MANUAL,
        reason: existingMatch.manualReason,
        fee: calculation.fee || "",
        first_class: firstClassValue,
      });
      continue;
    }
    const existingIndex = existingMatch.index;
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
      emailCheckboxRows.push(queueRowIndex);
    }

    const finalReason = [calculation.manualReason, draft.manualReason, draft.configurationWarning].filter(Boolean).join(" ");
    const resultStatus = calculation.status === AUTOMATION_STATUS.READY && !finalReason
      ? AUTOMATION_STATUS.READY
      : AUTOMATION_STATUS.MANUAL;
    results.push({ entry_id: entryId, row_index: mainRow, event_type: eventType, status: resultStatus, reason: finalReason, fee: calculation.fee || "", first_class: firstClassValue });
  }

  if (writes.length) await writeSheetRanges(accessToken, pipeline.spreadsheet_id, writes);
  if (emailCheckboxRows.length) {
    await ensureEmailOutputCheckboxValidation(
      accessToken,
      pipeline.spreadsheet_id,
      Math.min(...emailCheckboxRows),
      Math.max(...emailCheckboxRows),
    );
  }
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
  const emailCheckboxRows = [];
  const results = [];
  const now = new Date().toISOString();
  const duplicateEntryIds = duplicateMasterEntryIds(masterRows);

  for (let index = 1; index < masterRows.length; index += 1) {
    const row = masterRows[index] || [];
    const entryId = text(row[0]);
    if (!entryId || !entryIds.has(entryId)) continue;
    const registration = registrationFromMasterRow(row);
    if (duplicateEntryIds.has(entryId)) {
      results.push({
        entry_id: entryId,
        status: AUTOMATION_STATUS.MANUAL,
        reason: "A Közlemény azonosító több forrásrekordban szerepel; automatikus e-mail-készítés letiltva.",
      });
      continue;
    }
    if (!registration.paidDate) continue;
    const canonicalRegistration = {
      ...registration,
      contactFirstName: "",
      studentFirstName: "",
    };
    const draft = buildEmailDraft(
      canonicalRegistration, {}, emailSettings.settings, EMAIL_EVENT.PAYMENT_RECEIVED,
    );
    const identityReason = staleFirstNameReason(registration, draft);
    if (identityReason) {
      results.push({ entry_id: entryId, status: AUTOMATION_STATUS.MANUAL, reason: identityReason });
      continue;
    }
    const sourceHash = await sha256(JSON.stringify({
      registration: canonicalRegistration,
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
    if (hasLegacyManualEmailHistory(mutableEmailRows, entryId, registration.email)) {
      results.push({
        entry_id: entryId,
        status: AUTOMATION_STATUS.MANUAL,
        reason: "Korábbi rendszerben manuálisan elküldve; automatikus piszkozat nem készül.",
      });
      continue;
    }
    const existingMatch = findExistingEmailRow(
      mutableEmailRows, sendKey, entryId, EMAIL_EVENT.PAYMENT_RECEIVED, periodKey, registration.email,
    );
    if (existingMatch.manualReason) {
      results.push({
        entry_id: entryId,
        status: AUTOMATION_STATUS.MANUAL,
        reason: existingMatch.manualReason,
      });
      continue;
    }
    const existingIndex = existingMatch.index;
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
    emailCheckboxRows.push(queueRowIndex);
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
  if (emailCheckboxRows.length) {
    await ensureEmailOutputCheckboxValidation(
      accessToken,
      pipeline.spreadsheet_id,
      Math.min(...emailCheckboxRows),
      Math.max(...emailCheckboxRows),
    );
  }
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

function duplicateMasterEntryIds(masterRows) {
  const counts = new Map();
  masterRows.slice(1).forEach((row) => {
    const entryId = text(row?.[0]);
    if (entryId) counts.set(entryId, (counts.get(entryId) || 0) + 1);
  });
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([entryId]) => entryId));
}

function sameRecipient(left, right) {
  return text(left).toLowerCase() === text(right).toLowerCase();
}

function sameSheetValues(left, right) {
  return left.length === right.length && left.every((value, index) => text(value) === text(right[index]));
}

function staleFirstNameReason(registration, canonicalDraft) {
  const conflicts = [];
  if (text(registration.contactFirstName) && text(canonicalDraft.contactFirstName)
      && text(registration.contactFirstName).toLocaleLowerCase("hu") !== text(canonicalDraft.contactFirstName).toLocaleLowerCase("hu")) {
    conflicts.push("kapcsolattartó");
  }
  if (text(registration.studentFirstName) && text(canonicalDraft.studentFirstName)
      && text(registration.studentFirstName).toLocaleLowerCase("hu") !== text(canonicalDraft.studentFirstName).toLocaleLowerCase("hu")) {
    conflicts.push("növendék");
  }
  return conflicts.length
    ? `Az ${conflicts.join(" és ")} keresztnév-segédmező eltér a kanonikus forrástól; automatikus írás és e-mail-készítés letiltva.`
    : "";
}

function findExistingEmailRow(rows, sendKey, entryId, eventType, periodKey, recipient) {
  // A küldési szándék (jelentkezés + eseménytípus + időszak) csak egy aktív
  // sort kaphat. A régi viselkedés címzetteltérésnél egy új piszkozatot fűzött
  // a történeti sor mellé; ez képes volt ugyanazzal a küldési kulccsal több
  // aktív sort létrehozni. Ilyenkor kizárólag a kontrollált rekonstrukció
  // dönthet, ezért a generálás írás nélkül kézi felülvizsgálatra áll meg.
  const candidates = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row, index }) => index > 0 && (
      text(row[EMAIL_COLUMN.SEND_KEY]) === sendKey
      || (
        text(row[EMAIL_COLUMN.ENTRY_ID]) === entryId
        && emailEventTypeFromRow(row) === eventType
        && emailPeriodKeyFromRow(row) === periodKey
      )
    ));
  if (!candidates.length) return { index: -1, manualReason: "" };

  const recipientMatches = candidates.filter(({ row }) => sameRecipient(row[EMAIL_COLUMN.TO], recipient));
  if (recipientMatches.length === 1 && candidates.length === 1) {
    return { index: recipientMatches[0].index, manualReason: "" };
  }
  if (recipientMatches.length === 0) {
    return {
      index: -1,
      manualReason: "A meglévő e-mail-kimeneti sor címzettje eltér a jelenlegi forrástól; új piszkozat nem készül a kontrollált rekonstrukció előtt.",
    };
  }
  return {
    index: -1,
    manualReason: "Több e-mail-kimeneti sor tartozik ugyanahhoz a küldési szándékhoz; új piszkozat nem készül a kontrollált rekonstrukció előtt.",
  };
}

function hasPriorEmailSendEvidence(rows, entryId) {
  return rows.some((emailRow, emailIndex) => (
    emailIndex > 0
    && text(emailRow[EMAIL_COLUMN.ENTRY_ID]) === entryId
    && (
      isChecked(emailRow[EMAIL_COLUMN.MANUAL_SENT])
      || Boolean(text(emailRow[EMAIL_COLUMN.MESSAGE_ID]))
      || isFinalEmailStatus(text(emailRow[EMAIL_COLUMN.STATUS]))
    )
  ));
}

function hasLegacyManualEmailHistory(rows, entryId, recipient) {
  return rows.some((emailRow, emailIndex) => (
    emailIndex > 0
    && isChecked(emailRow[EMAIL_COLUMN.MANUAL_SENT])
    && text(emailRow[EMAIL_COLUMN.ENTRY_ID]) === entryId
    && text(emailRow[EMAIL_COLUMN.TEMPLATE_VERSION]) !== TEMPLATE_VERSION
    && sameRecipient(emailRow[EMAIL_COLUMN.TO], recipient)
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
  let lastRecordRow = 1;
  for (let index = 1; index < rows.length; index += 1) {
    if (text(rows[index]?.[keyColumn - 1])) lastRecordRow = index + 1;
  }
  return lastRecordRow + 1;
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
  const eventKey = brevoEventKey(payload);
  const inFlight = inFlightBrevoEvents.get(eventKey);
  if (inFlight) {
    await inFlight;
    return { duplicate: true, event: normalizeBrevoEvent(payload.event || payload.type), matched: false };
  }

  const record = (async () => recordBrevoEventOnce(accessToken, pipeline, payload, await brevoEventId(payload)))();
  inFlightBrevoEvents.set(eventKey, record);
  try {
    return await record;
  } finally {
    if (inFlightBrevoEvents.get(eventKey) === record) inFlightBrevoEvents.delete(eventKey);
  }
}

async function recordBrevoEventOnce(accessToken, pipeline, payload, eventId) {
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
  if (eventRows.slice(1).some((row) => text(row[0]) === eventId
      || (messageId && text(row[1]) === messageId && text(row[8]) === rawEvent))) {
    return { duplicate: true, event: rawEvent, matched: false };
  }

  const matches = messageId && recipient
    ? emailRows
      .map((row, index) => ({ row, index }))
      .filter(({ row, index }) => index > 0
        && text(row[EMAIL_COLUMN.MESSAGE_ID]) === messageId
        && sameRecipient(row[EMAIL_COLUMN.TO], recipient))
    : [];
  const emailIndex = matches.length === 1 ? matches[0].index : -1;
  const matchedRow = emailIndex >= 0 ? emailRows[emailIndex] : [];
  const sendKey = text(matchedRow[EMAIL_COLUMN.SEND_KEY]) || sendKeyFromPayload;
  const reason = text(payload.reason || payload.description || payload.response || payload.error);
  const receivedAt = new Date().toISOString();
  const quarantineReason = !messageId || !recipient
    ? "KARANTÉN: hiányzik a Brevo message ID vagy a címzett; e-mail-kimeneti sor nem módosult."
    : matches.length !== 1
      ? `KARANTÉN: a message ID és címzett alapján ${matches.length} e-mail-kimeneti sor található; e-mail-kimeneti sor nem módosult.`
      : "";
  const eventRow = [eventId, messageId, sendKey, brevoEventLabel(rawEvent), recipient, eventAt, receivedAt, [reason, quarantineReason].filter(Boolean).join(" "), rawEvent];
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

async function brevoEventId(payload) {
  return sha256(brevoEventKey(payload));
}

function brevoEventKey(payload) {
  const rawEvent = normalizeBrevoEvent(payload.event || payload.type);
  const messageId = text(payload["message-id"] || payload.messageId || payload.message_id);
  const recipient = text(payload.email || payload.recipient);
  const eventAt = brevoEventTimestamp(payload);
  return JSON.stringify({
    brevoId: text(payload.id || payload.event_id), messageId, rawEvent, recipient, eventAt,
  });
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
  const [rows, masterRows, metadata] = await Promise.all([
    readSheetRows(accessToken, pipeline.spreadsheet_id, EMAIL_OUTPUT_TAB, "A:AH"),
    readSheetRows(accessToken, pipeline.spreadsheet_id, pipeline.tab_name, "A:AT"),
    getSpreadsheetMetadata(accessToken, pipeline.spreadsheet_id),
  ]);
  const master = validateMasterRows(masterRows);
  validateEmailRows(rows);
  assertNoPartialBasicFilter(metadata, pipeline.tab_name, master.header.length);
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

async function clearSheetRanges(accessToken, spreadsheetId, ranges) {
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  await googleFetch(`${baseUrl}/values:batchClear`, accessToken, {
    method: "POST",
    body: JSON.stringify({ ranges }),
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
  return googleFetch(`${baseUrl}?fields=sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),basicFilter,conditionalFormats)`, accessToken);
}

function findSheetTitle(metadata, requestedTitle) {
  const requested = requestedTitle == null ? "" : String(requestedTitle);
  const exact = (metadata.sheets || []).find((item) => String(item.properties?.title ?? "") === requested);
  if (exact) return String(exact.properties.title);
  const trimmed = requested.trim();
  const equivalent = (metadata.sheets || []).find((item) => String(item.properties?.title ?? "").trim() === trimmed);
  return equivalent ? String(equivalent.properties.title) : "";
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

function importPage(message = "") {
  const content = `<main>
    <h1>Új jelentkezések hozzáadása</h1>
    <p>Válaszd ki a Gravity Formsból letöltött CSV-fájlt. Előbb megmutatjuk, hány új jelentkezést találtunk.</p>
    <p><a href="https://kult2.hu/wp-admin/admin.php?page=gf_export" target="_blank" rel="noopener noreferrer">CSV letöltése a Gravity Formsból</a></p>
    ${message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : ""}
    <form method="post" enctype="multipart/form-data" data-import-form>
      <input type="hidden" name="mode" value="plan">
      <label class="file-label">CSV-fájl<input type="file" name="file" accept=".csv,text/csv"></label>
      <button>Fájl ellenőrzése</button>
    </form>
    <p class="note">Az ellenőrzés még nem módosít semmit és nem küld e-mailt.</p>
  </main>`;
  return importPageShell("Jelentkezések importálása", content);
}

function importPlanPage(plan, count) {
  const newIds = plan.new_entry_ids;
  const oldIds = plan.skipped_existing_master;
  const newLabel = newIds.length === 1 ? "1 új jelentkezést" : `${newIds.length} új jelentkezést`;
  const newButtonLabel = newIds.length === 1 ? "1 új jelentkezés hozzáadása" : `${newIds.length} új jelentkezés hozzáadása`;
  const oldLabel = oldIds.length === 1 ? "1 jelentkezés" : `${oldIds.length} jelentkezés`;
  const action = newIds.length
    ? `<form method="post" enctype="multipart/form-data" data-import-form data-reuses-file>
        <input type="hidden" name="mode" value="execute">
        <input type="hidden" name="plan_hash" value="${escapeHtml(plan.plan_hash)}">
        <button>${newButtonLabel}</button>
      </form>`
    : "";
  const details = newIds.length
    ? `<details><summary>Az új jelentkezések azonosítói</summary><p>${escapeHtml(newIds.join(", "))}</p></details>`
    : "";
  const result = newIds.length
    ? `<p class="result"><strong>${newLabel} találtunk.</strong></p>`
    : '<p class="result"><strong>Nincs új jelentkezés ebben a fájlban.</strong></p>';
  const skipped = oldIds.length
    ? `<p>${oldLabel} már szerepel a táblázatban, ezért kihagyjuk.</p>`
    : "";
  const content = `<main>
    <h1>A fájl rendben van</h1>
    <p>${count} jelentkezést ellenőriztünk.</p>
    ${result}
    ${skipped}
    ${details}
    ${action}
    <p><a href="">Másik fájl választása</a></p>
  </main>`;
  return importPageShell("Import ellenőrzése", content);
}

function importResultPage(result, count, plan, backup, draftGrant) {
  const written = result.results.length;
  const draftAction = draftGrant
    ? `<form method="post"><input type="hidden" name="mode" value="drafts"><input type="hidden" name="draft_grant" value="${escapeHtml(draftGrant)}"><button>E-mail-piszkozatok elkészítése (${plan.new_entry_ids.length})</button></form><p class="note">Csak piszkozat készül. Küldéshez később külön jóváhagyás kell.</p>`
    : "";
  const writtenLabel = written === 1 ? "1 új jelentkezés bekerült." : `${written} új jelentkezés bekerült.`;
  const content = `<main>
    <h1>Kész</h1>
    <p class="result"><strong>${writtenLabel}</strong></p>
    <p>Korábbi jelentkezéseket nem változtattunk meg, és e-mailt sem küldtünk.</p>
    ${draftAction}
  </main>`;
  return importPageShell("Import kész", content);
}

function importDraftResultPage(result) {
  const manual = result.manual
    ? `<p>${result.manual} jelentkezést még kézzel át kell nézni.</p>`
    : "";
  const content = `<main>
    <h1>A piszkozatok elkészültek</h1>
    <p class="result"><strong>${result.ready} e-mail-piszkozat készen áll az ellenőrzésre.</strong></p>
    ${manual}
    <p>E-mailt nem küldtünk.</p>
  </main>`;
  return importPageShell("E-mail-piszkozatok elkészültek", content);
}

function importPageShell(title, content) {
  return `<!doctype html>
<html lang="hu">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root{color-scheme:light;font:16px/1.5 system-ui,-apple-system,sans-serif;color:#172033;background:#f5f7fb}
    body{max-width:680px;margin:48px auto;padding:0 20px}
    main{background:#fff;border:1px solid #dce1ea;border-radius:16px;padding:28px;box-shadow:0 8px 30px rgba(32,45,72,.08)}
    h1{font-size:1.65rem;line-height:1.2;margin:0 0 16px}
    p{margin:12px 0}a{color:#3157a4}button,input{font:inherit}
    button{display:inline-block;margin-top:18px;padding:11px 18px;border:0;border-radius:9px;background:#3157a4;color:#fff;font-weight:650;cursor:pointer}
    button:disabled{opacity:.65;cursor:wait}.file-label{display:block;margin-top:20px;font-weight:650}
    input[type=file]{display:block;max-width:100%;margin-top:8px;font-weight:400}
    .error{padding:12px 14px;border-radius:9px;background:#fff1f0;color:#8b1e19}.note{color:#5a6478;font-size:.92rem}
    .result{font-size:1.15rem}.client-error{margin-top:16px}details{margin:16px 0;color:#4c566a}details p{overflow-wrap:anywhere}
  </style>
</head>
<body>
${content}
${importClientScript()}
</body>
</html>`;
}

function importClientScript() {
  return `<script>
(() => {
  let selectedFile = null;

  function showError(message) {
    const main = document.querySelector("main");
    let error = main.querySelector(".client-error");
    if (!error) {
      error = document.createElement("p");
      error.className = "error client-error";
      error.setAttribute("role", "alert");
      main.append(error);
    }
    error.textContent = message;
  }

  function bindImportForm() {
    const form = document.querySelector("form[data-import-form]");
    if (!form) return;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = form.querySelector('input[type="file"][name="file"]');
      if (input && input.files && input.files[0]) selectedFile = input.files[0];
      if (!selectedFile) {
        showError(form.hasAttribute("data-reuses-file")
          ? "A fájl már nem érhető el. Válassz ki újra egy CSV-fájlt."
          : "Válassz ki egy CSV-fájlt.");
        return;
      }

      const button = form.querySelector("button");
      const originalLabel = button ? button.textContent : "";
      if (button) {
        button.disabled = true;
        button.textContent = "Dolgozunk…";
      }
      try {
        const data = new FormData(form);
        data.set("file", selectedFile, selectedFile.name);
        const response = await fetch(form.action || location.href, { method: "POST", body: data });
        const source = await response.text();
        const next = new DOMParser().parseFromString(source, "text/html");
        const nextMain = next.querySelector("main");
        if (!nextMain) throw new Error("invalid_response");
        document.title = next.title || document.title;
        document.querySelector("main").replaceWith(nextMain);
        bindImportForm();
        window.scrollTo({ top: 0, behavior: "smooth" });
      } catch (error) {
        showError("Nem sikerült kapcsolódni. A fájl nálad maradt; próbáld meg újra.");
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = originalLabel;
        }
      }
    });
  }

  bindImportForm();
})();
</script>`;
}

function importErrorMessage(error) {
  const message = text(error?.message);
  if (!message) return "Az import nem sikerült. Semmi nem változott; próbáld meg újra.";
  if (/CSV|Gravity Forms ID|növendéknév/i.test(message)) return message;
  if (/részleges|rendezést tartalmaz/i.test(message)) {
    return "A táblázaton most olyan szűrés vagy rendezés van, amely mellett nem tudunk importálni. Kapcsold ki, majd próbáld meg újra.";
  }
  if (/backup|IMPORT_BACKUP|Google API|Google token|service account/i.test(message)) {
    return "Most nem tudjuk biztonságosan elindítani az importot. Semmi nem változott; próbáld meg néhány perc múlva.";
  }
  return "Az import nem sikerült. Semmi nem változott; próbáld meg újra. Ha ismét ezt látod, szólj a rendszergazdának.";
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }

export {
  CSV_HEADERS, brevoSendKey, brevoStatus, buildApprovedCorrections, emailRevisionHashFromRow, extractReferences,
  findMasterRow, mergeMasterRow, nameSuggestions, normalizeForMatch, parseCsv, parseCsvRegistrations,
  partitionManualImportRegistrations, paymentFromRow, recordBrevoEvent, registrationFromCsvRow,
  appendOnlyMasterRegistrations, readImportSnapshot,
};
