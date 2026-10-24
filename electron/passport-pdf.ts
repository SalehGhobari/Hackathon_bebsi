import type { Passport } from "../lib/types";

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c as "&"]);
}

/**
 * Self-contained printable document. No remote assets, no fonts to fetch:
 * everything the PDF needs is inlined so it renders offline.
 */
export function renderPassportHtml(passport: Passport, qrDataUrl: string, lang: "en" | "ar"): string {
  const ar = lang === "ar";
  const t = (en: string, arabic: string) => (ar ? arabic : en);
  const dir = ar ? "rtl" : "ltr";

  const materials = passport.impact.materials
    .filter((m) => m.grams > 0)
    .map((m) => `<span class="chip">${esc(m.name)} · ${m.grams} g</span>`)
    .join("");

  const wipe = passport.wipe
    ? `<p class="ok">${t("Data wipe recorded", "تم تسجيل محو البيانات")}</p>
       <p class="muted">${esc(passport.wipe.method)} · ${esc(passport.wipe.disk)} · ${new Date(passport.wipe.claimedAt).toLocaleString()}</p>
       <p class="muted mono">nonce ${esc(passport.wipe.nonceHash)}</p>`
    : `<p class="warn">${t("No wipe record", "لا يوجد سجل محو")}</p>`;

  return `<!doctype html>
<html lang="${ar ? "ar" : "en"}" dir="${dir}">
<head>
<meta charset="utf-8">
<title>${t("Fahes passport", "جواز فحص")}</title>
<style>
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #101820; background: #fff;
    font: 11pt/1.5 "DejaVu Sans", "Noto Sans Arabic", system-ui, sans-serif;
  }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0f766e; padding-bottom: 10px; }
  .brand { font-size: 20pt; font-weight: 800; letter-spacing: -.5px; }
  .brand small { display: block; font-size: 9pt; font-weight: 400; color: #5b6b76; letter-spacing: 0; }
  .issued { text-align: end; font-size: 9pt; color: #5b6b76; }
  h1 { font-size: 15pt; margin: 18px 0 4px; }
  h2 { font-size: 9pt; text-transform: uppercase; letter-spacing: .08em; color: #5b6b76; margin: 18px 0 6px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 24px; }
  .k { font-size: 8.5pt; color: #5b6b76; }
  .v { font-size: 11.5pt; font-weight: 600; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 6px; }
  .stat { border: 1px solid #d8e0e5; border-radius: 8px; padding: 10px 12px; }
  .stat .n { font-size: 16pt; font-weight: 800; }
  .stat .l { font-size: 8.5pt; color: #5b6b76; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { border: 1px solid #d8e0e5; border-radius: 99px; padding: 2px 8px; font-size: 8.5pt; color: #44545e; }
  .qr { float: inline-end; width: 40mm; text-align: center; margin: 0 0 8px 12px; }
  .qr img { width: 40mm; height: 40mm; }
  .qr .cap { font-size: 7.5pt; color: #5b6b76; }
  .mono { font-family: "DejaVu Sans Mono", monospace; font-size: 7.5pt; word-break: break-all; }
  .muted { color: #5b6b76; font-size: 9pt; margin: 2px 0; }
  .ok { color: #0f766e; font-weight: 700; font-size: 9.5pt; margin: 2px 0; }
  .warn { color: #b45309; font-weight: 700; font-size: 9.5pt; margin: 2px 0; }
  footer { margin-top: 22px; border-top: 1px solid #d8e0e5; padding-top: 8px; font-size: 8pt; color: #5b6b76; }
  .clear { clear: both; }
</style>
</head>
<body>
  <header>
    <div class="brand">Fahes · فحص<small>${t("Hardware passport", "جواز الجهاز")}</small></div>
    <div class="issued">${t("Issued", "صدر في")} ${new Date(passport.issuedAt).toLocaleString()}<br>${esc(passport.id.slice(0, 8))}</div>
  </header>

  <div class="qr">
    <img src="${qrDataUrl}" alt="passport QR">
    <div class="cap">${t("Scan to verify the record", "امسح للتحقق من السجل")}</div>
  </div>

  <h1>${esc(passport.device.name)}</h1>
  <p class="muted">${esc(passport.device.model ?? "")} · ${esc(passport.device.class)}</p>

  <h2>${t("Condition", "الحالة")}</h2>
  <div class="grid">
    <div><div class="k">${t("Health", "الصحة")}</div><div class="v">${passport.health.overall ?? "—"} / 100</div></div>
    <div><div class="k">${t("Battery", "البطارية")}</div><div class="v">${passport.health.batteryPct ?? "—"}%</div></div>
  </div>
  <div><div class="k" style="margin-top:8px">${t("Storage", "التخزين")}</div><div class="v" style="font-size:9.5pt;font-weight:400">${esc(passport.health.storage)}</div></div>

  <h2>${t("What was avoided", "ما تم تجنّبه")}</h2>
  <div class="cards">
    <div class="stat"><div class="n">${passport.impact.co2eAvoidedKg}</div><div class="l">${t("kg CO₂e avoided", "كجم CO₂e تم تجنّبه")}</div></div>
    <div class="stat"><div class="n">${passport.impact.kgDiverted}</div><div class="l">${t("kg diverted from waste", "كجم خارج النفايات")}</div></div>
    <div class="stat"><div class="n">${passport.impact.materials.length}</div><div class="l">${t("materials recovered", "مواد مستعادة")}</div></div>
  </div>
  <div class="chips" style="margin-top:8px">${materials}</div>

  <h2>${t("Data destruction", "إتلاف البيانات")}</h2>
  ${wipe}

  <h2>${t("Integrity", "السلامة")}</h2>
  <p class="mono">sha256 ${esc(passport.hash)}</p>
  <div class="clear"></div>

  <footer>
    ${t(
      "Generated locally by Fahes. This document is an integrity record: the hash proves it was not altered after issue. It is not a guarantee of the device's condition.",
      "أُنشئ محلياً بواسطة فحص. هذا المستند سجل سلامة: البصمة تُثبت أنه لم يُعدّل بعد الإصدار، وليست ضماناً لحالة الجهاز.",
    )}
  </footer>
</body>
</html>`;
}
