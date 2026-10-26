import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Deepseek } from "../lib/deepseek";
import { Store } from "../lib/store";

/**
 * These tests never touch the network. They exercise the two guarantees that
 * matter: the key is persisted and round-trips, and a match result can only
 * contain ids that were in the closed set we handed the model.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fahes-ds-test-"));

let stored: string | null = null;
const ds = new Deepseek(
  {
    read: () => stored,
    write: (v) => {
      stored = v;
    },
    encrypted: () => true,
  },
  "deepseek-chat",
);

// --- key handling -----------------------------------------------------------
assert.equal(ds.status().configured, false);
assert.equal(ds.ready, false);

assert.throws(() => ds.setKey("nope"), /does not look like/);
assert.throws(() => ds.setKey("sk-short"), /does not look like/);

const status = ds.setKey("sk-abcdefghijklmnopqrstuvwxyz012345");
assert.equal(status.configured, true);
assert.equal(status.encrypted, true);
assert.equal(stored, "sk-abcdefghijklmnopqrstuvwxyz012345");

// a fresh instance reads the persisted key back
const reopened = new Deepseek(
  { read: () => stored, write: (v) => (stored = v), encrypted: () => true },
  "deepseek-chat",
);
assert.equal(reopened.ready, true);

assert.equal(ds.clearKey().configured, false);
assert.equal(stored, null);

// --- model selection --------------------------------------------------------
assert.equal(ds.setModel("deepseek-reasoner").model, "deepseek-reasoner");
assert.equal(ds.setModel("gpt-4").model, "deepseek-chat", "unknown models fall back to the default");

// --- store: key at rest, and the aiPhysical layer ---------------------------
// a stand-in for safeStorage: a reversible transform that does not embed the
// plaintext, so the "not written in the clear" assertion is meaningful
const box = {
  encrypted: true,
  encrypt: (p: string) => Buffer.from(p, "utf8").toString("base64"),
  decrypt: (b: string) => {
    try {
      return Buffer.from(b, "base64").toString("utf8");
    } catch {
      return null;
    }
  },
};
const store = new Store(dir, box);

assert.equal(store.readSecret(), null);
store.writeSecret("sk-abcdefghijklmnopqrstuvwxyz012345");
assert.equal(store.readSecret(), "sk-abcdefghijklmnopqrstuvwxyz012345");
assert.equal(store.secretsEncrypted(), true);

// the raw file must not contain the key in the clear
const raw = fs.readFileSync(path.join(dir, "fahes-data.json"), "utf8");
assert.ok(!raw.includes("sk-abcdefghijklmnopqrstuvwxyz012345"), "key must not be written in plaintext");
assert.ok(raw.includes("c2stYWJj"), "key should be stored through the secret box");

store.writeSecret(null);
assert.equal(store.readSecret(), null);

// a broken blob degrades to null instead of throwing
store.writeSecret("sk-abcdefghijklmnopqrstuvwxyz012345");
const broken = new Store(dir, { encrypted: true, encrypt: (p) => p, decrypt: () => null });
assert.equal(broken.readSecret(), null, "an undecryptable blob returns null, not a crash");

// --- aiPhysical is a separate layer ----------------------------------------
const item = store.addStash({ kind: "recycle", source: "manual", title: "Dell 65W charger", category: "charger" });
const before = item.impact.kgDiverted;
assert.equal(item.aiPhysical, undefined);

const saved = store.setAiPhysical(item.id, {
  source: "deepseek",
  confidence: "low",
  weightKg: 0.42,
  dimensions: "105 × 46 × 29 mm",
  materials: [{ name: "Copper", grams: 60 }],
  basis: "Class-based estimate.",
});
assert.ok(saved?.aiPhysical, "spec should be stored");
assert.equal(
  saved?.impact.kgDiverted,
  before,
  "storing a DeepSeek spec must not change the deterministic estimate",
);

// explicitly opting in does replace the manifest figures
const applied = store.applyAiPhysical(item.id);
assert.equal(applied?.impact.kgDiverted, 0.42);
assert.deepEqual(applied?.impact.materials, [{ name: "Copper", grams: 60 }]);

// quantity scales the applied figures (kg is rounded to 1 dp above 1 kg)
store.updateStash(item.id, { quantity: 3 });
const applied3 = store.applyAiPhysical(item.id);
assert.equal(applied3?.impact.kgDiverted, 1.3);
assert.deepEqual(applied3?.impact.materials, [{ name: "Copper", grams: 180 }]);

assert.equal(store.setAiPhysical(item.id, null)?.aiPhysical, undefined, "clearing removes the layer");

async function main() {
// --- closed-set matching: the model cannot smuggle in an id we never sent ---
{
  const real = [
    { id: "L1", title: "Kingston 16GB DDR4 SO-DIMM 3200", priceJod: 45, category: "ram" },
    { id: "L2", title: "Samsung 8GB DDR4 laptop ram", priceJod: 25, category: "ram" },
  ];

  const originalFetch = globalThis.fetch;
  let sentBody = "";

  // The stub answers with one real id, one id that does not exist, and a
  // nonsense score we must ignore.
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sentBody = init.body;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                matches: [
                  { id: "L2", score: 999, reason: "8 GB DDR4 laptop stick" },
                  { id: "L-DOES-NOT-EXIST", score: 100, reason: "invented" },
                  { id: "L1", score: -50, reason: "16 GB DDR4 SO-DIMM" },
                ],
                keywords: ["DDR4", "SO-DIMM"],
                summary: "Two DDR4 laptop sticks",
              }),
            },
          },
        ],
      }),
    };
  }) as unknown as typeof fetch;

  const ds2 = new Deepseek(
    { read: () => "sk-abcdefghijklmnopqrstuvwxyz012345", write: () => {}, encrypted: () => true },
    "deepseek-chat",
  );

  const result = await ds2.match(
    { title: "Battery", category: "ram", detail: "8 GB DDR4" },
    real,
    "opensooq",
  );

  assert.deepEqual(
    result.matches.map((m) => m.id),
    ["L2", "L1"],
    "only ids from the closed set survive, in the order the model returned them",
  );
  assert.equal(result.rejected, 1, "the invented id is counted, not shown");
  assert.equal(result.considered, 2);
  assert.equal(result.matches[0].best, true);
  assert.equal(result.matches[1].best, false);
  assert.ok(
    result.matches.every((m) => m.score <= 100 && m.score >= 10),
    "scores are re-derived from rank, not taken from the model",
  );
  assert.ok(!sentBody.includes("L-DOES-NOT-EXIST"), "we never suggest the id we then reject");

  // the prompt must forbid inventing a price
  assert.ok(/Never invent an id, a price or a listing/.test(sentBody), "prompt states the closed-set rule");

  // an empty match list is a legitimate answer, not an error
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: '{"matches":[],"keywords":[],"summary":"nothing fits"}' } }] }),
  })) as unknown as typeof fetch;

  const empty = await ds2.match({ title: "Battery", category: "ram", detail: "" }, real, "retail");
  assert.equal(empty.matches.length, 0, "no match is reported honestly");
  assert.equal(empty.rejected, 0);

  // a 401 surfaces as an auth error the UI can explain
  globalThis.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
  await assert.rejects(
    () => ds2.match({ title: "Battery", category: "ram", detail: "" }, real, "opensooq"),
    /rejected the API key/,
  );

  globalThis.fetch = originalFetch;
}

// --- physical estimates are clamped, never trusted blindly -----------------
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              weightKg: 99999,
              dimensions: "x".repeat(400),
              materials: [
                { name: "Copper", grams: 60 },
                { name: "", grams: 10 },
                { name: "Lead", grams: -5 },
              ],
              confidence: "certain",
              basis: "made up",
            }),
          },
        },
      ],
    }),
  })) as unknown as typeof fetch;

  const ds3 = new Deepseek(
    { read: () => "sk-abcdefghijklmnopqrstuvwxyz012345", write: () => {}, encrypted: () => true },
    "deepseek-chat",
  );
  const spec = await ds3.physical({ title: "Charger", category: "charger", detail: "" });

  assert.equal(spec.weightKg, 200, "an absurd weight is clamped to the ceiling");
  assert.ok((spec.dimensions ?? "").length <= 120, "dimensions are truncated");
  assert.deepEqual(spec.materials, [{ name: "Copper", grams: 60 }], "nameless and negative materials are dropped");
  assert.equal(spec.confidence, "low", "an unrecognised confidence falls back to low");
  assert.equal(spec.source, "deepseek");

  globalThis.fetch = originalFetch;
}
}

main().then(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("deepseek tests passed");
});
