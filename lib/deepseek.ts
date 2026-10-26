import type {
  DeepseekMatch,
  DeepseekMatchResult,
  DeepseekStatus,
  MaterialAmount,
  PhysicalSpec,
} from "./types";

/**
 * Optional DeepSeek integration.
 *
 * This is the one place in Fahes that talks to a third party, and it is built
 * so the model can never invent a fact:
 *
 *  - Matching is a CLOSED SET problem. We hand the model a numbered shortlist of
 *    real rows (OpenSooq listings or price-book entries) and it may only return
 *    ids that were in that shortlist. Anything else is counted and dropped, so
 *    a hallucinated listing can never reach the UI.
 *  - Prices are never requested. They come from the rows we already hold.
 *  - Physical specs are asked for as an explicit estimate and are returned as a
 *    separate, labelled layer — they never overwrite the deterministic estimate
 *    in `lib/recycle/estimate.ts`.
 *
 * Network access lives in the Electron main process. The renderer keeps its
 * `connect-src 'none'` policy and never sees the API key.
 */

const ENDPOINT = "https://api.deepseek.com/chat/completions";
export const DEFAULT_MODEL = "deepseek-chat";

/** Ceiling on how many candidates we will describe to the model. */
const MAX_CANDIDATES = 120;
/** How many matches we keep. */
const MAX_MATCHES = 8;

export type DeepseekCandidate = {
  id: string;
  title: string;
  priceJod?: number | null;
  category?: string | null;
  spec?: string | null;
  city?: string | null;
  condition?: string | null;
};

type ChatOptions = {
  json?: boolean;
  timeoutMs?: number;
  temperature?: number;
};

export class DeepseekError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "rate" | "network" | "parse" | "config" = "network",
  ) {
    super(message);
    this.name = "DeepseekError";
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Trim a string to something safe to store and print. */
function clean(value: unknown, max = 240): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

/**
 * Strip a ```json fence and any leading prose. Models occasionally wrap JSON in
 * a code block even when asked for a bare object.
 */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start === -1 || end <= start) throw new DeepseekError("DeepSeek did not return JSON.", "parse");
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      throw new DeepseekError("DeepSeek returned malformed JSON.", "parse");
    }
  }
}

export class Deepseek {
  private key: string | null = null;

  constructor(
    private readonly stored: {
      read: () => string | null;
      write: (value: string | null) => void;
      encrypted: () => boolean;
    },
    private model: string = DEFAULT_MODEL,
  ) {
    this.key = stored.read();
  }

  status(): DeepseekStatus {
    return {
      configured: Boolean(this.key),
      encrypted: this.stored.encrypted(),
      model: this.model,
      endpoint: ENDPOINT,
      note: this.key
        ? this.stored.encrypted()
          ? "Key stored encrypted by the OS keyring."
          : "Key stored obfuscated only — this system has no keyring, so the file is readable by your user."
        : "No key stored. Add one to use DeepSeek matching.",
    };
  }

  setModel(model: string): DeepseekStatus {
    this.model = /^deepseek-[a-z0-9.-]+$/i.test(model) ? model : DEFAULT_MODEL;
    return this.status();
  }

  setKey(raw: string): DeepseekStatus {
    const key = raw.trim();
    if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(key)) {
      throw new DeepseekError("That does not look like a DeepSeek key (expected sk-…).", "config");
    }
    this.key = key;
    this.stored.write(key);
    return this.status();
  }

  clearKey(): DeepseekStatus {
    this.key = null;
    this.stored.write(null);
    return this.status();
  }

  get ready(): boolean {
    return Boolean(this.key);
  }

  private async chat(messages: { role: "system" | "user"; content: string }[], opts: ChatOptions = {}) {
    if (!this.key) throw new DeepseekError("No DeepSeek API key is configured.", "config");

    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.key}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          temperature: opts.temperature ?? 0,
          ...(opts.json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DeepseekError(
        /timeout|abort/i.test(msg) ? "DeepSeek timed out. Check your connection." : `Could not reach DeepSeek: ${msg}`,
        "network",
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new DeepseekError("DeepSeek rejected the API key. Check it and try again.", "auth");
    }
    if (res.status === 402) {
      throw new DeepseekError("DeepSeek reports insufficient balance for this key.", "auth");
    }
    if (res.status === 429) {
      throw new DeepseekError("DeepSeek is rate limiting this key. Try again shortly.", "rate");
    }
    if (!res.ok) {
      throw new DeepseekError(`DeepSeek HTTP ${res.status}.`, "network");
    }

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) throw new DeepseekError("DeepSeek returned an empty answer.", "parse");
    return content;
  }

  /**
   * Rank a closed set of candidates against a stash item.
   *
   * The model returns ids only. We then re-derive the ordering and scores from
   * the array position, so a model that answers with a nonsense score cannot
   * distort the result.
   */
  async match(
    item: { title: string; category: string; detail: string; requirements?: string | null },
    candidates: DeepseekCandidate[],
    mode: "opensooq" | "retail",
    lang: "en" | "ar" = "en",
  ): Promise<DeepseekMatchResult> {
    if (!candidates.length) {
      throw new DeepseekError("There is nothing to match against yet.", "config");
    }

    const shortlist = candidates.slice(0, MAX_CANDIDATES);
    const known = new Map(shortlist.map((c) => [c.id, c]));

    const described = shortlist
      .map((c) => {
        const bits = [
          c.category ? `cat=${c.category}` : null,
          c.spec ? `spec=${c.spec}` : null,
          c.condition ? `cond=${c.condition}` : null,
          c.city ? `city=${c.city}` : null,
          typeof c.priceJod === "number" ? `price=${c.priceJod} JOD` : null,
        ].filter(Boolean);
        return `- id=${c.id} | ${c.title}${bits.length ? ` | ${bits.join(" ")}` : ""}`;
      })
      .join("\n");

    const what = mode === "opensooq" ? "used classifieds listings" : "retail price-book entries";

    const prompt = `You match one hardware item against a fixed list of ${what}.
You may ONLY choose ids that appear in the list below. Never invent an id, a price or a listing.

ITEM TO REPLACE
title: ${item.title}
category: ${item.category}
detail: ${item.detail || "(none)"}
${item.requirements ? `detected requirements: ${item.requirements}` : ""}

CANDIDATES (${shortlist.length})
${described}

Return ONLY JSON:
{"matches":[{"id":"<id from the list>","reason":"<short reason, ${lang === "ar" ? "Arabic" : "English"}>"}],"keywords":["<short search words>"],"summary":"<one line>"}
Rules:
- Best fit first, at most ${MAX_MATCHES} matches.
- Prefer exact specification matches (capacity, DDR generation, form factor, wattage, connector).
- Exclude anything clearly incompatible; if nothing fits, return an empty matches array.
- Do not guess at price. Prices come from the list.`;

    const raw = await this.chat(
      [
        {
          role: "system",
          content:
            "You are a precise hardware catalogue matcher. You only ever reference ids from the list you are given, and you answer with a single JSON object.",
        },
        { role: "user", content: prompt },
      ],
      { json: true, temperature: 0 },
    );

    const parsed = extractJson(raw) as { matches?: unknown; keywords?: unknown; summary?: unknown };
    const list = Array.isArray(parsed.matches) ? parsed.matches : [];

    const seen = new Set<string>();
    const matches: DeepseekMatch[] = [];
    let rejected = 0;

    for (const entry of list) {
      const id = clean((entry as { id?: unknown })?.id, 80);
      if (!id) continue;
      if (!known.has(id)) {
        rejected += 1;
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      matches.push({
        id,
        // Score from rank, not from anything the model claimed.
        score: Math.round(clamp(100 - matches.length * 100 / (MAX_MATCHES + 1), 10, 100)),
        reason: clean((entry as { reason?: unknown })?.reason) ?? "",
        best: matches.length === 0,
      });
      if (matches.length >= MAX_MATCHES) break;
    }

    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords
          .map((k) => clean(k, 40))
          .filter((k): k is string => Boolean(k))
          .slice(0, 6)
      : [];

    return {
      matches,
      keywords,
      summary: clean(parsed.summary, 200) ?? "",
      model: this.model,
      considered: shortlist.length,
      rejected,
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * Ask for a physical description of one part. This is explicitly an estimate:
   * the model is told to answer `null` rather than guess, and every number is
   * clamped to a plausible range before it is stored.
   */
  async physical(
    item: { title: string; category: string; detail: string },
    lang: "en" | "ar" = "en",
  ): Promise<PhysicalSpec> {
    const prompt = `Estimate the physical properties of one electronic part for an e-waste handover manifest.

PART
title: ${item.title}
category: ${item.category}
detail: ${item.detail || "(none)"}

Return ONLY JSON:
{"weightKg":number|null,"dimensions":string|null,"materials":[{"name":string,"grams":number}],"confidence":"high"|"medium"|"low","basis":"<one short line, ${lang === "ar" ? "Arabic" : "English"}>"}
Rules:
- weightKg is the mass of ONE unit in kilograms, excluding packaging.
- dimensions is a short string, e.g. "22 × 80 × 2.4 mm" or "M.2 2280". null if unknown.
- materials are the recoverable materials in ONE unit, in grams, summing to no more than the weight. Use common names: Copper, Aluminium, Steel, Plastics, Glass, Gold, Silver, Palladium, Lithium, Cobalt, Nickel, Rare earths, Lead, Tin.
- confidence is low unless the part is a common, well-documented model.
- basis says how you got the figure. Say so plainly if this is a rough class-based estimate.
- Use null / an empty array rather than inventing a precise number.`;

    const raw = await this.chat(
      [
        {
          role: "system",
          content:
            "You are a conservative hardware teardown estimator. You prefer null over a fabricated number, and you answer with a single JSON object.",
        },
        { role: "user", content: prompt },
      ],
      { json: true, temperature: 0 },
    );

    const parsed = extractJson(raw) as Record<string, unknown>;

    const weightRaw = parsed.weightKg;
    const weightKg =
      typeof weightRaw === "number" && Number.isFinite(weightRaw) && weightRaw > 0
        ? clamp(Math.round(weightRaw * 1000) / 1000, 0.001, 200)
        : null;

    const materials: MaterialAmount[] = Array.isArray(parsed.materials)
      ? (parsed.materials as unknown[])
          .map((m) => {
            const name = clean((m as { name?: unknown })?.name, 40);
            const grams = Number((m as { grams?: unknown })?.grams);
            if (!name || !Number.isFinite(grams) || grams <= 0) return null;
            return { name, grams: clamp(Math.round(grams * 10) / 10, 0.01, 200_000) };
          })
          .filter((m): m is MaterialAmount => m !== null)
          .slice(0, 16)
      : [];

    const confidence =
      parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
        ? parsed.confidence
        : "low";

    return {
      source: "deepseek",
      confidence,
      weightKg,
      dimensions: clean(parsed.dimensions, 120),
      materials,
      basis: clean(parsed.basis, 240) ?? "DeepSeek estimate.",
      model: this.model,
      fetchedAt: new Date().toISOString(),
    };
  }
}
