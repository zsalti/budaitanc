import { formatDate, formatMoney } from "./fee-engine.js";

export const TEMPLATE_VERSION = "2026-08-03-v1-draft";

export function createEmailDraft(registration, calculation) {
  const parentFirstName = firstName(registration.parentName) || firstName(registration.studentName) || "Jelentkező";
  const studentFirstName = firstName(registration.studentName) || "gyermeked";
  const date = formatDate(calculation.firstClass?.date);
  const time = calculation.firstClass?.startTime || "";
  const venue = calculation.firstClass?.venue || "";

  if (calculation.isTrial) {
    const subject = `Próbaóra – Budai Táncklub`;
    const plain = [
      `Kedves ${parentFirstName}!`, "",
      `Szeretettel várjuk ${studentFirstName}-t próbaórára ${date} ${time} időpontban, a ${venue} helyszínen.`, "",
      `A próbaóra díja ${formatMoney(calculation.fee)}, amelyet érkezéskor tudtok befizetni.`, "",
      "Üdvözlettel:", "Budai Táncklub",
    ].join("\n");
    return { subject, plain, html: paragraphsToHtml(plain) };
  }

  const subject = `Tanfolyami jelentkezés – Budai Táncklub`;
  const plain = [
    `Kedves ${parentFirstName}!`, "",
    `Köszönjük ${studentFirstName} tanfolyami jelentkezését. Az első látogatható óra időpontja: ${date} ${time}, helyszíne: ${venue}.`, "",
    `A ${calculation.semester}. féléves tandíj ${formatMoney(calculation.fee)}.`, "",
    "Üdvözlettel:", "Budai Táncklub",
  ].join("\n");
  return { subject, plain, html: paragraphsToHtml(plain) };
}

function firstName(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] || "";
}

function paragraphsToHtml(value) {
  return String(value).split(/\n{2,}/).map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
