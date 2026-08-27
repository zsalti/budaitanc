import assert from "node:assert/strict";

import { EMAIL_EVENT_LOG_HEADERS, EMAIL_OUTPUT_HEADERS, recordBrevoEvent } from "./src/worker.js";

const pipeline = { spreadsheet_id: "test-spreadsheet" };
const eventRows = [[...EMAIL_EVENT_LOG_HEADERS]];
const emailRows = [[...EMAIL_OUTPUT_HEADERS], emailRow({
  sendKey: "1001|ENROLLMENT|1|v2", messageId: "message-1", recipient: "parent@example.invalid", status: "BREVO FOGADTA",
})];
let outputWrites = 0;
let sheetReads = 0;
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, options = {}) => {
  const url = decodeURIComponent(String(input));
  if (url.includes("E-mail eseménynapló") && url.includes(":append?")) {
    const values = JSON.parse(options.body).values;
    eventRows.push(...values.map((row) => [...row]));
    return json({ updates: { updatedRows: values.length } });
  }
  if (url.includes("values:batchUpdate")) {
    const data = JSON.parse(options.body).data;
    for (const write of data) applyOutputRange(write.range, write.values[0]);
    outputWrites += data.length;
    return json({});
  }
  if (url.includes("E-mail eseménynapló")) {
    sheetReads += 1;
    return json({ values: eventRows.map((row) => [...row]) });
  }
  if (url.includes("E-mail kimenet")) {
    sheetReads += 1;
    return json({ values: emailRows.map((row) => [...row]) });
  }
  throw new Error(`Unhandled fetch: ${url}`);
};

try {
  const delivered = webhook({ id: "delivered-1", event: "delivered", messageId: "message-1", timestamp: 1787828400 });
  const deliveredResult = await recordBrevoEvent("test-access-token", pipeline, delivered);
  assert.deepEqual(deliveredResult, {
    duplicate: false, event: "delivered", matched: true, send_key: "1001|ENROLLMENT|1|v2", status: "KÉZBESÍTVE",
  });
  assert.equal(eventRows.length, 2, "az első esemény egyszer kerül a naplóba");
  assert.equal(emailRows[1][12], "KÉZBESÍTVE");
  assert.equal(emailRows[1][31], "KÉZBESÍTVE");

  const deliverySnapshot = JSON.stringify(emailRows);
  for (let run = 2; run <= 10; run += 1) {
    const replay = await recordBrevoEvent("test-access-token", pipeline, delivered);
    assert.deepEqual(replay, { duplicate: true, event: "delivered", matched: false }, `${run}. futás: replay válasz`);
    assert.equal(eventRows.length, 2, `${run}. futás: a replay nem hozhat létre második naplóbejegyzést`);
    assert.equal(JSON.stringify(emailRows), deliverySnapshot, `${run}. futás: a replay nem írhat e-mail-kimenetet`);
  }

  const lateRequest = await recordBrevoEvent("test-access-token", pipeline, webhook({
    id: "late-request-1", event: "request", messageId: "message-1", timestamp: 1787828460,
  }));
  assert.equal(lateRequest.duplicate, false);
  assert.equal(emailRows[1][12], "KÉZBESÍTVE", "a késő request nem ronthatja vissza a kézbesített státuszt");
  assert.equal(emailRows[1][31], "KÉZBESÍTVE");

  const beforeQuarantine = JSON.stringify(emailRows);
  const missingIdentity = await recordBrevoEvent("test-access-token", pipeline, { id: "missing-identity", event: "delivered", timestamp: 1787828520 });
  assert.equal(missingIdentity.matched, false);
  assert.equal(JSON.stringify(emailRows), beforeQuarantine, "hiányzó message ID/címzett nem módosíthat e-mail-kimenetet");
  assert.match(eventRows.at(-1)[7], /KARANTÉN/i);

  emailRows.push(emailRow({
    sendKey: "1002|ENROLLMENT|1|v2", messageId: "message-ambiguous", recipient: "parent@example.invalid", status: "BREVO FOGADTA",
  }), emailRow({
    sendKey: "1003|ENROLLMENT|1|v2", messageId: "message-ambiguous", recipient: "parent@example.invalid", status: "BREVO FOGADTA",
  }));
  const beforeAmbiguous = JSON.stringify(emailRows);
  const ambiguous = await recordBrevoEvent("test-access-token", pipeline, webhook({
    id: "ambiguous-1", event: "delivered", messageId: "message-ambiguous", timestamp: 1787828580,
  }));
  assert.equal(ambiguous.matched, false);
  assert.equal(JSON.stringify(emailRows), beforeAmbiguous, "több találatnál karanténba kell tenni az eseményt");
  assert.match(eventRows.at(-1)[7], /KARANTÉN.*2 e-mail-kimeneti sor/i);

  emailRows.push(emailRow({
    sendKey: "1004|ENROLLMENT|1|v2", messageId: "message-parallel", recipient: "parallel@example.invalid", status: "BREVO FOGADTA",
  }));
  const parallel = webhook({ id: "parallel-1", event: "delivered", messageId: "message-parallel", recipient: "parallel@example.invalid", timestamp: 1787828640 });
  const readsBeforeParallel = sheetReads;
  const [first, second] = await Promise.all([
    recordBrevoEvent("test-access-token", pipeline, parallel),
    recordBrevoEvent("test-access-token", pipeline, parallel),
  ]);
  assert.equal([first, second].filter((result) => result.duplicate).length, 1, "egyidejű azonos eseményből csak az egyik dolgozható fel");
  assert.equal(eventRows.filter((row) => row[1] === "message-parallel").length, 1, "egyidejű ismétlés nem duplikálhatja a naplót ugyanabban a Worker-isolate-ban");
  assert.equal(sheetReads - readsBeforeParallel, 2, "a társkérés a már futó feldolgozást várja meg, nem olvassa újra a Sheetet");
  assert.equal(emailRows.at(-1)[12], "KÉZBESÍTVE");

  assert.ok(outputWrites >= 2, "a jogosult, egyedi események frissítik a megfelelő kimeneti sort");
  console.log("Brevo webhook idempotence tests passed.");
} finally {
  globalThis.fetch = originalFetch;
}

function webhook({ id, event, messageId = "message-1", recipient = "parent@example.invalid", timestamp }) {
  return { id, event, "message-id": messageId, email: recipient, timestamp };
}

function emailRow({ sendKey, messageId, recipient, status }) {
  const row = Array.from({ length: EMAIL_OUTPUT_HEADERS.length }, () => "");
  row[0] = sendKey;
  row[4] = recipient;
  row[12] = status;
  row[13] = messageId;
  row[31] = status;
  return row;
}

function applyOutputRange(range, values) {
  const match = String(range).match(/!([A-Z]+)(\d+):([A-Z]+)\d+$/);
  assert.ok(match, `Unexpected output range: ${range}`);
  const startColumn = columnNumber(match[1]);
  const row = emailRows[Number(match[2]) - 1];
  values.forEach((value, index) => { row[startColumn + index] = value; });
}

function columnNumber(column) {
  return [...column].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

function json(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}
