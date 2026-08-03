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
    .addItem('E-mail-piszkozatok frissítése', 'refreshEmailDrafts')
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
    `Befizetések feldolgozva. Új: ${result.new_transactions}, automatikusan könyvelt: ${result.booked}, ` +
    `már rögzített: ${result.already_recorded}, függő: ${result.pending}, korábbi/ismételt: ${result.duplicates}, ` +
    `kézzel feloldott: ${result.manually_resolved}.`,
  );
}

function refreshEmailDrafts() {
  const result = callEmailEndpoint_('drafts');
  SpreadsheetApp.getUi().alert(
    `Piszkozatok frissítve. Feldolgozott: ${result.processed}, küldhető: ${result.ready}, kézi: ${result.manual}.`,
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
  ui.alert(`Küldés kész. Elküldve: ${result.sent}, kihagyva: ${result.skipped}, hibás: ${result.failed}.`);
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
