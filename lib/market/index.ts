import type {
  DeviceRequirements,
  MarketResponse,
  ParsedListing,
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
): MarketResponse {
  const parsed: ParsedListing[] = flagOutliers(raw.map(parseListing));

  const listings = parsed
    .map((listing) => ({ ...listing, compatibility: checkCompatibility(listing, requirements) }))
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
