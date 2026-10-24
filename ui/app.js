/* Fahas renderer — no frameworks, no network calls, no node access. */
const api = window.fahas;

const state = {
  view: null,
  ledger: null,
  prices: [],
  info: null,
  passport: null,
  tab: "overview",
  recyclers: [],
  market: null,
  marketFor: null,
  ocrStatus: null,
};

const $ = (sel) => document.querySelector(sel);

const HIERARCHY = { 1: "Prevent", 2: "Repair / reuse", 3: "Parts reuse", 4: "Recycle", 5: "Replace" };
const SAFETY = { diy: "DIY-friendly", shop: "Needs a shop", licensed: "Licensed technician", never: "Do not attempt" };

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
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4200);
}

function statusFor(score) {
  if (score === null || score === undefined) return "unknown";
  if (score >= 80) return "good";
  if (score >= 60) return "fair";
  return "poor";
}

function money(n) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function range(low, high, unit) {
  if (!low && !high) return "no part cost";
  if (low === high) return `${money(low)} ${unit}`;
  return `${money(low)}–${money(high)} ${unit}`;
}

/* ---------------- boot ---------------- */

document.addEventListener("DOMContentLoaded", () => {
  if (!api) {
    document.body.innerHTML =
      '<div style="padding:40px;font-family:system-ui"><h2>Fahas must run as the desktop app.</h2><p>Launch it with <code>npm run dev</code> or the packaged AppImage / installer.</p></div>';
    return;
  }
  bind();
  boot();
});

async function boot() {
  try {
    state.info = await call(api.info());
    $("#infoLine").textContent = `v${state.info.version} · ${state.info.platform}/${state.info.arch}\n${state.info.dataDir}`;
    $("#infoLine").style.whiteSpace = "pre-line";

    state.prices = await call(api.prices());
    state.recyclers = await call(api.recyclers());
    try {
      state.ocrStatus = await call(api.ocrStatus());
    } catch {
      state.ocrStatus = null;
    }
    state.ledger = await call(api.ledger());
    renderPrices();
    renderRecyclers();
    renderLedger();

    await refreshDevices();
    if (!state.view) showEmpty(true);

    // Rehearsal shortcut: `FAHAS_DEMO=1 npm run dev` opens straight into a demo scan.
    if (new URLSearchParams(location.search).get("demo") === "1") {
      const toggle = $("#demoToggle");
      if (toggle) toggle.checked = true;
      await doScan();
    }
  } catch (err) {
    toast(err.message, "error");
  }
}

function bind() {
  $("#scanBtn").addEventListener("click", doScan);
  $("#emptyScan").addEventListener("click", doScan);

  $("#tabs").addEventListener("click", (event) => {
    const btn = event.target.closest(".tab");
    if (!btn) return;
    switchTab(btn.dataset.tab);
  });

  $("#deviceList").addEventListener("click", (event) => {
    const btn = event.target.closest(".device");
    if (btn) loadDevice(btn.dataset.id);
  });

  $("#marketList").addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-read-photo]");
    if (!btn || !state.view) return;
    btn.disabled = true;
    btn.textContent = "Reading…";
    try {
      await call(api.readPhoto(btn.dataset.readPhoto));
      state.market = await call(api.market(state.view.device.id));
      renderMarket();
      toast("Photo read locally. Check any conflicts with the seller's text.");
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "Read photo";
    }
  });

  $("#remedyList").addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-remedy]");
    if (!btn || !state.view) return;
    btn.disabled = true;
    try {
      await call(api.addAction(state.view.device.id, btn.dataset.remedy));
      state.ledger = await call(api.ledger());
      state.view = await call(api.view(state.view.device.id));
      renderAll();
      renderLedger();
      toast("Decision logged. The impact ledger is updated.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });

  $("#actionList").addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-remove-action]");
    if (!btn || !state.view) return;
    try {
      await call(api.removeAction(btn.dataset.removeAction));
      state.ledger = await call(api.ledger());
      state.view = await call(api.view(state.view.device.id));
      renderAll();
      renderLedger();
      toast("Entry removed.");
    } catch (err) {
      toast(err.message, "error");
    }
  });

  $("#passportBtn").addEventListener("click", generatePassport);

  $("#passportBox").addEventListener("click", async (event) => {
    if (event.target.closest("#downloadPassport") && state.passport) {
      const blob = new Blob([JSON.stringify(state.passport.passport, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `fahas-passport-${(state.view?.device.name || "device").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    }
    if (event.target.closest("#verifyPassport") && state.passport) {
      try {
        const res = await call(api.verifyPassport(state.passport.passport));
        toast(res.valid ? "Passport hash verified — the record is unchanged." : "Hash mismatch: the record was altered.", res.valid ? "ok" : "error");
      } catch (err) {
        toast(err.message, "error");
      }
    }
  });

  ["mSearch", "mCategory", "mCondition", "mMax", "mCompatible", "mPartsOnly", "mOutliers"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", renderMarket);
  });

  $("#mRefresh").addEventListener("click", async () => {
    const btn = $("#mRefresh");
    btn.disabled = true;
    btn.textContent = "Fetching public listings…";
    try {
      const res = await call(api.refreshMarket(state.view?.device.id));
      state.market = res.market;
      state.marketFor = state.view?.device.id ?? null;
      renderMarket();
      toast(
        res.fetched === 0
          ? "No listings returned — the existing snapshot is still in use."
          : `Fetched ${res.fetched} listings, ${res.added} new.`,
        res.fetched === 0 ? "error" : "ok",
      );
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Refresh listings";
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
      toast("Wipe attestation recorded locally.");
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

/* ---------------- actions ---------------- */

async function doScan() {
  const btn = $("#scanBtn");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Reading hardware…";
  const demo = Boolean($("#demoToggle")?.checked);
  try {
    const data = await call(api.scan(demo));
    state.view = data;
    state.passport = null;
    state.market = null;
    state.marketFor = null;
    state.ledger = await call(api.ledger());
    renderAll();
    renderLedger();
    await refreshDevices();
    showEmpty(false);
    switchTab("overview");
    toast("Check complete. Everything stayed on this machine.");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function refreshDevices() {
  const devices = await call(api.devices());
  const list = $("#deviceList");
  if (!devices.length) {
    list.innerHTML = '<p class="tiny">No devices checked yet.</p>';
    showEmpty(true);
    return;
  }
  list.innerHTML = devices
    .map(
      (d) => `
      <button class="device ${state.view && state.view.device.id === d.id ? "active" : ""}" data-id="${esc(d.id)}">
        <span class="name">${esc(d.name)}</span>
        <span class="sub">${esc(d.platform || d.class)} · ${new Date(d.lastSeenAt).toLocaleDateString()}</span>
      </button>`,
    )
    .join("");

  if (!state.view) {
    await loadDevice(devices[0].id);
  }
}

async function loadDevice(id) {
  try {
    const view = await call(api.view(id));
    if (!view) return;
    state.view = view;
    state.passport = null;
    state.market = null;
    state.marketFor = null;
    renderAll();
    renderDevicesActive();
    showEmpty(false);
    if (state.tab === "market") loadMarket();
  } catch (err) {
    toast(err.message, "error");
  }
}

function renderDevicesActive() {
  document.querySelectorAll(".device").forEach((el) => {
    el.classList.toggle("active", state.view && el.dataset.id === state.view.device.id);
  });
}

function showEmpty(empty) {
  $("#empty").classList.toggle("hidden", !empty);
  document.querySelectorAll(".panel:not(.empty)").forEach((p) => p.classList.toggle("hidden", empty || !p.id.endsWith(`-${state.tab}`)));
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  const hasDevice = Boolean(state.view);
  showEmpty(!hasDevice);
  if (hasDevice) {
    document.querySelectorAll(".panel:not(.empty)").forEach((p) => {
      p.classList.toggle("hidden", p.id !== `panel-${tab}`);
    });
  }
  if (tab === "passport") renderPassport();
  if (tab === "market") loadMarket();
}

/* ---------------- rendering ---------------- */

function renderAll() {
  if (!state.view) return;
  renderHeader();
  renderOverview();
  renderAdvice();
  renderPassport();
}

function renderHeader() {
  const { device, diagnostic } = state.view;
  $("#demoBanner").classList.toggle("hidden", !diagnostic?.demo);
  $("#deviceName").textContent = device.name;
  const bits = [device.class, device.platform, `last check ${new Date(device.lastSeenAt).toLocaleString()}`].filter(Boolean);
  $("#deviceMeta").textContent = bits.join(" · ");

  const pill = $("#healthPill");
  const score = diagnostic?.health.overall ?? null;
  if (score === null) {
    pill.className = "pill";
    pill.textContent = "Health: unknown";
  } else {
    const st = statusFor(score);
    pill.className = `pill ${st}`;
    pill.textContent = `Health ${score}/100 · ${st}`;
  }
}

function renderOverview() {
  const { diagnostic, device } = state.view;
  if (!diagnostic) return;

  const overall = diagnostic.health.overall;
  $("#healthSummary").innerHTML = `
    <div class="ring" style="--score:${overall ?? 0}"><span>${overall ?? "?"}</span></div>
    <div class="ring-label">
      <strong>${overall === null ? "Not enough sensors" : overall >= 80 ? "In good shape" : overall >= 60 ? "Wear is showing" : "Needs attention"}</strong>
      Weighted from battery, storage, thermals and memory.<br />
      ${diagCount(diagnostic)}
    </div>`;

  $("#healthList").innerHTML = diagnostic.health.items
    .map((item) => {
      const st = item.status;
      const width = item.score === null ? 100 : item.score;
      return `
      <div class="health-row">
        <div class="health-top"><span>${esc(item.label)}</span><span class="score">${item.score === null ? "unknown" : item.score + "/100"}</span></div>
        <div class="bar ${st}"><i style="width:${width}%"></i></div>
        <p>${esc(item.summary)}</p>
        ${item.evidence.length ? `<ul class="evidence">${item.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
      </div>`;
    })
    .join("");

  $("#faultList").innerHTML = diagnostic.faults.length
    ? diagnostic.faults
        .map(
          (f) => `
        <div class="fault ${esc(f.severity)}">
          <h3><span class="sev">${esc(f.severity)}</span>${esc(f.title)}</h3>
          <p>${esc(f.detail)}</p>
        </div>`,
        )
        .join("")
    : '<p class="muted small">No faults detected. Nothing needs replacing right now.</p>';

  const battery = diagnostic.battery;
  const memType = diagnostic.ram.type ? `${diagnostic.ram.type}${diagnostic.ram.assumed ? " (inferred)" : ""}` : "not reported";
  const disks = diagnostic.disks.map((d) => `${d.model} · ${d.sizeGb} GB`).join("<br>") || "not reported";
  $("#specList").innerHTML = `
    <div><dt>CPU</dt><dd>${esc(diagnostic.cpu.model)}</dd></div>
    <div><dt>Cores / threads</dt><dd>${diagnostic.cpu.physicalCores} / ${diagnostic.cpu.threads}</dd></div>
    <div><dt>Memory</dt><dd>${diagnostic.ram.totalGb} GB · ${esc(memType)}</dd></div>
    <div><dt>Form factor</dt><dd>${esc(diagnostic.ram.formFactor || "—")}</dd></div>
    <div><dt>Disks</dt><dd>${disks}</dd></div>
    <div><dt>Battery</dt><dd>${battery.present ? `${battery.healthPct ?? "?"}% · ${battery.cycles ?? "?"} cycles` : "none reported"}</dd></div>
    <div><dt>System volume</dt><dd>${diagnostic.storage.usedPct}% used · ${diagnostic.storage.freeGb} GB free</dd></div>
    <div><dt>OS</dt><dd>${esc(diagnostic.os.platform)}</dd></div>`;

  const hints = device.hints || [];
  $("#hintList").innerHTML = hints.length
    ? hints.map((h) => `<li>${esc(h)}</li>`).join("")
    : '<li>Nothing to report.</li>';
}

function diagCount(diagnostic) {
  const known = diagnostic.health.items.filter((i) => i.score !== null).length;
  return `Scored from ${known} of ${diagnostic.health.items.length} subsystems.`;
}

function renderAdvice() {
  const { advice } = state.view;
  if (!advice) return;

  $("#adviceSummary").textContent = advice.summary;

  $("#remedyList").innerHTML = advice.remedies
    .map((r) => {
      const recommended = advice.recommendedId === r.id;
      const materials = r.materials.filter((m) => m.grams > 0).map((m) => `${m.name} ${m.grams} g`).join(" · ");
      return `
      <article class="remedy ${recommended ? "recommended" : ""}">
        <div class="remedy-head">
          <div>
            <div class="badges">
              ${recommended ? '<span class="badge mint">Recommended</span>' : ""}
              <span class="badge sand">${HIERARCHY[r.hierarchy] || "Option"}</span>
              <span class="badge">${esc(r.action.replace("-", " "))}</span>
              <span class="badge ${r.safety === "diy" ? "mint" : r.safety === "shop" ? "blue" : "red"}">${SAFETY[r.safety]}</span>
            </div>
            <h3>${esc(r.title)}</h3>
          </div>
        </div>
        <p class="desc">${esc(r.description)}</p>
        <div class="metrics">
          <div class="metric"><div class="k">Part</div><div class="v">${
            r.costLow === 0 && r.costHigh === 0
              ? ["service", "recycle", "replace-device"].includes(r.action)
                ? "no part"
                : "not surveyed"
              : range(r.costLow, r.costHigh, "JOD")
          }</div></div>
          <div class="metric"><div class="k">Labour</div><div class="v">${range(r.laborLow, r.laborHigh, "JOD")}</div></div>
          <div class="metric"><div class="k">Cost / year</div><div class="v">${r.costPerYear ? money(r.costPerYear) + " <small>JOD</small>" : "—"}</div></div>
          <div class="metric"><div class="k">${r.yearsGained ? "Added life" : "Impact"}</div><div class="v">${r.yearsGained ? r.yearsGained + " <small>years</small>" : (r.kgDiverted ? money(r.kgDiverted) + " <small>kg</small>" : "—")}</div></div>
        </div>
        ${
          r.co2eAvoidedKg || r.kgDiverted
            ? `<div class="badges">
                 ${r.co2eAvoidedKg ? `<span class="badge mint">~${money(r.co2eAvoidedKg)} kg CO₂e avoided</span>` : ""}
                 ${r.kgDiverted ? `<span class="badge sand">${money(r.kgDiverted)} kg diverted</span>` : ""}
                 ${materials ? `<span class="badge">${esc(materials)}</span>` : ""}
               </div>`
            : ""
        }
        <details>
          <summary>Steps and cautions</summary>
          <ul>${r.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
          ${r.warnings.length ? `<ul>${r.warnings.map((w) => `<li><strong>Caution:</strong> ${esc(w)}</li>`).join("")}</ul>` : ""}
        </details>
        <div class="price-refs">${r.priceRefs.map((p) => esc(p)).join("<br>")}</div>
        <div class="foot">
          <span class="muted small">Confidence: ${esc(r.confidence)}</span>
          <button class="ghost" data-remedy="${esc(r.id)}">${r.action === "recycle" || r.action === "replace-device" ? "Log this decision" : "Mark as done"}</button>
        </div>
      </article>`;
    })
    .join("");

  const replacement = advice.replacement;
  $("#replacementBox").innerHTML = replacement
    ? `<div class="card">
        <div class="card-head"><h2>Replacement baseline</h2></div>
        <div class="metrics">
          <div class="metric"><div class="k">New device</div><div class="v">${range(replacement.costLow, replacement.costHigh, "JOD")}</div></div>
          <div class="metric"><div class="k">Assumed life</div><div class="v">${replacement.years} <small>years</small></div></div>
          <div class="metric"><div class="k">Cost / year</div><div class="v">${money(replacement.costPerYear)} <small>JOD</small></div></div>
          <div class="metric"><div class="k">Before first use</div><div class="v">~250 <small>kg CO₂e</small></div></div>
        </div>
        <p class="muted small">Compare this with the repair options above. If a repair costs less per year, replacing it is the more expensive choice — financially and environmentally.</p>
      </div>`
    : "";

  const actions = state.view.actions || [];
  $("#actionList").innerHTML = actions.length
    ? actions
        .map(
          (a) => `
        <div class="action-row">
          <div>
            <strong>${esc(a.title)}</strong>
            <small>${new Date(a.createdAt).toLocaleString()} · ${a.cost} JOD · ${money(a.co2eAvoidedKg)} kg CO₂e · ${money(a.kgDiverted)} kg diverted</small>
          </div>
          <button class="ghost" data-remove-action="${esc(a.id)}">Remove</button>
        </div>`,
        )
        .join("")
    : '<p class="muted small">Nothing logged yet. Mark a remedy as done to start the impact ledger.</p>';
}

function renderLedger() {
  const l = state.ledger;
  if (!l) return;
  $("#ledgerStats").innerHTML = `
    <div class="stat"><div class="value">${money(l.jodSaved)}<span class="unit">JOD</span></div><div class="k">Spend avoided</div></div>
    <div class="stat"><div class="value">${money(l.co2eAvoidedKg)}<span class="unit">kg</span></div><div class="k">CO₂e avoided</div></div>
    <div class="stat"><div class="value">${money(l.kgDiverted)}<span class="unit">kg</span></div><div class="k">Diverted from waste</div></div>
    <div class="stat"><div class="value">${l.actions}<span class="unit">/ ${l.devices}</span></div><div class="k">Decisions / devices</div></div>`;

  const mats = l.materials.filter((m) => m.grams > 0);
  $("#ledgerMaterials").innerHTML = mats.length
    ? mats.map((m) => `<span class="chip">${esc(m.name)} · ${money(m.grams)} g</span>`).join("")
    : '<span class="muted small">Log a repair or a recycling decision to see recovered materials.</span>';
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
        <td>${range(p.low, p.high, p.currency)}${unit}</td>
        <td><span class="badge ${kindClass}">${esc(p.kind)}</span></td>
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
              <span class="badge mint">Verified contact</span>
              <span class="badge">${esc(r.city)}</span>
              <span class="badge blue">E-waste recycler</span>
            </div>
            <h3>${esc(r.name)}</h3>
          </div>
        </div>
        <p class="desc">${esc(r.address)}<br>${esc(r.hours)}</p>
        <div class="metrics" style="grid-template-columns:1fr 1fr">
          <div class="metric">
            <div class="k">Phone</div>
            <div class="v" style="font-size:12.5px;line-height:1.8">
              ${r.phones
                .map(
                  (p) =>
                    `${esc(p.number)} <span class="badge ${p.type === "mobile" ? "mint" : ""}" style="font-size:9.5px;padding:1px 6px">${p.type === "mobile" ? "mobile" : "landline"}</span>`,
                )
                .join("<br>")}
            </div>
          </div>
          <div class="metric"><div class="k">Email</div><div class="v" style="font-size:12.5px">${esc(r.email)}</div></div>
        </div>
        ${
          r.process && r.process.length
            ? `<div class="card" style="background:var(--panel-2);margin:12px 0;padding:12px 14px">
                 <div class="k muted small" style="margin-bottom:6px">Pickup: how it works${r.pickup ? " · collection available" : ""}</div>
                 <ol class="hints" style="padding-left:18px;margin:0">
                   ${r.process.map((step) => `<li>${esc(step)}</li>`).join("")}
                 </ol>
               </div>`
            : ""
        }
        <div class="k muted small" style="margin-bottom:6px">Accepts</div>
        <div class="chips">${r.accepts.map((a) => `<span class="chip">${esc(a)}</span>`).join("")}</div>
        <details>
          <summary>What they do with it</summary>
          <ul>${r.services.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
        </details>
        <p class="muted small">${esc(r.notes)}</p>
        <div class="foot">
          <span class="muted small">Source: <a href="${esc(r.sourceUrl)}" target="_blank" rel="noreferrer">${esc(r.sourceUrl)}</a></span>
          <a class="ghost" href="${esc(r.contactUrl)}" target="_blank" rel="noreferrer" style="text-decoration:none">Contact page</a>
        </div>
      </article>`,
    )
    .join("");
}

function renderPassport() {
  const box = $("#passportBox");
  const { device, diagnostic, wipe, actions } = state.view || {};
  if (!device) {
    box.innerHTML = '<p class="muted small">Run a check first.</p>';
    return;
  }

  const wipeHtml = wipe
    ? `<div class="wipe-box">
         <strong>Wipe attestation recorded</strong><br>
         ${esc(wipe.method)} · ${esc(wipe.disk)} · ${new Date(wipe.claimedAt).toLocaleString()}<br>
         <span class="hash">nonce ${esc(wipe.nonceHash)}</span>
         <p class="muted small">${esc(wipe.note)}</p>
       </div>`
    : `<div class="wipe-box">No wipe recorded for this device yet.</div>`;
  $("#wipeBox").innerHTML = wipeHtml;

  if (!state.passport) {
    box.innerHTML = `<p class="muted small">${actions?.length ? "Ready to issue." : "Run a check and log at least one decision for a meaningful passport."}</p>`;
    return;
  }

  const p = state.passport.passport;
  box.innerHTML = `
    <div class="passport-grid">
      <div class="qr"><img src="${state.passport.qr}" alt="Passport QR" /></div>
      <div>
        <div class="badges">
          <span class="badge mint">${p.health.overall ?? "?"}/100 health</span>
          <span class="badge sand">${money(p.impact.co2eAvoidedKg)} kg CO₂e</span>
          <span class="badge">${money(p.impact.kgDiverted)} kg diverted</span>
          ${p.wipe ? '<span class="badge blue">data wiped</span>' : '<span class="badge red">no wipe record</span>'}
        </div>
        <p class="small"><strong>${esc(p.device.name)}</strong><br><span class="muted">${esc(p.health.storage)}</span></p>
        <p class="muted small">Issued ${new Date(p.issuedAt).toLocaleString()}</p>
        <div class="chips">${p.impact.materials.map((m) => `<span class="chip">${esc(m.name)} ${money(m.grams)} g</span>`).join("")}</div>
        <p class="hash">sha256 ${esc(p.hash)}</p>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="ghost" id="verifyPassport">Verify hash</button>
          <button class="ghost" id="downloadPassport">Download JSON</button>
        </div>
      </div>
    </div>`;
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

async function loadMarket(force = false) {
  const deviceId = state.view?.device.id;
  if (!force && state.market && state.marketFor === (deviceId ?? null)) return;
  try {
    state.market = await call(api.market(deviceId));
    state.marketFor = deviceId ?? null;
    renderMarket();
  } catch (err) {
    toast(err.message, "error");
  }
}

function bucketCard(b) {
  return `
    <div class="bucket">
      <div class="bucket-label">${esc(b.label)}</div>
      <div class="bucket-price">${money(b.median)} <small>JOD</small></div>
      <div class="muted small">P25–P75 ${money(b.p25)}–${money(b.p75)} · n=${b.n}</div>
    </div>`;
}

function listingRow(l) {
  const arabic = (l.title.match(/[\u0600-\u06FF]/g) ?? []).length;
  const rtl = arabic > 0 && arabic / Math.max(1, l.title.length) > 0.3;
  const compatClass = l.compatibility.status === "compatible" ? "mint" : l.compatibility.status === "incompatible" ? "red" : "sand";
  const compatLabel =
    l.compatibility.status === "compatible" ? "Compatible" : l.compatibility.status === "incompatible" ? "Incompatible" : "Check specs";

  const photoChips = l.photo
    ? [
        l.photo.specs.ramGen,
        l.photo.specs.capacityGb ? `${l.photo.specs.capacityGb} GB` : null,
        l.photo.specs.formFactor,
        l.photo.specs.bus,
        l.photo.specs.watts ? `${l.photo.specs.watts} W` : null,
      ].filter(Boolean)
    : [];

  return `
    <div class="listing">
      <div class="listing-main">
        <div class="listing-title ${rtl ? "rtl" : ""}" ${rtl ? 'lang="ar" dir="rtl"' : ""}>${esc(l.title)}</div>
        <div class="chips">
          ${l.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}
          ${photoChips.map((t) => `<span class="chip photo">photo: ${esc(t)}</span>`).join("")}
          ${l.outlier ? '<span class="badge red">outlier</span>' : ""}
          ${l.photo && l.photo.conflicts.length ? '<span class="badge red">photo conflict</span>' : ""}
        </div>
        <div class="muted small">${esc(l.area || "Jordan")} · ${esc(l.condition)} · ${esc(l.confidence)} confidence</div>
        <details>
          <summary>Why: ${compatLabel}</summary>
          <ul>${l.compatibility.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
        </details>
        ${
          l.photo
            ? `<details>
                 <summary>Read from photo · ${l.photo.confidence ? `${l.photo.confidence}% confidence` : "confidence unavailable"}</summary>
                 <div class="ocr-text">${esc(l.photo.text)}</div>
                 ${
                   l.photo.conflicts.length
                     ? `<ul>${l.photo.conflicts
                         .map(
                           (c) =>
                             `<li><strong>Conflict:</strong> seller says “${esc(c.title)}”, photo says “${esc(c.photo)}”</li>`,
                         )
                         .join("")}</ul>`
                     : ""
                 }
               </details>`
            : ""
        }
      </div>
      <div class="listing-side">
        <div class="price">${money(l.priceJod)} <small>JOD</small></div>
        <span class="badge ${compatClass}">${compatLabel}</span>
        <a href="${esc(l.url)}" target="_blank" rel="noreferrer">Open listing</a>
        ${
          l.imageUrl && state.ocrStatus?.available
            ? `<button class="ghost mini" data-read-photo="${esc(l.id)}" ${l.photo ? "disabled" : ""}>${l.photo ? "Photo read" : "Read photo"}</button>`
            : ""
        }
      </div>
    </div>`;
}

function renderMarket() {
  const market = state.market;
  if (!market) return;

  const compatCount = market.listings.filter((l) => l.compatibility.status === "compatible").length;
  $("#marketMeta").textContent = `${market.count} listings · ${compatCount} compatible · captured ${market.updatedAt ?? "unknown"} · ${market.outliers} outliers flagged`;

  const ocrNote = $("#ocrNote");
  if (ocrNote) {
    ocrNote.textContent = state.ocrStatus?.available
      ? `Photo OCR ready — ${state.ocrStatus.note} Reading a photo downloads that public image once.`
      : `Photo OCR unavailable — ${state.ocrStatus?.note ?? "Tesseract not detected."}`;
  }
  const req = market.requirements;
  $("#marketCompat").textContent = req
    ? `Compatibility target: ${[req.ramGen, req.ramForm, req.storageBus, req.storageForm].filter(Boolean).join(" · ") || "not enough sensor data"} — checks use only what the seller wrote.`
    : "No device selected; compatibility checks are unavailable until you run a check.";

  const q = normText($("#mSearch").value);
  const category = $("#mCategory").value;
  const condition = $("#mCondition").value;
  const max = Number($("#mMax").value) || Infinity;
  const hideIncompatible = $("#mCompatible").checked;
  const partsOnly = $("#mPartsOnly").checked;
  const showOutliers = $("#mOutliers").checked;

  const matching = market.listings
    .filter((l) => {
      if (!showOutliers && l.outlier) return false;
      if (partsOnly) {
        if (["other", "keyboard"].includes(l.category)) return false;
        if (["small", "converter", "external"].includes(l.variant ?? "")) return false;
      }
      if (category !== "all" && l.category !== category) return false;
      if (condition !== "all" && l.condition !== condition) return false;
      if (l.priceJod > max) return false;
      if (q && !normText(`${l.title} ${l.tags.join(" ")} ${l.oqCategory} ${l.brand ?? ""}`).includes(q)) return false;
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

  const hiddenIncompatible = hideIncompatible
    ? matching.filter((l) => l.compatibility.status === "incompatible").length
    : 0;
  const filtered = hideIncompatible
    ? matching.filter((l) => l.compatibility.status !== "incompatible")
    : matching;

  const buckets = market.buckets.filter((b) => category === "all" || b.category === category).slice(0, 8);
  $("#marketBuckets").innerHTML = buckets.length
    ? buckets.map(bucketCard).join("")
    : '<p class="muted small">No price buckets for this filter yet.</p>';

  $("#mCount").textContent = hiddenIncompatible
    ? `${filtered.length} shown · ${hiddenIncompatible} hidden as incompatible`
    : `${filtered.length} shown`;

  $("#marketList").innerHTML = filtered.length
    ? filtered.slice(0, 150).map(listingRow).join("")
    : `<p class="muted small">${
        hiddenIncompatible
          ? `No compatible listings match. ${hiddenIncompatible} matching listing(s) are incompatible with this machine — untick “Hide incompatible” to see them.`
          : "No listings match these filters."
      }</p>`;
}

async function generatePassport() {
  if (!state.view) return;
  try {
    state.passport = await call(api.passport(state.view.device.id));
    renderPassport();
    toast("Passport generated. Scan the QR with any reader.");
  } catch (err) {
    toast(err.message, "error");
  }
}
