import type { RecycleBatch } from "../lib/types";

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c as "&"]);
}

function kg(n: number): string {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 1 });
}

/**
 * Self-contained recycling manifest. Photos are inlined as data URLs and no
 * fonts or assets are fetched, so the PDF renders fully offline.
 */
export function renderRecycleHtml(batch: RecycleBatch, lang: "en" | "ar"): string {
  const ar = lang === "ar";
  const t = (en: string, arabic: string) => (ar ? arabic : en);
  const dir = ar ? "rtl" : "ltr";
  const recycler = batch.recycler;

  const phones = recycler.phones.map((p) => esc(p.number)).join(" · ");
  const materials = batch.totals.materials
    .filter((m) => m.grams > 0)
    .map((m) => `<span class="chip">${esc(m.name)} · ${kg(m.grams)} g</span>`)
    .join("");

  const aiCount = batch.items.filter((i) => i.aiPhysical).length;

  const rows = batch.items
    .map((item, index) => {
      const photo = item.photoDataUrl
        ? `<img src="${item.photoDataUrl}" alt="">`
        : `<div class="no-photo">${t("No photo", "لا توجد صورة")}</div>`;
      return `<tr>
        <td class="n">${index + 1}</td>
        <td class="pic">${photo}</td>
        <td>
          <strong>${esc(item.title)}</strong>
          <div class="detail">${esc(item.detail || item.category)}</div>
          ${item.notes ? `<div class="notes">${esc(item.notes)}</div>` : ""}
          <div class="meta">${esc(item.category)} · ${t("source", "المصدر")}: ${esc(item.source)} · ${t("qty", "الكمية")}: ${item.quantity} · ${t("added", "أُضيف")}: ${new Date(item.createdAt).toLocaleDateString()}</div>
        </td>
        <td class="mass">${kg(item.impact.kgDiverted)} kg${
          item.aiPhysical
            ? `<div class="prov">${t("DeepSeek estimate", "تقدير DeepSeek")}</div>`
            : ""
        }</td>
      </tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="${ar ? "ar" : "en"}" dir="${dir}">
<head>
<meta charset="utf-8">
<title>${t("Fahes recycling manifest", "بيان إعادة تدوير فحص")}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #101820; background: #fff; font: 9.5pt/1.45 "DejaVu Sans", "Noto Sans Arabic", system-ui, sans-serif; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0f766e; padding-bottom: 9px; }
  .brand { font-size: 19pt; font-weight: 800; letter-spacing: -.4px; }
  .brand small { display: block; font-size: 8.5pt; font-weight: 400; color: #5b6b76; letter-spacing: 0; }
  .issued { text-align: end; font-size: 8.5pt; color: #5b6b76; }
  h1 { font-size: 15pt; margin: 14px 0 2px; color: #203c36; }
  h2 { font-size: 8pt; text-transform: uppercase; letter-spacing: .09em; color: #5b6b76; margin: 14px 0 4px; }
  .muted { color: #5b6b76; font-size: 8.5pt; }
  .top { display: grid; grid-template-columns: 1.4fr 1fr; gap: 14px; margin-top: 10px; }
  .box { border: 1px solid #d8e0e5; border-radius: 7px; padding: 9px 11px; }
  .box .name { font-size: 11pt; font-weight: 700; margin-bottom: 2px; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; margin-top: 6px; }
  .stat { border: 1px solid #d8e0e5; border-radius: 7px; padding: 7px 9px; }
  .stat .n { font-size: 14pt; font-weight: 800; color: #0f766e; }
  .stat .l { font-size: 7.5pt; color: #5b6b76; }
  .prov { font-size: 6.5pt; color: #a85c34; text-transform: uppercase; letter-spacing: .04em; margin-top: 1px; }
  .prov-note { font-size: 7.5pt; color: #6f6455; margin: 6px 0 0; line-height: 1.45; }
  table { width: 100%; border-collapse: collapse; margin-top: 5px; }
  th { text-align: start; font-size: 7.5pt; color: #5b6b76; text-transform: uppercase; letter-spacing: .06em; border-bottom: 1px solid #d8e0e5; padding: 4px 5px; }
  td { border-bottom: 1px solid #edf1f3; padding: 6px 5px; vertical-align: top; }
  td.n { width: 7mm; color: #5b6b76; font-size: 8pt; }
  td.pic { width: 28mm; }
  td.pic img, .no-photo { width: 25mm; height: 25mm; object-fit: cover; border-radius: 5px; border: 1px solid #d8e0e5; }
  .no-photo { display: flex; align-items: center; justify-content: center; color: #8a99a3; font-size: 7pt; text-align: center; }
  td.mass { width: 17mm; text-align: end; font-weight: 700; font-size: 8.5pt; }
  .detail { color: #44545e; font-size: 8.5pt; margin-top: 1px; }
  .notes { color: #5b6b76; font-size: 8pt; font-style: italic; margin-top: 2px; }
  .meta { color: #8a99a3; font-size: 7pt; margin-top: 2px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .chip { border: 1px solid #d8e0e5; border-radius: 99px; padding: 1px 7px; font-size: 7.5pt; color: #44545e; }
  .declaration { margin-top: 14px; border-top: 1px solid #d8e0e5; padding-top: 8px; font-size: 8pt; color: #5b6b76; }
  .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 18px; }
  .line { border-top: 1px solid #101820; padding-top: 3px; font-size: 8pt; color: #5b6b76; min-height: 18mm; }
  footer { margin-top: 14px; border-top: 1px solid #d8e0e5; padding-top: 6px; font-size: 7pt; color: #8a99a3; }
</style>
</head>
<body>
  <header>
    <div class="brand">Fahes · فحص<small>${t("Recycle & replace", "إعادة التدوير والاستبدال")}</small></div>
    <div class="issued">${t("Manifest", "البيان")} ${esc(batch.id.slice(0, 8))}<br>${new Date(batch.createdAt).toLocaleString()}</div>
  </header>

  <h1>${t("E-waste recycling manifest", "بيان إعادة تدوير النفايات الإلكترونية")}</h1>
  <p class="muted">${t(
    "Generated locally by Fahes for handover to a licensed e-waste recycler. No data was uploaded.",
    "أُنشئ محلياً بواسطة فحص لتسليمه إلى جهة إعادة تدوير مرخّصة. لم تُرفع أي بيانات.",
  )}</p>

  <div class="top">
    <div class="box">
      <div class="k muted">${t("Recycler", "جهة إعادة التدوير")}</div>
      <div class="name">${esc(recycler.name)}</div>
      <div class="muted">${esc(recycler.address)} · ${esc(recycler.city)}</div>
      <div class="muted">${phones}</div>
      <div class="muted">${esc(recycler.email)}</div>
      ${recycler.pickup ? `<div class="muted">${t("Pickup available", "يتوفر استلام من الموقع")}</div>` : ""}
    </div>
    <div>
      <div class="cards">
        <div class="stat"><div class="n">${batch.totals.items}</div><div class="l">${t("items", "عنصر")}</div></div>
        <div class="stat"><div class="n">${kg(batch.totals.kgDiverted)}</div><div class="l">${t("kg diverted", "كجم خارج النفايات")}</div></div>
        <div class="stat"><div class="n">${batch.totals.co2eAvoidedKg}</div><div class="l">${t("kg CO₂e avoided", "كجم CO₂e تم تجنّبه")}</div></div>
      </div>
      <h2>${t("Recoverable materials (estimate)", "المواد القابلة للاستعادة (تقدير)")}</h2>
      <div class="chips">${materials || `<span class="muted">${t("No material estimate", "لا يوجد تقدير للمواد")}</span>`}</div>
      ${
        aiCount
          ? `<p class="prov-note">${t(
              `${aiCount} item(s) use a DeepSeek estimate, marked in the table above. Those figures come from a language model, not a manufacturer teardown, and are unverified.`,
              `${aiCount} عنصر/عناصر تستخدم تقدير DeepSeek، موسومة في الجدول أعلاه. هذه الأرقام من نموذج لغوي لا من تفكيك الشركة المصنّعة، وهي غير مُتحقّق منها.`,
            )}</p>`
          : ""
      }
    </div>
  </div>

  <h2>${t("Items for recycling", "العناصر المطلوب إعادة تدويرها")}</h2>
  <table>
    <thead><tr>
      <th></th>
      <th>${t("Photo", "الصورة")}</th>
      <th>${t("Item", "العنصر")}</th>
      <th style="text-align:end">${t("Mass", "الوزن")}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  ${batch.note ? `<h2>${t("Note", "ملاحظة")}</h2><p>${esc(batch.note)}</p>` : ""}

  <div class="declaration">
    <strong>${t("Handover declaration", "إقرار التسليم")}</strong><br>
    ${t(
      "The items listed above are handed over for responsible recycling. Data-bearing devices must be wiped or physically destroyed before handover; Fahes records the operator's attestation but does not prove erasure.",
      "تُسلَّم العناصر المذكورة أعلاه لإعادة التدوير المسؤولة. يجب محو الأجهزة التي تحتوي بيانات أو إتلافها مادياً قبل التسليم؛ يسجّل فحص إقرار المشغّل لكنه لا يثبت المحو.",
    )}
  </div>

  <div class="sign">
    <div class="line">${t("Handed over by / date", "سلّمها / التاريخ")}</div>
    <div class="line">${t("Received by / date", "استلمها / التاريخ")}</div>
  </div>

  <footer>
    ${t(
      "Fahes · local-first hardware advisor. This manifest is a handover aid, not a certificate of recycling. Material and CO₂e figures are conservative estimates.",
      "فحص · مستشار عتاد يعمل محلياً. هذا البيان أداة تسليم وليس شهادة إعادة تدوير. أرقام المواد وCO₂e تقديرات متحفظة.",
    )}
  </footer>
</body>
</html>`;
}
