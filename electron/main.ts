import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell } from "electron";
import type { OpenDialogOptions, SaveDialogOptions } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import QRCode from "qrcode";
import { Store } from "../lib/store";
import { compactForQr, verifyPassport } from "../lib/passport";
import { renderPassportHtml } from "./passport-pdf";
import { aiSearch, aiStatus } from "../lib/ai";
import { scanConnected } from "../lib/detect/connected";
import { scanLan } from "../lib/detect/lan";
import { renderRecycleHtml } from "./recycle-pdf";

let store: Store;
let win: BrowserWindow | null = null;

const appIcon = path.join(__dirname, "../../build/icon.png");

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 840,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: "#0b0f12",
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
    const subject = "Fahes e-waste recycling manifest";
    const body = [
      `Hello ${recycler.name},`,
      "",
      "I have prepared a recycling manifest in Fahes. Please find the PDF attached to this email.",
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

  handle("ai:status", () => aiStatus());
  handle("ai:search", (payload) => {
    const { query, lang } = payload as { query: string; lang?: "en" | "ar" };
    return aiSearch(query, lang === "ar" ? "ar" : "en");
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
      color: { dark: "#0b0f12", light: "#ffffff" },
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
    store = new Store(path.join(electronApp.getPath("userData")));
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
