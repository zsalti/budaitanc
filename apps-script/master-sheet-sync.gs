const BUDAI_TANC_SYNC = Object.freeze({
  endpoint: 'https://budaitancklub-registration-webhook.zsolt-3bf.workers.dev',
  pipelineId: 'tanctanfolyam_jelentkezes',
  tokenProperty: 'SYNC_ADMIN_TOKEN',
  paymentTokenProperty: 'PAYMENT_IMPORT_TOKEN',
  emailTokenProperty: 'EMAIL_ADMIN_TOKEN',
});

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Budai Tánc')
    .addItem('Munkatársi Sheet szinkronizálása', 'syncStaffSheet')
    .addItem('Befizetések érkeztetése', 'importPayments')
    .addItem('E-mail lapok inicializálása', 'setupEmailInfrastructure')
    .addItem('E-mail-piszkozatok frissítése', 'refreshEmailDrafts')
    .addItem('Hibás közlemények összevezetése', 'reconcileEmailReferences')
    .addItem('Jóváhagyott e-mailek küldése', 'sendApprovedEmails')
    .addSeparator()
    .addItem('Szinkron token beállítása', 'configureSyncToken')
    .addItem('Befizetési token beállítása', 'configurePaymentToken')
    .addItem('E-mail token beállítása', 'configureEmailToken')
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
  configureToken_(
    BUDAI_TANC_SYNC.paymentTokenProperty,
    'Befizetési token',
    'Illeszd be az egyszer kapott befizetés-import tokent. A Google Script Properties-ben tároljuk, nem a Sheetben.',
  );
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
  const ui = SpreadsheetApp.getUi();
  const result = ui.prompt(
    'Szinkron token',
    'Illeszd be az egyszer kapott szinkron tokent. A Google Script Properties-ben tároljuk, nem a Sheetben.',
    ui.ButtonSet.OK_CANCEL,
  );
  if (result.getSelectedButton() !== ui.Button.OK) return;
  const token = result.getResponseText().trim();
  if (!token) return ui.alert('Nem adtál meg tokent.');
  PropertiesService.getScriptProperties().setProperty(BUDAI_TANC_SYNC.tokenProperty, token);
  ui.alert('A szinkron token elmentve.');
}

function syncStaffSheet() {
  const ui = SpreadsheetApp.getUi();
  const token = PropertiesService.getScriptProperties().getProperty(BUDAI_TANC_SYNC.tokenProperty);
  if (!token) return ui.alert('Előbb válaszd a Budai Tánc → Szinkron token beállítása menüpontot.');

  const response = UrlFetchApp.fetch(`${BUDAI_TANC_SYNC.endpoint}/sync/${encodeURIComponent(token)}`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ pipeline_id: BUDAI_TANC_SYNC.pipelineId }),
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  const body = response.getContentText();
  if (status < 200 || status >= 300) throw new Error(`A szinkron nem sikerült (HTTP ${status}): ${body}`);

  const result = JSON.parse(body);
  ui.alert(`Szinkron kész. Új: ${result.created}, frissített: ${result.updated}, törölt: ${result.deleted}.`);
}

function importPayments() {
  const ui = SpreadsheetApp.getUi();
  const token = PropertiesService.getScriptProperties().getProperty(BUDAI_TANC_SYNC.paymentTokenProperty);
  if (!token) return ui.alert('Előbb válaszd a Budai Tánc → Befizetési token beállítása menüpontot.');

  const response = UrlFetchApp.fetch(`${BUDAI_TANC_SYNC.endpoint}/payments/${encodeURIComponent(token)}`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ pipeline_id: BUDAI_TANC_SYNC.pipelineId }),
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  const body = response.getContentText();
  if (status < 200 || status >= 300) throw new Error(`A befizetések érkeztetése nem sikerült (HTTP ${status}): ${body}`);

  const result = JSON.parse(body);
  ui.alert(
    `Befizetések feldolgozva. Fájl sorai: ${result.total_rows}, új sorok: ${result.new_rows}, ` +
    `automatikusan könyvelt: ${result.booked} (ebből javított közleménnyel: ${result.corrected_booked}, ` +
    `névvel megerősítve: ${result.name_confirmed}), már rögzített: ${result.already_recorded}, ` +
    `függő: ${result.pending}, korábbi/ismételt: ${result.duplicates} ` +
    `(ebből vízjel miatt kihagyva: ${result.skipped_by_watermark}), kézzel feloldott: ${result.manually_resolved}` +
    `${result.state_reset ? ', FIGYELEM: a vízjel-ellenőrzés visszaállt (a fájl átrendeződhetett)' : ''}.`,
  );
}

function refreshEmailDrafts() {
  const result = callEmailEndpoint_('drafts');
  SpreadsheetApp.getUi().alert(
    `Piszkozatok frissítve. Feldolgozott: ${result.processed}, küldhető: ${result.ready}, kézi: ${result.manual}.`,
  );
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

function callEmailEndpoint_(action) {
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
      payload: JSON.stringify({ pipeline_id: BUDAI_TANC_SYNC.pipelineId }),
      muteHttpExceptions: true,
    },
  );
  const status = response.getResponseCode();
  const body = response.getContentText();
  if (status < 200 || status >= 300) throw new Error(`Az e-mail művelet nem sikerült (HTTP ${status}): ${body}`);
  return JSON.parse(body);
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
