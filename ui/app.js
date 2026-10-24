/* Fahes renderer — recycle & replace. No frameworks, no network calls, no node access. */
const api = window.fahes;

const state = {
  view: null,
  devices: [],
  stash: [],
  candidates: [],
  usb: null,
  lan: null,
  ledger: null,
  prices: [],
  info: null,
  passport: null,
  tab: "scan",
  recyclers: [],
  market: null,
  marketKey: null,
  photos: new Map(),
  itemPhotos: new Map(),
  aiFilters: null,
  aiEngine: null,
  aiStatus: null,
  replaceItem: null,
};

const $ = (sel) => document.querySelector(sel);
const t = (key, vars) => window.I18N.t(key, vars);

const TAB_META = {
  scan: ["Scan & stash", "Read this PC, USB devices, or your LAN, then file each item for recycling or replacement."],
  replace: ["Replace", "Stash what you want to replace, then find compatible parts in the OpenSooq index."],
  recycle: ["Recycle", "Keep a manifest of e-waste, attach photos, and hand it to a recycler."],
  impact: ["Impact", "What your stash keeps out of landfill."],
  more: ["More", "Price book, recycling partners and the second-life passport."],
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function call(promise) {
  const res = await promise;
  if (!res || !res.ok) throw new Error((res && res.error) || "Request failed");
  return res.data;
}

let toastTimer = null;
function toast(message, kind = "ok") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast ${kind === "error" ? "error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4600);
}

function money(n) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function kg(n) {
  return `${money(n)} kg`;
}

function statusFor(score) {
  if (score === null || score === undefined) return "unknown";
  if (score >= 80) return "good";
  if (score >= 60) return "fair";
  return "poor";
}

function sourceLabel(source) {
  return { local: "This PC", usb: "USB / removable", lan: "LAN", manual: "Manual" }[source] ?? source;
}

function statusLabel(status) {
  return { stashed: "In stash", recycled: "Recycled", replaced: "Replaced" }[status] ?? status;
}

function mergeMaterials(list) {
  const map = new Map();
  for (const m of list) map.set(m.name, (map.get(m.name) ?? 0) + m.grams);
  return [...map.entries()]
    .map(([name, grams]) => ({ name, grams: Math.round(grams * 10) / 10 }))
    .filter((m) => m.grams > 0)
    .sort((a, b) => b.grams - a.grams);
}

/* ---------------- boot ---------------- */

document.addEventListener("DOMContentLoaded", () => {
  if (!api) {
    document.body.innerHTML =
      '<div style="padding:40px;font-family:system-ui"><h2>Fahes must run as the desktop app.</h2><p>Launch it with <code>npm run dev</code> or the packaged AppImage / installer.</p></div>';
    return;
  }
  bind();
  boot();
});

async function boot() {
  try {
    window.I18N.applyStatic();
    const note = $("#partialNote");
    if (note) {
      note.textContent = window.I18N.lang === "ar" ? t("lang.partialNote") : "";
      note.classList.toggle("hidden", window.I18N.lang !== "ar");
    }
    state.info = await call(api.info());
    $("#infoLine").textContent = `v${state.info.version} · ${state.info.platform}/${state.info.arch}\n${state.info.dataDir}`;
    $("#infoLine").style.whiteSpace = "pre-line";

    state.prices = await call(api.prices());
    state.recyclers = await call(api.recyclers());
    try {
      state.aiStatus = await call(api.aiStatus());
    } catch {
      state.aiStatus = null;
    }
    state.ledger = await call(api.ledger());
    await refreshStash();
    await refreshDevices();
    renderAll();
    switchTab("scan");

    if (new URLSearchParams(location.search).get("demo") === "1") {
      const toggle = $("#demoToggle");
      if (toggle) toggle.checked = true;
      await doLocalScan(true);
    }
  } catch (err) {
    toast(err.message, "error");
  }
}

/* ---------------- bindings ---------------- */

function bind() {
  $("#scanBtn").addEventListener("click", () => doLocalScan(Boolean($("#demoToggle")?.checked)));
  $("#scanLocalBtn").addEventListener("click", () => doLocalScan(Boolean($("#demoToggle")?.checked)));
  $("#scanUsbBtn").addEventListener("click", doUsbScan);
  $("#scanLanBtn").addEventListener("click", doLanScan);

  $("#langBtn").addEventListener("click", () => {
    window.I18N.setLang(window.I18N.lang === "ar" ? "en" : "ar");
    applyLanguage();
  });

  $("#tabs").addEventListener("click", (event) => {
    const btn = event.target.closest(".tab");
    if (btn) switchTab(btn.dataset.tab);
  });

  $("#deviceList").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-device]");
    if (btn) loadDevice(btn.dataset.device);
  });

  $("#stashSummary").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-goto]");
    if (btn) switchTab(btn.dataset.goto);
  });

  $("#manualStashForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = $("#manualTitle").value.trim();
    if (!title) return;
    try {
      await call(
        api.addStash({
          kind: $("#manualKind").value,
          source: "manual",
          title,
          category: $("#manualCategory").value,
          quantity: Number($("#manualQty").value) || 1,
        }),
      );
      $("#manualTitle").value = "";
      $("#manualQty").value = "1";
      await refreshStash();
      toast(t("toast.stashed"));
    } catch (err) {
      toast(err.message, "error");
    }
  });

  $("#replaceForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = $("#replaceTitle").value.trim();
    if (!title) return;
    const category = $("#replaceCategory").value;
    try {
      await call(
        api.addStash({
          kind: "replace",
          source: "manual",
          title,
          category,
          marketCategory: category === "other" ? null : category,
        }),
      );
      $("#replaceTitle").value = "";
      await refreshStash();
      toast(t("toast.stashed"));
    } catch (err) {
      toast(err.message, "error");
    }
  });

  $("#recycleForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = $("#recycleTitle").value.trim();
    if (!title) return;
    try {
      await call(
        api.addStash({
          kind: "recycle",
          source: "manual",
          title,
          category: $("#recycleCategory").value,
          quantity: Number($("#recycleQty").value) || 1,
        }),
      );
      $("#recycleTitle").value = "";
      $("#recycleQty").value = "1";
      await refreshStash();
      toast(t("toast.stashed"));
    } catch (err) {
      toast(err.message, "error");
    }
  });

  for (const id of ["replaceList", "recycleList", "localResult"]) {
    document.getElementById(id)?.addEventListener("click", onStashClick);
    document.getElementById(id)?.addEventListener("focusout", onNotesBlur);
  }
  for (const id of ["usbResults", "lanResults"]) {
    document.getElementById(id)?.addEventListener("click", onStashClick);
  }

  $("#replaceTarget").addEventListener("click", (event) => {
    if (event.target.closest("[data-clear-target]")) {
      state.replaceItem = null;
      state.aiFilters = null;
      state.aiEngine = null;
      state.market = null;
      state.marketKey = null;
      $("#mSearch").value = "";
      renderReplaceTarget();
      loadMarket(true);
      return;
    }
    if (event.target.closest("[data-ai-target]")) {
      runAiSearch(true);
    }
  });

  $("#recyclerSelect").addEventListener("change", renderRecycleSummary);
  $("#generateRecyclePdf").addEventListener("click", generateRecyclePdf);
  $("#emailRecycler").addEventListener("click", emailRecycler);

  $("#aiAsk").addEventListener("click", () => runAiSearch());
  $("#mSearch").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runAiSearch();
    }
  });
  $("#aiChips").addEventListener("click", (event) => {
    if (!event.target.closest("[data-ai-clear]")) return;
    state.aiFilters = null;
    state.aiEngine = null;
    $("#mSearch").value = "";
    $("#mCategory").value = "all";
    $("#mCondition").value = "all";
    $("#mMax").value = "";
    renderMarket();
  });

  $("#marketCats").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-cat]");
    if (!chip) return;
    $("#mCategory").value = chip.dataset.cat;
    renderMarket();
  });

  $("#marketList").addEventListener("click", (event) => {
    const photo = event.target.closest("[data-view-photo]");
    if (photo) {
      openPhoto(photo.dataset.viewPhoto);
      return;
    }
    const use = event.target.closest("[data-use-listing]");
    if (use) useListing(use.dataset.useListing);
  });

  for (const id of ["mSearch", "mCategory", "mCondition", "mMax", "mCompatible", "mPartsOnly", "mOutliers"]) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", renderMarket);
  }

  $("#mRefresh").addEventListener("click", async () => {
    const btn = $("#mRefresh");
    btn.disabled = true;
    btn.textContent = t("market.refreshing");
    try {
      const target = marketTarget();
      const res = await call(api.refreshMarket(target));
      state.market = res.market;
      state.marketKey = marketKey();
      renderMarket();
      toast(
        res.fetched === 0
          ? t("toast.fetchedNone")
          : t("toast.fetched", { fetched: res.fetched, added: res.added }),
        res.fetched === 0 ? "error" : "ok",
      );
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = t("market.refresh");
    }
  });

  $("#photoClose").addEventListener("click", closePhoto);
  $("#photoModal").addEventListener("click", (event) => {
    if (event.target === $("#photoModal")) closePhoto();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePhoto();
  });

  document.addEventListener("click", async (event) => {
    const openPdf = event.target.closest("[data-open-pdf]");
    if (openPdf) {
      try {
        await call(api.openPath(openPdf.dataset.openPdf));
      } catch (err) {
        toast(err.message, "error");
      }
      return;
    }
    const wipeBtn = event.target.closest("[data-record-wipe]");
    if (wipeBtn && state.view) {
      const disk = wipeBtn.dataset.recordWipe || "drive";
      try {
        await call(api.recordWipe(state.view.device.id, "Secure erase (command run by the user)", disk));
        state.view = await call(api.view(state.view.device.id));
        toast(t("toast.wipeRecorded", { disk }));
        renderAll();
      } catch (err) {
        toast(err.message, "error");
      }
    }
  });

  $("#passportBtn").addEventListener("click", generatePassport);
  $("#passportBox").addEventListener("click", async (event) => {
    if (event.target.closest("#downloadPassportPdf") && state.view) {
      try {
        const res = await call(api.passportPdf(state.view.device.id, window.I18N.lang));
        if (res.saved) toast(t("toast.pdfSaved", { path: res.path }));
      } catch (err) {
        toast(err.message, "error");
      }
    }
    if (event.target.closest("#verifyPassport") && state.passport) {
      try {
        const res = await call(api.verifyPassport(state.passport.passport));
        toast(res.valid ? t("toast.verified") : t("toast.tampered"), res.valid ? "ok" : "error");
      } catch (err) {
        toast(err.message, "error");
      }
    }
  });

  $("#wipeBtn").addEventListener("click", async () => {
    if (!state.view) return;
    const method = $("#wipeMethod").value;
    const disk = $("#wipeDisk").value.trim() || "not specified";
    try {
      await call(api.recordWipe(state.view.device.id, method, disk));
      state.view = await call(api.view(state.view.device.id));
      state.passport = null;
      renderPassport();
      toast(t("toast.wipe"));
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

async function onStashClick(event) {
  const target = event.target;
  const candidate = target.closest("[data-candidate]");
  if (candidate) {
    await stashCandidate(candidate.dataset.candidate, candidate.dataset.kind);
    return;
  }
  const discovery = target.closest("[data-discovery]");
  if (discovery) {
    await stashDiscovery(discovery.dataset.discovery, discovery.dataset.kind);
    return;
  }
  const find = target.closest("[data-find-parts]");
  if (find) {
    await findParts(find.dataset.findParts);
    return;
  }
  const remove = target.closest("[data-remove-stash]");
  if (remove) {
    try {
      await call(api.removeStash(remove.dataset.removeStash));
      if (state.replaceItem?.id === remove.dataset.removeStash) state.replaceItem = null;
      state.itemPhotos.delete(remove.dataset.removeStash);
      await refreshStash();
      toast("Removed from the stash.");
    } catch (err) {
      toast(err.message, "error");
    }
    return;
  }
  const attach = target.closest("[data-attach]");
  if (attach) {
    await attachPhoto(attach.dataset.attach);
    return;
  }
  const mark = target.closest("[data-mark-replaced]");
  if (mark) {
    try {
      await call(api.markStash(mark.dataset.markReplaced, "replaced"));
      if (state.replaceItem?.id === mark.dataset.markReplaced) {
        state.replaceItem = null;
        state.market = null;
        state.marketKey = null;
      }
      await refreshStash();
      state.ledger = await call(api.ledger());
      renderAll();
      toast("Marked as replaced.");
    } catch (err) {
      toast(err.message, "error");
    }
  }
}

async function onNotesBlur(event) {
  const box = event.target.closest("[data-notes]");
  if (!box) return;
  try {
    await call(api.updateStash(box.dataset.notes, { notes: box.value }));
  } catch {
    /* a note is a convenience; do not interrupt the user */
  }
}

/* ---------------- scanning ---------------- */

async function doLocalScan(demo = false) {
  const btn = $("#scanLocalBtn");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Reading hardware…";
  try {
    const data = await call(api.scan(demo));
    state.view = data;
    state.candidates = await call(api.stashCandidates(data.device.id));
    state.ledger = await call(api.ledger());
    await refreshDevices();
    renderAll();
    switchTab("scan");
    toast(t("toast.checkDone"));
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function doUsbScan() {
  const btn = $("#scanUsbBtn");
  btn.disabled = true;
  btn.textContent = "Scanning…";
  try {
    state.usb = await call(api.scanConnected());
    renderScan();
    toast(`${state.usb.devices.length} connected device${state.usb.devices.length === 1 ? "" : "s"} found.`);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = t("scan.usb");
  }
}

async function doLanScan() {
  const btn = $("#scanLanBtn");
  btn.disabled = true;
  btn.textContent = "Scanning LAN…";
  try {
    state.lan = await call(api.scanLan());
    renderScan();
    toast(`${state.lan.devices.length} LAN device${state.lan.devices.length === 1 ? "" : "s"} found.`);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = t("scan.lan");
  }
}

async function refreshDevices() {
  state.devices = await call(api.devices());
  renderSidebar();
  if (!state.view && state.devices.length) {
    await loadDevice(state.devices[0].id);
  }
}

async function loadDevice(id) {
  try {
    const view = await call(api.view(id));
    if (!view) return;
    state.view = view;
    state.candidates = await call(api.stashCandidates(id));
    renderAll();
    renderSidebar();
    if (state.tab === "replace") loadMarket();
  } catch (err) {
    toast(err.message, "error");
  }
}

/* ---------------- stash ---------------- */

async function refreshStash() {
  state.stash = await call(api.stashList());
  renderSidebar();
  renderStashLists();
  renderRecycleSummary();
  state.ledger = await call(api.ledger());
  renderLedger();
  await loadStashPhotos();
}

function renderStashLists() {
  renderReplace();
  renderRecycle();
}

async function loadStashPhotos() {
  const missing = state.stash.filter((i) => i.photoFile && !state.itemPhotos.has(i.id));
  if (!missing.length) return;
  await Promise.all(
    missing.map(async (item) => {
      try {
        const res = await call(api.stashPhoto(item.id));
        if (res?.dataUrl) state.itemPhotos.set(item.id, res.dataUrl);
      } catch {
        /* photo unavailable; keep the placeholder */
      }
    }),
  );
  renderStashLists();
}

async function stashCandidate(baseKey, kind) {
  const candidate = state.candidates.find((c) => c.key === `${baseKey}:${kind}`);
  if (!candidate) return;
  const existing = state.stash.find(
    (i) =>
      i.kind === kind &&
      i.status === "stashed" &&
      i.deviceId === (state.view?.device.id ?? null) &&
      i.title === candidate.title &&
      i.category === candidate.category,
  );
  if (existing) {
    toast("Already in the stash.");
    return;
  }
  try {
    await call(
      api.addStash({
        kind,
        source: "local",
        title: candidate.title,
        category: candidate.category,
        detail: candidate.detail,
        deviceId: state.view?.device.id ?? null,
        serialHash: state.view?.device.serialHash ?? null,
        deviceClass: state.view?.device.class ?? null,
        marketCategory: candidate.marketCategory,
        requirements: candidate.requirements,
        impact: candidate.impact,
      }),
    );
    await refreshStash();
    toast(kind === "recycle" ? "Added to the recycle stash." : "Added to the replacement stash.");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function stashDiscovery(id, kind) {
  const all = [...(state.usb?.devices ?? []), ...(state.lan?.devices ?? [])];
  const device = all.find((d) => d.id === id);
  if (!device) return;
  const existing = state.stash.find(
    (i) => i.kind === kind && i.status === "stashed" && i.title === device.title && i.source === device.source,
  );
  if (existing) {
    toast("Already in the stash.");
    return;
  }
  try {
    await call(
      api.addStash({
        kind,
        source: device.source,
        title: device.title,
        category: device.category,
        detail: device.detail,
        serialHash: device.serialHash,
        marketCategory: ["ssd", "hdd", "ram", "battery", "charger", "cooling", "gpu", "laptop", "desktop"].includes(device.category)
          ? device.category
          : null,
      }),
    );
    await refreshStash();
    toast(kind === "recycle" ? "Added to the recycle stash." : "Added to the replacement stash.");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function attachPhoto(id) {
  try {
    const item = await call(api.pickStashPhoto(id));
    if (!item) return;
    const res = await call(api.stashPhoto(id));
    if (res?.dataUrl) state.itemPhotos.set(id, res.dataUrl);
    await refreshStash();
    toast("Photo attached.");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function findParts(id) {
  const item = state.stash.find((i) => i.id === id);
  if (!item) return;
  state.replaceItem = item;
  state.aiFilters = null;
  state.aiEngine = null;
  $("#mSearch").value = "";
  $("#mCondition").value = "all";
  $("#mMax").value = "";
  $("#mCategory").value = item.marketCategory ?? "all";
  await loadMarket(true);
  switchTab("replace");
  renderReplaceTarget();
  setTimeout(() => $("#replaceTarget").scrollIntoView({ behavior: "smooth", block: "start" }), 50);
}

async function useListing(listingId) {
  if (!state.replaceItem) {
    toast("Choose a replacement item first.", "error");
    return;
  }
  const listing = state.market?.listings.find((l) => l.id === listingId);
  if (!listing) return;
  try {
    await call(
      api.markStash(state.replaceItem.id, "replaced", {
        listingId: listing.id,
        title: listing.title,
        priceJod: listing.priceJod,
        url: listing.url,
      }),
    );
    state.replaceItem = null;
    state.market = null;
    state.marketKey = null;
    await refreshStash();
    state.ledger = await call(api.ledger());
    renderAll();
    if (state.tab === "replace") await loadMarket(true);
    toast("Replacement logged.");
  } catch (err) {
    toast(err.message, "error");
  }
}

/* ---------------- rendering ---------------- */

function renderAll() {
  renderSidebar();
  renderHeader();
  renderScan();
  renderReplace();
  renderRecycle();
  renderLedger();
  renderPrices();
  renderRecyclers();
  renderPassport();
  renderReplaceTarget();
  renderMarket();
}

function renderSidebar() {
  const activeRecycle = state.stash.filter((i) => i.kind === "recycle" && i.status === "stashed").length;
  const activeReplace = state.stash.filter((i) => i.kind === "replace" && i.status === "stashed").length;
  $("#stashSummary").innerHTML = `
    <button class="stash-pill" data-goto="recycle"><strong>${activeRecycle}</strong> to recycle</button>
    <button class="stash-pill" data-goto="replace"><strong>${activeReplace}</strong> to replace</button>`;

  const list = $("#deviceList");
  if (!state.devices.length) {
    list.innerHTML = '<p class="tiny">No devices scanned yet.</p>';
    return;
  }
  list.innerHTML = state.devices
    .map(
      (d) => `
      <button class="device ${state.view?.device.id === d.id ? "active" : ""}" data-device="${esc(d.id)}">
        <span class="name">${esc(d.name)}</span>
        <span class="sub">${esc(d.platform || d.class)} · ${new Date(d.lastSeenAt).toLocaleDateString()}</span>
      </button>`,
    )
    .join("");
}

function renderHeader() {
  const [title, meta] = TAB_META[state.tab] ?? TAB_META.scan;
  $("#pageTitle").textContent = title;
  $("#pageMeta").textContent = meta;

  const score = state.view?.diagnostic?.health.overall ?? null;
  const pill = $("#healthPill");
  if (score === null) {
    pill.classList.add("hidden");
  } else {
    const st = statusFor(score);
    pill.className = `pill ${st}`;
    pill.textContent = t("overview.healthPill", { score, status: t("overview." + st) });
  }
  $("#demoBanner").classList.toggle("hidden", !state.view?.diagnostic?.demo);
}

function renderScan() {
  const box = $("#localResult");
  if (!state.view) {
    box.innerHTML = `
      <div class="card empty-inline">
        <h2>Start with this machine</h2>
        <p class="muted small">Scan the PC to see its battery, drives, memory and cooling. Every part is offered as a recycle or replace action.</p>
      </div>`;
  } else {
    const { device, diagnostic } = state.view;
    const overall = diagnostic?.health.overall;
    const groups = groupCandidates(state.candidates);
    box.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h2>${esc(device.name)}</h2>
          <span class="pill ${statusFor(overall)}">${overall ?? "?"}/100</span>
        </div>
        <p class="muted small">${esc([device.class, device.brand, device.model, device.platform].filter(Boolean).join(" · "))}${
          diagnostic?.demo ? " · <strong>demo data</strong>" : ""
        }</p>
        <div class="candidate-list">
          ${groups
            .map(
              (g) => `
            <div class="candidate">
              <div>
                <strong>${esc(g.title)}</strong>
                <div class="muted small">${esc(g.detail)}</div>
              </div>
              <div class="candidate-actions">
                ${g.kinds.includes("recycle") ? `<button class="ghost mini" data-candidate="${esc(g.key)}" data-kind="recycle">Recycle</button>` : ""}
                ${g.kinds.includes("replace") ? `<button class="primary mini" data-candidate="${esc(g.key)}" data-kind="replace">Replace</button>` : ""}
              </div>
            </div>`,
            )
            .join("")}
        </div>
      </div>`;
  }

  renderDiscovery("usbResults", "usbNotes", state.usb, "No removable drives or USB peripherals found.");
  renderDiscovery("lanResults", "lanNotes", state.lan, "No other devices answered on the local network.");
}

function groupCandidates(candidates) {
  const map = new Map();
  for (const c of candidates) {
    const base = c.key.replace(/:(recycle|replace)$/, "");
    if (!map.has(base)) map.set(base, { key: base, title: c.title, detail: c.detail, kinds: [] });
    map.get(base).kinds.push(c.kind);
  }
  return [...map.values()];
}

function renderDiscovery(resultsId, notesId, discovery, emptyText) {
  const box = document.getElementById(resultsId);
  const notes = document.getElementById(notesId);
  if (!box) return;
  if (!discovery) {
    box.innerHTML = '<p class="muted small">Not scanned yet.</p>';
    if (notes) notes.textContent = "";
    return;
  }
  box.innerHTML = discovery.devices.length
    ? discovery.devices
        .map(
          (d) => `
      <div class="candidate">
        <div>
          <strong>${esc(d.title)}</strong>
          <div class="muted small">${esc(d.detail)}</div>
        </div>
        <div class="candidate-actions">
          <button class="ghost mini" data-discovery="${esc(d.id)}" data-kind="recycle">Recycle</button>
          <button class="primary mini" data-discovery="${esc(d.id)}" data-kind="replace">Replace</button>
        </div>
      </div>`,
        )
        .join("")
    : `<p class="muted small">${esc(emptyText)}</p>`;
  if (notes) notes.textContent = discovery.notes.join(" ");
}

function renderReplace() {
  const items = state.stash.filter((i) => i.kind === "replace");
  const active = items.filter((i) => i.status === "stashed").length;
  $("#replaceCount").textContent = `${active} active · ${items.length} logged`;
  $("#replaceList").innerHTML = items.length
    ? items.map(stashItemCard).join("")
    : `<p class="muted small">Nothing here yet. Stash a part from a scan, or add one above.</p>`;
  renderReplaceTarget();
}

function renderRecycle() {
  const items = state.stash.filter((i) => i.kind === "recycle");
  const active = items.filter((i) => i.status === "stashed").length;
  $("#recycleCount").textContent = `${active} active · ${items.length} logged`;
  $("#recycleList").innerHTML = items.length
    ? items.map(stashItemCard).join("")
    : `<p class="muted small">Nothing here yet. Stash something from a scan, or add it above.</p>`;
  renderRecycleSummary();
  renderDestruction();
}

function stashItemCard(item) {
  const photo = state.itemPhotos.get(item.id);
  const bits = [item.category, `qty ${item.quantity}`];
  if (item.impact.kgDiverted) bits.push(kg(item.impact.kgDiverted));
  if (item.impact.co2eAvoidedKg) bits.push(`${money(item.impact.co2eAvoidedKg)} kg CO2e`);
  const replaced = item.replacedWith
    ? `<div class="stash-replaced">Replaced with <a href="${esc(item.replacedWith.url)}" target="_blank" rel="noreferrer">${esc(item.replacedWith.title)}</a> · ${money(item.replacedWith.priceJod)} JOD</div>`
    : "";
  return `
    <article class="stash-item ${esc(item.status)}">
      <div class="stash-thumb">${photo ? `<img src="${photo}" alt="">` : `<span>${esc(item.category.slice(0, 2).toUpperCase())}</span>`}</div>
      <div class="stash-main">
        <div class="stash-head">
          <strong>${esc(item.title)}</strong>
          <span class="badge ${item.status === "recycled" ? "mint" : item.status === "replaced" ? "blue" : "sand"}">${statusLabel(item.status)}</span>
          <span class="badge">${sourceLabel(item.source)}</span>
        </div>
        ${item.detail ? `<div class="muted small">${esc(item.detail)}</div>` : ""}
        <div class="muted small">${esc(bits.join(" · "))} · ${new Date(item.createdAt).toLocaleDateString()}</div>
        ${replaced}
        <textarea class="stash-notes" data-notes="${esc(item.id)}" rows="1" placeholder="Notes…">${esc(item.notes)}</textarea>
      </div>
      <div class="stash-actions">
        ${
          item.status === "stashed" && item.kind === "recycle"
            ? `<button class="ghost mini" data-attach="${esc(item.id)}">${photo ? "Change photo" : "Attach photo"}</button>`
            : ""
        }
        ${
          item.status === "stashed" && item.kind === "replace"
            ? `<button class="primary mini" data-find-parts="${esc(item.id)}">Find parts</button>
               <button class="ghost mini" data-mark-replaced="${esc(item.id)}">Mark replaced</button>`
            : ""
        }
        <button class="ghost mini" data-remove-stash="${esc(item.id)}">${item.status === "stashed" ? "Remove" : "Delete"}</button>
      </div>
    </article>`;
}

function renderRecycleSummary() {
  const active = state.stash.filter((i) => i.kind === "recycle" && i.status === "stashed");
  const totals = active.reduce(
    (acc, i) => ({
      items: acc.items + i.quantity,
      kg: acc.kg + i.impact.kgDiverted,
      co2e: acc.co2e + i.impact.co2eAvoidedKg,
      materials: [...acc.materials, ...i.impact.materials],
    }),
    { items: 0, kg: 0, co2e: 0, materials: [] },
  );
  const materials = mergeMaterials(totals.materials);

  const select = $("#recyclerSelect");
  if (select) {
    const current = select.value;
    select.innerHTML = state.recyclers
      .map((r) => `<option value="${esc(r.id)}">${esc(r.name)} · ${esc(r.city)}${r.pickup ? " · pickup" : ""}</option>`)
      .join("");
    if (current && state.recyclers.some((r) => r.id === current)) select.value = current;
  }

  $("#recycleSummary").innerHTML = `
    <div class="manifest-stats">
      <div class="stat"><div class="value">${totals.items}</div><div class="k">items</div></div>
      <div class="stat"><div class="value">${money(totals.kg)}<span class="unit">kg</span></div><div class="k">diverted</div></div>
      <div class="stat"><div class="value">${money(totals.co2e)}<span class="unit">kg</span></div><div class="k">CO2e avoided</div></div>
    </div>
    <div class="chips">${
      materials.length
        ? materials.map((m) => `<span class="chip">${esc(m.name)} · ${money(m.grams)} g</span>`).join("")
        : `<span class="muted small">Material estimates appear when items are added.</span>`
    }</div>`;

  const ready = Boolean(active.length && select?.value);
  $("#generateRecyclePdf").disabled = !ready;
  $("#emailRecycler").disabled = !select?.value;
}

function renderDestruction() {
  const box = $("#destructionBox");
  if (!box) return;
  box.innerHTML = state.view?.diagnostic ? destructionBlock() : `<p class="muted small">Scan this PC to see disk-specific wipe commands.</p>`;
}

function destructionBlock() {
  const diagnostic = state.view?.diagnostic;
  if (!diagnostic) return "";
  const disks = (diagnostic.disks ?? []).slice(0, 2);
  const commands = disks
    .map((disk) => {
      const cmd = /nvme/i.test(disk.transport)
        ? `sudo nvme sanitize /dev/${disk.name} -a 2`
        : disk.rotational
          ? `sudo shred -v -n 1 /dev/${disk.name}`
          : `sudo hdparm --user-master u --security-set-pass p /dev/${disk.name} && sudo hdparm --user-master u --security-erase p /dev/${disk.name}`;
      return `<div class="wipe-cmd"><span class="muted small">${esc(disk.model)} · /dev/${esc(disk.name)}</span><code>${esc(cmd)}</code></div>`;
    })
    .join("");

  return `<div class="market-picks" style="margin-top:0">
    <p class="muted small" style="margin:4px 0">${t("recycle.destroyBackup")}</p>
    ${commands}
    <p class="muted small" style="margin:6px 0 0">${t("recycle.destroyPhysical")}</p>
    <button class="ghost mini" data-record-wipe="${esc(disks[0]?.name ?? "")}">${t("recycle.recordWipe")}</button>
  </div>`;
}

async function generateRecyclePdf() {
  const recyclerId = $("#recyclerSelect").value;
  if (!recyclerId) return;
  const btn = $("#generateRecyclePdf");
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Generating…";
  try {
    const res = await call(
      api.recyclePdf({
        recyclerId,
        note: $("#recycleNote").value,
        lang: window.I18N.lang,
      }),
    );
    if (!res.saved) {
      toast("Recycling manifest not saved.");
      return;
    }
    $("#recyclePdfResult").innerHTML = `Saved: <code>${esc(res.path)}</code> <button class="ghost mini" data-open-pdf="${esc(res.path)}">Open PDF</button>`;
    state.ledger = await call(api.ledger());
    await refreshStash();
    renderAll();
    toast(`Manifest saved for ${res.count} item${res.count === 1 ? "" : "s"}.`);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function emailRecycler() {
  const recyclerId = $("#recyclerSelect").value;
  if (!recyclerId) return;
  try {
    await call(api.emailRecycler(recyclerId));
    toast("Email opened. Attach the saved PDF before sending.");
  } catch (err) {
    toast(err.message, "error");
  }
}

function renderReplaceTarget() {
  const el = $("#replaceTarget");
  if (!state.replaceItem) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  const item = state.replaceItem;
  const bits = [item.category, item.detail].filter(Boolean).join(" · ");
  el.innerHTML = `
    <div>
      <div class="k muted small">Finding parts for</div>
      <strong>${esc(item.title)}</strong>
      <div class="muted small">${esc(bits)}</div>
    </div>
    <div class="target-actions">
      <button class="ghost mini" data-ai-target="1">AI compatible parts</button>
      <button class="ghost mini" data-clear-target="1">Clear</button>
    </div>`;
  el.classList.remove("hidden");
}

/* ---------------- market ---------------- */

function normText(input) {
  const digits = "٠١٢٣٤٥٦٧٨٩";
  return String(input ?? "")
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[٠-٩]/g, (d) => String(digits.indexOf(d)))
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, "")
    .toLowerCase();
}

function marketTarget() {
  return state.replaceItem ? { stashId: state.replaceItem.id } : state.view ? { deviceId: state.view.device.id } : {};
}

function marketKey() {
  return state.replaceItem ? `stash:${state.replaceItem.id}` : state.view ? `device:${state.view.device.id}` : "none";
}

async function runAiSearch(useTarget = false) {
  const query = useTarget
    ? [state.replaceItem?.title, state.replaceItem?.detail].filter(Boolean).join(" ")
    : $("#mSearch").value.trim();
  if (!query) return;
  const btn = $("#aiAsk");
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = t("ai.thinking");
  try {
    const res = await call(api.aiSearch(query, window.I18N.lang));
    state.aiFilters = res.filters;
    state.aiEngine = res;
    if (res.filters.category) $("#mCategory").value = res.filters.category;
    if (res.filters.condition) $("#mCondition").value = res.filters.condition;
    if (res.filters.maxPriceJod) $("#mMax").value = res.filters.maxPriceJod;
    $("#mSearch").value = "";
    renderMarket();
    toast(res.engine === "local-model" ? t("ai.model", { model: res.model }) : t("ai.fallback"));
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function loadMarket(force = false) {
  const key = marketKey();
  if (!force && state.market && state.marketKey === key) {
    renderMarket();
    return;
  }
  try {
    state.market = await call(api.market(marketTarget()));
    state.marketKey = key;
    renderMarket();
  } catch (err) {
    toast(err.message, "error");
  }
}

function bucketLabel(b) {
  const map = {
    "Used laptop": "bucket.usedLaptop",
    "New laptop": "bucket.newLaptop",
    "Laptop charger (mixed wattage)": "bucket.laptopCharger",
    "Thermal paste": "bucket.paste",
    "Cooling fan": "bucket.fan",
    "Desktop / mini PC": "bucket.desktop",
    "Used desktop / mini PC": "bucket.usedDesktop",
    "Graphics card": "bucket.gpu",
    "Laptop battery": "bucket.battery",
  };
  if (map[b.label]) return t(map[b.label]);
  const charger = /^Charger (\d+) W$/.exec(b.label);
  if (charger) return t("bucket.chargerW", { w: charger[1] });
  return b.label;
}

function bucketCard(b) {
  return `
    <div class="bucket">
      <div class="bucket-label">${esc(bucketLabel(b))}</div>
      <div class="bucket-price">${money(b.median)} <small>JOD</small></div>
      <div class="muted small">P25–P75 ${money(b.p25)}–${money(b.p75)} · n=${b.n}</div>
    </div>`;
}

function listingRow(l) {
  const arabic = (l.title.match(/[\u0600-\u06FF]/g) ?? []).length;
  const rtl = arabic > 0 && arabic / Math.max(1, l.title.length) > 0.3;
  const compatClass = l.compatibility.status === "compatible" ? "mint" : l.compatibility.status === "incompatible" ? "red" : "sand";
  const compatLabel =
    l.compatibility.status === "compatible"
      ? t("market.compatible")
      : l.compatibility.status === "incompatible"
        ? t("market.incompatible")
        : t("market.check");

  return `
    <div class="listing">
      <div class="listing-main">
        <div class="listing-title ${rtl ? "rtl" : ""}" ${rtl ? 'lang="ar" dir="rtl"' : ""}>${esc(l.title)}</div>
        <div class="chips">
          ${l.tags.map((tag) => `<span class="chip">${esc(tag)}</span>`).join("")}
          ${l.outlier ? `<span class="badge red">${t("market.outlier")}</span>` : ""}
        </div>
        <div class="muted small">${esc(l.area || "Jordan")} · ${esc(l.condition === "new" || l.condition === "used" ? t("market." + l.condition) : l.condition)} · ${esc(t("conf." + l.confidence))}</div>
        <details>
          <summary>${t("market.why", { status: compatLabel })}</summary>
          <ul>${l.compatibility.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
        </details>
      </div>
      <div class="listing-side">
        <div class="price">${money(l.priceJod)} <small>JOD</small></div>
        <span class="badge ${compatClass}">${compatLabel}</span>
        ${
          state.photos.has(l.id)
            ? `<button class="thumb" data-view-photo="${esc(l.id)}" title="${t("market.viewPhoto")}"><img src="${state.photos.get(l.id)}" alt="Listing photo" /></button>`
            : ""
        }
        ${l.imageUrl ? `<button class="ghost mini" data-view-photo="${esc(l.id)}">${t("market.viewPhoto")}</button>` : ""}
        ${state.replaceItem ? `<button class="primary mini" data-use-listing="${esc(l.id)}">Use this part</button>` : ""}
        <a href="${esc(l.url)}" target="_blank" rel="noreferrer">${t("market.open")}</a>
      </div>
    </div>`;
}

function renderAiChips() {
  const el = $("#aiChips");
  if (!el) return;
  const ai = state.aiFilters;
  if (!ai) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  const bits = [
    ai.category,
    ai.ramGen,
    ai.formFactor,
    ai.minCapacityGb ? `${ai.minCapacityGb} GB+` : null,
    ai.maxPriceJod ? `≤ ${ai.maxPriceJod} JOD` : null,
    ai.condition,
  ].filter(Boolean);
  const engine = state.aiEngine?.engine === "local-model" ? state.aiEngine.model : "keywords";
  el.innerHTML = `<span class="badge blue">${esc(engine)}</span> ${bits
    .map((b) => `<span class="chip">${esc(b)}</span>`)
    .join("")} <button class="ghost mini" data-ai-clear>${t("ai.clear")}</button>`;
  el.classList.remove("hidden");
}

function renderMarket() {
  const market = state.market;
  if (!market) {
    $("#marketMeta").textContent = "Loading…";
    return;
  }

  const compatCount = market.listings.filter((l) => l.compatibility.status === "compatible").length;
  $("#marketMeta").textContent = t("market.meta", {
    count: market.count,
    compat: compatCount,
    date: market.updatedAt ?? "—",
    outliers: market.outliers,
  });

  const req = market.requirements;
  const wholeDevice = state.replaceItem && ["laptop", "desktop", "other"].includes(state.replaceItem.category);
  const targetBits = req ? [req.ramGen, req.ramForm, req.storageBus, req.storageForm].filter(Boolean).join(" · ") : "";
  $("#marketCompat").textContent = wholeDevice
    ? "Whole device — compare CPU, RAM and storage; part compatibility does not apply."
    : state.replaceItem
      ? t("market.compatTarget", { target: targetBits || state.replaceItem.title })
      : req
        ? t("market.compatTarget", { target: targetBits || "—" })
        : t("market.noDevice");

  const q = normText($("#mSearch").value);
  const category = $("#mCategory").value;
  const counts = new Map();
  for (const listing of market.listings) counts.set(listing.category, (counts.get(listing.category) ?? 0) + 1);
  const ordered = ["ram", "ssd", "hdd", "battery", "charger", "cooling", "gpu", "laptop", "desktop"];
  const chips = [
    `<button class="cat-chip ${category === "all" ? "active" : ""}" data-cat="all">${t("market.all")} <span class="n">${market.count}</span></button>`,
    ...ordered
      .filter((key) => counts.get(key))
      .map(
        (key) =>
          `<button class="cat-chip ${category === key ? "active" : ""}" data-cat="${key}">${t("cat." + key)} <span class="n">${counts.get(key)}</span></button>`,
      ),
  ];
  $("#marketCats").innerHTML = chips.join("");

  const condition = $("#mCondition").value;
  const max = Number($("#mMax").value) || Infinity;
  const hideIncompatible = $("#mCompatible").checked;
  const partsOnly = $("#mPartsOnly").checked;
  const showOutliers = $("#mOutliers").checked;

  const matchingAll = market.listings
    .filter((l) => {
      if (partsOnly) {
        if (["other", "keyboard"].includes(l.category)) return false;
        if (["small", "converter", "external"].includes(l.variant ?? "")) return false;
      }
      if (category !== "all" && l.category !== category) return false;
      if (condition !== "all" && l.condition !== condition) return false;
      if (l.priceJod > max) return false;
      if (q && !normText(`${l.title} ${l.tags.join(" ")} ${l.oqCategory} ${l.brand ?? ""}`).includes(q)) return false;

      const ai = state.aiFilters;
      if (ai) {
        if (ai.ramGen && (l.ramGen ?? "") !== ai.ramGen) return false;
        if (ai.formFactor && (l.formFactor ?? "") !== ai.formFactor) return false;
        if (ai.minCapacityGb && (l.capacityGb ?? 0) < ai.minCapacityGb) return false;
        const hasSpec = Boolean(ai.ramGen || ai.formFactor || ai.minCapacityGb);
        if (!hasSpec && ai.keywords?.length) {
          const hay = normText(`${l.title} ${l.tags.join(" ")} ${l.brand ?? ""}`);
          if (!ai.keywords.some((k) => hay.includes(normText(k)))) return false;
        }
      }
      return true;
    })
    .sort((a, b) => {
      const rank = { compatible: 0, check: 1, incompatible: 2 };
      return (
        rank[a.compatibility.status] - rank[b.compatibility.status] ||
        a.category.localeCompare(b.category) ||
        a.priceJod - b.priceJod
      );
    });

  const hiddenOutliers = showOutliers ? 0 : matchingAll.filter((l) => l.outlier).length;
  const withoutOutliers = showOutliers ? matchingAll : matchingAll.filter((l) => !l.outlier);
  const hiddenIncompatible = hideIncompatible
    ? withoutOutliers.filter((l) => l.compatibility.status === "incompatible").length
    : 0;
  const filtered = hideIncompatible
    ? withoutOutliers.filter((l) => l.compatibility.status !== "incompatible")
    : withoutOutliers;

  const buckets = market.buckets.filter((b) => category === "all" || b.category === category).slice(0, 8);
  $("#marketBuckets").innerHTML = buckets.length
    ? buckets.map(bucketCard).join("")
    : `<p class="muted small">${t("market.noBuckets")}</p>`;

  const hiddenNotes = [
    hiddenOutliers ? t("market.hiddenOutliers", { n: hiddenOutliers }) : "",
    hiddenIncompatible ? t("market.hiddenIncompatible", { n: hiddenIncompatible }) : "",
  ].filter(Boolean);
  $("#mCount").textContent = hiddenNotes.length
    ? `${t("market.shown", { n: filtered.length })} · ${hiddenNotes.join(" · ")}`
    : t("market.shown", { n: filtered.length });

  const emptyHints = [
    hiddenOutliers ? t("market.noMatchOutliers", { n: hiddenOutliers }) : "",
    hiddenIncompatible ? t("market.noMatchIncompatible", { n: hiddenIncompatible }) : "",
  ].filter(Boolean);

  renderAiChips();
  const aiNote = $("#aiNote");
  if (aiNote) {
    aiNote.textContent = state.aiStatus?.available
      ? t("ai.noteModel", { model: state.aiStatus.model })
      : t("ai.noteKeywords");
  }
  $("#marketList").innerHTML = filtered.length
    ? filtered.slice(0, 150).map(listingRow).join("")
    : `<p class="muted small">${t("market.noMatch")}${state.aiFilters ? " " + t("market.aiEmpty") : ""}${
        emptyHints.length ? " " + emptyHints.join(" ") : ""
      }</p>`;
}

async function openPhoto(listingId) {
  const listing = state.market?.listings.find((l) => l.id === listingId);
  const modal = $("#photoModal");
  $("#photoImg").src = "";
  $("#photoTitle").textContent = listing?.title ?? "";
  $("#photoPrice").textContent = listing ? `${money(listing.priceJod)} JOD` : "";
  $("#photoArea").textContent = listing?.area ?? "";
  $("#photoLink").href = listing?.url ?? "#";
  modal.classList.remove("hidden");

  const cached = state.photos.get(listingId);
  if (cached) {
    $("#photoImg").src = cached;
    return;
  }

  $("#photoPrice").textContent = t("market.loadingPhoto");
  try {
    const image = await call(api.listingImage(listingId));
    state.photos.set(listingId, image.dataUrl);
    $("#photoImg").src = image.dataUrl;
    $("#photoPrice").textContent = listing ? `${money(listing.priceJod)} JOD` : "";
    renderMarket();
  } catch (err) {
    toast(err.message, "error");
    closePhoto();
  }
}

function closePhoto() {
  $("#photoModal").classList.add("hidden");
  $("#photoImg").src = "";
}

/* ---------------- impact, prices, recyclers, passport ---------------- */

function renderLedger() {
  const l = state.ledger;
  if (!l) return;
  $("#ledgerStats").innerHTML = `
    <div class="stat"><div class="value">${l.stashedRecycle ?? 0}</div><div class="k">to recycle</div></div>
    <div class="stat"><div class="value">${l.stashedReplace ?? 0}</div><div class="k">to replace</div></div>
    <div class="stat"><div class="value">${money(l.kgDiverted)}<span class="unit">kg</span></div><div class="k">diverted</div></div>
    <div class="stat"><div class="value">${money(l.co2eAvoidedKg)}<span class="unit">kg</span></div><div class="k">CO2e avoided</div></div>`;

  const mats = (l.materials ?? []).filter((m) => m.grams > 0);
  $("#ledgerMaterials").innerHTML = mats.length
    ? mats.map((m) => `<span class="chip">${esc(m.name)} · ${money(m.grams)} g</span>`).join("")
    : `<span class="muted small">${t("impact.empty")}</span>`;
}

function renderPrices() {
  $("#priceTable").innerHTML = state.prices
    .map((p) => {
      const unit = p.unit && p.unit !== "each" ? ` / ${esc(p.unit)}` : "";
      const kindClass = p.kind === "retail" ? "mint" : p.kind === "used" ? "sand" : p.kind === "estimate" ? "red" : "blue";
      const label = p.vendor || p.source;
      const source = p.url
        ? `<a href="${esc(p.url)}" target="_blank" rel="noreferrer">${esc(label)}</a>`
        : esc(label);
      return `
      <tr>
        <td>${esc(p.item)}</td>
        <td>${esc(p.spec)}</td>
        <td>${money(p.low) === money(p.high) ? `${money(p.low)} ${esc(p.currency)}` : `${money(p.low)}–${money(p.high)} ${esc(p.currency)}`}${unit}</td>
        <td><span class="badge ${kindClass}">${esc(t("kind." + p.kind))}</span></td>
        <td>${source}<br>${esc(p.sourceDate)}</td>
      </tr>`;
    })
    .join("");
}

function renderRecyclers() {
  const list = $("#recyclerList");
  if (!list) return;
  const count = $("#recyclerCount");
  if (count) count.textContent = `Jordan · ${state.recyclers.length} recycler${state.recyclers.length === 1 ? "" : "s"} · contact details from their sites`;
  list.innerHTML = state.recyclers
    .map(
      (r) => `
      <article class="remedy recommended">
        <div class="remedy-head">
          <div>
            <div class="badges">
              <span class="badge mint">${t("recycle.verified")}</span>
              <span class="badge">${esc(r.city)}</span>
              <span class="badge blue">${t("recycle.recycler")}</span>
            </div>
            <h3>${esc(r.name)}</h3>
          </div>
        </div>
        <p class="desc">${esc(r.address)}<br>${esc(r.hours)}</p>
        <div class="metrics" style="grid-template-columns:1fr 1fr">
          <div class="metric">
            <div class="k">${t("recycle.phone")}</div>
            <div class="v" style="font-size:12.5px;line-height:1.8">
              ${r.phones
                .map(
                  (p) =>
                    `${esc(p.number)} <span class="badge ${p.type === "mobile" ? "mint" : ""}" style="font-size:9.5px;padding:1px 6px">${p.type === "mobile" ? t("recycle.mobile") : t("recycle.landline")}</span>`,
                )
                .join("<br>")}
            </div>
          </div>
          <div class="metric"><div class="k">${t("recycle.email")}</div><div class="v" style="font-size:12.5px">${esc(r.email)}</div></div>
        </div>
        ${
          r.process && r.process.length
            ? `<div class="card" style="background:var(--panel-2);margin:12px 0;padding:12px 14px">
                 <div class="k muted small" style="margin-bottom:6px">${r.pickup ? t("recycle.pickup") : t("recycle.pickupPlain")}</div>
                 <ol class="hints" style="padding-left:18px;margin:0">
                   ${r.process.map((step) => `<li>${esc(step)}</li>`).join("")}
                 </ol>
               </div>`
            : ""
        }
        <div class="k muted small" style="margin-bottom:6px">${t("recycle.accepts")}</div>
        <div class="chips">${r.accepts.map((a) => `<span class="chip">${esc(a)}</span>`).join("")}</div>
        <details>
          <summary>${t("recycle.services")}</summary>
          <ul>${r.services.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
        </details>
        <p class="muted small">${esc(r.notes)}</p>
        <div class="foot">
          <span class="muted small">${t("recycle.source")} <a href="${esc(r.sourceUrl)}" target="_blank" rel="noreferrer">${esc(r.sourceUrl)}</a></span>
          <a class="ghost" href="${esc(r.contactUrl)}" target="_blank" rel="noreferrer" style="text-decoration:none">${t("recycle.contact")}</a>
        </div>
      </article>`,
    )
    .join("");
}

function renderPassport() {
  const box = $("#passportBox");
  if (!box) return;
  const { device, diagnostic, wipe, actions } = state.view || {};
  if (!device) {
    box.innerHTML = `<p class="muted small">${t("passport.needCheck")}</p>`;
    return;
  }

  const wipeHtml = wipe
    ? `<div class="wipe-box">
         <strong>${t("passport.wipeRecorded")}</strong><br>
         ${esc(wipe.method)} · ${esc(wipe.disk)} · ${new Date(wipe.claimedAt).toLocaleString()}<br>
         <span class="hash">nonce ${esc(wipe.nonceHash)}</span>
         <p class="muted small">${esc(wipe.note)}</p>
       </div>`
    : `<div class="wipe-box">${t("passport.noWipeYet")}</div>`;
  $("#wipeBox").innerHTML = wipeHtml;

  if (!state.passport) {
    box.innerHTML = `<p class="muted small">${actions?.length ? t("passport.ready") : t("passport.needDecision")}</p>`;
    return;
  }

  const p = state.passport.passport;
  box.innerHTML = `
    <div class="passport-grid">
      <div class="qr"><img src="${state.passport.qr}" alt="Passport QR" /></div>
      <div>
        <div class="badges">
          <span class="badge mint">${t("passport.health", { score: p.health.overall ?? "?" })}</span>
          <span class="badge sand">${money(p.impact.co2eAvoidedKg)} kg CO₂e</span>
          <span class="badge">${money(p.impact.kgDiverted)} kg diverted</span>
          ${p.wipe ? `<span class="badge blue">${t("passport.wiped")}</span>` : `<span class="badge red">${t("passport.noWipe")}</span>`}
        </div>
        <p class="small"><strong>${esc(p.device.name)}</strong><br><span class="muted">${esc(p.health.storage)}</span></p>
        <p class="muted small">${t("passport.issued", { date: new Date(p.issuedAt).toLocaleString() })}</p>
        <div class="chips">${p.impact.materials.map((m) => `<span class="chip">${esc(m.name)} ${money(m.grams)} g</span>`).join("")}</div>
        <p class="hash">sha256 ${esc(p.hash)}</p>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="ghost" id="verifyPassport">${t("passport.verify")}</button>
          <button class="ghost" id="downloadPassportPdf">${t("passport.downloadPdf")}</button>
        </div>
      </div>
    </div>`;
}

async function generatePassport() {
  if (!state.view) return;
  try {
    state.passport = await call(api.passport(state.view.device.id));
    renderPassport();
    toast(t("toast.passport"));
  } catch (err) {
    toast(err.message, "error");
  }
}

/* ---------------- tabs / language ---------------- */

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((el) => el.classList.toggle("active", el.dataset.tab === tab));
  document.querySelectorAll(".panel").forEach((el) => el.classList.toggle("hidden", el.id !== `panel-${tab}`));
  const main = document.querySelector("main");
  if (main) main.scrollTop = 0;
  renderHeader();
  if (tab === "replace") loadMarket();
  if (tab === "recycle") {
    renderRecycle();
  }
}

function applyLanguage() {
  window.I18N.applyStatic();
  const note = $("#partialNote");
  if (note) {
    note.textContent = window.I18N.lang === "ar" ? t("lang.partialNote") : "";
    note.classList.toggle("hidden", window.I18N.lang !== "ar");
  }
  renderAll();
}
