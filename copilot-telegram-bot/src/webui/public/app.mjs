// ============================================================
// Copilot Bot Dashboard — Frontend Application
// ============================================================

const BASE = "";  // relative to ingress

// ── API Helpers ─────────────────────────────────────────────

async function api(path, opts = {}) {
    const res = await fetch(`${BASE}/api${path}`, {
        headers: { "Content-Type": "application/json", ...opts.headers },
        ...opts,
    });
    if (res.status === 204) return null;
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

// ── Toast ───────────────────────────────────────────────────

function toast(message, type = "success") {
    const container = document.getElementById("toast-container");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = type === "error" ? `❌ ${message}` : `✅ ${message}`;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3500);
}

// ── Tab Navigation ──────────────────────────────────────────

function initTabs() {
    const tabBar = document.getElementById("tab-bar");
    const tabs = tabBar.querySelectorAll(".tab-btn");

    tabBar.addEventListener("click", (e) => {
        const btn = e.target.closest(".tab-btn");
        if (!btn) return;

        const tabId = btn.dataset.tab;
        tabs.forEach(t => t.classList.toggle("active", t === btn));
        document.querySelectorAll(".tab-content").forEach(c =>
            c.classList.toggle("active", c.id === `tab-${tabId}`)
        );

        // Lazy-load tab data
        if (tabId === "instructions") loadInstructions();
        if (tabId === "docs") loadDocs();
    });
}

// ── Dashboard ───────────────────────────────────────────────

function formatUptime(seconds) {
    if (!seconds || seconds < 0) return "—";
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function formatTime(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString();
}

async function loadDashboard() {
    try {
        const status = await api("/status");
        renderDashboard(status);
    } catch (err) {
        toast(`Failed to load status: ${err.message}`, "error");
    }
}

function renderDashboard(s) {
    document.getElementById("version-label").textContent = `v${s.bot.version}`;

    // Status cards
    const cardsHtml = `
        <div class="card">
            <div class="card-title">⏱️ Uptime</div>
            <div class="card-value">${formatUptime(s.bot.uptime)}</div>
            <div class="card-sub">Since ${formatTime(s.bot.startedAt)}</div>
        </div>
        <div class="card">
            <div class="card-title">🤖 Copilot</div>
            <div class="card-value">
                <span class="status-badge ${s.copilot.connected ? "online" : "offline"}">
                    <span class="status-dot ${s.copilot.connected ? "online" : "offline"}"></span>
                    ${s.copilot.connected ? "Connected" : "Disconnected"}
                </span>
            </div>
            <div class="card-sub">Model: ${s.copilot.model || "auto"}</div>
        </div>
        <div class="card">
            <div class="card-title">🏠 Home Assistant</div>
            <div class="card-value">
                <span class="status-badge ${s.homeAssistant.connected ? "online" : "offline"}">
                    <span class="status-dot ${s.homeAssistant.connected ? "online" : "offline"}"></span>
                    ${s.homeAssistant.connected ? "Connected" : "Disconnected"}
                </span>
            </div>
            <div class="card-sub">${s.homeAssistant.version ? `v${s.homeAssistant.version}` : "—"}</div>
        </div>
        <div class="card">
            <div class="card-title">💬 Scopes</div>
            <div class="card-value">${s.scopes.total}</div>
            <div class="card-sub">${s.scopes.dm} DM · ${s.scopes.group} group · ${s.scopes.forum} forum</div>
        </div>
    `;
    document.getElementById("status-cards").innerHTML = cardsHtml;

    // Module list
    const orchStatus = s.orchestrator || {};
    const modules = [
        {
            name: "Telegram Bot",
            online: true, // if we're seeing data, it's running
            detail: s.bot.promptActive ? "Processing prompt..." : "Idle",
        },
        {
            name: "Copilot ACP",
            online: s.copilot.connected,
            detail: s.copilot.connected ? `Model: ${s.copilot.model || "auto"}` : "Not started",
        },
        {
            name: "HA WebSocket",
            online: orchStatus.haConnected ?? false,
            detail: orchStatus.haConnected ? "Subscribed to events" : "Disconnected",
        },
        {
            name: "Standing Instructions",
            online: orchStatus.started ?? false,
            detail: orchStatus.paused
                ? "Paused"
                : `${orchStatus.enabled || 0}/${orchStatus.total || 0} active · ${orchStatus.triggerCount || 0} triggers`,
            paused: orchStatus.paused,
        },
    ];

    document.getElementById("module-list").innerHTML = modules.map(m => `
        <li class="module-item">
            <span class="status-dot ${m.paused ? "warning" : (m.online ? "online" : "offline")}"></span>
            <span class="module-name">${m.name}</span>
            <span class="module-detail">${m.detail}</span>
        </li>
    `).join("");
}

// ── Instructions ────────────────────────────────────────────

let cachedInstructions = [];

async function loadInstructions() {
    try {
        cachedInstructions = await api("/instructions");
        renderInstructions(cachedInstructions);
        document.getElementById("instr-count").textContent = cachedInstructions.length;
    } catch (err) {
        toast(`Failed to load instructions: ${err.message}`, "error");
    }
}

function renderInstructions(instructions) {
    const container = document.getElementById("instr-list");

    if (!instructions.length) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="icon">📋</div>
                <p>No standing instructions yet. Create one to automate agent responses.</p>
            </div>`;
        return;
    }

    container.innerHTML = instructions.map(instr => {
        const triggerType = instr.trigger?.type || "unknown";
        const actionType = instr.action?.type || "unknown";
        const triggerLabel = triggerType === "state_change"
            ? (Array.isArray(instr.trigger.entity_id) ? instr.trigger.entity_id.join(", ") : instr.trigger.entity_id)
            : triggerType === "cron" ? instr.trigger.expression
            : triggerType === "timer" ? new Date(instr.trigger.fire_at).toLocaleString()
            : "—";

        const lastTriggered = instr.last_triggered_at
            ? `Last: ${new Date(instr.last_triggered_at).toLocaleString()}`
            : "Never triggered";

        return `
        <div class="instr-card ${instr.enabled ? "" : "disabled"}" data-id="${instr.id}">
            <div class="instr-header">
                <div class="instr-desc">${escHtml(instr.description)}</div>
                <div class="instr-actions">
                    <label class="toggle" title="${instr.enabled ? "Disable" : "Enable"}">
                        <input type="checkbox" ${instr.enabled ? "checked" : ""} data-toggle-id="${instr.id}">
                        <span class="toggle-slider"></span>
                    </label>
                </div>
            </div>
            <div class="instr-meta">
                <span class="instr-tag trigger-${triggerType}">${triggerType}</span>
                <span class="instr-tag action-${actionType}">${actionType}</span>
                <span>${escHtml(triggerLabel)}</span>
                <span>·</span>
                <span>${lastTriggered}</span>
                ${instr.trigger_count ? `<span>· ${instr.trigger_count} triggers</span>` : ""}
                ${instr.cooldown_seconds ? `<span>· ${instr.cooldown_seconds}s cooldown</span>` : ""}
            </div>
        </div>`;
    }).join("");

    // Toggle handlers
    container.querySelectorAll("[data-toggle-id]").forEach(el => {
        el.addEventListener("change", async (e) => {
            e.stopPropagation();
            const id = el.dataset.toggleId;
            const action = el.checked ? "enable" : "disable";
            try {
                await api(`/instructions/${encodeURIComponent(id)}/${action}`, { method: "POST" });
                toast(`Instruction ${action}d`);
                loadInstructions();
            } catch (err) {
                toast(err.message, "error");
                loadInstructions();
            }
        });
    });

    // Click to edit
    container.querySelectorAll(".instr-card").forEach(el => {
        el.addEventListener("click", (e) => {
            if (e.target.closest(".toggle")) return;
            const id = el.dataset.id;
            const instr = cachedInstructions.find(i => i.id === id);
            if (instr) openInstrModal(instr);
        });
    });
}

// ── Instruction Modal ───────────────────────────────────────

function openInstrModal(instr = null) {
    const tmpl = document.getElementById("tmpl-instr-modal");
    const clone = tmpl.content.cloneNode(true);
    document.body.appendChild(clone);

    const modal = document.getElementById("instr-modal");
    const form = document.getElementById("instr-form");
    const isEdit = !!instr;

    document.getElementById("modal-title-text").textContent = isEdit ? "Edit Instruction" : "New Instruction";
    document.getElementById("btn-modal-delete").style.display = isEdit ? "inline-flex" : "none";

    // Wire trigger type switching
    const triggerSelect = document.getElementById("instr-trigger-type");
    const actionSelect = document.getElementById("instr-action-type");

    function updateTriggerFields() {
        const type = triggerSelect.value;
        document.getElementById("trigger-state-fields").style.display = type === "state_change" ? "block" : "none";
        document.getElementById("trigger-cron-fields").style.display = type === "cron" ? "block" : "none";
        document.getElementById("trigger-timer-fields").style.display = type === "timer" ? "block" : "none";
    }

    function updateActionFields() {
        const type = actionSelect.value;
        document.getElementById("action-wake-fields").style.display = type === "wake_agent" ? "block" : "none";
        document.getElementById("action-notify-fields").style.display = type === "notify" ? "block" : "none";
    }

    triggerSelect.addEventListener("change", updateTriggerFields);
    actionSelect.addEventListener("change", updateActionFields);

    // Populate form if editing
    if (instr) {
        document.getElementById("instr-id").value = instr.id;
        document.getElementById("instr-desc").value = instr.description || "";
        triggerSelect.value = instr.trigger?.type || "state_change";
        actionSelect.value = instr.action?.type || "wake_agent";

        // State change fields
        if (instr.trigger?.type === "state_change") {
            const entityId = Array.isArray(instr.trigger.entity_id)
                ? instr.trigger.entity_id.join(", ")
                : instr.trigger.entity_id || "";
            document.getElementById("instr-entity").value = entityId;
            document.getElementById("instr-from").value = instr.trigger.from || "";
            document.getElementById("instr-to").value = instr.trigger.to || "";
            document.getElementById("instr-above").value = instr.trigger.above ?? "";
            document.getElementById("instr-below").value = instr.trigger.below ?? "";
            document.getElementById("instr-attribute").value = instr.trigger.attribute || "";
        }

        // Cron fields
        if (instr.trigger?.type === "cron") {
            document.getElementById("instr-cron").value = instr.trigger.expression || "";
        }

        // Timer fields
        if (instr.trigger?.type === "timer" && instr.trigger.fire_at) {
            const dt = new Date(instr.trigger.fire_at);
            document.getElementById("instr-fire-at").value = toLocalDatetime(dt);
        }

        // Action fields
        if (instr.action?.type === "wake_agent") {
            document.getElementById("instr-prompt").value = instr.action.prompt || "";
        }
        if (instr.action?.type === "notify") {
            document.getElementById("instr-message").value = instr.action.message || "";
        }

        // Options
        document.getElementById("instr-cooldown").value = instr.cooldown_seconds ?? 300;
        document.getElementById("instr-max-triggers").value = instr.max_triggers ?? "";
        document.getElementById("instr-one-shot").checked = !!instr.one_shot;
    }

    updateTriggerFields();
    updateActionFields();

    // Close handlers
    const closeModal = () => modal.remove();
    document.getElementById("modal-close").addEventListener("click", closeModal);
    document.getElementById("btn-modal-cancel").addEventListener("click", closeModal);
    modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

    // Delete handler
    document.getElementById("btn-modal-delete").addEventListener("click", async () => {
        if (!confirm("Delete this instruction?")) return;
        try {
            await api(`/instructions/${encodeURIComponent(instr.id)}`, { method: "DELETE" });
            toast("Instruction deleted");
            closeModal();
            loadInstructions();
        } catch (err) {
            toast(err.message, "error");
        }
    });

    // Save handler
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const body = buildInstrBody();
        try {
            if (isEdit) {
                await api(`/instructions/${encodeURIComponent(instr.id)}`, {
                    method: "PUT",
                    body: JSON.stringify(body),
                });
                toast("Instruction updated");
            } else {
                await api("/instructions", {
                    method: "POST",
                    body: JSON.stringify(body),
                });
                toast("Instruction created");
            }
            closeModal();
            loadInstructions();
        } catch (err) {
            toast(err.message, "error");
        }
    });
}

function buildInstrBody() {
    const triggerType = document.getElementById("instr-trigger-type").value;
    const actionType = document.getElementById("instr-action-type").value;

    const body = {
        description: document.getElementById("instr-desc").value.trim(),
        cooldown_seconds: parseInt(document.getElementById("instr-cooldown").value) || 0,
        one_shot: document.getElementById("instr-one-shot").checked,
    };

    const maxTriggers = document.getElementById("instr-max-triggers").value;
    body.max_triggers = maxTriggers ? parseInt(maxTriggers) : null;

    // Trigger
    if (triggerType === "state_change") {
        const raw = document.getElementById("instr-entity").value.trim();
        const entityId = raw.includes(",") ? raw.split(",").map(s => s.trim()).filter(Boolean) : raw;

        body.trigger = {
            type: "state_change",
            entity_id: entityId,
            from: document.getElementById("instr-from").value.trim() || null,
            to: document.getElementById("instr-to").value.trim() || null,
            above: parseFloatOrNull(document.getElementById("instr-above").value),
            below: parseFloatOrNull(document.getElementById("instr-below").value),
            attribute: document.getElementById("instr-attribute").value.trim() || null,
        };
    } else if (triggerType === "cron") {
        body.trigger = {
            type: "cron",
            expression: document.getElementById("instr-cron").value.trim(),
        };
    } else if (triggerType === "timer") {
        const fireAt = document.getElementById("instr-fire-at").value;
        body.trigger = {
            type: "timer",
            fire_at: fireAt ? new Date(fireAt).toISOString() : "",
        };
    }

    // Action
    if (actionType === "wake_agent") {
        body.action = {
            type: "wake_agent",
            prompt: document.getElementById("instr-prompt").value.trim(),
        };
    } else if (actionType === "notify") {
        body.action = {
            type: "notify",
            message: document.getElementById("instr-message").value.trim(),
        };
    }

    return body;
}

// ── Docs ────────────────────────────────────────────────────

let docsCache = [];
let activeDocName = null;
let docDirty = false;

async function loadDocs() {
    try {
        docsCache = await api("/docs");
        renderDocsSidebar(docsCache);
    } catch (err) {
        toast(`Failed to load docs: ${err.message}`, "error");
    }
}

function renderDocsSidebar(docs) {
    const list = document.getElementById("docs-file-list");
    const mainDocs = docs.filter(d => d.type === "main");
    const dailyLogs = docs.filter(d => d.type === "daily_log");

    let html = `<li class="docs-file-item section-header">Agent Config</li>`;
    html += mainDocs.map(d => `
        <li class="docs-file-item ${d.name === activeDocName ? "active" : ""}"
            data-doc="${escAttr(d.name)}" title="${escAttr(d.path)}">
            📄 ${d.name}
        </li>
    `).join("");

    if (dailyLogs.length) {
        html += `<li class="docs-file-item section-header">Daily Logs</li>`;
        html += dailyLogs.map(d => {
            const label = d.name.replace("memory/", "");
            return `
                <li class="docs-file-item ${d.name === activeDocName ? "active" : ""}"
                    data-doc="${escAttr(d.name)}">
                    📅 ${label}
                </li>`;
        }).join("");
    }

    list.innerHTML = html;

    // Click handlers
    list.querySelectorAll("[data-doc]").forEach(el => {
        el.addEventListener("click", () => openDoc(el.dataset.doc));
    });
}

async function openDoc(name) {
    if (docDirty && activeDocName && name !== activeDocName) {
        if (!confirm("Unsaved changes will be lost. Continue?")) return;
    }

    activeDocName = name;
    docDirty = false;

    // Update sidebar selection
    document.querySelectorAll(".docs-file-item[data-doc]").forEach(el =>
        el.classList.toggle("active", el.dataset.doc === name)
    );

    try {
        const data = await api(`/docs/${encodeURIComponent(name)}`);
        document.getElementById("docs-empty").style.display = "none";
        const activeEl = document.getElementById("docs-active");
        activeEl.style.display = "flex";
        document.getElementById("docs-filename").textContent = name;
        document.getElementById("docs-textarea").value = data.content;
    } catch (err) {
        toast(`Failed to load ${name}: ${err.message}`, "error");
    }
}

function initDocsEditor() {
    const textarea = document.getElementById("docs-textarea");
    textarea.addEventListener("input", () => { docDirty = true; });

    // Tab key support in textarea
    textarea.addEventListener("keydown", (e) => {
        if (e.key === "Tab") {
            e.preventDefault();
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            textarea.value = textarea.value.substring(0, start) + "  " + textarea.value.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + 2;
            docDirty = true;
        }
        // Ctrl+S / Cmd+S to save
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            saveDoc();
        }
    });

    document.getElementById("btn-docs-save").addEventListener("click", saveDoc);
}

async function saveDoc() {
    if (!activeDocName) return;
    const content = document.getElementById("docs-textarea").value;
    try {
        await api(`/docs/${encodeURIComponent(activeDocName)}`, {
            method: "PUT",
            body: JSON.stringify({ content }),
        });
        docDirty = false;
        toast(`Saved ${activeDocName}`);
    } catch (err) {
        toast(`Failed to save: ${err.message}`, "error");
    }
}

// ── Utils ───────────────────────────────────────────────────

function escHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

function escAttr(str) {
    return str.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function parseFloatOrNull(val) {
    if (!val && val !== 0) return null;
    const n = parseFloat(val);
    return Number.isFinite(n) ? n : null;
}

function toLocalDatetime(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ── Auto-Refresh ────────────────────────────────────────────

let refreshTimer = null;

function startAutoRefresh() {
    loadDashboard();
    refreshTimer = setInterval(() => {
        const activeTab = document.querySelector(".tab-btn.active")?.dataset.tab;
        if (activeTab === "dashboard") loadDashboard();
    }, 15_000);
}

// ── Init ────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    initTabs();
    initDocsEditor();
    startAutoRefresh();

    // New instruction button
    document.getElementById("btn-new-instr").addEventListener("click", () => openInstrModal());
});
