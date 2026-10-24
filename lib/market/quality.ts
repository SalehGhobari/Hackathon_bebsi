import type { MarketCategory, ParsedListing, PhotoQuality } from "../types";

/**
 * Mean OCR confidence is a bad gate on real listing photos: a phone photo of a
 * product box contains watermarks, Arabic marketing text and the shop's phone
 * number, which drags the average down even when the label itself is perfect.
 *
 * So quality is scored from EVIDENCE: did we extract usable specs, and do they
 * belong to the listing's category?
 */
export function assessPhotoQuality(args: {
  confidence: number;
  validRatio: number;
  listingCategory: MarketCategory;
  photoOnly: ParsedListing;
}): PhotoQuality {
  const { confidence, validRatio, listingCategory, photoOnly } = args;

  const specs = [
    photoOnly.capacityGb,
    photoOnly.ramGen,
    photoOnly.formFactor,
    photoOnly.bus,
    photoOnly.watts,
    photoOnly.brand,
  ].filter((value) => value !== null && value !== "").length;

  const categoryMatch = photoOnly.category === listingCategory || photoOnly.category === "other";

  const score = Math.round(
    0.35 * confidence +
      0.2 * validRatio * 100 +
      0.25 * (Math.min(specs, 4) / 4) * 100 +
      0.2 * (categoryMatch ? 100 : 0),
  );

  const reasons: string[] = [];
  if (confidence < 40) reasons.push("OCR confidence is low");
  if (validRatio < 0.5) reasons.push("too many unreadable tokens");
  if (specs < 2) reasons.push("no usable spec was extracted");
  if (!categoryMatch) reasons.push("the text does not match the listing's category");

  const high = score >= 70 && specs >= 2 && confidence >= 40 && validRatio >= 0.5 && categoryMatch;

  return {
    band: high ? "high" : score >= 50 ? "medium" : "low",
    score,
    confidence,
    validRatio,
    specHits: specs,
    categoryMatch,
    reasons,
  };
}
