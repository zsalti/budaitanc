import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(new URL("./master-sheet-sync.gs", import.meta.url));
const source = await readFile(sourcePath, "utf8");

// This is intentionally a source-level contract test: Apps Script services are
// supplied by Google, but the safety-critical menu and endpoint choices must
// remain reviewable and testable in the repository.
assert.match(source, /const BUDAI_TANC_SYNC = Object\.freeze\(/);
assert.match(source, /endpoint:\s*'https:\/\/budaitancklub-registration-webhook\.zsolt-3bf\.workers\.dev'/);
assert.match(source, /syncTokenProperty:\s*'SYNC_ADMIN_TOKEN'/);
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
assert.match(source, /automatikusan kiválasztott friss backupot/i);
assert.doesNotMatch(source, /backup_id\s*:/, "A normál Apps Script API-hívás nem küldhet kézi backup-ID-t.");
assert.doesNotMatch(source, /Friss Drive-backup azonosító/, "A normál Apps Script UI nem kérhet kézi backup-ID-t.");
assert.doesNotMatch(source, /backupPrompt/, "A normál Apps Script UI nem nyithat backup-ID párbeszédet.");
assert.match(source, /allow_deletes:/);
assert.match(source, /\/sync\//, "A bound script a Worker védett szinkronvonalát hívja.");
assert.doesNotMatch(source, /MailApp\.|GmailApp\./, "A bound script nem küldhet közvetlenül levelet.");
assert.doesNotMatch(source, /\/payments\//, "A bound script nem hívhat befizetési végpontot.");

console.log("Apps Script menu and endpoint contract passed.");
