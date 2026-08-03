const WEEKDAYS = new Map([
  ["VASARNAP", 0], ["HETFO", 1], ["KEDD", 2], ["SZERDA", 3],
  ["CSUTORTOK", 4], ["PENTEK", 5], ["SZOMBAT", 6],
]);

export const AUTOMATION_STATUS = Object.freeze({
  READY: "KÜLDHETŐ",
  APPROVED: "JÓVÁHAGYVA",
  SENT: "ELKÜLDVE",
  MANUAL: "KÉZI ELBÍRÁLÁS",
  ERROR: "HIBA",
  CHANGED_AFTER_SEND: "ELKÜLDÉS UTÁN MÓDOSULT",
});

export const TRIAL_FEE = 2600;

export function parseAutomationConfig(rows) {
  const courses = [];
  const fees = [];
  const exceptions = [];

  for (const row of rows || []) {
    if (text(row[0]) && normalizeKey(row[0]) !== "TANFOLYAM KULCS") {
      const weekday = WEEKDAYS.get(normalizeKey(row[2]));
      const sessionsPerWeek = number(row[7]);
      const minutesPerSession = number(row[8]);
      if (weekday !== undefined && text(row[3]) && text(row[9])) {
        courses.push({
          key: normalizeCourseKey(row[0]),
          rawValue: text(row[1]),
          rawKey: normalizeKey(row[1]),
          weekday,
          weekdayName: text(row[2]),
          startTime: normalizeTime(row[3]),
          endTime: normalizeTime(row[4]),
          venue: text(row[5]),
          teacher: text(row[6]),
          sessionsPerWeek,
          minutesPerSession,
          feeCategory: text(row[9]),
          manual: boolean(row[10]),
        });
      }
    }

    if (text(row[12]) && normalizeKey(row[12]) !== "FELEV") {
      const semester = number(row[12]);
      const start = parseDate(row[13]);
      const end = parseDate(row[14]);
      const baseFee = number(row[16]);
      const discountedFee = number(row[17]);
      if ((semester === 1 || semester === 2) && start && end && text(row[15]) && baseFee > 0) {
        fees.push({ semester, start, end, category: text(row[15]), baseFee, discountedFee });
      }
    }

    if (text(row[19]) && normalizeKey(row[19]) !== "TANFOLYAM KULCS") {
      const date = parseDate(row[20]);
      const type = normalizeKey(row[21]);
      if (date && (type === "ELMARAD" || type === "RENDKIVULI")) {
        exceptions.push({
          courseKey: normalizeCourseKey(row[19]), date, type,
          startTime: normalizeTime(row[22]), endTime: normalizeTime(row[23]), venue: text(row[24]),
        });
      }
    }
  }

  return { courses, fees, exceptions };
}

export function calculateRegistration(registration, config) {
  const courseRaw = text(registration.courseRaw);
  const courseKey = normalizeCourseKey(courseRaw.split("/")[0] || courseRaw);
  const manualReason = preflightManualReason(registration, courseKey);
  if (manualReason) return manual(manualReason, { courseKey });

  const sessions = matchingSessions(courseRaw, courseKey, config.courses);
  if (!sessions.length) return manual("Ismeretlen tanfolyam vagy hiányzó órarend.", { courseKey });
  if (sessions.some((session) => session.manual)) return manual("A tanfolyam kézi elbírálásra van jelölve.", { courseKey });

  const isTrial = normalizeKey(registration.trialSignup) === "IGEN";
  let firstClass;
  if (isTrial) {
    const trialDate = parseDate(registration.trialDate);
    if (!trialDate) return manual("Hiányzik a próbaóra dátuma.", { courseKey, isTrial });
    firstClass = sessionOnExactDate(trialDate, sessions, config.exceptions);
    if (!firstClass) return manual("A megadott próbaóranapon nincs megtartható foglalkozás.", { courseKey, isTrial });
    return readyResult({
      courseKey, isTrial, firstClass, semester: semesterForDate(firstClass.date),
      feeBand: "Próbaóra", feeCategory: "PRÓBAÓRA", discount: "Nincs", fee: TRIAL_FEE,
      explanation: `Próbaóra: ${formatDate(firstClass.date)}, fix ${formatMoney(TRIAL_FEE)}.`,
    });
  }

  const submittedDate = parseDate(registration.submittedAt);
  if (!submittedDate) return manual("Hiányzik vagy hibás a jelentkezés dátuma.", { courseKey });
  const requestedStart = parseDate(registration.startDate);
  let anchor = requestedStart && requestedStart > submittedDate ? requestedStart : submittedDate;
  if (!semesterForDate(anchor)) {
    const nextEnrollmentStart = config.fees.map((fee) => fee.start).filter((date) => date >= anchor).sort((left, right) => left - right)[0];
    if (!nextEnrollmentStart) return manual("A megadott kezdés után nincs új belépési időszak.", { courseKey });
    anchor = nextEnrollmentStart;
  }
  firstClass = nextSession(anchor, sessions, config.exceptions);
  if (!firstClass) return manual("Nem található következő megtartható óra.", { courseKey });

  const semester = semesterForDate(firstClass.date);
  if (!semester) return manual("Az első óra nem tartozik felvételi időszakhoz.", { courseKey, firstClass });
  const category = uniqueCategory(sessions);
  if (!category) return manual("A tanfolyam díjkategóriája nem egyértelmű.", { courseKey, firstClass, semester });
  const band = config.fees.find((fee) => fee.semester === semester && fee.category === category && firstClass.date >= fee.start && firstClass.date <= fee.end);
  if (!band) return manual("Nem található díjsáv az első óra dátumához.", { courseKey, firstClass, semester, feeCategory: category });

  const discountResult = validateDiscount(registration, firstClass.date);
  if (discountResult.manualReason) return manual(discountResult.manualReason, { courseKey, firstClass, semester, feeCategory: category });
  const fee = discountResult.applied ? band.discountedFee : band.baseFee;
  const feeBand = `${formatDate(band.start)}–${formatDate(band.end)}`;
  return readyResult({
    courseKey, isTrial, firstClass, semester, feeBand, feeCategory: category,
    discount: discountResult.label, fee,
    explanation: `Első óra: ${formatDate(firstClass.date)} ${firstClass.startTime}; ${semester}. félév, ${feeBand}, ${category}, ${discountResult.label.toLowerCase()}: ${formatMoney(fee)}.`,
  });
}

function preflightManualReason(registration, courseKey) {
  if (!courseKey) return "Hiányzik a választott tanfolyam.";
  if (courseKey.includes("PILATES") || courseKey.includes("BERCZIK TORNA")) return "Pilates- és Berczik-jelentkezések kézi elbírálásúak.";
  if (!text(registration.email)) return "Hiányzik az e-mail-cím.";
  if (hasMeaningfulValue(registration.carryoverAmount)) return "Jóváírás vagy egyedi elszámolás van megadva.";
  if (hasMeaningfulValue(registration.alternateAttendance)) return "Eltérő óraszám vagy alternatív részvétel van megadva.";
  return "";
}

function matchingSessions(courseRaw, courseKey, courses) {
  const rawKey = normalizeKey(courseRaw);
  const exactRaw = courses.filter((course) => course.rawKey && course.rawKey === rawKey);
  if (exactRaw.length) return exactRaw;
  const exactCourse = courses.filter((course) => course.key === courseKey);
  if (exactCourse.length) return exactCourse;
  const aliases = courseAliases(courseKey);
  return courses.filter((course) => aliases.includes(course.key));
}

function courseAliases(key) {
  const aliases = [key];
  aliases.push(key.replace(/^SZINPADI /, ""));
  if (key === normalizeCourseKey("MŰVÉSZI TORNA HALADÓ ÓVODÁS 5-6 ÉVESEK")) aliases.push(normalizeCourseKey("MŰVÉSZI TORNA ÓVODÁS 5-6 ÉVESEK"));
  if (key === normalizeCourseKey("MŰVÉSZI TORNA ÓVODÁS 4+")) aliases.push(normalizeCourseKey("MŰVÉSZI TORNA ÓVODÁS 4 ÉVESEK"));
  if (key === normalizeCourseKey("KLASSZIKUS BALETT GYERMEK 6-8 ÉVESEK")) aliases.push(normalizeCourseKey("KLASSZIKUS BALETT ÓVODÁS 4,5 ÉVES KORTÓL"));
  return [...new Set(aliases)];
}

function sessionOnExactDate(date, sessions, exceptions) {
  const extraordinary = extraordinarySession(date, sessions[0].key, exceptions);
  if (extraordinary) return extraordinary;
  if (isCancelled(date, sessions[0].key, exceptions)) return null;
  const session = sessions.find((item) => item.weekday === date.getUTCDay());
  return session ? occurrence(date, session) : null;
}

function nextSession(anchor, sessions, exceptions) {
  for (let offset = 0; offset <= 28; offset += 1) {
    const date = addDays(anchor, offset);
    const extraordinary = extraordinarySession(date, sessions[0].key, exceptions);
    if (extraordinary) return extraordinary;
    if (isCancelled(date, sessions[0].key, exceptions)) continue;
    const candidates = sessions.filter((item) => item.weekday === date.getUTCDay()).sort((a, b) => a.startTime.localeCompare(b.startTime));
    if (candidates.length) return occurrence(date, candidates[0]);
  }
  return null;
}

function extraordinarySession(date, courseKey, exceptions) {
  const item = exceptions.find((entry) => entry.courseKey === courseKey && sameDate(entry.date, date) && entry.type === "RENDKIVULI");
  return item ? { date, startTime: item.startTime, endTime: item.endTime, venue: item.venue, teacher: "" } : null;
}

function isCancelled(date, courseKey, exceptions) {
  return exceptions.some((entry) => entry.courseKey === courseKey && sameDate(entry.date, date) && entry.type === "ELMARAD");
}

function occurrence(date, session) {
  return { date, startTime: session.startTime, endTime: session.endTime, venue: session.venue, teacher: session.teacher };
}

function semesterForDate(date) {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  if ((month === 9 && day >= 3) || month >= 10 || month === 1) return month === 1 || month >= 9 ? 1 : 0;
  if (month >= 2 && month <= 5) return 2;
  return 0;
}

function validateDiscount(registration, firstClassDate) {
  const siblingName = meaningful(registration.siblingName);
  const siblingGroup = meaningful(registration.siblingGroup);
  const siblingClaimed = siblingName || siblingGroup;
  if (siblingClaimed && !(siblingName && siblingGroup)) return { manualReason: "A testvérkedvezmény adatai hiányosak." };

  const cardNumber = meaningful(registration.districtCardNumber);
  const cardExpiryRaw = meaningful(registration.districtCardExpiry);
  const districtClaimed = cardNumber || cardExpiryRaw;
  if (districtClaimed && !(cardNumber && cardExpiryRaw)) return { manualReason: "A kerületi kedvezmény adatai hiányosak." };
  let districtValid = false;
  if (districtClaimed) {
    const expiry = parseDate(cardExpiryRaw);
    if (!expiry || expiry < firstClassDate) return { manualReason: "A Kerület Kártya lejárt vagy a lejárati dátuma hibás." };
    districtValid = true;
  }

  const siblingValid = Boolean(siblingName && siblingGroup);
  if (siblingValid && districtValid) return { applied: true, label: "Testvér- és kerületi kedvezmény (egyszeri 5%)" };
  if (siblingValid) return { applied: true, label: "Testvérkedvezmény 5%" };
  if (districtValid) return { applied: true, label: "Kerületi kedvezmény 5%" };
  return { applied: false, label: "Nincs kedvezmény" };
}

function uniqueCategory(sessions) {
  const values = [...new Set(sessions.map((item) => item.feeCategory).filter(Boolean))];
  return values.length === 1 ? values[0] : "";
}

function readyResult(value) { return { status: AUTOMATION_STATUS.READY, manualReason: "", ...value }; }
function manual(reason, value = {}) { return { status: AUTOMATION_STATUS.MANUAL, manualReason: reason, fee: "", ...value }; }

export function parseDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const match = text(value).match(/^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]) ? date : null;
}

export function formatDate(date) { return date ? date.toISOString().slice(0, 10) : ""; }
export function formatMoney(value) { return `${Number(value).toLocaleString("hu-HU")} Ft`; }
export function normalizeCourseKey(value) { return normalizeKey(value).replace(/^SZINPADI /, "").replace(/\s+/g, " ").trim(); }
export function normalizeKey(value) {
  return text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9+,]+/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
}
function normalizeTime(value) { const match = text(value).replace(".", ":").match(/\d{1,2}:\d{2}/); return match ? match[0].padStart(5, "0") : text(value); }
function number(value) { const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, "")); return Number.isFinite(parsed) ? parsed : 0; }
function boolean(value) { return value === true || ["TRUE", "IGEN", "1"].includes(normalizeKey(value)); }
function meaningful(value) { return hasMeaningfulValue(value) ? text(value) : ""; }
function hasMeaningfulValue(value) { const key = normalizeKey(value); return Boolean(key) && !["NEM", "NINCS", "-", "0"].includes(key); }
function addDays(date, days) { const result = new Date(date); result.setUTCDate(result.getUTCDate() + days); return result; }
function sameDate(left, right) { return formatDate(left) === formatDate(right); }
function text(value) { return value == null ? "" : String(value).trim(); }
