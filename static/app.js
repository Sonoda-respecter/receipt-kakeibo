/* ===== State ===== */
let currentImageFile = null;
let analyzedData = null;

/* ===== Init ===== */
document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  initDropZone();
  initAnalyzeBtn();
  initFormActions();
  loadMonthSelectors();
});

/* ===== Tabs ===== */
function initTabs() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${tab}`).classList.add("active");
      if (tab === "history") loadHistory();
      if (tab === "summary") loadSummary();
    });
  });
}

/* ===== Drop Zone ===== */
function initDropZone() {
  const zone = document.getElementById("drop-zone");
  const input = document.getElementById("file-input");

  zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("dragover"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", e => {
    e.preventDefault();
    zone.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) setImage(file);
  });

  input.addEventListener("change", () => {
    if (input.files[0]) setImage(input.files[0]);
  });

  document.getElementById("btn-reselect").addEventListener("click", () => {
    input.value = "";
    input.click();
  });
}

function setImage(file) {
  currentImageFile = file;
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById("preview-img").src = e.target.result;
    document.getElementById("upload-prompt").style.display = "none";
    document.getElementById("preview-container").style.display = "block";
    document.getElementById("result-form").style.display = "none";
  };
  reader.readAsDataURL(file);
}

/* ===== Analyze ===== */
function initAnalyzeBtn() {
  document.getElementById("btn-analyze").addEventListener("click", async () => {
    if (!currentImageFile) return;
    const btn = document.getElementById("btn-analyze");
    const spinner = btn.querySelector(".spinner");
    btn.disabled = true;
    spinner.style.display = "inline-block";
    btn.childNodes[btn.childNodes.length - 1].textContent = " 解析中...";

    try {
      const form = new FormData();
      form.append("image", currentImageFile);
      const res = await fetch("/api/analyze", { method: "POST", body: form });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "解析失敗");
      analyzedData = data;
      populateForm(data);
      document.getElementById("result-form").style.display = "block";
      document.getElementById("result-form").scrollIntoView({ behavior: "smooth" });
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
      spinner.style.display = "none";
      btn.childNodes[btn.childNodes.length - 1].textContent = " AI解析する";
    }
  });
}

function populateForm(data) {
  document.getElementById("f-date").value = data.date || today();
  document.getElementById("f-store").value = data.store || "";
  document.getElementById("f-total").value = data.total || 0;
  document.getElementById("f-memo").value = data.memo || "";

  const sel = document.getElementById("f-category");
  if (data.category) {
    for (let opt of sel.options) {
      if (opt.value === data.category) { opt.selected = true; break; }
    }
  }

  renderItems(data.items || []);
}

function renderItems(items) {
  const list = document.getElementById("items-list");
  list.innerHTML = "";
  items.forEach((item, i) => addItemRow(item, i));
}

function addItemRow(item = { name: "", price: 0, qty: 1 }) {
  const list = document.getElementById("items-list");
  const row = document.createElement("div");
  row.className = "item-row";
  row.innerHTML = `
    <input type="text" placeholder="商品名" value="${escHtml(item.name || "")}" data-field="name">
    <input type="number" placeholder="金額" value="${item.price || 0}" min="0" data-field="price">
    <input type="number" placeholder="数量" value="${item.qty || 1}" min="1" data-field="qty">
    <button class="btn-remove" title="削除">✕</button>
  `;
  row.querySelector(".btn-remove").addEventListener("click", () => row.remove());
  list.appendChild(row);
}

document.getElementById("btn-add-item").addEventListener("click", () => addItemRow());

/* ===== Form Save/Cancel ===== */
function initFormActions() {
  document.getElementById("btn-save").addEventListener("click", saveExpense);
  document.getElementById("btn-cancel").addEventListener("click", () => {
    document.getElementById("result-form").style.display = "none";
    document.getElementById("upload-prompt").style.display = "block";
    document.getElementById("preview-container").style.display = "none";
    currentImageFile = null;
    document.getElementById("file-input").value = "";
  });
}

async function saveExpense() {
  const date = document.getElementById("f-date").value;
  const store = document.getElementById("f-store").value.trim();
  const total = parseInt(document.getElementById("f-total").value, 10);
  const category = document.getElementById("f-category").value;
  const memo = document.getElementById("f-memo").value.trim();

  if (!date || !store || isNaN(total)) {
    showToast("日付・店舗名・金額を入力してください", "error");
    return;
  }

  const items = [];
  document.querySelectorAll("#items-list .item-row").forEach(row => {
    items.push({
      name: row.querySelector("[data-field=name]").value,
      price: parseInt(row.querySelector("[data-field=price]").value, 10) || 0,
      qty: parseInt(row.querySelector("[data-field=qty]").value, 10) || 1,
    });
  });

  const btn = document.getElementById("btn-save");
  btn.disabled = true;
  try {
    const res = await fetch("/api/expenses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, store, category, total, items, memo }),
    });
    if (!res.ok) throw new Error("保存失敗");
    showToast("保存しました！");
    document.getElementById("btn-cancel").click();
    loadMonthSelectors();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

/* ===== History ===== */
async function loadHistory() {
  const sel = document.getElementById("history-month-sel");
  const month = sel.value;
  const res = await fetch(`/api/expenses?month=${month}`);
  const expenses = await res.json();

  const list = document.getElementById("expenses-list");
  const total = expenses.reduce((s, e) => s + e.total, 0);
  document.getElementById("history-total-label").textContent =
    expenses.length > 0 ? `合計 ${fmt(total)}` : "";

  if (expenses.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>この月の記録はありません</p></div>`;
    return;
  }

  list.innerHTML = expenses.map(e => `
    <div class="expense-card" data-id="${e.id}">
      <div class="expense-store">${escHtml(e.store)}</div>
      <div class="expense-amount">${fmt(e.total)}</div>
      <div class="expense-meta">
        ${e.date} &nbsp;<span class="badge">${escHtml(e.category)}</span>
        ${e.memo ? `&nbsp;${escHtml(e.memo)}` : ""}
      </div>
      <div class="expense-actions">
        <button class="btn-danger" onclick="deleteExpense(${e.id})">削除</button>
      </div>
    </div>
  `).join("");
}

async function deleteExpense(id) {
  if (!confirm("この記録を削除しますか？")) return;
  await fetch(`/api/expenses/${id}`, { method: "DELETE" });
  showToast("削除しました");
  loadHistory();
  loadSummary();
}

/* ===== Summary ===== */
async function loadSummary() {
  const sel = document.getElementById("summary-month-sel");
  const month = sel.value;
  const res = await fetch(`/api/summary?month=${month}`);
  const data = await res.json();

  document.getElementById("summary-total-amount").textContent = fmt(data.total);

  const bars = document.getElementById("category-bars");
  if (!data.by_category || data.by_category.length === 0) {
    bars.innerHTML = `<div class="empty-state"><div class="icon">📊</div><p>データがありません</p></div>`;
    return;
  }

  const max = data.by_category[0].total;
  bars.innerHTML = data.by_category.map(c => `
    <div class="bar-row">
      <div class="bar-label">${escHtml(c.category)}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${Math.round(c.total / max * 100)}%"></div>
      </div>
      <div class="bar-amount">${fmt(c.total)}</div>
    </div>
  `).join("");
}

/* ===== Month Selectors ===== */
async function loadMonthSelectors() {
  const res = await fetch("/api/months");
  const months = await res.json();

  // Add current month if not present
  const cur = today().slice(0, 7);
  if (!months.includes(cur)) months.unshift(cur);

  ["history-month-sel", "summary-month-sel"].forEach(id => {
    const sel = document.getElementById(id);
    const prev = sel.value || cur;
    sel.innerHTML = months.map(m => `<option value="${m}" ${m === prev ? "selected" : ""}>${m}</option>`).join("");
    sel.addEventListener("change", () => {
      if (id === "history-month-sel") loadHistory();
      else loadSummary();
    });
  });
}

/* ===== Utils ===== */
function fmt(n) {
  return "¥" + (n || 0).toLocaleString("ja-JP");
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function showToast(msg, type = "") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast" + (type ? ` ${type}` : "");
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3000);
}
