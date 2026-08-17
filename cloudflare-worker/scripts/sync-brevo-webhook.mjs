const API_ROOT = "https://api.brevo.com/v3";
const execute = process.argv.includes("--execute");
const apiKey = process.env.BREVO_API_KEY || process.env.BREVO_API;
const webhookUrl = process.env.BREVO_WEBHOOK_URL;
const webhookSecret = process.env.BREVO_WEBHOOK_SECRET;
const events = ["request", "delivered", "softBounce", "hardBounce", "blocked", "invalid", "spam", "unsubscribed"];

if (!apiKey) throw new Error("Hiányzik a BREVO_API_KEY környezeti változó.");
if (!webhookUrl || !webhookSecret) throw new Error("BREVO_WEBHOOK_URL és BREVO_WEBHOOK_SECRET szükséges.");

const current = await listWebhooks();
const existing = (current.webhooks || []).find((item) => item.url === webhookUrl);
const body = {
  url: webhookUrl,
  description: "Budai Táncklub tranzakciós kézbesítési állapotok",
  events,
  type: "transactional",
  batched: false,
  headers: [{ key: "X-BudaiTanc-Brevo-Secret", value: webhookSecret }],
};

if (!execute) {
  console.log(JSON.stringify({
    mode: "dry-run", action: existing ? "update" : "create", existing_id: existing?.id || null,
    url: webhookUrl, events, note: "Nem történt Brevo-módosítás; végrehajtáshoz add meg a --execute kapcsolót.",
  }, null, 2));
  process.exit(0);
}

const result = existing
  ? await brevoRequest(`/webhooks/${existing.id}`, "PUT", body)
  : await brevoRequest("/webhooks", "POST", body);
const id = Number(existing?.id || result.id);
const verified = await brevoRequest(`/webhooks/${id}`, "GET");
console.log(JSON.stringify({ id, url: verified.url, events: verified.events, type: verified.type }, null, 2));

async function brevoRequest(path, method, bodyValue) {
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers: { accept: "application/json", "content-type": "application/json", "api-key": apiKey },
    ...(bodyValue ? { body: JSON.stringify(bodyValue) } : {}),
  });
  if (!response.ok) throw new Error(`Brevo ${method} ${path} sikertelen (${response.status}): ${(await response.text()).slice(0, 500)}`);
  if (response.status === 204) return {};
  return response.json();
}

async function listWebhooks() {
  const response = await fetch(`${API_ROOT}/webhooks?type=transactional&sort=desc`, {
    headers: { accept: "application/json", "api-key": apiKey },
  });
  if (response.ok) return response.json();
  const body = await response.text();
  // Some Brevo accounts represent an empty transactional-webhook collection
  // as document_not_found instead of returning an empty list.
  if (response.status === 400 && body.includes("document_not_found")) return { webhooks: [] };
  throw new Error(`Brevo GET /webhooks sikertelen (${response.status}): ${body.slice(0, 500)}`);
}
