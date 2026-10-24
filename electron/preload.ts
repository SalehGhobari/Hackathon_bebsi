import { contextBridge, ipcRenderer } from "electron";

const invoke = (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload);

const api = {
  info: () => invoke("app:info"),
  scan: (demo = false) => invoke("scan", { demo }),
  devices: () => invoke("devices:list"),
  view: (id: string) => invoke("devices:view", { id }),
  addAction: (deviceId: string, remedyId: string) => invoke("actions:add", { deviceId, remedyId }),
  removeAction: (id: string) => invoke("actions:remove", { id }),
  ledger: () => invoke("ledger"),
  prices: () => invoke("prices"),
  recyclers: () => invoke("recyclers"),
  market: (deviceId?: string) => invoke("market:get", { deviceId }),
  refreshMarket: (deviceId?: string) => invoke("market:refresh", { deviceId }),
  listingImage: (listingId: string) => invoke("market:image", { listingId }),

  recordWipe: (deviceId: string, method: string, disk: string) =>
    invoke("wipe:add", { deviceId, method, disk }),
  passport: (deviceId: string) => invoke("passport", { deviceId }),
  verifyPassport: (passport: unknown) => invoke("passport:verify", { passport }),
};

contextBridge.exposeInMainWorld("fahas", api);

export type FahasApi = typeof api;
