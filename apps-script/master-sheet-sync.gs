const BUDAI_TANC_SYNC = Object.freeze({
  endpoint: 'https://budaitancklub-registration-webhook.zsolt-3bf.workers.dev',
  pipelineId: 'tanctanfolyam_jelentkezes',
  emailTokenProperty: 'EMAIL_ADMIN_TOKEN',
  syncTokenProperty: 'SYNC_ADMIN_TOKEN',
});

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Budai Tánc')
    .addItem('E-mail lapok inicializálása', 'setupEmailInfrastructure')
    .addItem('E-mail-piszkozatok az import után', 'showImportDraftGuidance')
    .addItem('Hibás közlemények összevezetése', 'reconcileEmailReferences')
    .addItem('Jóváhagyott e-mailek küldése', 'sendApprovedEmails')
    .addSeparator()
    .addItem('Munkatársi Sheet-szinkron előnézete', 'previewStaffSheetSync')
    .addItem('Munkatársi Sheet-szinkron végrehajtása', 'syncStaffSheet')
    .addSeparator()
    .addItem('Forrásoszlopok védelmének frissítése', 'protectRegistrationSourceColumns')
    .addItem('Részleges alapszűrő eltávolítása', 'removePartialMasterFilter')
    .addSeparator()
    .addItem('E-mail token beállítása', 'configureEmailToken')
    .addItem('Munkatársi Sheet token beállítása', 'configureSyncToken')
    .addToUi();
}

function configureEmailToken() {
  configureToken_(
    BUDAI_TANC_SYNC.emailTokenProperty,
    'E-mail token',
    'Illeszd be az e-mail-automatizmus admin tokenjét. A Google Script Properties-ben tároljuk, nem a Sheetben.',
  );
}

function configurePaymentToken() {
  SpreadsheetApp.getUi().alert('A befizetés-import a helyreállítás alatt ki van kapcsolva.');
}

function configureToken_(propertyName, title, prompt) {
  const ui = SpreadsheetApp.getUi();
  const result = ui.prompt(title, prompt, ui.ButtonSet.OK_CANCEL);
  if (result.getSelectedButton() !== ui.Button.OK) return;
  const token = result.getResponseText().trim();
  if (!token) return ui.alert('Nem adtál meg tokent.');
  PropertiesService.getScriptProperties().setProperty(propertyName, token);
  ui.alert('A token elmentve.');
}

function configureSyncToken() {
  configureToken_(
    BUDAI_TANC_SYNC.syncTokenProperty,
    'Munkatársi Sheet token',
    'Illeszd be a munkatársi Sheet-szinkron admin tokenjét. A Google Script Properties-ben tároljuk, nem a Sheetben.',
  );
}

function showImportDraftGuidance() {
  SpreadsheetApp.getUi().alert(
    'Az új e-mail-piszkozatokat az import eredményoldalán indítsd el. A rendszer ott automatikusan a frissen importált ID-khoz kötött, rövid életű jogosultságot használ; ez a menü nem kér és nem fogad kézi ID-listát.',
  );
}

function previewStaffSheetSync() {
  const result = callSyncEndpoint_({ mode: 'preview' });
  showStaffSyncResult_('Munkatársi Sheet-szinkron előnézet', result);
}

function syncStaffSheet() {
  const ui = SpreadsheetApp.getUi();
  const preview = callSyncEndpoint_({ mode: 'preview' });
  const confirmation = ui.alert(
    'Munkatársi Sheet-szinkron végrehajtása',
    staffSyncSummary_(preview) + '\n\nA Worker azonos tervhash-t, friss Drive-backupot és visszaolvasást követel. Folytatod?',
    ui.ButtonSet.YES_NO,
  );
  if (confirmation !== ui.Button.YES) return;

  if (Number(preview.deleted || 0) > 0) {
    const deleteConfirmation = ui.alert(
      'Törlési megerősítés szükséges',
      `${preview.deleted} munkatársi sor nincs már a fő Sheetben, ezért a szinkron törölné. Ez visszafordítható a backupból, de csak tudatos jóváhagyással futtatható. Folytatod?`,
      ui.ButtonSet.YES_NO,
    );
    if (deleteConfirmation !== ui.Button.YES) return;
  }

  const backupPrompt = ui.prompt(
    'Friss Drive-backup azonosító',
    'Add meg a közvetlenül a munkatársi Sheet-ről készített, elérhető Google Sheets Drive-másolat azonosítóját.',
    ui.ButtonSet.OK_CANCEL,
  );
  if (backupPrompt.getSelectedButton() !== ui.Button.OK) return;
  const backupId = backupPrompt.getResponseText().trim();
  if (!backupId) return ui.alert('A végrehajtáshoz kötelező a friss Drive-backup azonosítója.');

  const result = callSyncEndpoint_({
    mode: 'execute',
    plan_hash: preview.plan_hash,
    backup_id: backupId,
    allow_deletes: Number(preview.deleted || 0) > 0,
  });
  showStaffSyncResult_('Munkatársi Sheet-szinkron elkészült', result);
}

function importPayments() {
  SpreadsheetApp.getUi().alert('A befizetés-import a helyreállítás alatt ki van kapcsolva.');
}

function reconcileEmailReferences() {
  const result = callEmailEndpoint_('reconcile');
  SpreadsheetApp.getUi().alert(
    `Közlemény-eltérések frissítve. Összesen: ${result.total}, egyértelmű javaslat: ${result.suggested}, ` +
    `kézi elbírálás: ${result.manual}. A „${result.sheet}” fülön ellenőrizhetők.`,
  );
}

function setupEmailInfrastructure() {
  const result = callEmailEndpoint_('setup');
  SpreadsheetApp.getUi().alert(
    `E-mail lapok készen állnak. Létrehozott lapok: ${result.created_tabs.length || 0}; ` +
    `kimeneti oszlopok: ${result.output_columns}.`,
  );
}

function sendApprovedEmails() {
  const ui = SpreadsheetApp.getUi();
  const confirmation = ui.alert(
    'Jóváhagyott e-mailek küldése',
    'A rendszer elküldi az E-mail kimenet lapon bejelölt, küldhető leveleket. Folytatod?',
    ui.ButtonSet.YES_NO,
  );
  if (confirmation !== ui.Button.YES) return;
  const result = callEmailEndpoint_('send');
  ui.alert(
    `Brevo-feldolgozás kész. Brevo által fogadott: ${result.accepted}, kihagyva: ${result.skipped}, ` +
    `hibás: ${result.failed}, kézi ellenőrzést igényel: ${result.needs_review}.`,
  );
}

function callEmailEndpoint_(action, payload = {}) {
  const ui = SpreadsheetApp.getUi();
  const token = PropertiesService.getScriptProperties().getProperty(BUDAI_TANC_SYNC.emailTokenProperty);
  if (!token) {
    ui.alert('Előbb válaszd a Budai Tánc → E-mail token beállítása menüpontot.');
    throw new Error('Hiányzik az EMAIL_ADMIN_TOKEN Script Property.');
  }
  const response = UrlFetchApp.fetch(
    `${BUDAI_TANC_SYNC.endpoint}/emails/${action}/${encodeURIComponent(token)}`,
    {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ pipeline_id: BUDAI_TANC_SYNC.pipelineId, ...payload }),
      muteHttpExceptions: true,
    },
  );
  const status = response.getResponseCode();
  const body = response.getContentText();
  if (status < 200 || status >= 300) throw new Error(`Az e-mail művelet nem sikerült (HTTP ${status}): ${body}`);
  return JSON.parse(body);
}

function callSyncEndpoint_(payload) {
  const ui = SpreadsheetApp.getUi();
  const token = PropertiesService.getScriptProperties().getProperty(BUDAI_TANC_SYNC.syncTokenProperty);
  if (!token) {
    ui.alert('Előbb válaszd a Budai Tánc → Munkatársi Sheet token beállítása menüpontot.');
    throw new Error('Hiányzik a SYNC_ADMIN_TOKEN Script Property.');
  }
  const response = UrlFetchApp.fetch(
    `${BUDAI_TANC_SYNC.endpoint}/sync/${encodeURIComponent(token)}`,
    {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ pipeline_id: BUDAI_TANC_SYNC.pipelineId, ...payload }),
      muteHttpExceptions: true,
    },
  );
  const status = response.getResponseCode();
  const body = response.getContentText();
  if (status < 200 || status >= 300) throw new Error(`A munkatársi Sheet-szinkron nem sikerült (HTTP ${status}): ${body}`);
  return JSON.parse(body);
}

function staffSyncSummary_(result) {
  const extraColumns = (result.added_columns || []).join(', ') || 'nincs';
  return `Új: ${result.created || 0}; frissül: ${result.updated || 0}; változatlan: ${result.unchanged || 0}; ` +
    `törlendő: ${result.deleted || 0}; összes fő Sheet-rekord: ${result.total || 0}; új oszlopok: ${extraColumns}.`;
}

function showStaffSyncResult_(title, result) {
  SpreadsheetApp.getUi().alert(`${staffSyncSummary_(result)}\nTervhash: ${result.plan_hash || 'n/a'}`);
}

function protectRegistrationSourceColumns() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  if (header[0] !== 'Közlemény') {
    throw new Error('Nyisd meg a fő regisztrációs lapot, majd futtasd újra a védelmet.');
  }
  const editableHeaders = new Set([
    'I. féléves tandíj', 'I. féléves tandíjfizetés dátuma', 'I. tagsági kiállítva',
    'Egyéb megjegyzés', 'Más óraszámban jár', 'II. féléves tandíj befizetés dátuma',
  ]);
  const sourceColumns = header
    .map((name, index) => ({ name: String(name || '').trim(), column: index + 1 }))
    .filter(({ name }) => name && !editableHeaders.has(name))
    .map(({ column }) => column);
  const currentUser = Session.getEffectiveUser();
  const groups = contiguousColumns_(sourceColumns);
  groups.forEach(([start, width]) => {
    const range = sheet.getRange(1, start, sheet.getMaxRows(), width);
    const description = `Budai Tánc – védett forrásoszlopok (${start}-${start + width - 1})`;
    const existing = range.getProtections(SpreadsheetApp.ProtectionType.RANGE)
      .find((protection) => protection.getDescription() === description);
    const protection = existing || range.protect().setDescription(description);
    protection.addEditor(currentUser);
    protection.removeEditors(protection.getEditors().filter((editor) => editor.getEmail() !== currentUser.getEmail()));
    if (protection.canDomainEdit()) protection.setDomainEdit(false);
  });
  SpreadsheetApp.getActive().toast('A forrás- és azonosítóoszlopok védelme frissült.', 'Budai Tánc', 5);
}

function removePartialMasterFilter() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const filter = sheet.getFilter();
  if (filter) filter.remove();
  SpreadsheetApp.getActive().toast('A kanonikus főlapon nincs részleges alapszűrő. Napi nézethez használj külön Filter view-t.', 'Budai Tánc', 6);
}

function contiguousColumns_(columns) {
  if (!columns.length) return [];
  const groups = [];
  let start = columns[0];
  let previous = start;
  columns.slice(1).forEach((column) => {
    if (column === previous + 1) {
      previous = column;
      return;
    }
    groups.push([start, previous - start + 1]);
    start = column;
    previous = column;
  });
  groups.push([start, previous - start + 1]);
  return groups;
}

function onEdit(e) {
  if (!e || !e.range) return;
  const range = e.range;
  const sheet = range.getSheet();
  if (sheet.getName() !== 'E-mail kimenet' || range.getRow() < 2) return;

  const isSingleCell = range.getNumRows() === 1 && range.getNumColumns() === 1;
  const isApproval = isSingleCell && range.getColumn() === 12;
  const isManualSent = isSingleCell && range.getColumn() === 19;
  const changesApprovedContent = rangesOverlap_(range, 5, 8) || rangesOverlap_(range, 22, 27);
  if (!isApproval && !isManualSent && !changesApprovedContent) return;

  const lock = LockService.getDocumentLock();
  lock.waitLock(5000);
  try {
    if (isApproval) updateEmailApproval_(sheet, range);
    else if (isManualSent) updateManualEmailStatus_(sheet, range);
    else invalidateEmailApproval_(sheet, range);
  } finally {
    lock.releaseLock();
  }
}

function updateEmailApproval_(sheet, checkbox) {
  const row = checkbox.getRow();
  if (checkbox.getValue() !== true) {
    sheet.getRange(row, 29, 1, 3).clearContent();
    return;
  }

  const values = sheet.getRange(row, 1, 1, 34).getValues()[0];
  const sendKey = String(values[0] || '').trim();
  const recipient = String(values[4] || '').trim();
  const subject = String(values[5] || '').trim();
  const plain = String(values[6] || '').trim();
  const html = String(values[7] || '').trim();
  const templateId = String(values[25] || '').trim();
  const paramsJson = String(values[26] || '').trim();
  let reason = '';
  if (!sendKey || !recipient || !subject || !plain || !html) reason = 'Hiányzik a küldési kulcs, címzett, tárgy vagy levéltörzs.';
  else if (!templateId || !paramsJson) reason = 'Hiányzik a Brevo template ID vagy a paraméterek JSON értéke.';
  else if (/{{|}}|{%|%}/.test([subject, plain, html].join('\n'))) reason = 'Feloldatlan merge tag maradt a levélben.';
  else {
    try { JSON.parse(paramsJson); }
    catch (error) { reason = 'A Brevo-paraméterek JSON értéke hibás.'; }
  }
  if (reason) {
    checkbox.setValue(false);
    sheet.getRange(row, 29, 1, 3).clearContent();
    SpreadsheetApp.getActive().toast(reason, 'Jóváhagyás elutasítva', 7);
    return;
  }

  const revisionHash = emailRevisionHash_(values);
  const now = new Date();
  sheet.getRange(row, 28).setValue(revisionHash);
  sheet.getRange(row, 29).setValue(revisionHash);
  sheet.getRange(row, 30).setValue(now.toISOString());
  sheet.getRange(row, 31).setValue(Session.getActiveUser().getEmail() || 'Kézi jóváhagyás');
  SpreadsheetApp.getActive().toast('A levél ezen revíziója küldésre jóváhagyva.', 'Budai Tánc', 4);
}

function invalidateEmailApproval_(sheet, editedRange) {
  const firstRow = editedRange.getRow();
  const lastRow = firstRow + editedRange.getNumRows() - 1;
  for (let row = firstRow; row <= lastRow; row += 1) {
    const values = sheet.getRange(row, 1, 1, 34).getValues()[0];
    if (!String(values[0] || '').trim()) continue;
    sheet.getRange(row, 28).setValue(emailRevisionHash_(values));
    sheet.getRange(row, 12).setValue(false);
    sheet.getRange(row, 29, 1, 3).clearContent();
  }
  SpreadsheetApp.getActive().toast('A módosított levélhez új jóváhagyás szükséges.', 'Budai Tánc', 5);
}

function emailRevisionHash_(row) {
  const indexes = [4, 5, 6, 7, 3, 15, 21, 22, 23, 24, 25, 26];
  const source = indexes.map(index => String(row[index] == null ? '' : row[index]).trim()).join('\u001f');
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, source, Utilities.Charset.UTF_8);
  return digest.map(byte => (`0${((byte + 256) % 256).toString(16)}`).slice(-2)).join('');
}

function rangesOverlap_(range, firstColumn, lastColumn) {
  const rangeFirst = range.getColumn();
  const rangeLast = rangeFirst + range.getNumColumns() - 1;
  return rangeFirst <= lastColumn && rangeLast >= firstColumn;
}

function updateManualEmailStatus_(sheet, checkbox) {
  const row = checkbox.getRow();
  const values = sheet.getRange(row, 1, 1, 21).getValues()[0];
  const checked = checkbox.getValue() === true;
  const sendKey = String(values[0] || '').trim();
  const currentStatus = String(values[12] || '').trim();
  const messageId = String(values[13] || '').trim();

  if (!sendKey) {
    if (checked) checkbox.setValue(false);
    SpreadsheetApp.getActive().toast('Üres e-mail-sor nem jelölhető elküldöttnek.', 'Budai Tánc', 5);
    return;
  }

  if (checked) {
    if (['BREVO FOGADTA', 'KÉZBESÍTVE', 'ELKÜLDVE'].includes(currentStatus) && messageId && messageId !== 'MANUÁLIS') {
      checkbox.setValue(false);
      SpreadsheetApp.getActive().toast('Ezt a levelet a Brevo már elküldte.', 'Budai Tánc', 5);
      return;
    }

    const now = new Date();
    const localTimestamp = Utilities.formatDate(now, 'Europe/Budapest', 'yyyy-MM-dd HH:mm:ss');
    checkbox.setNote(`Előző státusz: ${currentStatus}`);
    sheet.getRange(row, 12).setValue(false);
    sheet.getRange(row, 13).setValue('ELKÜLDVE');
    sheet.getRange(row, 14).setValue('MANUÁLIS');
    sheet.getRange(row, 18).setValue(now.toISOString());
    sheet.getRange(row, 20).setValue(localTimestamp);
    sheet.getRange(row, 21).setValue(Session.getActiveUser().getEmail() || 'Kézi jelölés');
    SpreadsheetApp.getActive().toast('A manuális e-mail-küldés rögzítve.', 'Budai Tánc', 4);
    return;
  }

  if (messageId !== 'MANUÁLIS') return;
  const previousStatus = previousStatusFromNote_(checkbox.getNote());
  const hasDraft = Boolean(String(values[4] || '').trim() && String(values[5] || '').trim() && (String(values[6] || '').trim() || String(values[7] || '').trim()));
  const restoredStatus = previousStatus && previousStatus !== 'ELKÜLDVE'
    ? previousStatus
    : (hasDraft ? 'KÜLDHETŐ' : 'KÉZI ELBÍRÁLÁS');
  sheet.getRange(row, 12).setValue(false);
  sheet.getRange(row, 13).setValue(restoredStatus);
  sheet.getRange(row, 14).clearContent();
  sheet.getRange(row, 18).clearContent();
  sheet.getRange(row, 20, 1, 2).clearContent();
  checkbox.clearNote();
  SpreadsheetApp.getActive().toast('A manuális küldés jelölése visszavonva.', 'Budai Tánc', 4);
}

function previousStatusFromNote_(note) {
  const match = String(note || '').match(/^Előző státusz:\s*(.+)$/);
  return match ? match[1].trim() : '';
}
