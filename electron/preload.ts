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
  market: (target?: string | { deviceId?: string; stashId?: string }) =>
    invoke("market:get", typeof target === "string" ? { deviceId: target } : target ?? {}),
  refreshMarket: (target?: string | { deviceId?: string; stashId?: string }) =>
    invoke("market:refresh", typeof target === "string" ? { deviceId: target } : target ?? {}),
  searchMarket: (term: string, target?: string | { deviceId?: string; stashId?: string }) =>
    invoke("market:search", { term, target }),
  listingImage: (listingId: string) => invoke("market:image", { listingId }),
  aiStatus: () => invoke("ai:status"),
  aiSearch: (query: string, lang?: string) => invoke("ai:search", { query, lang }),

  deepseekStatus: () => invoke("deepseek:status"),
  deepseekSetKey: (key: string) => invoke("deepseek:setKey", { key }),
  deepseekClearKey: () => invoke("deepseek:clearKey"),
  deepseekSetModel: (model: string) => invoke("deepseek:setModel", { model }),
  deepseekMatch: (stashId: string, mode: "opensooq" | "retail", lang?: string) =>
    invoke("deepseek:match", { stashId, mode, lang }),
  deepseekPhysical: (stashId: string, lang?: string, save = true) =>
    invoke("deepseek:physical", { stashId, lang, save }),
  deepseekApplyPhysical: (stashId: string) => invoke("deepseek:applyPhysical", { stashId }),
  deepseekClearPhysical: (stashId: string) => invoke("deepseek:clearPhysical", { stashId }),

  scanConnected: () => invoke("scan:connected"),
  scanLan: () => invoke("scan:lan"),

  stashList: (kind?: "recycle" | "replace") => invoke("stash:list", { kind }),
  stashCandidates: (deviceId: string) => invoke("stash:candidates", { deviceId }),
  addStash: (input: unknown) => invoke("stash:add", input),
  updateStash: (id: string, patch: unknown) => invoke("stash:update", { id, patch }),
  removeStash: (id: string) => invoke("stash:remove", { id }),
  markStash: (id: string, status: "recycled" | "replaced", replacedWith?: unknown) =>
    invoke("stash:mark", { id, status, replacedWith }),
  pickStashPhoto: (id: string) => invoke("stash:photo-pick", { id }),
  stashPhoto: (id: string) => invoke("stash:photo", { id }),

  estimateRecycle: (name: string, category?: string, quantity?: number) =>
    invoke("recycle:estimate", { name, category, quantity }),

  recyclePdf: (payload: { recyclerId: string; itemIds?: string[]; note?: string; lang?: string }) =>
    invoke("recycle:pdf", payload),
  emailRecycler: (recyclerId: string) => invoke("recycle:email", { recyclerId }),
  openPath: (path: string) => invoke("open:path", { path }),

  recordWipe: (deviceId: string, method: string, disk: string) =>
    invoke("wipe:add", { deviceId, method, disk }),
  passport: (deviceId: string) => invoke("passport", { deviceId }),
  verifyPassport: (passport: unknown) => invoke("passport:verify", { passport }),
  passportPdf: (deviceId: string, lang?: string) => invoke("passport:pdf", { deviceId, lang }),
};

contextBridge.exposeInMainWorld("fahes", api);

export type FahesApi = typeof api;
