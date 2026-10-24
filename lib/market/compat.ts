import type { CompatResult, Device, DeviceRequirements, Diagnostic, ParsedListing } from "../types";

export function requirementsFrom(device: Device, diagnostic: Diagnostic | null): DeviceRequirements {
  const ramType = diagnostic?.ram.type ?? "";
  const ramGen = /DDR\s?([2-5])/i.exec(ramType)?.[1] ? `DDR${/DDR\s?([2-5])/i.exec(ramType)![1]}` : null;
  const ramForm = diagnostic?.ram.formFactor ?? null;

  const transports = new Set((diagnostic?.disks ?? []).map((d) => d.transport.toLowerCase()));
  const storageBus = transports.has("nvme") ? "NVMe" : transports.has("sata") ? "SATA" : null;
  const storageForm = storageBus === "NVMe" ? "M.2" : storageBus === "SATA" ? '2.5"' : null;

  return {
    ramGen,
    ramForm,
    storageBus,
    storageForm,
    model: device.model,
    kind: device.class,
  };
}

function norm(v: string | null | undefined): string {
  return (v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Compatibility is deliberately conservative:
 * - a known mismatch is "incompatible"
 * - a known match is "compatible"
 * - missing data is "check", never a guess
 */
export function checkCompatibility(listing: ParsedListing, req: DeviceRequirements | null): CompatResult {
  if (!req) return { status: "check", reasons: ["No device selected."] };

  if (listing.category === "ram") {
    const reasons: string[] = [];
    let mismatch = false;
    if (req.ramGen && listing.ramGen && norm(req.ramGen) !== norm(listing.ramGen)) {
      mismatch = true;
      reasons.push(`Needs ${req.ramGen}, listing is ${listing.ramGen}`);
    }
    if (req.ramForm && listing.formFactor && norm(req.ramForm) !== norm(listing.formFactor)) {
      mismatch = true;
      reasons.push(`Needs ${req.ramForm}, listing is ${listing.formFactor}`);
    }
    if (mismatch) return { status: "incompatible", reasons };

    const known = Boolean(
      (req.ramGen && listing.ramGen) || (req.ramForm && listing.formFactor),
    );
    if (known) {
      return {
        status: "compatible",
        reasons: [
          [req.ramGen ?? listing.ramGen, req.ramForm ?? listing.formFactor].filter(Boolean).join(" · "),
          "Confirm slot count and maximum capacity in the service manual.",
        ],
      };
    }
    return { status: "check", reasons: ["Listing does not state generation or form factor."] };
  }

  if (listing.category === "ssd" || listing.category === "hdd") {
    const reasons: string[] = [];
    if (req.storageBus && listing.bus && norm(req.storageBus) !== norm(listing.bus)) {
      return {
        status: "incompatible",
        reasons: [`This machine uses ${req.storageBus}, listing is ${listing.bus}`],
      };
    }
    if (req.storageForm && listing.formFactor && norm(req.storageForm) !== norm(listing.formFactor)) {
      return {
        status: "incompatible",
        reasons: [`This machine takes ${req.storageForm}, listing is ${listing.formFactor}`],
      };
    }
    if (listing.category === "hdd") {
      return {
        status: "check",
        reasons: ["A mechanical drive may not fit a modern laptop. Check for a 2.5\" bay."],
      };
    }
    if (req.storageBus && listing.bus) {
      reasons.push(`${req.storageBus} · ${req.storageForm ?? "check form factor"}`);
      reasons.push("Confirm the M.2 length (2242 vs 2280) before buying.");
      return { status: "compatible", reasons };
    }
    return { status: "check", reasons: ["Listing does not state NVMe/SATA or physical size."] };
  }

  if (listing.category === "battery") {
    const model = req.model ? norm(req.model) : "";
    const matchesModel = model.length >= 3 && norm(listing.title).includes(model);
    return matchesModel
      ? { status: "compatible", reasons: ["Listing mentions this machine's model."] }
      : { status: "check", reasons: ["Match the exact battery part number, not just the laptop brand."] };
  }

  if (listing.category === "charger") {
    return {
      status: "check",
      reasons: [
        listing.watts ? `Rated ${listing.watts} W.` : "Wattage not stated.",
        "Match connector type and at least the original wattage.",
      ],
    };
  }

  return { status: "check", reasons: ["No compatibility rule for this category."] };
}
