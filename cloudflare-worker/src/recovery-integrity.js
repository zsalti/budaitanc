const MASTER_REQUIRED_HEADERS = Object.freeze({
  0: "Közlemény",
  5: "Jelentkező (növendék) neve",
  6: "Jelentkezés ideje",
  17: "E-mail cím",
});

const EMAIL_REQUIRED_HEADERS = Object.freeze({
  0: "Küldési kulcs",
  1: "Bejegyzésazonosító",
  11: "Jóváhagyva",
  12: "Státusz",
});

// J:N are calculated or manually managed fields. This matcher is used only
// after writing a new append-only row to confirm that row was written intact.
const SOURCE_COLUMN_INDEXES = Object.freeze([
  0, 1, 2, 3, 4, 5, 6, 7, 8,
  14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
]);

export async function buildAppendOnlyImportPlan({ csvText, registrations, masterRows, emailRows }) {
  const master = validateMasterRows(masterRows);
  const email = validateEmailRows(emailRows);
  const input = validateInputRegistrations(registrations);
  const masterById = new Map(master.records.map((record) => [record.entryId, record]));
  const sourceById = new Map(input.map((registration) => [registration.entryId, registration]));

  const existingMasterNotInCsv = master.records
    .map((record) => record.entryId)
    .filter((entryId) => !sourceById.has(entryId));

  const newRegistrations = input.filter((registration) => !masterById.has(registration.entryId));
  const recoveredFromEmailHistory = newRegistrations
    .filter((registration) => email.entryIds.has(registration.entryId))
    .map((registration) => registration.entryId);
  const skippedExistingMaster = input
    .filter((registration) => masterById.has(registration.entryId))
    .map((registration) => registration.entryId);
  const csvSha256 = await sha256(csvText);
  const masterSnapshotSha256 = await semanticHash(masterRows);
  const emailSnapshotSha256 = await semanticHash(emailRows);
  const planPayload = {
    csv_sha256: csvSha256,
    master_snapshot_sha256: masterSnapshotSha256,
    email_snapshot_sha256: emailSnapshotSha256,
    new_entry_ids: newRegistrations.map((registration) => registration.entryId),
    recovered_from_email_history: recoveredFromEmailHistory,
    skipped_existing_master: skippedExistingMaster,
    existing_master_not_in_csv: existingMasterNotInCsv,
  };
  return {
    ...planPayload,
    plan_hash: await sha256(JSON.stringify(planPayload)),
    newRegistrations,
    append_start_row: appendStartRow(masterRows),
    csv_scope: existingMasterNotInCsv.length ? "new_records_only" : "complete_export",
  };
}

export function validateMasterRows(rows) {
  const header = rows?.[0] || [];
  assertHeaders(header, MASTER_REQUIRED_HEADERS, "fő Sheet");
  const records = [];
  const seen = new Set();
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] || [];
    const entryId = text(row[0]);
    const studentName = text(row[5]);
    if (!row.some((value) => text(value))) continue;
    if (!entryId || !studentName) {
      throw new Error(`A fő Sheet ${index + 1}. sora nem biztonságos: ID és növendéknév is kötelező.`);
    }
    if (seen.has(entryId)) throw new Error(`Duplikált ID a fő Sheetben: ${entryId}.`);
    seen.add(entryId);
    records.push({ entryId, row, rowIndex: index + 1 });
  }
  return { header, records, entryIds: seen };
}

export function validateEmailRows(rows) {
  const header = rows?.[0] || [];
  assertHeaders(header, EMAIL_REQUIRED_HEADERS, "E-mail kimenet");
  const sendKeys = new Set();
  const entryIds = new Set();
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] || [];
    if (!row.some((value) => text(value))) continue;
    const sendKey = text(row[0]);
    const entryId = text(row[1]);
    if (!sendKey || !entryId) {
      throw new Error(`Az E-mail kimenet ${index + 1}. sora nem biztonságos: küldési kulcs és ID is kötelező.`);
    }
    if (sendKeys.has(sendKey)) throw new Error(`Duplikált küldési kulcs az E-mail kimenetben: ${sendKey}.`);
    sendKeys.add(sendKey);
    entryIds.add(entryId);
  }
  return { header, sendKeys, entryIds };
}

export function assertNoPartialBasicFilter(metadata, tabName, minimumColumnCount) {
  const sheet = (metadata?.sheets || []).find((item) => item.properties?.title === tabName);
  if (!sheet) throw new Error(`Nem található fül: ${tabName}.`);
  const filter = sheet.basicFilter;
  if (!filter) return;
  const range = filter.range || {};
  const startColumn = Number(range.startColumnIndex || 0);
  const startRow = Number(range.startRowIndex || 0);
  const endColumn = Number(range.endColumnIndex || 0);
  if (startRow !== 0 || startColumn !== 0 || endColumn < minimumColumnCount) {
    throw new Error(
      `A fő Sheet alapszűrője csak részleges tartományt fed le (${startColumn}:${endColumn}). Távolítsd el, vagy a teljes fejlécszélességre állítsd be.`,
    );
  }
}

export function appendStartRow(rows) {
  let lastRecordRow = 1;
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] || [];
    if (text(row[0]) && text(row[5])) lastRecordRow = index + 1;
  }
  return lastRecordRow + 1;
}

export function sourceMatchesMaster(registration, masterRow) {
  const sourceRow = [registration.entryId, ...registration.row];
  return SOURCE_COLUMN_INDEXES.every((index) => normalized(sourceRow[index]) === normalized(masterRow[index]));
}

export async function semanticHash(rows) {
  const normalizedRows = (rows || []).map((row) => {
    const values = [...(row || [])].map((value) => text(value));
    while (values.length && !values.at(-1)) values.pop();
    return values;
  });
  while (normalizedRows.length && !normalizedRows.at(-1).length) normalizedRows.pop();
  return sha256(JSON.stringify(normalizedRows));
}

export async function sha256(value) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value))),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateInputRegistrations(registrations) {
  const seen = new Set();
  for (const registration of registrations || []) {
    const entryId = text(registration?.entryId);
    if (!entryId || !text(registration?.studentName)) {
      throw new Error("Minden CSV-sorhoz kötelező a Gravity Forms ID és a növendéknév.");
    }
    if (seen.has(entryId)) throw new Error(`Duplikált Gravity Forms ID a CSV-ben: ${entryId}.`);
    seen.add(entryId);
  }
  if (!registrations?.length) throw new Error("A CSV nem tartalmaz feldolgozható jelentkezést.");
  return registrations;
}

function assertHeaders(header, expected, name) {
  const missing = Object.entries(expected)
    .filter(([index, value]) => normalized(header[Number(index)]) !== normalized(value))
    .map(([, value]) => value);
  if (missing.length) throw new Error(`Hiányzó vagy elmozdult ${name}-fejléc: ${missing.join(", ")}.`);
}

function normalized(value) {
  return text(value).replace(/\s+/g, " ").toLocaleLowerCase("hu-HU");
}

function text(value) {
  return value == null ? "" : String(value).trim();
}
