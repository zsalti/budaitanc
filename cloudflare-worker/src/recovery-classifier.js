import { AUTOMATION_STATUS, calculateRegistration, formatDate, parseAutomationConfig } from "./fee-engine.js";
import {
  EMAIL_EVENT,
  TEMPLATE_VERSION,
  buildEmailDraft,
  defaultEmailSettings,
  parseEmailSettings,
} from "./email-templates.js";

const EMAIL_REVISION_FIELDS = [4, 5, 6, 7, 3, 15, 21, 22, 23, 24, 25, 26];

/**
 * Classify a complete Gravity Forms source export without writing Sheets or
 * rendering personal data into the retained recovery manifest.
 */
export function classifyRecoverySource({ registrations, configRows, settingsRows = [] }) {
  if (!Array.isArray(registrations) || !registrations.length) {
    throw new Error("A helyreállítási forrás nem tartalmaz rekordot.");
  }
  if (!Array.isArray(configRows) || text(configRows[0]?.[0]) !== "Tanfolyam kulcs") {
    throw new Error("A Tanfolyamok központi konfigurációja hiányzik vagy hibás.");
  }

  const ids = registrations.map((item) => text(item.entryId));
  const duplicateIds = duplicates(ids);
  if (ids.some((entryId) => !entryId) || duplicateIds.length) {
    throw new Error(`A helyreállítási forrás azonosítói hiányosak vagy duplikáltak: ${duplicateIds.join(", ") || "hiányzó ID"}`);
  }

  const config = parseAutomationConfig(configRows);
  const settingsConfigured = text(settingsRows[0]?.[0]) === "Kulcs";
  const settings = settingsConfigured ? parseEmailSettings(settingsRows) : defaultEmailSettings();
  const records = registrations
    .map((source) => classifyOne(source, config, settings, settingsConfigured))
    .sort((left, right) => compareEntryIds(left.entry_id, right.entry_id));

  const reasonCounts = new Map();
  for (const record of records) {
    if (!record.reason) continue;
    reasonCounts.set(record.reason, (reasonCounts.get(record.reason) || 0) + 1);
  }

  return {
    mode: "read_only",
    source_records: records.length,
    expected_intent_rows: records.length,
    send_ready: records.filter((record) => record.classification === "send_ready").length,
    manual_review: records.filter((record) => record.classification === "manual_review").length,
    event_counts: countBy(records, "event_type"),
    classification_counts: countBy(records, "classification"),
    manual_reason_counts: Object.fromEntries([...reasonCounts.entries()].sort(([left], [right]) => left.localeCompare(right, "hu"))),
    records,
  };
}

export async function buildRecoveryEmailRows({ registrations, configRows, settingsRows = [] }) {
  // Reuse the public classifier for input validation before producing the
  // PII-bearing scratch artifact.
  classifyRecoverySource({ registrations, configRows, settingsRows });
  const config = parseAutomationConfig(configRows);
  const settingsConfigured = text(settingsRows[0]?.[0]) === "Kulcs";
  const settings = settingsConfigured ? parseEmailSettings(settingsRows) : defaultEmailSettings();
  const rows = [];
  for (const source of [...registrations].sort((left, right) => compareEntryIds(text(left.entryId), text(right.entryId)))) {
    const registration = canonicalRegistration(source);
    const calculation = calculateRegistration(registration, config);
    const eventType = calculation.isTrial ? EMAIL_EVENT.TRIAL : EMAIL_EVENT.ENROLLMENT;
    const canonicalDraft = buildEmailDraft(registration, calculation, settings, eventType);
    const draft = calculation.status === AUTOMATION_STATUS.READY
      ? canonicalDraft
      : emptyEmailDraft(eventType);
    const sourceHash = await sha256(JSON.stringify({
      registration,
      calculation: serializableCalculation(calculation),
      eventType,
      templateVersion: TEMPLATE_VERSION,
      templateKey: draft.templateKey,
      templateId: draft.templateId,
      params: draft.params,
      settingsConfigured,
    }));
    const firstClass = calculation.firstClass
      ? `${formatDate(calculation.firstClass.date)} ${calculation.firstClass.startTime}`.trim()
      : "";
    const periodKey = emailPeriodKey(registration, calculation);
    const sendKey = `${registration.entryId}|${eventType}|${periodKey}|${TEMPLATE_VERSION}`;
    const finalReason = [calculation.manualReason, draft.manualReason, draft.configurationWarning].filter(Boolean).join(" ");
    const status = calculation.status === AUTOMATION_STATUS.READY && !finalReason
      ? AUTOMATION_STATUS.READY
      : AUTOMATION_STATUS.MANUAL;
    const explanation = [
      calculation.explanation || calculation.manualReason,
      draft.manualReason,
      draft.configurationWarning,
      settingsConfigured ? "" : "Az E-mail beállítások fül még nincs inicializálva; kódalapú alapértékek láthatók.",
    ].filter(Boolean).join(" ");
    const row = [
      sendKey, registration.entryId, periodKey, TEMPLATE_VERSION, registration.email,
      draft.subject, draft.plain, draft.html, firstClass, calculation.fee || "", explanation,
      false, status, "", "", sourceHash, "", "", false, "", "", eventType,
      draft.audienceType, draft.venueCode, draft.templateKey, draft.templateId,
      draft.params ? JSON.stringify(draft.params) : "", "", "", "", "", "", "", "",
    ];
    row[33] = await sha256(EMAIL_REVISION_FIELDS.map((index) => text(row[index])).join("\u001f"));
    rows.push(row);
  }
  return {
    rows,
    counts: {
      total: rows.length,
      send_ready: rows.filter((row) => row[12] === AUTOMATION_STATUS.READY).length,
      manual_review: rows.filter((row) => row[12] === AUTOMATION_STATUS.MANUAL).length,
      approved: rows.filter((row) => row[11] === true).length,
      duplicate_send_keys: duplicateCount(rows.map((row) => text(row[0]))),
    },
  };
}

function classifyOne(source, config, settings, settingsConfigured) {
  const registration = canonicalRegistration(source);
  const calculation = calculateRegistration(registration, config);
  const eventType = calculation.isTrial ? EMAIL_EVENT.TRIAL : EMAIL_EVENT.ENROLLMENT;
  const draft = buildEmailDraft(registration, calculation, settings, eventType);
  const reasons = [
    calculation.manualReason,
    draft.manualReason,
    draft.configurationWarning,
    settingsConfigured ? "" : "Az E-mail beállítások fül nincs inicializálva.",
  ].filter(Boolean);
  const sendReady = calculation.status === AUTOMATION_STATUS.READY && reasons.length === 0;

  return {
    entry_id: registration.entryId,
    event_type: eventType,
    classification: sendReady ? "send_ready" : "manual_review",
    calculation_status: calculation.status,
    reason: reasons.join(" "),
    course_key: calculation.courseKey || "",
    semester: calculation.semester || "",
    fee_category: calculation.feeCategory || "",
    fee: calculation.fee || "",
    first_class: calculation.firstClass
      ? `${formatDate(calculation.firstClass.date)} ${calculation.firstClass.startTime}`.trim()
      : "",
    template_key: draft.templateKey || "",
    audience_type: draft.audienceType || "",
  };
}

function canonicalRegistration(source) {
  const row = Array.isArray(source.sheetRow) ? source.sheetRow : [];
  return {
    entryId: text(source.entryId || row[0]),
    courseRaw: text(row[1]),
    studentName: text(row[5]),
    submittedAt: text(row[6]),
    startDate: text(row[7]),
    trialSignup: text(row[8]),
    alternateAttendance: text(row[13]),
    email: text(row[17]),
    birthDate: text(row[14]),
    parentName: text(row[18]),
    districtCardNumber: text(row[19]),
    districtCardExpiry: text(row[20]),
    siblingName: text(row[22]),
    siblingGroup: text(row[23]),
    carryoverAmount: text(row[24]),
    trialDate: text(source.trialDate),
    paidDate: "",
    contactFirstName: "",
    studentFirstName: "",
  };
}

function emptyEmailDraft(eventType) {
  return {
    subject: "", plain: "", html: "", eventType, audienceType: "", venueCode: "", templateKey: "",
    templateId: "", params: null, contactFirstName: "", studentFirstName: "", manualReason: "", configurationWarning: "",
  };
}

function serializableCalculation(calculation) {
  return {
    ...calculation,
    firstClass: calculation.firstClass
      ? { ...calculation.firstClass, date: formatDate(calculation.firstClass.date) }
      : null,
  };
}

function emailPeriodKey(registration, calculation) {
  if (calculation.isTrial) return "PRÓBA";
  if (calculation.semester) return String(calculation.semester);
  const candidate = text(registration.startDate) || text(registration.submittedAt);
  const month = Number((candidate.match(/^\d{4}[-./](\d{1,2})/) || [])[1]);
  return month >= 2 && month <= 5 ? "2" : "1";
}

function duplicateCount(values) {
  const counts = new Map();
  values.filter(Boolean).forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  return [...counts.values()].filter((count) => count > 1).length;
}

async function sha256(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value))));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function duplicates(values) {
  const counts = new Map();
  values.filter(Boolean).forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value).sort(compareEntryIds);
}

function countBy(records, key) {
  const counts = new Map();
  records.forEach((record) => counts.set(record[key], (counts.get(record[key]) || 0) + 1));
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => String(left).localeCompare(String(right), "hu")));
}

function compareEntryIds(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) return leftNumber - rightNumber;
  return String(left).localeCompare(String(right), "hu");
}

function text(value) { return value == null ? "" : String(value).trim(); }
