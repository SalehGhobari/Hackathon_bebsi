import { parseListing } from "../lib/market/parse";
import type { RawListing } from "../lib/types";

const raw = (title: string): RawListing => ({
  id: "t",
  url: "https://example.invalid",
  title,
  priceJod: 1,
  condition: "used",
  area: "Amman",
  oqCategory: "",
  page: "test",
  capturedAt: "2026-10-24",
  imageUrl: null,
});

/** Real titles from the snapshot, including the ones that were misclassified. */
const CASES: [string, string][] = [
  ["لابتوب القيمنق الاحترافي MSI Katana 15 Gaming من الجيل المتطور سعة 16 جيجابايت من نوع DDR5 الأحدث", "laptop"],
  ["لاب توب العاب MSI GAMING LAPTOP I7 13620H RTX 5060 16GBRAM DDR5 فقط ب 979", "laptop"],
  ["كومبيوتر جيمنج AMD RYZEN 3100 4CO/8TH - 16GB DDR4 RAM - MSI NVIDIA GEFORCE GTX 960 4GB GAMING PC", "desktop"],
  ["AMD RYZEN 5 8400F 6CO/12TH - 16GB DDR5 RAM - MSI NVIDIA GEFORCE RTX 3050 GAMING PC", "desktop"],
  ["لابتوب ديل مستعمل dell vostro 15 3000 كور اي 7 جيل 11 بكرتين شاشه و ssd 512", "laptop"],
  ["رام لاب توب ddr3 سعر حرق بلااااش", "ram"],
  ["رامات Kingston ValueRAM 16GB DDR4 3200 MT/s", "ram"],
  ["شاحن لاب توب لينوفو الأصلي 65w", "charger"],
  ["بطارية لابتوب اسير", "battery"],
  ["هاردسك SSD SATA 2.5 بوصة واستمتع بإقلاع أسرع", "ssd"],
  ["NVMe 265GB مستعمل بحال الوكاله", "ssd"],
  ["مبرد مائي MSI MAG CORELIQUID A13 240mm ARGB جديد", "cooling"],
  ["RTX 4080 MSI Ventus 3x", "gpu"],
  ["معالج انتل i5 جيل رابع intel i5 4460", "cpu"],
  ["لوحة أم SOYO B650 ITX WIFI AM5", "motherboard"],
  ["كيبورد لابتوب أصلي", "keyboard"],
  ["قطع كمبيوتر ram ssd nvme hdd", "other"],
  ["شاشة لابتوب 15.6 بوصة FHD", "other"],
  ["وصلات كمبيوتر وشاشات جديدة للبيع", "other"],
  ["كل شاحن سعر شاحن لاب توب عده نوعيات بحال الوكاله تايب سي", "charger"],
];

let failures = 0;
for (const [title, expected] of CASES) {
  const listing = parseListing(raw(title));
  const ok = listing.category === expected;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${listing.category.padEnd(12)} (expected ${expected.padEnd(12)}) ${title.slice(0, 62)}`,
  );
}

console.log(`\n${CASES.length - failures}/${CASES.length} correct`);
if (failures > 0) process.exit(1);
