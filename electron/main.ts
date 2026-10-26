import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, shell } from "electron";
import type { OpenDialogOptions, SaveDialogOptions } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import QRCode from "qrcode";
import { Store, type SecretBox } from "../lib/store";
import { compactForQr, verifyPassport } from "../lib/passport";
import { renderPassportHtml } from "./passport-pdf";
import { Deepseek, DeepseekError, DEFAULT_MODEL } from "../lib/deepseek";
import { priceRowsWithLinks } from "../lib/retail";
import { parseQuery } from "../lib/market/query";
import { scanConnected } from "../lib/detect/connected";
import { scanLan } from "../lib/detect/lan";
import { renderRecycleHtml } from "./recycle-pdf";

let store: Store;
let deepseek: Deepseek;
let win: BrowserWindow | null = null;

/**
 * Wrap Electron's safeStorage as the store's SecretBox. On Linux without a
 * keyring `isEncryptionAvailable()` is false; we then keep the key obfuscated
 * only and report that honestly through `deepseek:status` instead of implying
 * the key is protected.
 */
function makeSecretBox(): SecretBox {
  const usable = (() => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  })();

  return {
    encrypted: usable,
    encrypt: (plain) => {
      if (!usable) return Buffer.from(plain, "utf8").toString("base64");
      try {
        return safeStorage.encryptString(plain).toString("base64");
      } catch {
        return Buffer.from(plain, "utf8").toString("base64");
      }
    },
    decrypt: (blob) => {
      try {
        const buf = Buffer.from(blob, "base64");
        if (!usable) return buf.toString("utf8");
        return safeStorage.decryptString(buf);
      } catch {
        return null;
      }
    },
  };
}

const appIcon = path.join(__dirname, "../../build/icon.png");

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 840,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: "#17130f",
    title: "Fahes — recycle & replace",
    icon: app.isPackaged ? undefined : appIcon,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => win?.show());
  const demoQuery: Record<string, string> | undefined =
    process.env.FAHES_DEMO === "1" || process.env.FAHAS_DEMO === "1" ? { demo: "1" } : undefined;
  win.loadFile(path.join(__dirname, "../../ui/index.html"), demoQuery ? { query: demoQuery } : {});

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("closed", () => {
    win = null;
  });
}

type Handler = (payload: unknown) => unknown | Promise<unknown>;

function handle(channel: string, fn: Handler) {
  ipcMain.handle(channel, async (_event, payload: unknown) => {
    try {
      return { ok: true, data: await fn(payload) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  });
}

function registerIpc() {
  handle("app:info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    dataDir: store.dataDir(),
    electron: process.versions.electron,
    node: process.versions.node,
  }));

  handle("scan", (payload) => store.scan((payload as { demo?: boolean }) ?? {}));
  handle("devices:list", () => store.listDevices());
  handle("devices:view", (payload) => store.view((payload as { id: string }).id));

  handle("actions:add", (payload) => {
    const { deviceId, remedyId } = payload as { deviceId: string; remedyId: string };
    return store.addAction(deviceId, remedyId);
  });

  handle("actions:remove", (payload) => store.removeAction((payload as { id: string }).id));
  handle("ledger", () => store.ledger());
  handle("prices", () => store.prices());
  handle("recyclers", () => store.recyclers());

  handle("market:get", (payload) =>
    store.market((payload as { deviceId?: string; stashId?: string } | undefined) ?? {}),
  );
  handle("market:search", (payload) => {
    const { term, target } = payload as {
      term: string;
      target?: string | { deviceId?: string; stashId?: string };
    };
    return store.searchMarket(term, target);
  });

  handle("market:refresh", (payload) =>
    store.refreshMarket((payload as { deviceId?: string; stashId?: string } | undefined) ?? {}),
  );
  handle("market:image", (payload) => store.image((payload as { listingId: string }).listingId));

  handle("scan:connected", () => scanConnected());
  handle("scan:lan", () => scanLan());

  handle("stash:list", (payload) => store.listStash((payload as { kind?: "recycle" | "replace" } | undefined)?.kind));
  handle("stash:candidates", (payload) => store.candidates((payload as { deviceId: string }).deviceId));
  handle("stash:add", (payload) => store.addStash(payload as Parameters<typeof store.addStash>[0]));
  handle("stash:update", (payload) => {
    const { id, patch } = payload as { id: string; patch: Parameters<typeof store.updateStash>[1] };
    return store.updateStash(id, patch);
  });
  handle("stash:remove", (payload) => store.removeStash((payload as { id: string }).id));
  handle("stash:mark", (payload) => {
    const { id, status, replacedWith } = payload as {
      id: string;
      status: "recycled" | "replaced";
      replacedWith?: Parameters<typeof store.markStash>[2];
    };
    return store.markStash(id, status, replacedWith);
  });

  handle("stash:photo-pick", async (payload) => {
    const { id } = payload as { id: string };
    const options: OpenDialogOptions = {
      title: "Attach a photo",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const image = nativeImage.createFromPath(result.filePaths[0]);
    if (image.isEmpty()) throw new Error("That image could not be read.");
    const size = image.getSize();
    const resized = size.width > 1200 ? image.resize({ width: 1200 }) : image;
    return store.setStashPhoto(id, resized.toJPEG(82), "image/jpeg");
  });

  handle("stash:photo", (payload) => ({
    dataUrl: store.stashPhotoDataUrl((payload as { id: string }).id),
  }));

  handle("recycle:estimate", (payload) => {
    const { name, category, quantity } = payload as { name: string; category?: string; quantity?: number };
    return store.estimateRecycle(name, category, quantity);
  });

  handle("recycle:pdf", async (payload) => {
    const { recyclerId, itemIds, note, lang } = payload as {
      recyclerId: string;
      itemIds?: string[];
      note?: string;
      lang?: "en" | "ar";
    };
    const batch = store.recycleBatch(recyclerId, itemIds, note ?? "");
    const html = renderRecycleHtml(batch, lang === "ar" ? "ar" : "en");
    const tmp = path.join(os.tmpdir(), `fahes-recycle-${Date.now()}.html`);
    fs.writeFileSync(tmp, html, "utf8");

    const preview = new BrowserWindow({ show: false, webPreferences: { offscreen: true, javascript: false } });
    try {
      await preview.loadFile(tmp);
      const pdf = await preview.webContents.printToPDF({ printBackground: true, pageSize: "A4" });

      const forcedPath = process.env.FAHES_RECYCLE_PDF_PATH;
      let savedPath = forcedPath ?? null;
      if (!savedPath) {
        const options: SaveDialogOptions = {
          title: "Save recycling manifest",
          defaultPath: `fahes-recycle-${new Date().toISOString().slice(0, 10)}.pdf`,
          filters: [{ name: "PDF", extensions: ["pdf"] }],
        };
        const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) return { saved: false };
        savedPath = result.filePath;
      }
      fs.writeFileSync(savedPath, pdf);
      store.markRecycled(batch.items.map((i) => i.id));
      return { saved: true, path: savedPath, count: batch.totals.items, ids: batch.items.map((i) => i.id) };
    } finally {
      preview.destroy();
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* temp file already gone */
      }
    }
  });

  handle("recycle:email", async (payload) => {
    const { recyclerId } = payload as { recyclerId: string };
    const recycler = store.recyclers().find((r) => r.id === recyclerId);
    if (!recycler) throw new Error("Choose a recycling partner first.");
    const subject = "E-waste recycling manifest";
    const body = [
      `Hello ${recycler.name},`,
      "",
      "I have prepared a recycling manifest. Please find the PDF attached to this email.",
      "It lists the items, quantities and photos, and my contact details for pickup.",
      "",
      "Thank you.",
    ].join("\n");
    await shell.openExternal(
      `mailto:${encodeURIComponent(recycler.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
    );
    return { opened: true };
  });

  handle("open:path", async (payload) => {
    const target = (payload as { path: string }).path;
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return true;
  });

  // Deterministic: turns a phrase into filters. No model involved.
  handle("market:parse", (payload) => parseQuery((payload as { query: string }).query));

  /* ---------------- optional DeepSeek integration ---------------- */

  handle("deepseek:status", () => deepseek.status());

  handle("deepseek:setKey", (payload) => {
    const { key } = payload as { key: string };
    return deepseek.setKey(key);
  });

  handle("deepseek:clearKey", () => deepseek.clearKey());

  handle("deepseek:setModel", (payload) => {
    const { model } = payload as { model?: string };
    const next = deepseek.setModel(model ?? DEFAULT_MODEL);
    store.writeSecretModel(next.model);
    return next;
  });

  /**
   * Rank real rows against a stashed item. The candidate set is built here, in
   * the main process, straight from the store — the renderer never supplies the
   * set, so it cannot be widened, and the model can only answer with ids from it.
   */
  handle("deepseek:match", async (payload) => {
    const { stashId, mode, lang } = payload as {
      stashId: string;
      mode: "opensooq" | "retail";
      lang?: "en" | "ar";
    };

    const item = store.stashItem(stashId);
    if (!item) throw new DeepseekError("That stash item no longer exists.", "config");

    const requirements = item.requirements
      ? [item.requirements.ramGen, item.requirements.ramForm, item.requirements.storageBus, item.requirements.storageForm]
          .filter(Boolean)
          .join(" · ")
      : null;

    const subject = {
      title: item.title,
      category: item.category,
      detail: item.detail,
      requirements,
    };

    if (mode === "retail") {
      const rows = store.prices();
      const result = await deepseek.match(
        subject,
        rows.map((row) => ({
          id: row.id,
          title: row.item,
          priceJod: row.low,
          category: row.category,
          spec: row.spec,
          condition: row.kind,
        })),
        "retail",
        lang === "ar" ? "ar" : "en",
      );
      // Every retail match carries the vendor page and a live search link,
      // because the price itself cannot be read from those sites server-side.
      return { mode, result, rows: priceRowsWithLinks(rows) };
    }

    const market = store.market({ stashId });
    const listings = market.listings
      .filter((l) => !l.outlier)
      .map((l) => ({
        id: l.id,
        title: l.title,
        priceJod: l.priceJod,
        category: l.category,
        condition: l.condition,
        city: l.area ?? null,
      }));

    const result = await deepseek.match(subject, listings, "opensooq", lang === "ar" ? "ar" : "en");
    return { mode, result, listings: market.listings };
  });

  handle("deepseek:physical", async (payload) => {
    const { stashId, lang, save } = payload as {
      stashId: string;
      lang?: "en" | "ar";
      save?: boolean;
    };
    const item = store.stashItem(stashId);
    if (!item) throw new DeepseekError("That stash item no longer exists.", "config");

    const spec = await deepseek.physical(
      { title: item.title, category: item.category, detail: item.detail },
      lang === "ar" ? "ar" : "en",
    );

    // `save: false` is used for a dry look-up so the user can compare the two
    // estimates before committing to one.
    return save === false ? { spec, item } : { spec, item: store.setAiPhysical(stashId, spec) };
  });

  handle("deepseek:applyPhysical", (payload) => {
    const { stashId } = payload as { stashId: string };
    return store.applyAiPhysical(stashId);
  });

  handle("deepseek:clearPhysical", (payload) => {
    const { stashId } = payload as { stashId: string };
    return store.setAiPhysical(stashId, null);
  });


  handle("wipe:add", (payload) => {
    const { deviceId, method, disk } = payload as { deviceId: string; method: string; disk: string };
    return store.recordWipe(deviceId, method, disk);
  });

  handle("passport", async (payload) => {
    const { deviceId } = payload as { deviceId: string };
    const passport = store.passport(deviceId);
    if (!passport) return null;
    const qr = await QRCode.toDataURL(compactForQr(passport), {
      margin: 1,
      width: 280,
      errorCorrectionLevel: "M",
      color: { dark: "#17130f", light: "#fffdf8" },
    });
    return { passport, qr, compact: compactForQr(passport) };
  });

  handle("passport:pdf", async (payload) => {
    const { deviceId, lang } = payload as { deviceId: string; lang?: "en" | "ar" };
    const passport = store.passport(deviceId);
    if (!passport) throw new Error("No passport available for this device.");

    const qr = await QRCode.toDataURL(compactForQr(passport), {
      margin: 1,
      width: 420,
      color: { dark: "#101820", light: "#ffffff" },
    });
    const html = renderPassportHtml(passport, qr, lang === "ar" ? "ar" : "en");
    const tmp = path.join(os.tmpdir(), `fahes-passport-${Date.now()}.html`);
    fs.writeFileSync(tmp, html, "utf8");

    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, javascript: false } });
    try {
      await win.loadFile(tmp);
      const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: "A4" });

      const forcedPath = process.env.FAHES_PDF_PATH;
      if (forcedPath) {
        fs.writeFileSync(forcedPath, pdf);
        return { saved: true, path: forcedPath };
      }

      const result = await dialog.showSaveDialog({
        title: "Save passport",
        defaultPath: `fahes-passport-${(passport.device.name || "device")
          .replace(/[^a-z0-9]+/gi, "-")
          .toLowerCase()}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (result.canceled || !result.filePath) return { saved: false };
      fs.writeFileSync(result.filePath, pdf);
      return { saved: true, path: result.filePath };
    } finally {
      win.destroy();
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* temp file already gone */
      }
    }
  });

  handle("passport:verify", (payload) => {
    const { passport } = payload as { passport: Parameters<typeof verifyPassport>[0] };
    return { valid: verifyPassport(passport) };
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  try {
    const { app: electronApp } = require("electron") as typeof import("electron");
    store = new Store(path.join(electronApp.getPath("userData")), makeSecretBox());
    deepseek = new Deepseek(
      {
        read: () => store.readSecret(),
        write: (value) => store.writeSecret(value),
        encrypted: () => store.secretsEncrypted(),
      },
      store.secretModel(),
    );
  } catch (err) {
    console.error("Failed to open local store", err);
    throw err;
  }

  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
