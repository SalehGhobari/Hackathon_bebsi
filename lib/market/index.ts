import type {
  DeviceRequirements,
  MarketResponse,
  ParsedListing,
  PhotoRead,
  RawListing,
} from "../types";
import { bucketize } from "./aggregate";
import { checkCompatibility } from "./compat";
import { flagOutliers, parseListing } from "./parse";

export { requirementsFrom } from "./compat";
export { fetchMarketListings, MARKET_SOURCES } from "./fetch";

export function buildMarket(
  raw: RawListing[],
  updatedAt: string | null,
  sources: string[],
  requirements: DeviceRequirements | null,
  photos: Record<string, PhotoRead> = {},
): MarketResponse {
  // OCR text is only an aid: it augments the seller's words, never replaces them.
  // Parse with the extra text, but keep the seller's title for display.
  const originalTitle = new Map(raw.map((listing) => [listing.id, listing.title]));
  const enriched = raw.map((listing) => {
    const photo = photos[listing.id];
    // Only high-quality reads are allowed to change what the marker parses.
    if (!photo || !photo.text || photo.quality?.band !== "high") return { listing, photo: photo ?? null };
    return { listing: { ...listing, title: `${listing.title} ${photo.text}` }, photo };
  });

  const parsed: ParsedListing[] = flagOutliers(enriched.map(({ listing }) => parseListing(listing)));

  const byId = new Map(enriched.map(({ listing, photo }) => [listing.id, photo]));

  const listings = parsed
    .map((listing) => ({
      ...listing,
      title: originalTitle.get(listing.id) ?? listing.title,
      compatibility: checkCompatibility(listing, requirements),
      photo: byId.get(listing.id) ?? null,
    }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.priceJod - b.priceJod);

  return {
    updatedAt,
    count: listings.length,
    outliers: listings.filter((l) => l.outlier).length,
    sources,
    listings,
    buckets: bucketize(parsed),
    requirements,
  };
}
