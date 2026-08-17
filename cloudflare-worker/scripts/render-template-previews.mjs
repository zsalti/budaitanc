import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TEMPLATE_VERSION, brevoTemplateDefinitions, renderEmailTemplate } from "../src/email-templates.js";

const outputArgument = process.argv.find((argument) => argument.startsWith("--out-dir="));
const outputDirectory = resolve(process.cwd(), outputArgument?.slice("--out-dir=".length) || "previews");
const params = {
  recipient_first_name: "Anna",
  student_first_name: "Béla",
  student_full_name: "Teszt Béla",
  course_name: "teszt tánctanfolyam",
  class_datetime: "2026. szeptember 18. 17:00",
  venue_name: "Berczik Sára Budai Táncklub",
  venue_address: "1027 Budapest, Kapás u. 55.",
  venue_note: "",
  venue_detail: "1027 Budapest, Kapás u. 55.",
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

await mkdir(outputDirectory, { recursive: true });
const results = [];
for (const definition of brevoTemplateDefinitions()) {
  const rendered = renderEmailTemplate(definition.key, params);
  if (/{{|}}|{%|%}/.test([rendered.subject, rendered.plain, rendered.html].join("\n"))) {
    throw new Error(`Feloldatlan változó a(z) ${definition.key} helyi előnézetében.`);
  }
  const filename = `${definition.key.toLowerCase()}.html`;
  await writeFile(resolve(outputDirectory, filename), rendered.html, "utf8");
  results.push({ key: definition.key, file: filename, subject: rendered.subject, html_chars: rendered.html.length });
}
await writeFile(resolve(outputDirectory, "manifest.json"), `${JSON.stringify({ template_version: TEMPLATE_VERSION, params, templates: results }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output_directory: outputDirectory, template_version: TEMPLATE_VERSION, templates: results }, null, 2));
