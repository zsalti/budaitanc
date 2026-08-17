import { brevoTemplateDefinitions } from "../src/email-templates.js";

const API_ROOT = "https://api.brevo.com/v3";
const execute = process.argv.includes("--execute");
const activate = process.argv.includes("--activate");
const apiKey = process.env.BREVO_API_KEY || process.env.BREVO_API;
const senderEmail = process.env.BREVO_SENDER_EMAIL;
const senderName = process.env.BREVO_SENDER_NAME || "Budai Táncklub";
const replyTo = process.env.BREVO_REPLY_TO_EMAIL || "";
const configuredIds = parseJson(process.env.BREVO_TEMPLATE_IDS_JSON || "{}", "BREVO_TEMPLATE_IDS_JSON");
const definitions = brevoTemplateDefinitions();

if (activate && !execute) throw new Error("A --activate csak --execute mellett használható.");
if (execute && (!apiKey || !senderEmail)) {
  throw new Error("A végrehajtáshoz BREVO_API_KEY és BREVO_SENDER_EMAIL szükséges.");
}

const existing = apiKey ? await brevoGet("/smtp/templates?limit=1000&sort=desc") : { templates: [] };
const actions = definitions.map((definition) => {
  const tag = `budai-tancklub:${definition.key}`;
  const configuredId = Number(configuredIds[definition.key]) || 0;
  const match = configuredId
    ? (existing.templates || []).find((item) => Number(item.id) === configuredId)
    : (existing.templates || []).find((item) => item.tag === tag);
  return { definition, tag, existing: match || null, action: match ? "update" : "create" };
});

if (!execute) {
  console.log(JSON.stringify({
    mode: "dry-run",
    note: "Nem történt Brevo-módosítás. A --execute inaktív sablonokat hoz létre/frissít; aktiváláshoz külön --activate kell.",
    actions: actions.map(({ definition, tag, existing: match, action }) => ({
      key: definition.key, action, existing_id: match?.id || null, tag,
      template_name: definition.templateName, subject: definition.subject, target_active: false,
    })),
  }, null, 2));
  process.exit(0);
}

const templateIds = {};
for (const item of actions) {
  const body = {
    sender: { email: senderEmail, name: senderName },
    templateName: item.definition.templateName,
    subject: item.definition.subject,
    htmlContent: item.definition.htmlContent,
    isActive: activate,
    tag: item.tag,
    ...(replyTo ? { replyTo } : {}),
  };
  const result = item.existing
    ? await brevoRequest(`/smtp/templates/${item.existing.id}`, "PUT", body)
    : await brevoRequest("/smtp/templates", "POST", body);
  const id = Number(item.existing?.id || result.id);
  const verified = await brevoGet(`/smtp/templates/${id}`);
  if (verified.tag !== item.tag
      || verified.subject !== item.definition.subject
      || text(verified.htmlContent) !== text(item.definition.htmlContent)
      || text(verified.sender?.email).toLowerCase() !== senderEmail.toLowerCase()
      || Boolean(verified.isActive) !== activate) {
    throw new Error(`A visszaolvasott ${item.definition.key} sablon eltér a kért állapottól.`);
  }
  templateIds[item.definition.key] = id;
}

console.log(JSON.stringify({
  mode: activate ? "executed-and-activated" : "executed-inactive",
  template_ids: templateIds,
  sheet_values: Object.fromEntries(Object.entries(templateIds).map(([key, id]) => [`TEMPLATE_${key}`, id])),
}, null, 2));

async function brevoGet(path) {
  return brevoRequest(path, "GET");
}

async function brevoRequest(path, method, body) {
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers: { accept: "application/json", "content-type": "application/json", "api-key": apiKey },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`Brevo ${method} ${path} sikertelen (${response.status}): ${(await response.text()).slice(0, 500)}`);
  if (response.status === 204) return {};
  return response.json();
}

function parseJson(value, name) {
  try { return JSON.parse(value); }
  catch { throw new Error(`${name} nem érvényes JSON.`); }
}

function text(value) {
  return value == null ? "" : String(value).trim();
}
