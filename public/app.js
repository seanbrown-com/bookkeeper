const state = {
  configured: false,
  authenticated: false,
  accounts: [],
  txOffset: 0,
  txDone: false,
  txLoading: false,
  txAccountFilter: "",
  metricsStartDate: "",
  metricsEndDate: "",
  activePage: "dashboard",
};

const $ = (selector) => document.querySelector(selector);
const money = (value) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value || 0));

const MASTER_CATEGORIES = [
  "Groceries",
  "Restaurants",
  "Fast Food",
  "Bars",
  "Fuel",
  "Merchandise",
  "Wholesale & Discount Stores",
  "Discount Stores",
  "Department Stores",
  "Home Improvement",
  "Clothing",
  "Pharmacy",
  "Entertainment",
  "Fitness",
  "Travel",
  "Airlines",
  "Lodging",
  "Car Rental",
  "Transportation",
  "Utilities",
  "Services",
  "Health & Education",
  "Business & Recreation",
  "Government",
  "Transfers & Payments",
  "Other",
];

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body;
}

function setSummary(summary) {
  $("#cash-total").textContent = money(summary.cash);
  $("#debt-total").textContent = money(summary.debt);
  $("#net-total").textContent = money(summary.net);
}

async function init() {
  document.documentElement.dataset.theme = localStorage.getItem("bookkeeper-theme") || "light";
  bindChrome();
  const status = await api("/api/status");
  state.configured = status.configured;
  state.authenticated = status.authenticated;
  if (!status.authenticated) renderAuth();
  else await renderApp();
}

function renderAuth() {
  $("#app").classList.add("hidden");
  $("#auth").classList.remove("hidden");
  $("#auth-title").textContent = state.configured ? "Bookkeeper" : "Set Up Bookkeeper";
  $("#auth-submit").textContent = state.configured ? "Log in" : "Create login";
  $("#auth-note").textContent = state.configured
    ? "Log in to unlock the local encrypted store."
    : "Create the first local user. Use a password of at least 10 characters.";
}

async function renderApp() {
  $("#auth").classList.add("hidden");
  $("#app").classList.remove("hidden");
  await loadBootstrap();
  showPage(state.activePage);
}

async function loadBootstrap() {
  const data = await api("/api/bootstrap");
  state.accounts = data.accounts;
  setSummary(data.summary);
  renderDashboard(data.accounts);
}

function bindChrome() {
  $("#auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const username = $("#auth-username").value;
      const password = $("#auth-password").value;
      await api(state.configured ? "/api/login" : "/api/setup", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      state.authenticated = true;
      await renderApp();
    } catch (error) {
      toast(error.message);
    }
  });

  document.querySelectorAll(".nav button").forEach((button) => {
    button.addEventListener("click", () => showPage(button.dataset.page));
  });

  $("#theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("bookkeeper-theme", next);
  });

  window.addEventListener("scroll", () => {
    if (state.activePage !== "transactions" || state.txDone || state.txLoading) return;
    const nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 300;
    if (nearBottom) renderTransactions(false);
  });
}

async function showPage(page) {
  state.activePage = page;
  document.querySelectorAll(".nav button").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === page);
  });
  document.querySelectorAll(".page").forEach((el) => el.classList.add("hidden"));
  $(`#page-${page}`).classList.remove("hidden");

  if (page === "dashboard") await loadBootstrap();
  if (page === "transactions") await renderTransactions(true);
  if (page === "month") await renderMonthAhead();
  if (page === "metrics") await renderMetrics();
  if (page === "import") renderImport();
  if (page === "settings") await renderSettings();
  if (page === "activity") await renderActivity();
}

function renderDashboard(accounts) {
  const page = $("#page-dashboard");
  page.innerHTML = accounts.length
    ? accounts.map(renderAccountCard).join("")
    : `<section class="panel"><p class="muted">No accounts yet. Add SimpleFIN in Settings or import a spreadsheet.</p></section>`;

  page.querySelectorAll("[data-color]").forEach((input) => {
    input.addEventListener("change", async () => {
      await api(`/api/accounts/${input.dataset.color}`, {
        method: "PATCH",
        body: JSON.stringify({ color: input.value }),
      });
      await loadBootstrap();
    });
  });

  page.querySelectorAll("[data-regular]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api("/api/transactions/regular", {
        method: "POST",
        body: JSON.stringify({ transactionId: button.dataset.regular }),
      });
      toast("Added to Month Ahead");
      button.disabled = true;
    });
  });

  page.querySelectorAll("[data-hide-account]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/accounts/${button.dataset.hideAccount}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: true }),
      });
      toast("Account hidden");
      await loadBootstrap();
    });
  });

  page.querySelectorAll("[data-view-account]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.txAccountFilter = button.dataset.viewAccount;
      await showPage("transactions");
    });
  });
}

function renderAccountCard(account) {
  const txs = account.recentTransactions || [];
  return `
    <article class="account-card">
      <div class="account-title" style="background:${account.color}">
        <h2>${escapeHtml(account.name)}</h2>
        <div class="account-tools">
          <input data-color="${account.id}" type="color" value="${account.color}" title="Account color" />
          <button data-hide-account="${account.id}" class="title-button" type="button">Hide</button>
        </div>
      </div>
      <div class="account-body">
        <div class="account-balance-row">
          <strong>${money(account.balance)}</strong>
          <button data-view-account="${account.id}" class="secondary" type="button">View All</button>
        </div>
        <div class="tx-list">
          ${txs.length ? txs.map(renderTransactionRow).join("") : `<p class="muted">No transactions yet.</p>`}
        </div>
      </div>
    </article>
  `;
}

function renderTransactionRow(tx) {
  const regularDisabled = tx.isRegularLike ? "disabled" : "";
  const regularText = tx.isRegularLike ? "Recurring" : "Recurring";
  return `
    <div class="transaction-row">
      <span class="muted">${tx.date}</span>
      <span class="desc">${escapeHtml(tx.description)}</span>
      <strong class="amount">${money(tx.amount)}</strong>
      <button class="secondary" data-regular="${tx.id}" type="button" ${regularDisabled}>${regularText}</button>
    </div>
  `;
}

async function renderTransactions(reset = false) {
  const page = $("#page-transactions");
  if (reset) {
    state.txOffset = 0;
    state.txDone = false;
    page.innerHTML = `
      <section class="panel">
        <label>Account filter
          <select id="tx-account-filter">
            <option value="">All accounts</option>
            ${state.accounts.map((a) => `<option value="${a.id}" ${a.id === state.txAccountFilter ? "selected" : ""}>${escapeHtml(a.name)}</option>`).join("")}
          </select>
        </label>
      </section>
      <div id="all-tx" class="tx-list"></div>
      <button id="load-more" type="button">Load more</button>
    `;
    $("#tx-account-filter").addEventListener("change", async () => {
      state.txAccountFilter = $("#tx-account-filter").value;
      await renderTransactions(true);
    });
    $("#all-tx").addEventListener("click", async (event) => {
      const editCategory = event.target.closest("[data-edit-category]");
      if (editCategory) {
        const cell = editCategory.closest(".category-cell");
        cell.innerHTML = renderCategorySelector({
          id: editCategory.dataset.editCategory,
          category: editCategory.dataset.currentCategory || "Uncategorized",
        });
        cell.querySelector("select")?.focus();
        return;
      }

      const button = event.target.closest("[data-regular]");
      if (!button || button.disabled) return;
      await api("/api/transactions/regular", {
        method: "POST",
        body: JSON.stringify({ transactionId: button.dataset.regular }),
      });
      toast("Added to Month Ahead");
      button.disabled = true;
    });
    $("#all-tx").addEventListener("change", async (event) => {
      const select = event.target.closest("[data-category-transaction]");
      if (!select || !select.value) return;
      const category = select.value;
      await api("/api/transactions/category", {
        method: "POST",
        body: JSON.stringify({
          transactionId: select.dataset.categoryTransaction,
          category,
        }),
      });
      toast("Category rule saved");
      const cell = select.closest(".category-cell");
      cell.innerHTML = renderCategoryDisplay({ id: select.dataset.categoryTransaction, category });
    });
    $("#load-more").addEventListener("click", () => renderTransactions(false));
  }
  if (state.txLoading || state.txDone) return;
  state.txLoading = true;
  const params = new URLSearchParams({ limit: "100", offset: String(state.txOffset) });
  if (state.txAccountFilter) params.set("accountId", state.txAccountFilter);
  const data = await api(`/api/transactions?${params.toString()}`);
  const list = $("#all-tx");
  list.insertAdjacentHTML("beforeend", data.transactions.map((tx) => `
    <div class="transaction-row all-transaction-row">
      <span class="muted">${tx.date}</span>
      <span class="muted">${escapeHtml(tx.account?.name || "")}</span>
      <span class="desc">${escapeHtml(tx.description)}</span>
      <span class="category-cell">${renderTransactionCategory(tx)}</span>
      <strong class="amount">${money(tx.amount)}</strong>
      <button class="secondary" data-regular="${tx.id}" type="button" ${tx.isRegularLike ? "disabled" : ""}>Recurring</button>
    </div>
  `).join(""));
  state.txOffset += data.transactions.length;
  state.txDone = data.transactions.length < 100;
  $("#load-more").disabled = state.txDone;
  $("#load-more").textContent = state.txDone ? "All loaded" : "Load more";
  state.txLoading = false;
}

function renderTransactionCategory(tx) {
  if (tx.category !== "Uncategorized") return renderCategoryDisplay(tx);
  return renderCategorySelector(tx);
}

function renderCategoryDisplay(tx) {
  const category = tx.category || "Uncategorized";
  return `
    <span class="category-pill">${escapeHtml(category)}</span>
    <button class="icon-inline" data-edit-category="${tx.id}" data-current-category="${escapeHtml(category)}" type="button" title="Edit category" aria-label="Edit category">✎</button>
  `;
}

function renderCategorySelector(tx) {
  return `
    <select class="category-select" data-category-transaction="${tx.id}">
      <option value="">Uncategorized</option>
      ${MASTER_CATEGORIES.map((category) => `<option value="${escapeHtml(category)}" ${category === tx.category ? "selected" : ""}>${escapeHtml(category)}</option>`).join("")}
    </select>
  `;
}

async function renderMonthAhead() {
  const data = await api("/api/month-ahead");
  const page = $("#page-month");
  const manualGuesses = data.guesses.filter((guess) => guess.manual);
  const autoGuesses = data.guesses.filter((guess) => !guess.manual);
  page.innerHTML = `
    <section class="panel">
      <p class="muted">Estimated next 30 days: <strong>Cash ${money(data.estimate.cash)}, Debt ${money(data.estimate.debt)}, Net ${money(data.estimate.net)}</strong></p>
      <p class="muted">Includes ${money(data.deltas?.income || 0)} expected income and ${money(data.deltas?.obligations || 0)} expected bills/payments.</p>
    </section>
    <section class="panel grid">
      <h2>Add Recurring Item</h2>
      <div class="grid two">
        <label>Day of month <input id="manual-regular-day" type="number" min="1" max="31" placeholder="15" /></label>
        <label>Amount <input id="manual-regular-amount" type="number" step="0.01" placeholder="-120.00" /></label>
      </div>
      <label>Description <input id="manual-regular-description" placeholder="Mortgage, paycheck, utility bill" /></label>
      <button id="add-manual-regular" type="button">Add Recurring Item</button>
    </section>
    ${renderGuessSection("Manual", manualGuesses)}
    ${renderGuessSection("Auto", autoGuesses)}
  `;
  $("#add-manual-regular").addEventListener("click", async () => {
    await api("/api/month-ahead/manual", {
      method: "POST",
      body: JSON.stringify({
        dayOfMonth: Number($("#manual-regular-day").value),
        description: $("#manual-regular-description").value,
        amount: Number($("#manual-regular-amount").value),
      }),
    });
    toast("Recurring item added");
    await renderMonthAhead();
  });
  page.querySelectorAll("[data-reject]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api("/api/month-ahead/reject", {
        method: "POST",
        body: JSON.stringify({ key: button.dataset.reject }),
      });
      await renderMonthAhead();
    });
  });
}

function renderGuessSection(title, guesses) {
  return `
    <section class="panel grid">
      <h2>${title}</h2>
      <div class="tx-list">
        ${guesses.map((guess) => `
          <div class="guess-row">
            <span class="muted">${guess.nextDate}</span>
            <span class="desc">${escapeHtml(guess.description)}<br><span class="muted">${guess.occurrences} occurrence${guess.occurrences === 1 ? "" : "s"}</span></span>
            <strong class="amount">${money(guess.amount)}</strong>
            <button class="danger" data-reject="${guess.key}" type="button">Reject</button>
          </div>
        `).join("") || `<p class="muted">No ${title.toLowerCase()} recurring transactions.</p>`}
      </div>
    </section>
  `;
}

async function renderMetrics() {
  const today = isoDate(new Date());
  state.metricsEndDate ||= today;
  state.metricsStartDate ||= isoDate(addDays(new Date(), -30));
  const params = new URLSearchParams({
    startDate: state.metricsStartDate,
    endDate: state.metricsEndDate,
  });
  const data = await api(`/api/metrics?${params.toString()}`);
  const page = $("#page-metrics");
  page.innerHTML = `
    <section class="panel grid">
      <div class="grid two">
        <label>Start date <input id="metrics-start" type="date" value="${data.startDate}" /></label>
        <label>End date <input id="metrics-end" type="date" value="${data.endDate}" /></label>
      </div>
      <button id="update-metrics" type="button">Update Metrics</button>
    </section>
    ${renderChartPanel("Net Balance", data.net, { format: money })}
    ${renderChartPanel("Non-Recurring Expenses", data.nonRecurringExpenses, { format: money, zeroFloor: true })}
    ${renderCategoryBars("Non-Recurring Expenses by Category", data.nonRecurringExpenseCategories || [], data.nonRecurringExpenseMccs || [])}
    ${renderChartPanel("Credit Card Payments", data.creditCardPayments, { format: money, zeroFloor: true })}
  `;
  bindChartHovers(page);
  $("#update-metrics").addEventListener("click", async () => {
    state.metricsStartDate = $("#metrics-start").value;
    state.metricsEndDate = $("#metrics-end").value;
    await renderMetrics();
  });
}

function renderChartPanel(title, points, { format = String, zeroFloor = false } = {}) {
  const values = points.map((point) => Number(point.value || 0));
  const latest = values.length ? values.at(-1) : 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  const subtitle = title === "Non-Recurring Expenses"
    ? `Total ${format(total)}`
    : `Latest ${format(latest)}`;
  return `
    <section class="panel chart-panel">
      <div class="chart-heading">
        <h2>${title}</h2>
        <span class="muted">${subtitle}</span>
      </div>
      ${renderLineChart(points, { format, zeroFloor })}
    </section>
  `;
}

function renderRawDiagnostics(diagnostics) {
  const candidates = diagnostics.categoryCandidates || [];
  return `
    <div class="panel">
      <strong>${diagnostics.transactionCount} SimpleFIN raw transactions analyzed</strong>
      <p class="muted">${diagnostics.fieldCount} raw field paths found.</p>
    </div>
    <div class="panel">
      <h3>Category-like Fields</h3>
      ${candidates.length ? candidates.map(renderDiagnosticField).join("") : `<p class="muted">No category-like raw fields found.</p>`}
    </div>
    <div class="panel">
      <h3>Most Common Raw Fields</h3>
      ${(diagnostics.commonFields || []).slice(0, 24).map(renderDiagnosticField).join("") || `<p class="muted">No raw fields found.</p>`}
    </div>
  `;
}

function renderDiagnosticField(field) {
  return `
    <div class="diagnostic-row">
      <span class="desc">${escapeHtml(field.path)}</span>
      <span class="muted">${field.count} tx</span>
      <span class="muted">${escapeHtml((field.types || []).join(", "))}</span>
      <span class="muted">${escapeHtml((field.sampleValues || []).join(", "))}</span>
    </div>
  `;
}

function renderCategoryBars(title, categories, mccs = []) {
  const max = Math.max(...categories.map((item) => Number(item.value || 0)), 0);
  return `
    <section class="panel chart-panel">
      <div class="chart-heading">
        <h2>${title}</h2>
        <span class="muted">Total ${money(categories.reduce((sum, item) => sum + Number(item.value || 0), 0))}</span>
      </div>
      <div class="category-bars">
        ${categories.length ? categories.map((item) => {
          const width = max ? Math.max(2, (Number(item.value || 0) / max) * 100) : 0;
          return `
            <div class="category-bar-row">
              <span class="category-name">${escapeHtml(item.category)}</span>
              <div class="category-bar-track"><span class="category-bar-fill" style="width:${width}%"></span></div>
              <strong class="amount">${money(item.value)}</strong>
            </div>
          `;
        }).join("") : `<p class="muted">No categorized expenses for this range.</p>`}
      </div>
      <details class="mcc-details">
        <summary>MCC coverage</summary>
        <div class="mcc-grid">
          ${mccs.length ? mccs.map((item) => `
            <span>${escapeHtml(item.mcc)}</span>
            <span>${escapeHtml(item.category)}</span>
            <span class="muted">${item.count} tx</span>
            <strong class="amount">${money(item.value)}</strong>
          `).join("") : `<p class="muted">No MCC data for this range.</p>`}
        </div>
      </details>
    </section>
  `;
}

function renderLineChart(points, { format = String, zeroFloor = false } = {}) {
  if (!points.length) return `<p class="muted">No data for this range.</p>`;
  const width = 900;
  const height = 260;
  const pad = { top: 18, right: 18, bottom: 34, left: 76 };
  const values = points.map((point) => Number(point.value || 0));
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min > 0) min = 0;
  if (zeroFloor) min = Math.min(0, min);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const xFor = (index) => pad.left + (points.length === 1 ? plotWidth : (index / (points.length - 1)) * plotWidth);
  const yFor = (value) => pad.top + ((max - value) / (max - min)) * plotHeight;
  const line = points.map((point, index) => `${xFor(index).toFixed(1)},${yFor(point.value).toFixed(1)}`).join(" ");
  const area = `${pad.left},${pad.top + plotHeight} ${line} ${pad.left + plotWidth},${pad.top + plotHeight}`;
  const yTicks = makeNumberTicks(min, max, 5);
  const xTicks = makeIndexTicks(points.length, 5);
  const hoverPoints = points.map((point, index) => ({
    date: point.date,
    label: format(point.value),
    x: Number(xFor(index).toFixed(1)),
    y: Number(yFor(point.value).toFixed(1)),
  }));
  return `
    <svg class="line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(points.length)} daily points" data-hover-points="${encodeURIComponent(JSON.stringify(hoverPoints))}">
      ${yTicks.map((tick) => `
        <line class="chart-grid" x1="${pad.left}" y1="${yFor(tick).toFixed(1)}" x2="${pad.left + plotWidth}" y2="${yFor(tick).toFixed(1)}" />
        <text class="chart-label y-label" x="8" y="${yFor(tick).toFixed(1)}">${escapeHtml(format(tick))}</text>
      `).join("")}
      ${xTicks.map((index) => `
        <line class="chart-tick" x1="${xFor(index).toFixed(1)}" y1="${pad.top + plotHeight}" x2="${xFor(index).toFixed(1)}" y2="${pad.top + plotHeight + 5}" />
        <text class="chart-label ${index === points.length - 1 ? "end-label" : ""}" x="${xFor(index).toFixed(1)}" y="${height - 8}">${escapeHtml(points[index].date)}</text>
      `).join("")}
      <polygon class="chart-area" points="${area}" />
      <polyline class="chart-line" points="${line}" />
      <g class="chart-hover hidden">
        <line class="chart-hover-line" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotHeight}" />
        <circle class="chart-hover-dot" cx="${pad.left}" cy="${pad.top + plotHeight}" r="5" />
        <rect class="chart-tooltip-box" x="${pad.left + 10}" y="${pad.top + 10}" width="132" height="44" rx="6" />
        <text class="chart-tooltip-date" x="${pad.left + 20}" y="${pad.top + 28}"></text>
        <text class="chart-tooltip-value" x="${pad.left + 20}" y="${pad.top + 48}"></text>
      </g>
    </svg>
  `;
}

function bindChartHovers(container) {
  container.querySelectorAll(".line-chart[data-hover-points]").forEach((svg) => {
    const points = JSON.parse(decodeURIComponent(svg.dataset.hoverPoints || "[]"));
    const hover = svg.querySelector(".chart-hover");
    const line = svg.querySelector(".chart-hover-line");
    const dot = svg.querySelector(".chart-hover-dot");
    const box = svg.querySelector(".chart-tooltip-box");
    const dateText = svg.querySelector(".chart-tooltip-date");
    const valueText = svg.querySelector(".chart-tooltip-value");
    if (!points.length || !hover || !line || !dot || !box || !dateText || !valueText) return;

    const viewBox = svg.viewBox.baseVal;
    const moveHover = (event) => {
      const rect = svg.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * viewBox.width;
      const nearest = points.reduce((best, point) => (
        Math.abs(point.x - x) < Math.abs(best.x - x) ? point : best
      ), points[0]);
      const tooltipWidth = 132;
      const tooltipX = nearest.x + tooltipWidth + 18 > viewBox.width ? nearest.x - tooltipWidth - 14 : nearest.x + 14;
      const tooltipY = Math.max(18, Math.min(viewBox.height - 58, nearest.y - 54));

      hover.classList.remove("hidden");
      line.setAttribute("x1", nearest.x);
      line.setAttribute("x2", nearest.x);
      dot.setAttribute("cx", nearest.x);
      dot.setAttribute("cy", nearest.y);
      box.setAttribute("x", tooltipX);
      box.setAttribute("y", tooltipY);
      dateText.setAttribute("x", tooltipX + 10);
      dateText.setAttribute("y", tooltipY + 18);
      valueText.setAttribute("x", tooltipX + 10);
      valueText.setAttribute("y", tooltipY + 36);
      dateText.textContent = nearest.date;
      valueText.textContent = nearest.label;
    };

    svg.addEventListener("mousemove", moveHover);
    svg.addEventListener("mouseleave", () => hover.classList.add("hidden"));
    svg.addEventListener("touchmove", (event) => {
      if (!event.touches[0]) return;
      moveHover(event.touches[0]);
    }, { passive: true });
    svg.addEventListener("touchend", () => hover.classList.add("hidden"));
  });
}

function makeNumberTicks(min, max, count) {
  if (count <= 1) return [min];
  return Array.from({ length: count }, (_, index) => {
    const value = min + ((max - min) * index) / (count - 1);
    return Number(value.toFixed(2));
  });
}

function makeIndexTicks(length, count) {
  if (length <= 1) return [0];
  const ticks = new Set();
  for (let index = 0; index < count; index += 1) {
    ticks.add(Math.round(((length - 1) * index) / (count - 1)));
  }
  return [...ticks].sort((a, b) => a - b);
}

function renderImport() {
  const page = $("#page-import");
  page.innerHTML = `
    <section class="panel grid">
      <h2>Create account</h2>
      <div class="grid two">
        <label>Name <input id="new-account-name" placeholder="New manual account" /></label>
        <label>Type
          <select id="new-account-type">
            <option value="cash">Cash / checking</option>
            <option value="credit">Credit / loan</option>
          </select>
        </label>
      </div>
      <button id="create-account" class="secondary" type="button">Create Account</button>
    </section>
    <section class="panel grid">
      <label>Import file <input id="import-file" type="file" accept=".csv,.xlsx,.xls" /></label>
      <label>CSV/generic XLSX account
        <select id="import-account">
          <option value="">Auto-detect workbook account blocks</option>
          ${state.accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("")}
        </select>
      </label>
      <button id="preview-import" type="button">Preview Import</button>
    </section>
    <section id="import-result" class="import-preview"></section>
  `;
  $("#create-account").addEventListener("click", async () => {
    const name = $("#new-account-name").value.trim();
    if (!name) return toast("Name the account first.");
    await api("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ name, type: $("#new-account-type").value }),
    });
    toast("Account created");
    await loadBootstrap();
    renderImport();
  });
  $("#preview-import").addEventListener("click", previewImport);
}

async function previewImport() {
  const file = $("#import-file").files[0];
  if (!file) return toast("Choose a CSV or Excel file first.");
  const contentBase64 = await fileToBase64(file);
  const accountId = $("#import-account").value || null;
  const preview = await api("/api/import/preview", {
    method: "POST",
    body: JSON.stringify({
      fileName: file.name,
      contentBase64,
      accountId,
      mode: accountId ? "generic" : "workbook",
    }),
  });
  $("#import-result").innerHTML = `
    <section class="panel">
      <strong>${preview.transactionCount} transactions</strong>
      <p class="muted">${preview.duplicateCount} likely duplicates across ${preview.accountCount} accounts.</p>
      <button id="commit-import" type="button">Confirm Import</button>
    </section>
    ${preview.accounts.map((account) => `
      <section class="panel grid">
        <strong>${escapeHtml(account.detectedAccountName || account.accountName)}</strong>
        <label>Import these columns into
          <select data-map-account="${account.accountId}">
            <option value="">Create new account: ${escapeHtml(account.accountName)}</option>
            ${state.accounts.map((a) => `<option value="${a.id}" ${a.id === account.matchedAccountId ? "selected" : ""}>${escapeHtml(a.name)}</option>`).join("")}
          </select>
        </label>
        <p class="muted">${account.total} rows, ${account.duplicates} duplicates, impact ${money(account.balanceImpact)}</p>
        ${account.sample.map((tx) => `<div class="transaction-row"><span>${tx.date}</span><span>${escapeHtml(tx.description)}</span><strong class="amount">${money(tx.amount)}</strong><span>${tx.balance === null ? "" : money(tx.balance)}</span></div>`).join("")}
      </section>
    `).join("")}
  `;
  $("#commit-import").addEventListener("click", async () => {
    const mappings = {};
    document.querySelectorAll("[data-map-account]").forEach((select) => {
      mappings[select.dataset.mapAccount] = { accountId: select.value || null };
    });
    const result = await api("/api/import/commit", {
      method: "POST",
      body: JSON.stringify({ previewId: preview.id, mappings }),
    });
    toast(`Imported ${result.inserted} transactions, ${result.correctionsInserted || 0} corrections`);
    await loadBootstrap();
  });
}

function renderSyncJob(job) {
  const details = job.details || {};
  const diagnostics = details.accountDiagnostics || [];
  const returned = diagnostics.reduce((sum, item) => sum + Number(item.transactionsReturned || 0), 0);
  const cleanup = details.duplicatesRemoved || details.staleRemoved
    ? `, removed ${details.duplicatesRemoved || 0}, missing ${details.staleRemoved || 0}`
    : "";
  const totals = `accounts ${details.accountsImported ?? "?"}, returned ${returned}, inserted ${details.transactionsImported ?? "?"}${cleanup}`;
  return `
    <div class="panel sync-job-card">
      <strong>${escapeHtml(job.kind)}: ${escapeHtml(job.status)}</strong>
      <p class="muted">${job.started_at}${job.finished_at ? ` to ${job.finished_at}` : ""}</p>
      <p class="muted">${escapeHtml(totals)}${details.errors?.length ? `, errors ${details.errors.length}` : ""}</p>
      ${diagnostics.length ? `
        <details>
          <summary>Account diagnostics</summary>
          <div class="sync-diagnostics">
            ${diagnostics.map((item) => `
              <span>${escapeHtml(item.name || item.accountId || "Account")}</span>
              <span class="muted">returned ${item.transactionsReturned ?? 0}</span>
              <span class="muted">inserted ${item.transactionsInserted ?? 0}</span>
              <span class="muted">removed ${item.duplicatesRemoved ?? 0}</span>
              <span class="muted">missing ${item.staleRemoved ?? 0}</span>
              <span class="muted">latest returned ${item.latestReturnedDate || "none"}</span>
              <span class="muted">latest stored ${item.latestStoredDate || "none"}</span>
              <span class="muted">balance ${item.balanceDate || "none"}</span>
            `).join("")}
          </div>
        </details>
      ` : `<p class="muted">No per-account diagnostics recorded for this older job.</p>`}
    </div>
  `;
}

async function renderSettings() {
  const settings = await api("/api/settings/simplefin");
  const allAccounts = settings.accounts;
  const hiddenAccounts = settings.accounts.filter((account) => account.hidden);
  const dailyEnabledDisabled = !settings.sync.firstUserPullAt ? "disabled" : "";
  const page = $("#page-settings");
  page.innerHTML = `
    <section class="panel grid">
      <h2>SimpleFIN</h2>
      <a href="${settings.createUrl}" target="_blank" rel="noreferrer"><button type="button">Get setup token</button></a>
      <label>Token label <input id="sf-label" placeholder="SimpleFIN / MX" /></label>
      <label>Setup token <textarea id="sf-token" rows="3"></textarea></label>
      <button id="claim-token" type="button">Claim token</button>
      <h3>Pull Date Range</h3>
      <div class="grid two">
        <label>Start date <input id="sf-start-date" type="date" /></label>
        <label>End date <input id="sf-end-date" type="date" /></label>
      </div>
      <button id="refresh-simplefin" class="secondary" type="button">Start Pull Job</button>
      <button id="force-today-simplefin" class="secondary" type="button">Force Sync Today</button>
      <h3>Daily Pull</h3>
      <div class="grid two">
        <label>Hour
          <input id="sync-hour" type="number" min="0" max="23" value="${settings.sync.dailyHour}" />
        </label>
        <label class="checkbox-row">
          <input id="sync-enabled" type="checkbox" ${settings.sync.dailyEnabled ? "checked" : ""} ${dailyEnabledDisabled} />
          Enable daily pull
        </label>
      </div>
      <button id="save-sync-settings" class="secondary" type="button">Save Schedule</button>
      ${settings.sync.firstUserPullAt ? `<p class="muted">Last pulled through ${settings.sync.lastPulledThrough || "unknown"}.</p>` : `<p class="muted">Daily pull unlocks after the first manual date-range pull.</p>`}
      <div class="table-like">
        ${settings.connections.map((c) => `<div class="panel"><strong>${escapeHtml(c.label || c.id)}</strong><p class="muted">${escapeHtml(c.tokenPreview)}</p><p class="muted">Last sync: ${c.lastSyncAt || "never"}</p><button class="danger" data-delete-token="${c.id}" type="button">Remove token</button></div>`).join("") || `<p class="muted">No SimpleFIN tokens saved.</p>`}
      </div>
      <h3>Sync Jobs</h3>
      <div class="table-like">
        ${settings.jobs.map(renderSyncJob).join("") || `<p class="muted">No sync jobs yet.</p>`}
      </div>
    </section>
    <section class="panel grid">
      <h2>Raw Field Diagnostics</h2>
      <button id="run-raw-diagnostics" class="secondary" type="button">Analyze Raw Fields</button>
      <div id="raw-diagnostics" class="table-like"></div>
    </section>
    <section class="panel grid">
      <h2>Link Accounts</h2>
      <p class="muted">Move transactions from an imported/manual account into a SimpleFIN account.</p>
      <label>Source account
        <select id="merge-source">
          ${allAccounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}${a.hidden ? " (hidden)" : ""}</option>`).join("")}
        </select>
      </label>
      <label>Target account
        <select id="merge-target">
          ${allAccounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}${a.hidden ? " (hidden)" : ""}</option>`).join("")}
        </select>
      </label>
      <button id="merge-accounts" class="secondary" type="button">Merge Accounts</button>
    </section>
    <section class="panel grid">
      <h2>Hidden Accounts</h2>
      ${hiddenAccounts.map((a) => `<div class="transaction-row"><span></span><span>${escapeHtml(a.name)}</span><span class="muted">${escapeHtml(a.type)}</span><button data-unhide-account="${a.id}" type="button">Unhide</button></div>`).join("") || `<p class="muted">No hidden accounts.</p>`}
    </section>
    <section class="panel grid">
      <h2>Password</h2>
      <label>Current password <input id="current-password" type="password" /></label>
      <label>New password <input id="new-password" type="password" /></label>
      <button id="change-password" type="button">Update password</button>
    </section>
    <section class="panel">
      <button id="logout" class="secondary" type="button">Log out</button>
    </section>
  `;
  $("#claim-token").addEventListener("click", async () => {
    await api("/api/settings/simplefin", {
      method: "POST",
      body: JSON.stringify({ setupToken: $("#sf-token").value, label: $("#sf-label").value }),
    });
    toast("Token saved");
    await renderSettings();
  });
  $("#refresh-simplefin").addEventListener("click", async () => {
    const result = await api("/api/settings/simplefin/refresh", {
      method: "POST",
      body: JSON.stringify({
        startDate: $("#sf-start-date").value,
        endDate: $("#sf-end-date").value,
      }),
    });
    toast(`Started sync job ${result.id}`);
    await renderSettings();
  });
  $("#force-today-simplefin").addEventListener("click", async () => {
    const result = await api("/api/settings/simplefin/force-today", { method: "POST" });
    toast(`Started force sync ${result.id}`);
    await renderSettings();
  });
  $("#save-sync-settings").addEventListener("click", async () => {
    await api("/api/settings/sync", {
      method: "PATCH",
      body: JSON.stringify({
        dailyHour: Number($("#sync-hour").value),
        dailyEnabled: $("#sync-enabled").checked,
      }),
    });
    toast("Schedule saved");
    await renderSettings();
  });
  $("#run-raw-diagnostics").addEventListener("click", async () => {
    const diagnostics = await api("/api/settings/raw-field-diagnostics");
    $("#raw-diagnostics").innerHTML = renderRawDiagnostics(diagnostics);
  });
  page.querySelectorAll("[data-delete-token]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/settings/simplefin/${encodeURIComponent(button.dataset.deleteToken)}`, { method: "DELETE" });
      toast("Token removed");
      await renderSettings();
    });
  });
  page.querySelectorAll("[data-unhide-account]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/accounts/${button.dataset.unhideAccount}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      toast("Account unhidden");
      await loadBootstrap();
      await renderSettings();
    });
  });
  $("#merge-accounts").addEventListener("click", async () => {
    await api("/api/accounts/merge", {
      method: "POST",
      body: JSON.stringify({
        sourceAccountId: $("#merge-source").value,
        targetAccountId: $("#merge-target").value,
      }),
    });
    toast("Accounts merged");
    await loadBootstrap();
    await renderSettings();
  });
  $("#change-password").addEventListener("click", async () => {
    await api("/api/settings/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: $("#current-password").value, newPassword: $("#new-password").value }),
    });
    toast("Password updated");
  });
  $("#logout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    location.reload();
  });
}

async function renderActivity() {
  const data = await api("/api/activity");
  $("#page-activity").innerHTML = `<pre class="log">${escapeHtml(data.logs.map((log) => `[${log.created_at}] ${log.level}: ${log.message} ${log.details ? JSON.stringify(log.details) : ""}`).join("\n"))}</pre>`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

init().catch((error) => {
  console.error(error);
  toast(error.message);
});
