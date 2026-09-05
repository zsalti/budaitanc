import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const sourcePath = fileURLToPath(new URL("./master-sheet-sync.gs", import.meta.url));
const source = await readFile(sourcePath, "utf8");

// This is intentionally a source-level contract test: Apps Script services are
// supplied by Google, but the safety-critical menu and endpoint choices must
// remain reviewable and testable in the repository.
assert.match(source, /const BUDAI_TANC_SYNC = Object\.freeze\(/);
assert.match(source, /endpoint:\s*'https:\/\/budaitancklub-registration-webhook\.zsolt-3bf\.workers\.dev'/);
assert.match(source, /syncTokenProperty:\s*'SYNC_ADMIN_TOKEN'/);
assert.match(source, /staffSpreadsheetId:\s*'1Tusi8FGqRPfRzB0WuxNz3LfTWrZxo05XswxIiZw-UzY'/);
assert.match(source, /backupReaderEmail:\s*'budaitancklub-reg@budaitancklub\.iam\.gserviceaccount\.com'/);
assert.match(source, /function onOpen\(\)/);
assert.match(source, /E-mail-piszkozatok az import után/);
assert.match(source, /Jóváhagyott e-mailek küldése/);
assert.match(source, /function showImportDraftGuidance\(\)/);
assert.doesNotMatch(source, /Importált Gravity Forms ID-k/, "A bound script nem kérhet kézi import-ID listát.");
assert.doesNotMatch(source, /entry_ids:\s*entryIds/, "A bound script nem választhat kézi ID-listát piszkozatokhoz.");
assert.match(source, /function sendApprovedEmails\(\)/);
assert.match(source, /ui\.ButtonSet\.YES_NO/);
assert.match(source, /if \(confirmation !== ui\.Button\.YES\) return;/);
assert.match(source, /function configurePaymentToken\(\)[\s\S]*helyreállítás alatt ki van kapcsolva/);
assert.match(source, /function configureSyncToken\(\)/);
assert.match(source, /function previewStaffSheetSync\(\)/);
assert.match(source, /function syncStaffSheet\(\)/);
assert.match(source, /mode:\s*'preview'/);
assert.match(source, /mode:\s*'execute'/);
assert.match(source, /backup_id:\s*backupId/);
assert.match(source, /function createStaffSyncBackup_\(\)/);
assert.match(source, /DriveApp\.getFileById\(BUDAI_TANC_SYNC\.staffSpreadsheetId\)/);
assert.match(source, /source\.makeCopy\(/);
assert.match(source, /backup\.addViewer\(BUDAI_TANC_SYNC\.backupReaderEmail\)/);
assert.doesNotMatch(source, /Friss Drive-backup azonosító/, "A bound script nem kérhet kézi backup-ID-t.");
assert.doesNotMatch(source, /allow_deletes:/, "A munkatársi szinkron nem kérhet sortörlést.");
assert.match(source, /Változni fog:/);
assert.match(source, /Nem változik:/);
assert.match(source, /Összesen:/);
assert.doesNotMatch(source, /Új soron kitöltött oszlopok/);
assert.doesNotMatch(source, /Meglévő soron írható oszlopok/);
assert.doesNotMatch(source, /Tervhash:/, "Az előnézeti ablak ne mutasson belső tervhash-t.");
assert.match(source, /\/sync\//, "A bound script a Worker védett szinkronvonalát hívja.");
assert.doesNotMatch(source, /MailApp\.|GmailApp\./, "A bound script nem küldhet közvetlenül levelet.");
assert.doesNotMatch(source, /\/payments\//, "A bound script nem hívhat befizetési végpontot.");

const backupCalls = [];
const backupFile = {
  addViewer(email) { backupCalls.push(["viewer", email]); },
  getId() { return "fresh-backup-id"; },
};
const parentFolder = { id: "staff-parent" };
const sourceFile = {
  getParents() {
    return { hasNext: () => true, next: () => parentFolder };
  },
  makeCopy(name, parent) {
    backupCalls.push(["copy", name, parent]);
    return backupFile;
  },
};
const context = {
  DriveApp: {
    getFileById(id) {
      backupCalls.push(["source", id]);
      return sourceFile;
    },
  },
  Session: { getScriptTimeZone: () => "Europe/Budapest" },
  Utilities: { formatDate: () => "2026-09-05 12-00-00" },
};
vm.runInNewContext(source, context);

assert.equal(
  context.staffSyncSummary_({ created: 2, updated: 3, unchanged: 5, total: 10 }),
  "Változni fog: 5\nNem változik: 5\nÖsszesen: 10",
);
assert.equal(context.createStaffSyncBackup_(), "fresh-backup-id");
assert.deepEqual(backupCalls, [
  ["source", "1Tusi8FGqRPfRzB0WuxNz3LfTWrZxo05XswxIiZw-UzY"],
  ["copy", "Munkatársi Sheet automatikus backup 2026-09-05 12-00-00", parentFolder],
  ["viewer", "budaitancklub-reg@budaitancklub.iam.gserviceaccount.com"],
]);

console.log("Apps Script menu and endpoint contract passed.");
