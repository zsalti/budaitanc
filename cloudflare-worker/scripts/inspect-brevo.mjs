const API_ROOT = "https://api.brevo.com/v3";
const apiKey = process.env.BREVO_API_KEY || process.env.BREVO_API;

if (!apiKey) {
  console.error("Hiányzik a BREVO_API_KEY környezeti változó.");
  process.exitCode = 2;
} else {
  const [senders, templates, webhooks] = await Promise.all([
    brevoGet("/senders"),
    brevoGet("/smtp/templates?limit=1000&sort=desc"),
    brevoGetWebhooks(),
  ]);
  const requestedTemplateId = argumentValue("--template-id");
  const template = requestedTemplateId ? await brevoGet(`/smtp/templates/${encodeURIComponent(requestedTemplateId)}`) : null;
  console.log(JSON.stringify({
    senders: (senders.senders || []).map((sender) => ({
      id: sender.id, name: sender.name, email: sender.email, active: sender.active,
    })),
    templates: (templates.templates || []).map((item) => ({
      id: item.id, name: item.name, subject: item.subject, active: item.isActive,
      tag: item.tag, sender: item.sender, modifiedAt: item.modifiedAt,
    })),
    webhooks: (webhooks.webhooks || []).map((item) => ({
      id: item.id, url: item.url, events: item.events, type: item.type, description: item.description,
    })),
    selected_template: template ? {
      id: template.id, name: template.name, subject: template.subject, active: template.isActive,
      tag: template.tag, sender: template.sender, replyTo: template.replyTo,
      htmlContent: template.htmlContent,
    } : null,
  }, null, 2));
}

async function brevoGet(path) {
  const response = await fetch(`${API_ROOT}${path}`, { headers: { accept: "application/json", "api-key": apiKey } });
  if (!response.ok) throw new Error(`Brevo GET ${path} sikertelen (${response.status}): ${(await response.text()).slice(0, 500)}`);
  return response.json();
}

async function brevoGetWebhooks() {
  const response = await fetch(`${API_ROOT}/webhooks?type=transactional&sort=desc`, {
    headers: { accept: "application/json", "api-key": apiKey },
  });
  if (response.ok) return response.json();
  const body = await response.text();
  // Brevo returns document_not_found instead of an empty collection for some
  // accounts that have no transactional webhook yet.
  if (response.status === 400 && body.includes("document_not_found")) return { webhooks: [] };
  throw new Error(`Brevo GET /webhooks sikertelen (${response.status}): ${body.slice(0, 500)}`);
}

function argumentValue(name) {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) || "";
}
