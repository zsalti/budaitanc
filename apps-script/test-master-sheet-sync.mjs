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
assert.match(source, /function onOpen\(\)/);
assert.match(source, /E-mail-piszkozatok készítése importált ID-khoz/);
assert.match(source, /Jóváhagyott e-mailek küldése/);
assert.match(source, /function refreshEmailDrafts\(\)/);
assert.match(source, /new Set\(entryIds\)\.size !== entryIds\.length/);
assert.match(source, /callEmailEndpoint_\('drafts', \{ entry_ids: entryIds \}\)/);
assert.match(source, /function sendApprovedEmails\(\)/);
assert.match(source, /ui\.ButtonSet\.YES_NO/);
assert.match(source, /if \(confirmation !== ui\.Button\.YES\) return;/);
assert.match(source, /function configurePaymentToken\(\)[\s\S]*helyreállítás alatt ki van kapcsolva/);
assert.match(source, /function syncStaffSheet\(\)[\s\S]*helyreállítás alatt ki van kapcsolva/);
assert.doesNotMatch(source, /MailApp\.|GmailApp\./, "A bound script nem küldhet közvetlenül levelet.");
assert.doesNotMatch(source, /\/payments\//, "A bound script nem hívhat befizetési végpontot.");
assert.doesNotMatch(source, /\/sync\//, "A bound script nem hívhat teljes szinkron-végpontot.");

console.log("Apps Script menu and endpoint contract passed.");
