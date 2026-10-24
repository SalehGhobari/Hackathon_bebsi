import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import path from "node:path";
import QRCode from "qrcode";
import { Store } from "../lib/store";
import { compactForQr, verifyPassport } from "../lib/passport";

let store: Store;
let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 840,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: "#0b0f12",
    title: "Fahas — hardware advisor",
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
    process.env.FAHAS_DEMO === "1" ? { demo: "1" } : undefined;
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

  handle("market:get", (payload) => store.market((payload as { deviceId?: string } | undefined)?.deviceId));
  handle("market:refresh", (payload) =>
    store.refreshMarket((payload as { deviceId?: string } | undefined)?.deviceId),
  );
  handle("market:image", (payload) => store.image((payload as { listingId: string }).listingId));


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
