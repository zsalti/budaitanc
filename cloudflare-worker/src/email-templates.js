import { formatDate, formatMoney, parseDate } from "./fee-engine.js";

export const TEMPLATE_VERSION = "2026-08-16-v2";

export const EMAIL_EVENT = Object.freeze({
  TRIAL: "TRIAL",
  ENROLLMENT: "ENROLLMENT",
  PAYMENT_RECEIVED: "PAYMENT_RECEIVED",
});

export const AUDIENCE_TYPE = Object.freeze({
  ADULT_SELF: "ADULT_SELF",
  PARENT_FOR_CHILD: "PARENT_FOR_CHILD",
});

export const TEMPLATE_KEY = Object.freeze({
  TRIAL_PARENT: "TRIAL_PARENT",
  TRIAL_ADULT: "TRIAL_ADULT",
  ENROLLMENT_PARENT: "ENROLLMENT_PARENT",
  ENROLLMENT_ADULT: "ENROLLMENT_ADULT",
  PAYMENT_PARENT: "PAYMENT_PARENT",
  PAYMENT_ADULT: "PAYMENT_ADULT",
});

const TEMPLATE_META = Object.freeze({
  [TEMPLATE_KEY.TRIAL_PARENT]: { name: "Budai Táncklub – Próbaóra – Szülő", subject: "Próbaóra infók" },
  [TEMPLATE_KEY.TRIAL_ADULT]: { name: "Budai Táncklub – Próbaóra – Felnőtt", subject: "Próbaóra infók" },
  [TEMPLATE_KEY.ENROLLMENT_PARENT]: { name: "Budai Táncklub – Beiratkozás – Szülő", subject: "Beiratkozás és befizetési infók" },
  [TEMPLATE_KEY.ENROLLMENT_ADULT]: { name: "Budai Táncklub – Beiratkozás – Felnőtt", subject: "Beiratkozás és befizetési infók" },
  [TEMPLATE_KEY.PAYMENT_PARENT]: { name: "Budai Táncklub – Utalás beérkezett – Szülő", subject: "Utalás beérkezett, tagsági kártya infó" },
  [TEMPLATE_KEY.PAYMENT_ADULT]: { name: "Budai Táncklub – Utalás beérkezett – Felnőtt", subject: "Utalás beérkezett, tagsági kártya infó" },
});

const PARAM_NAMES = [
  "recipient_first_name", "student_first_name", "student_full_name", "course_name",
  "class_datetime", "venue_name", "venue_address", "venue_note", "venue_detail", "amount_formatted", "bank_account_number",
  "beneficiary_name", "payment_reference", "registration_url", "house_rules_url",
  "signature_name", "signature_title", "signature_phone", "signature_company",
  "signature_institution", "signature_address", "brand_color",
];

export function defaultEmailSettings() {
  return {
    senderName: "Budai Táncklub",
    replyTo: "",
    registrationUrl: "https://kult2.hu/budai-tancklub/tanctanfolyam-jelentkezes/",
    houseRulesUrl: "https://kult2.hu/budai-tancklub/hazirend/",
    bankAccountNumber: "12001008-01351837-00100005",
    beneficiaryName: "KULT2 Nonprofit Kft.",
    paymentReferencePrefix: "Budai Táncklub",
    trialFee: 2600,
    brandColor: "#4b5563",
    signature: {
      name: "Rényi-Szirányi Laura",
      title: "intézményvezető",
      phone: "+36 70/3356283",
      company: "KULT2 Nonprofit Kft.",
      institution: "Berczik Sára Budai Táncklub",
      address: "1027 Budapest, Kapás u. 55.",
    },
    venues: [
      {
        code: "MAIN",
        aliases: ["Berczik terem", "Hajós terem"],
        displayName: "Berczik Sára Budai Táncklub",
        address: "1027 Budapest, Kapás u. 55.",
        note: "",
      },
      {
        code: "AGNES",
        aliases: ["Ágnes terem"],
        displayName: "Ágnes terem",
        address: "1024 Budapest, Margit krt. 48. I. em. 1., 9-es kapucsengő.",
        note: "Fontos: ez nem a Budai Táncklub Kapás utcai főépülete; attól körülbelül 100 méterre található.",
      },
    ],
    templateIds: Object.fromEntries(Object.values(TEMPLATE_KEY).map((key) => [key, ""])),
  };
}

export function emailSettingsSheetRows() {
  const settings = defaultEmailSettings();
  const scalarRows = [
    ["SENDER_NAME", settings.senderName],
    ["REPLY_TO", settings.replyTo],
    ["REGISTRATION_URL", settings.registrationUrl],
    ["HOUSE_RULES_URL", settings.houseRulesUrl],
    ["BANK_ACCOUNT_NUMBER", settings.bankAccountNumber],
    ["BENEFICIARY_NAME", settings.beneficiaryName],
    ["PAYMENT_REFERENCE_PREFIX", settings.paymentReferencePrefix],
    ["TRIAL_FEE", settings.trialFee],
    ["BRAND_COLOR", settings.brandColor],
    ["SIGNATURE_NAME", settings.signature.name],
    ["SIGNATURE_TITLE", settings.signature.title],
    ["SIGNATURE_PHONE", settings.signature.phone],
    ["SIGNATURE_COMPANY", settings.signature.company],
    ["SIGNATURE_INSTITUTION", settings.signature.institution],
    ["SIGNATURE_ADDRESS", settings.signature.address],
    ...Object.values(TEMPLATE_KEY).map((key) => [`TEMPLATE_${key}`, ""]),
  ];
  const venueRows = settings.venues.flatMap((venue) => venue.aliases.map((alias) => [
    venue.code, alias, venue.displayName, venue.address, venue.note,
  ]));
  const length = Math.max(scalarRows.length, venueRows.length);
  const rows = [["Kulcs", "Érték", "", "Helyszínkód", "Alias", "Megjelenő név", "Cím", "Megjegyzés"]];
  for (let index = 0; index < length; index += 1) {
    const scalar = scalarRows[index] || ["", ""];
    const venue = venueRows[index] || ["", "", "", "", ""];
    rows.push([scalar[0], scalar[1], "", ...venue]);
  }
  return rows;
}

export function parseEmailSettings(rows) {
  const settings = defaultEmailSettings();
  const values = new Map();
  const venueMap = new Map();

  for (const row of (rows || []).slice(1)) {
    const key = text(row[0]);
    if (key) values.set(key.toUpperCase(), text(row[1]));
    const code = text(row[3]).toUpperCase();
    const alias = text(row[4]);
    if (code && alias) {
      const venue = venueMap.get(code) || {
        code, aliases: [], displayName: text(row[5]), address: text(row[6]), note: text(row[7]),
      };
      venue.aliases.push(alias);
      if (text(row[5])) venue.displayName = text(row[5]);
      if (text(row[6])) venue.address = text(row[6]);
      if (text(row[7])) venue.note = text(row[7]);
      venueMap.set(code, venue);
    }
  }

  settings.senderName = values.get("SENDER_NAME") || settings.senderName;
  settings.replyTo = values.get("REPLY_TO") || settings.replyTo;
  settings.registrationUrl = values.get("REGISTRATION_URL") || settings.registrationUrl;
  settings.houseRulesUrl = values.get("HOUSE_RULES_URL") || settings.houseRulesUrl;
  settings.bankAccountNumber = values.get("BANK_ACCOUNT_NUMBER") || settings.bankAccountNumber;
  settings.beneficiaryName = values.get("BENEFICIARY_NAME") || settings.beneficiaryName;
  settings.paymentReferencePrefix = values.get("PAYMENT_REFERENCE_PREFIX") || settings.paymentReferencePrefix;
  settings.trialFee = positiveNumber(values.get("TRIAL_FEE")) || settings.trialFee;
  settings.brandColor = safeColor(values.get("BRAND_COLOR")) || settings.brandColor;
  settings.signature = {
    name: values.get("SIGNATURE_NAME") || settings.signature.name,
    title: values.get("SIGNATURE_TITLE") || settings.signature.title,
    phone: values.get("SIGNATURE_PHONE") || settings.signature.phone,
    company: values.get("SIGNATURE_COMPANY") || settings.signature.company,
    institution: values.get("SIGNATURE_INSTITUTION") || settings.signature.institution,
    address: values.get("SIGNATURE_ADDRESS") || settings.signature.address,
  };
  settings.templateIds = Object.fromEntries(Object.values(TEMPLATE_KEY).map((key) => [
    key, positiveInteger(values.get(`TEMPLATE_${key}`)),
  ]));
  if (venueMap.size) settings.venues = [...venueMap.values()];
  return settings;
}

export function buildEmailDraft(registration, calculation, settings = defaultEmailSettings(), requestedEvent = "") {
  const eventType = requestedEvent || (calculation?.isTrial ? EMAIL_EVENT.TRIAL : EMAIL_EVENT.ENROLLMENT);
  const audience = classifyAudience(registration);
  const studentFirstName = text(registration.studentFirstName) || firstNameSuggestion(registration.studentName);
  const recipientSource = audience.type === AUDIENCE_TYPE.ADULT_SELF ? registration.studentName : registration.parentName;
  const recipientFirstName = text(registration.contactFirstName) || firstNameSuggestion(recipientSource);
  const manualReasons = [audience.manualReason];

  if (!text(registration.email)) manualReasons.push("Hiányzik az e-mail-cím.");
  if (!studentFirstName) manualReasons.push("Hiányzik vagy nem állapítható meg a növendék keresztneve.");
  if (!recipientFirstName) manualReasons.push("Hiányzik vagy nem állapítható meg a kapcsolattartó keresztneve.");

  let venue = null;
  if (eventType !== EMAIL_EVENT.PAYMENT_RECEIVED) {
    venue = resolveVenue(calculation?.firstClass?.venue, settings);
    if (!venue) manualReasons.push("A helyszín nem oldható fel az E-mail beállítások aliasai alapján.");
    if (!calculation?.firstClass?.date || !calculation?.firstClass?.startTime) manualReasons.push("Hiányzik az első vagy próbaóra időpontja.");
  }

  const templateKey = templateKeyFor(eventType, audience.type);
  const templateId = settings.templateIds?.[templateKey] || "";
  const params = {
    recipient_first_name: recipientFirstName,
    student_first_name: studentFirstName,
    student_full_name: text(registration.studentName),
    course_name: courseDisplayName(registration.courseRaw),
    class_datetime: classDateTime(calculation?.firstClass),
    venue_name: text(calculation?.firstClass?.venue) || venue?.displayName || "",
    venue_address: venue?.address || "",
    venue_note: venue?.note || "",
    venue_detail: venueDetail(venue),
    amount_formatted: formatMoney(calculation?.fee || registration.amount || 0),
    bank_account_number: settings.bankAccountNumber,
    beneficiary_name: settings.beneficiaryName,
    payment_reference: [settings.paymentReferencePrefix, text(registration.entryId)].filter(Boolean).join(" "),
    registration_url: settings.registrationUrl,
    house_rules_url: settings.houseRulesUrl,
    signature_name: settings.signature.name,
    signature_title: settings.signature.title,
    signature_phone: settings.signature.phone,
    signature_company: settings.signature.company,
    signature_institution: settings.signature.institution,
    signature_address: settings.signature.address,
    brand_color: settings.brandColor,
  };
  const rendered = renderEmailTemplate(templateKey, params);
  if (hasMergeTag(rendered.subject) || hasMergeTag(rendered.plain) || hasMergeTag(rendered.html)) {
    manualReasons.push("Feloldatlan merge tag maradt a levélben.");
  }

  return {
    ...rendered,
    eventType,
    audienceType: audience.type,
    venueCode: venue?.code || "",
    templateKey,
    templateId,
    templateVersion: TEMPLATE_VERSION,
    params,
    contactFirstName: recipientFirstName,
    studentFirstName,
    manualReason: manualReasons.filter(Boolean).join(" "),
    sendReady: !manualReasons.some(Boolean) && Boolean(templateId),
    configurationWarning: templateId ? "" : `Hiányzik a Brevo template ID: ${templateKey}.`,
  };
}

export function classifyAudience(registration) {
  const birthDate = parseDate(registration.birthDate);
  const referenceDate = parseDate(registration.submittedAt);
  if (!birthDate || !referenceDate) {
    return { type: "", manualReason: "Hiányzik vagy hibás a születési/jelentkezési dátum; a felnőtt–szülő besorolás nem végezhető el." };
  }
  const age = ageOnDate(birthDate, referenceDate);
  const parentName = text(registration.parentName);
  const samePerson = normalizeName(parentName) && normalizeName(parentName) === normalizeName(registration.studentName);
  if (age >= 18 && (!parentName || samePerson)) return { type: AUDIENCE_TYPE.ADULT_SELF, age, manualReason: "" };
  if (age < 18 && parentName) return { type: AUDIENCE_TYPE.PARENT_FOR_CHILD, age, manualReason: "" };
  if (age < 18) return { type: "", age, manualReason: "Kiskorú növendéknél hiányzik a szülő/gondviselő neve." };
  return { type: "", age, manualReason: "Nagykorú növendéknél eltérő szülő/gondviselő szerepel; kézi címzettválasztás szükséges." };
}

export function firstNameSuggestion(value) {
  const parts = text(value).split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] || "";
}

export function resolveVenue(value, settings = defaultEmailSettings()) {
  const key = normalizeName(value);
  if (!key) return null;
  return (settings.venues || []).find((venue) => (venue.aliases || []).some((alias) => normalizeName(alias) === key)) || null;
}

export function renderEmailTemplate(templateKey, rawParams) {
  const params = Object.fromEntries(Object.entries(rawParams || {}).map(([key, value]) => [key, text(value)]));
  const meta = TEMPLATE_META[templateKey];
  if (!meta) throw new Error(`Ismeretlen e-mail-sablon: ${templateKey || "(üres)"}`);
  const content = contentFor(templateKey, params);
  return {
    subject: meta.subject,
    plain: content.plain,
    html: wrapHtml(content.html, params),
  };
}

export function brevoTemplateDefinitions() {
  const tokens = Object.fromEntries(PARAM_NAMES.map((name) => [name, `{{params.${name}}}`]));
  return Object.entries(TEMPLATE_META).map(([key, meta]) => ({
    key,
    templateName: `${meta.name} – ${TEMPLATE_VERSION}`,
    subject: meta.subject,
    htmlContent: renderEmailTemplate(key, tokens).html,
  }));
}

function contentFor(templateKey, p) {
  switch (templateKey) {
    case TEMPLATE_KEY.TRIAL_PARENT:
      return trialContent(p, false);
    case TEMPLATE_KEY.TRIAL_ADULT:
      return trialContent(p, true);
    case TEMPLATE_KEY.ENROLLMENT_PARENT:
      return enrollmentContent(p, false);
    case TEMPLATE_KEY.ENROLLMENT_ADULT:
      return enrollmentContent(p, true);
    case TEMPLATE_KEY.PAYMENT_PARENT:
      return paymentContent(p, false);
    case TEMPLATE_KEY.PAYMENT_ADULT:
      return paymentContent(p, true);
    default:
      throw new Error(`Hiányzó sablontartalom: ${templateKey}`);
  }
}

function trialContent(p, adult) {
  const greeting = `Kedves ${p.recipient_first_name}!`;
  const intro = adult
    ? `Köszönjük jelentkezését a Budai Táncklub ${p.course_name} próbaórájára! Nagyon örülünk érdeklődésének, és szeretettel várjuk Önt.`
    : `Köszönjük a jelentkezést a Budai Táncklub ${p.course_name} próbaórájára! Nagyon örülünk az érdeklődésnek, és szeretettel várjuk gyermekét.`;
  const arrival = adult
    ? "Kérjük, érkezés után jelentkezzen az információs pultnál vagy az ügyeletes kollégánál, és jelezze, hogy próbaórára érkezett."
    : `Kérjük, érkezés után jelentkezzenek az információs pultnál vagy az ügyeletes kollégánál, és jelezzék, hogy ${p.student_full_name} érkezett próbaórára.`;
  const after = adult
    ? "A próbaórát követően kérjük, küldjön nekünk egy rövid e-mailes visszajelzést arról, hogy szeretne-e beiratkozni a tanfolyamra az adott félévre."
    : "A próbaórát követően kérjük, küldjenek nekünk egy rövid e-mailes visszajelzést arról, hogy szeretnének-e beiratkozni a tanfolyamra az adott félévre.";
  const rules = adult
    ? "Kérjük, szánjon pár percet intézményünk házirendjének átolvasására is, amely tartalmazza a tanév várható programjait és a legfontosabb tudnivalókat."
    : "Kérjük, szánjanak pár percet intézményünk házirendjének átolvasására is, amely tartalmazza a tanév várható programjait és a legfontosabb tudnivalókat.";
  const closing = adult ? "Szeretettel várjuk a táncteremben!" : "Szeretettel várjuk gyermekét a táncteremben!";
  const plain = [
    greeting, "", intro, "", "A próbaóra részletei:", `- Időpont: ${p.class_datetime}`,
    `- Helyszín: ${p.venue_name} – ${p.venue_detail}`,
    `- Részvételi díj: ${p.amount_formatted} (helyszínen, az óra előtt fizethető készpénzzel vagy bankkártyával az információs pultnál)`,
    "", "Érkezéskor:", arrival, "", "Mi a teendő a próbaóra után?", after, "",
    `Beiratkozni ezen a linken tud${adult ? "" : "nak"}: ${p.registration_url}`, "",
    `${rules} ${p.house_rules_url}`, "", closing, "", signaturePlain(p),
  ].join("\n");
  const html = [
    paragraph(greeting), paragraph(intro), heading("A próbaóra részletei:"),
    `<ul><li><strong>Időpont:</strong> ${e(p.class_datetime)}</li><li><strong>Helyszín:</strong> ${e(p.venue_name)} – ${e(p.venue_detail)}</li><li><strong>Részvételi díj:</strong> ${e(p.amount_formatted)} <em>(helyszínen, az óra előtt fizethető készpénzzel vagy bankkártyával az információs pultnál)</em></li></ul>`,
    heading("Érkezéskor:"), paragraph(arrival), heading("Mi a teendő a próbaóra után?"), paragraph(after),
    paragraph(`Beiratkozni <a href="${a(p.registration_url)}">ezen a linken</a> tud${adult ? "" : "nak"}.`),
    paragraph(`${rules.replace("házirendjének", `<a href="${a(p.house_rules_url)}">házirendjének</a>`)}`),
    paragraph(closing), signatureHtml(p),
  ].join("");
  return { plain, html };
}

function enrollmentContent(p, adult) {
  const greeting = `Kedves ${p.recipient_first_name}!`;
  const intro = adult
    ? `Köszönjük beiratkozását. Nagyon örülünk, hogy részt vesz a ${p.course_name} tanfolyamunkon!`
    : `Köszönjük a beiratkozást. Nagyon örülünk, hogy ${p.student_first_name} is részt vesz a ${p.course_name} tanfolyamunkon!`;
  const rules = adult
    ? "Kérjük, szánjon pár percet intézményünk házirendjének átolvasására, amely tartalmazza az idei tanév várható programjait és a legfontosabb tudnivalókat is."
    : "Kérjük, szánjanak pár percet intézményünk házirendjének átolvasására, amely tartalmazza az idei tanév várható programjait és a legfontosabb tudnivalókat is.";
  const billing = adult
    ? "Amennyiben számlára van szüksége, kérjük, az utalással egyidejűleg küldje el részünkre a számlázási adatokat."
    : "Amennyiben számlára van szükségük, kérjük, az utalással egyidejűleg küldjék el részünkre a számlázási adatokat.";
  const legal = adult ? "Felhívjuk figyelmét" : "Felhívjuk figyelmüket";
  const plain = [
    greeting, "", intro, "", `${rules} ${p.house_rules_url}`, "",
    "A beiratkozás a tandíj befizetésével válik véglegessé.", "", "Tandíj utalási adatai:",
    `Összeg: ${p.amount_formatted}`, `Bankszámlaszám: ${p.bank_account_number}`,
    `Kedvezményezett neve: ${p.beneficiary_name}`, `Közlemény: "${p.payment_reference}"`, "",
    `Számlázási információk: ${billing}`, "",
    `(${legal}, hogy a gazdasági társaságok csak a vállalkozási tevékenységük érdekében felmerült költségeket számolhatják el. Ebből kifolyólag a KULT2 Nonprofit Kft. nem vállal felelősséget az esetleges következményekért.)`,
    "", `Első óra: ${p.class_datetime}`, `Helyszín: ${p.venue_name} – ${p.venue_detail}`, "", signaturePlain(p),
  ].join("\n");
  const html = [
    paragraph(greeting), paragraph(intro),
    paragraph(rules.replace("házirendjének", `<a href="${a(p.house_rules_url)}">házirendjének</a>`)),
    paragraph("A beiratkozás a tandíj befizetésével válik véglegessé."), heading("Tandíj utalási adatai:"),
    `<ul><li><strong>Összeg:</strong> ${e(p.amount_formatted)}</li><li><strong>Bankszámlaszám:</strong> ${e(p.bank_account_number)}</li><li><strong>Kedvezményezett neve:</strong> ${e(p.beneficiary_name)}</li><li><strong>Közlemény:</strong> „${e(p.payment_reference)}”</li></ul>`,
    paragraph(`<strong>Számlázási információk:</strong> ${e(billing)}`),
    paragraph(`<small>(${e(legal)}, hogy a gazdasági társaságok csak a vállalkozási tevékenységük érdekében felmerült költségeket számolhatják el. Ebből kifolyólag a KULT2 Nonprofit Kft. nem vállal felelősséget az esetleges következményekért.)</small>`),
    `<p><strong>Első óra:</strong> ${e(p.class_datetime)}<br><strong>Helyszín:</strong> ${e(p.venue_name)} – ${e(p.venue_detail)}</p>`,
    signatureHtml(p),
  ].join("");
  return { plain, html };
}

function paymentContent(p, adult) {
  const greeting = `Kedves ${p.recipient_first_name}!`;
  const invoice = adult
    ? "Amennyiben a beiratkozáskor számlát igényelt, azt 14 napon belül elküldi a KULT2 Nonprofit Kft."
    : "Amennyiben a beiratkozáskor számlát igényeltek, azt 14 napon belül elküldi a KULT2 Nonprofit Kft.";
  const card = adult
    ? "Kérjük, az órákra érkezéskor az információs pultnál vagy az ügyeletes kollégának minden esetben mutassa be a tagsági kártyát, vagy annak jól látható fényképét a mobiltelefonján. A kártya elvesztése és a fénykép hiánya esetén 500 Ft pótlási díj ellenében tudunk új kártyát kiállítani."
    : "Kérjük, az órákra érkezéskor az információs pultnál vagy az ügyeletes kollégának minden esetben mutassák be a tagsági kártyát, vagy annak jól látható fényképét a mobiltelefonjukon. A kártya elvesztése és a fénykép hiánya esetén 500 Ft pótlási díj ellenében tudunk új kártyát kiállítani.";
  const pickup = "A félévre szóló tagsági kártya átvehető a Táncklub főépületének információs pultjánál.";
  const plain = [greeting, "", "Köszönjük szépen az utalást.", "", invoice, "", pickup, "", card, "", signaturePlain(p)].join("\n");
  const html = [paragraph(greeting), paragraph("Köszönjük szépen az utalást."), paragraph(invoice), paragraph(pickup), paragraph(card), signatureHtml(p)].join("");
  return { plain, html };
}

function wrapHtml(body, p) {
  const color = safeColor(p.brand_color) || "#4b5563";
  return `<!doctype html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Budai Táncklub</title></head><body style="margin:0;background:#f5f5f5;color:#222;font-family:Arial,Helvetica,sans-serif"><div style="display:none;max-height:0;overflow:hidden">Budai Táncklub értesítés</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f5f5"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fff;border-top:4px solid ${a(color)}"><tr><td style="padding:28px 32px;font-size:16px;line-height:1.55">${body}</td></tr></table></td></tr></table></body></html>`;
}

function signaturePlain(p) {
  return ["Üdvözlettel:", p.signature_name, p.signature_title, p.signature_phone, p.signature_company, p.signature_institution, p.signature_address].join("\n");
}

function signatureHtml(p) {
  return `<p style="margin-top:28px">Üdvözlettel:<br>${e(p.signature_name)}<br>${e(p.signature_title)}<br>${e(p.signature_phone)}<br><strong>${e(p.signature_company)}</strong><br><strong>${e(p.signature_institution)}</strong><br><strong>${e(p.signature_address)}</strong></p>`;
}

function templateKeyFor(eventType, audienceType) {
  const adult = audienceType === AUDIENCE_TYPE.ADULT_SELF;
  if (eventType === EMAIL_EVENT.TRIAL) return adult ? TEMPLATE_KEY.TRIAL_ADULT : TEMPLATE_KEY.TRIAL_PARENT;
  if (eventType === EMAIL_EVENT.ENROLLMENT) return adult ? TEMPLATE_KEY.ENROLLMENT_ADULT : TEMPLATE_KEY.ENROLLMENT_PARENT;
  if (eventType === EMAIL_EVENT.PAYMENT_RECEIVED) return adult ? TEMPLATE_KEY.PAYMENT_ADULT : TEMPLATE_KEY.PAYMENT_PARENT;
  throw new Error(`Ismeretlen e-mail-esemény: ${eventType || "(üres)"}`);
}

function ageOnDate(birthDate, referenceDate) {
  let age = referenceDate.getUTCFullYear() - birthDate.getUTCFullYear();
  const beforeBirthday = referenceDate.getUTCMonth() < birthDate.getUTCMonth()
    || (referenceDate.getUTCMonth() === birthDate.getUTCMonth() && referenceDate.getUTCDate() < birthDate.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

function classDateTime(firstClass) {
  const date = formatDate(firstClass?.date);
  const time = text(firstClass?.startTime);
  return [date, time].filter(Boolean).join(" ");
}

function courseDisplayName(raw) { return text(raw).split("/")[0].trim(); }
function venueDetail(venue) { return venue ? [venue.address, venue.note].filter(Boolean).join(" ") : ""; }
function normalizeName(value) { return text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function positiveNumber(value) { const parsed = Number(String(value || "").replace(/[^0-9.]/g, "")); return Number.isFinite(parsed) && parsed > 0 ? parsed : 0; }
function positiveInteger(value) { const parsed = Math.trunc(positiveNumber(value)); return parsed > 0 ? parsed : ""; }
function safeColor(value) { const candidate = text(value); return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : ""; }
function hasMergeTag(value) { return /{{|}}|{%|%}/.test(String(value || "")); }
function heading(value) { return `<h2 style="font-size:18px;margin:24px 0 8px">${e(value)}</h2>`; }
function paragraph(value) { return `<p style="margin:0 0 16px">${value.includes("<a ") || value.includes("<strong>") || value.includes("<small>") ? value : e(value)}</p>`; }
function e(value) { return text(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
function a(value) { return e(value).replace(/`/g, "&#96;"); }
function text(value) { return value == null ? "" : String(value).trim(); }
