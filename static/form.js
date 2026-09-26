/* POI field survey — form engine + offline queue.
   Edit FORM below to change the questionnaire; nothing else needs to move.
   Any `name` that isn't a column in poi_submissions lands in the attrs JSONB. */

const FORM = [
  {
    title: "Who's surveying",
    hint: "Filled once per session and reused for the records that follow.",
    fields: [
      { name: "surveyor", label: "Surveyor name or ID", type: "text",
        required: true, remember: true },
      { name: "grid_id", label: "Grid area", type: "text",
        hint: "The grid cell you're working through today.", remember: true },
    ],
  },
  {
    title: "Location",
    hint: "Stand at the entrance before you capture. Accuracy under 10 m is good.",
    fields: [
      { name: "geopoint", label: "GPS position", type: "geopoint", required: true },
      { name: "photo", label: "Storefront photo", type: "photo",
        hint: "Frame the signage so the business name is readable — that's what OCR reads." },
    ],
  },
  {
    title: "The place",
    fields: [
      { name: "status", label: "What did you find here?", type: "radio", required: true,
        options: [
          ["unchanged", "Same business as the 2021 record"],
          ["renamed",   "Same business, name has changed"],
          ["replaced",  "Different business at this address"],
          ["closed",    "Vacant or permanently closed"],
          ["new",       "Not in the 2021 dataset at all"],
        ] },
      { name: "poi_name", label: "Business name on the signage", type: "text",
        required: true, hint: "Type it exactly as written, including spelling.",
        requiredUnless: { status: "closed" } },
      { name: "prior_name", label: "Name in the 2021 record", type: "text",
        showIf: { status: ["renamed", "replaced"] } },
      { name: "category", label: "Category", type: "select", required: true,
        options: [
          ["", "Choose a category"],
          ["food_drink",    "Food and drink"],
          ["retail",        "Retail"],
          ["services",      "Services"],
          ["health",        "Health and pharmacy"],
          ["finance",       "Bank or ATM"],
          ["education",     "Education"],
          ["accommodation", "Accommodation"],
          ["transport",     "Transport"],
          ["public",        "Public or civic"],
          ["other",         "Something else"],
        ] },
      { name: "category_other", label: "Describe the category", type: "text",
        showIf: { category: ["other"] } },
    ],
  },
  {
    title: "Address and detail",
    fields: [
      { name: "address", label: "Street address", type: "text" },
      { name: "floor", label: "Floor or unit", type: "text",
        hint: "Ground, 1st, Shop 4 — leave blank if it's at street level." },
      { name: "phone", label: "Phone number", type: "tel" },
      { name: "access", label: "What applies here?", type: "checkbox",
        options: [
          ["wheelchair", "Step-free entrance"],
          ["parking",    "Own parking"],
          ["multi_unit", "Shares the building with other POIs"],
        ] },
      { name: "notes", label: "Notes", type: "textarea",
        hint: "Anything the next surveyor should know." },
    ],
  },
  { title: "Check and send", type: "review" },
];

/* ------------------------------------------------------------------ state */

const state = {};
let photoBlob = null;
let pageIndex = 0;
let pages = [];

const $ = (sel) => document.querySelector(sel);
const root = $("#form-root");

/* --------------------------------------------------------------- IndexedDB */

const DB_NAME = "poi-survey";
const STORE = "records";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "client_uuid" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const out = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(out.result !== undefined ? out.result : out);
    tx.onerror = () => reject(tx.error);
  });
}

const putRecord = (rec) => withStore("readwrite", (s) => s.put(rec));
const allRecords = () => withStore("readonly", (s) => s.getAll());
const dropRecord = (id) => withStore("readwrite", (s) => s.delete(id));

/* ------------------------------------------------------------- conditions */

function fieldVisible(f) {
  if (!f.showIf) return true;
  return Object.entries(f.showIf).every(([key, allowed]) => {
    const v = state[key];
    return Array.isArray(v) ? v.some((x) => allowed.includes(x)) : allowed.includes(v);
  });
}

function fieldRequired(f) {
  if (!f.required) return false;
  if (f.requiredUnless) {
    const [key, val] = Object.entries(f.requiredUnless)[0];
    if (state[key] === val) return false;
  }
  return true;
}

/* ----------------------------------------------------------------- render */

function render() {
  root.innerHTML = "";
  pages = FORM.map((pageDef, i) => {
    const page = document.createElement("section");
    page.className = "page";
    page.dataset.index = i;

    const h = document.createElement("h2");
    h.textContent = pageDef.title;
    page.append(h);

    if (pageDef.hint) {
      const p = document.createElement("p");
      p.className = "page-hint";
      p.textContent = pageDef.hint;
      page.append(p);
    }

    if (pageDef.type === "review") {
      const dl = document.createElement("dl");
      dl.className = "review";
      dl.id = "review-body";
      page.append(dl);
    } else {
      pageDef.fields.forEach((f) => page.append(buildField(f)));
    }

    root.append(page);
    return page;
  });
  showPage(0);
}

function buildField(f) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  wrap.dataset.name = f.name;
  if (f.required) wrap.classList.add("required");

  const labelText = f.label + (f.required ? "*" : "");
  const id = "f_" + f.name;

  if (["text", "tel", "number", "textarea", "select"].includes(f.type)) {
    const label = el("label", { htmlFor: id, className: "field-label" }, f.label);
    if (f.required) label.append(el("span", { className: "req-mark" }, "*"));
    wrap.append(label);
    if (f.hint) wrap.append(el("span", { className: "hint" }, f.hint));

    let input;
    if (f.type === "textarea") {
      input = el("textarea", { id, name: f.name, rows: 3 });
    } else if (f.type === "select") {
      input = el("select", { id, name: f.name });
      f.options.forEach(([v, t]) => input.append(el("option", { value: v }, t)));
    } else {
      input = el("input", { id, name: f.name, type: f.type });
    }
    input.addEventListener("input", () => {
      state[f.name] = input.value;
      if (f.remember) localStorage.setItem("remember:" + f.name, input.value);
      clearError(wrap);
      refreshVisibility();
    });
    wrap.append(input);
  }

  if (f.type === "radio" || f.type === "checkbox") {
    wrap.append(labelBlock(f, labelText));
    const group = el("div", { className: "choices", role: f.type === "radio" ? "radiogroup" : "group" });
    f.options.forEach(([value, text]) => {
      const box = el("label", { className: "choice" });
      const input = el("input", { type: f.type, name: f.name, value });
      input.addEventListener("change", () => {
        state[f.name] = f.type === "radio"
          ? input.value
          : [...group.querySelectorAll("input:checked")].map((i) => i.value);
        clearError(wrap);
        refreshVisibility();
      });
      box.append(input, el("span", {}, text));
      group.append(box);
    });
    wrap.append(group);
  }

  if (f.type === "geopoint") {
    wrap.append(labelBlock(f, labelText));
    wrap.append(geopointWidget());
  }

  if (f.type === "photo") {
    wrap.append(labelBlock(f, labelText));
    wrap.append(photoWidget());
  }

  wrap.append(el("p", { className: "error" }, ""));
  return wrap;
}

function labelBlock(f, text) {
  const frag = document.createDocumentFragment();
  const label = el("span", { className: "field-label" }, f.label);
  if (f.required) label.append(el("span", { className: "req-mark" }, "*"));
  frag.append(label);
  if (f.hint) frag.append(el("span", { className: "hint" }, f.hint));
  return frag;
}

function el(tag, props = {}, text) {
  const node = Object.assign(document.createElement(tag), props);
  if (text !== undefined) node.textContent = text;
  return node;
}

/* --------------------------------------------------------------- geopoint */

function geopointWidget() {
  const frag = document.createDocumentFragment();

  const readout = el("div", { className: "geo-readout" });
  const cell = (label) => {
    const d = el("div");
    d.append(el("dt", {}, label), el("dd", {}, "—"));
    readout.append(d);
    return d.querySelector("dd");
  };
  const latOut = cell("Latitude");
  const lonOut = cell("Longitude");
  const accOut = cell("Accuracy");

  const btn = el("button", { type: "button", className: "btn ghost wide" }, "Capture GPS position");
  let watchId = null;

  btn.addEventListener("click", () => {
    if (!navigator.geolocation) return toast("This browser has no location support.", "bad");
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
      btn.textContent = "Capture again";
      return;
    }
    btn.textContent = "Reading… tap to stop";
    toast("Hold still — accuracy improves over a few seconds.");
    watchId = navigator.geolocation.watchPosition(
      ({ coords, timestamp }) => {
        state.lat = coords.latitude;
        state.lon = coords.longitude;
        state.gps_accuracy_m = coords.accuracy;
        state.captured_at = new Date(timestamp).toISOString();
        latOut.textContent = coords.latitude.toFixed(6);
        lonOut.textContent = coords.longitude.toFixed(6);
        accOut.textContent = `${coords.accuracy.toFixed(0)} m`;
        accOut.className = coords.accuracy <= 10 ? "accuracy-good" : "accuracy-poor";
        clearError(btn.closest(".field"));
        if (coords.accuracy <= 8) {
          navigator.geolocation.clearWatch(watchId);
          watchId = null;
          btn.textContent = "Capture again";
          toast("Position locked.", "ok");
        }
      },
      (err) => {
        watchId = null;
        btn.textContent = "Capture GPS position";
        toast(
          err.code === err.PERMISSION_DENIED
            ? "Location is blocked. Allow it in the browser's site settings, then capture again."
            : "No fix yet. Step into the open and capture again.",
          "bad"
        );
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  });

  frag.append(readout, btn);
  return frag;
}

/* ------------------------------------------------------------------ photo */

function photoWidget() {
  const frag = document.createDocumentFragment();
  const drop = el("div", { className: "photo-drop" }, "No photo yet");

  const input = el("input", { type: "file", accept: "image/*", hidden: true });
  input.capture = "environment";

  const take = el("button", { type: "button", className: "btn ghost row" }, "Take photo");
  const clear = el("button", { type: "button", className: "btn ghost row" }, "Remove");
  clear.disabled = true;

  take.addEventListener("click", () => input.click());
  clear.addEventListener("click", () => {
    photoBlob = null;
    drop.textContent = "No photo yet";
    clear.disabled = true;
    input.value = "";
  });

  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    photoBlob = await downscale(file, 1600, 0.8);
    drop.innerHTML = "";
    drop.append(el("img", { src: URL.createObjectURL(photoBlob), alt: "Storefront photo just taken" }));
    clear.disabled = false;
  });

  const pair = el("div", { className: "btn-pair" });
  pair.append(take, clear);
  frag.append(drop, pair, input);
  return frag;
}

function downscale(file, maxEdge, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const canvas = el("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      canvas.toBlob((b) => resolve(b || file), "image/jpeg", quality);
    };
    img.onerror = () => resolve(file);
    img.src = URL.createObjectURL(file);
  });
}

/* ------------------------------------------------------------- navigation */

function showPage(i) {
  pageIndex = Math.max(0, Math.min(i, FORM.length - 1));
  pages.forEach((p, n) => p.classList.toggle("active", n === pageIndex));

  const pct = ((pageIndex + 1) / FORM.length) * 100;
  $("#progress-fill").style.width = pct + "%";
  document.querySelector(".progress").setAttribute("aria-valuenow", Math.round(pct));
  $("#page-count").textContent = `Section ${pageIndex + 1} of ${FORM.length}`;

  const last = pageIndex === FORM.length - 1;
  $("#next-btn").hidden = last;
  $("#submit-btn").hidden = !last;
  $("#back-btn").disabled = pageIndex === 0;

  if (last) buildReview();
  refreshVisibility();
  window.scrollTo({ top: 0 });
}

function refreshVisibility() {
  FORM.forEach((page) => {
    (page.fields || []).forEach((f) => {
      const node = root.querySelector(`.field[data-name="${f.name}"]`);
      if (!node) return;
      const visible = fieldVisible(f);
      node.hidden = !visible;
      node.classList.toggle("required", visible && fieldRequired(f));
    });
  });
}

function validatePage() {
  const def = FORM[pageIndex];
  if (!def.fields) return true;
  let ok = true;

  def.fields.forEach((f) => {
    const node = root.querySelector(`.field[data-name="${f.name}"]`);
    if (!node || node.hidden || !fieldRequired(f)) return;

    const missing = f.type === "geopoint"
      ? state.lat === undefined
      : Array.isArray(state[f.name])
        ? state[f.name].length === 0
        : !String(state[f.name] ?? "").trim();

    if (missing) {
      ok = false;
      node.classList.add("invalid");
      node.querySelector(".error").textContent =
        f.type === "geopoint" ? "Capture a position before continuing." : "This one is required.";
    }
  });

  if (!ok) {
    root.querySelector(".field.invalid").scrollIntoView({ block: "center", behavior: "smooth" });
    toast("Some answers are still missing.", "warn");
  }
  return ok;
}

function clearError(node) {
  node?.classList.remove("invalid");
}

/* ----------------------------------------------------------------- review */

const LABELS = Object.fromEntries(
  FORM.flatMap((p) => (p.fields || []).map((f) => [f.name, f.label]))
);

function buildReview() {
  const dl = $("#review-body");
  dl.innerHTML = "";
  const add = (label, value) => {
    const row = el("div");
    row.append(el("dt", {}, label), el("dd", {}, value));
    dl.append(row);
  };

  Object.entries(state).forEach(([k, v]) => {
    if (["lat", "lon", "gps_accuracy_m", "captured_at"].includes(k)) return;
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) return;
    add(LABELS[k] || k, Array.isArray(v) ? v.join(", ") : v);
  });

  if (state.lat !== undefined) {
    add("Position", `${state.lat.toFixed(6)}, ${state.lon.toFixed(6)} ±${Math.round(state.gps_accuracy_m)} m`);
  }
  add("Photo", photoBlob ? `Attached, ${(photoBlob.size / 1024).toFixed(0)} KB` : "None");
}

/* ------------------------------------------------------------ queue + send */

async function enqueue(kind) {
  const record = { ...state, client_uuid: crypto.randomUUID() };
  await putRecord({
    client_uuid: record.client_uuid,
    record,
    photo: photoBlob,
    kind,                       // "queued" or "draft"
    created: new Date().toISOString(),
  });
  await refreshQueueBadge();
  return record.client_uuid;
}

async function uploadQueue({ manual = false } = {}) {
  const items = (await allRecords()).filter((r) => r.kind === "queued");
  if (!items.length) {
    if (manual) toast("Nothing waiting to upload.");
    return;
  }
  if (!navigator.onLine) {
    if (manual) toast("No connection. Records stay safe on this device.", "warn");
    return;
  }

  let sent = 0;
  for (const item of items) {
    const body = new FormData();
    body.append("record", JSON.stringify(item.record));
    if (item.photo) body.append("photo", item.photo, `${item.client_uuid}.jpg`);
    try {
      const res = await fetch("/api/submissions", { method: "POST", body });
      if (res.ok) {
        await dropRecord(item.client_uuid);
        sent++;
      } else if (res.status === 400) {
        // a malformed record will never succeed — park it as a draft to fix by hand
        await putRecord({ ...item, kind: "draft", error: (await res.json()).error });
      }
    } catch {
      break; // connection dropped mid-run; the rest stay queued
    }
  }

  await refreshQueueBadge();
  if (sent) toast(`${sent} record${sent > 1 ? "s" : ""} uploaded.`, "ok");
  else if (manual) toast("Upload didn't go through. It'll retry automatically.", "warn");
}

async function refreshQueueBadge() {
  const items = await allRecords();
  const btn = $("#queue-btn");
  btn.hidden = items.length === 0;
  $("#queue-count").textContent = items.length;
}

async function renderQueuePanel() {
  const list = $("#queue-list");
  const items = await allRecords();
  list.innerHTML = "";
  if (!items.length) {
    list.append(el("li", { className: "empty" }, "Everything on this device has been uploaded."));
    return;
  }
  items.forEach((item) => {
    const li = el("li");
    li.append(
      el("span", {}, item.record.poi_name || "Untitled record"),
      el("span", { className: "state" + (item.kind === "draft" ? " draft" : "") },
        item.kind === "draft" ? "Draft" : "Waiting")
    );
    list.append(li);
  });
}

function resetForm() {
  Object.keys(state).forEach((k) => delete state[k]);
  photoBlob = null;
  render();
  restoreRemembered();
}

function restoreRemembered() {
  FORM.flatMap((p) => p.fields || [])
    .filter((f) => f.remember)
    .forEach((f) => {
      const saved = localStorage.getItem("remember:" + f.name);
      if (!saved) return;
      state[f.name] = saved;
      const input = root.querySelector(`[name="${f.name}"]`);
      if (input) input.value = saved;
    });
}

/* ------------------------------------------------------------------ toast */

let toastTimer;
function toast(message, kind = "") {
  const node = $("#toast");
  node.textContent = message;
  node.className = "toast " + kind;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 3200);
}

/* ------------------------------------------------------------------- wire */

$("#next-btn").addEventListener("click", () => validatePage() && showPage(pageIndex + 1));
$("#back-btn").addEventListener("click", () => showPage(pageIndex - 1));

$("#draft-btn").addEventListener("click", async () => {
  await enqueue("draft");
  toast("Saved as a draft on this device.", "ok");
  resetForm();
});

$("#submit-btn").addEventListener("click", async () => {
  for (let i = 0; i < FORM.length; i++) {
    pageIndex = i;
    if (!validatePage()) return showPage(i);
  }
  await enqueue("queued");
  resetForm();
  toast("Record saved. Uploading…", "ok");
  uploadQueue();
});

const panel = $("#queue-panel");
$("#queue-btn").addEventListener("click", async () => {
  await renderQueuePanel();
  panel.showModal();
});
$("#close-panel").addEventListener("click", () => panel.close());
$("#upload-now").addEventListener("click", async () => {
  await uploadQueue({ manual: true });
  renderQueuePanel();
});
$("#export-queue").addEventListener("click", async () => {
  const items = (await allRecords()).map(({ record, kind, created }) => ({ ...record, kind, created }));
  const url = URL.createObjectURL(new Blob([JSON.stringify(items, null, 2)], { type: "application/json" }));
  const a = el("a", { href: url, download: "poi-records.json" });
  a.click();
  URL.revokeObjectURL(url);
});

window.addEventListener("online", () => uploadQueue());
setInterval(() => uploadQueue(), 5 * 60 * 1000);

render();
restoreRemembered();
refreshQueueBadge();
uploadQueue();
