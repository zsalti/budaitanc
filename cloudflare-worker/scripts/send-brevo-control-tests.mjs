import { createHash } from "node:crypto";

const API_ROOT = "https://api.brevo.com/v3";
const execute = process.argv.includes("--execute");
const apiKey = process.env.BREVO_API_KEY || process.env.BREVO_API;
const senderEmail = process.env.BREVO_SENDER_EMAIL;
const senderName = process.env.BREVO_SENDER_NAME || "Budai Táncklub";
const replyTo = process.env.BREVO_REPLY_TO_EMAIL || senderEmail;

if (!apiKey || !senderEmail) throw new Error("A BREVO_API_KEY/BREVO_API és BREVO_SENDER_EMAIL szükséges.");
if (!replyTo) throw new Error("A BREVO_REPLY_TO_EMAIL szükséges.");

const templates = await brevoRequest("/smtp/templates?limit=1000&sort=desc", "GET");
const templateIds = Object.fromEntries((templates.templates || [])
  .filter((item) => String(item.tag || "").startsWith("budai-tancklub:"))
  .map((item) => [String(item.tag).replace("budai-tancklub:", ""), Number(item.id)]));

const baseParams = {
  student_first_name: "Béla",
  student_full_name: "Teszt Béla",
  course_name: "teszt tánctanfolyam",
  amount_formatted: "2 600 Ft",
  bank_account_number: "12001008-01351837-00100005",
  beneficiary_name: "KULT2 Nonprofit Kft.",
  payment_reference: "Budai Táncklub TEST-001",
  registration_url: "https://kult2.hu/budai-tancklub/tanctanfolyam-jelentkezes/",
  house_rules_url: "https://kult2.hu/budai-tancklub/hazirend/",
  signature_name: "Rényi-Szirányi Laura",
  signature_title: "intézményvezető",
  signature_phone: "+36 70/3356283",
  signature_company: "KULT2 Nonprofit Kft.",
  signature_institution: "Berczik Sára Budai Táncklub",
  signature_address: "1027 Budapest, Kapás u. 55.",
  brand_color: "#4b5563",
};
const venues = {
  kapas: { name: "Berczik Sára Budai Táncklub", detail: "1027 Budapest, Kapás u. 55.", datetime: "2026. szeptember 18. 17:00" },
  agnesterem: { name: "Ágnes terem", detail: "1024 Budapest, Margit krt. 48. I. em. 1., 9-es kapucsengő.", datetime: "2026. szeptember 19. 10:00" },
};
const audiences = {
  parent_for_child: { templateSuffix: "PARENT", recipientFirstName: "Anna" },
  adult_self: { templateSuffix: "ADULT", recipientFirstName: "Béla" },
};
const scenarios = [];
for (const event of ["trial", "enrollment"]) {
  for (const [venueKey, venue] of Object.entries(venues)) {
    for (const [audienceKey, audience] of Object.entries(audiences)) {
      scenarios.push({
        key: `${event}+${venueKey}+${audienceKey}`,
        templateKey: `${event === "trial" ? "TRIAL" : "ENROLLMENT"}_${audience.templateSuffix}`,
        to: `zsalti.r+${event}+${venueKey}+${audienceKey}@gmail.com`,
        params: { ...baseParams, ...venueParams(venue), recipient_first_name: audience.recipientFirstName, amount_formatted: event === "trial" ? "2 600 Ft" : "43 000 Ft" },
      });
    }
  }
}
for (const [audienceKey, audience] of Object.entries(audiences)) {
  scenarios.push({
    key: `payment_received+${audienceKey}`,
    templateKey: `PAYMENT_${audience.templateSuffix}`,
    to: `zsalti.r+payment_received+${audienceKey}@gmail.com`,
    params: { ...baseParams, recipient_first_name: audience.recipientFirstName, class_datetime: "", venue_name: "", venue_address: "", venue_note: "", venue_detail: "" },
  });
}

for (const scenario of scenarios) {
  scenario.templateId = templateIds[scenario.templateKey];
  if (!scenario.templateId) throw new Error(`Hiányzik vagy nem azonosítható az aktív tesztsablon: ${scenario.templateKey}.`);
  if (!/^zsalti\.r\+[a-z0-9_+]+@gmail\.com$/.test(scenario.to)) throw new Error(`Nem engedélyezett tesztcím: ${scenario.to}`);
}

if (!execute) {
  console.log(JSON.stringify({ mode: "dry-run", recipient_count: scenarios.length, scenarios: scenarios.map(summary) }, null, 2));
  process.exit(0);
}

const results = [];
for (const scenario of scenarios) {
  const response = await brevoRequest("/smtp/email", "POST", {
    sender: { email: senderEmail, name: senderName },
    replyTo: { email: replyTo },
    to: [{ email: scenario.to, name: scenario.params.recipient_first_name }],
    templateId: scenario.templateId,
    params: scenario.params,
    tags: ["budai-tancklub-test", scenario.key.replaceAll("+", "-")],
    headers: {
      "Idempotency-Key": deterministicUuid(`budai-tancklub-test|${scenario.key}`),
      "X-Mailin-custom": `test_scenario:${scenario.key}`,
    },
  });
  results.push({ ...summary(scenario), message_id: response.messageId || "" });
}
console.log(JSON.stringify({ mode: "executed", recipient_count: results.length, results }, null, 2));

function venueParams(venue) {
  return { class_datetime: venue.datetime, venue_name: venue.name, venue_address: venue.detail, venue_note: "", venue_detail: venue.detail };
}

function summary(scenario) {
  return { key: scenario.key, template_key: scenario.templateKey, template_id: scenario.templateId, to: scenario.to };
}

async function brevoRequest(path, method, body) {
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers: { accept: "application/json", "content-type": "application/json", "api-key": apiKey },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`Brevo ${method} ${path} sikertelen (${response.status}): ${(await response.text()).slice(0, 500)}`);
  return response.json();
}

function deterministicUuid(value) {
  const chars = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = ["8", "9", "a", "b"][parseInt(chars[16], 16) % 4];
  const compact = chars.join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}
