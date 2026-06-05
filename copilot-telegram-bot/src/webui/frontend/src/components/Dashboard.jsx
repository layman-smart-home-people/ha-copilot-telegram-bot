import { useState, useEffect, useCallback, useRef } from "react";
import { api, apiWithRetry } from "../api";

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

function StatusBadge({ online, paused }) {
  if (paused) {
    return (
      <span className="status-badge paused">
        <span className="status-dot warning" />
        Paused
      </span>
    );
  }
  return (
    <span className={`status-badge ${online ? "online" : "offline"}`}>
      <span className={`status-dot ${online ? "online" : "offline"}`} />
      {online ? "Connected" : "Disconnected"}
    </span>
  );
}

export default function Dashboard({ toast, onVersion }) {
  const [status, setStatus] = useState(null);
  const initialRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const fetcher = initialRef.current ? apiWithRetry : api;
      initialRef.current = false;
      const data = await fetcher("/status");
      setStatus(data);
      onVersion(data.bot.version);
    } catch (err) {
      toast(`Failed to load status: ${err.message}`, "error");
    }
  }, [toast, onVersion]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  if (!status) {
    return (
      <div className="card-grid">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="card">
            <div className="skeleton" style={{ height: 20, width: "60%", marginBottom: 8 }} />
            <div className="skeleton" style={{ height: 36, width: "40%" }} />
          </div>
        ))}
      </div>
    );
  }

  const s = status;
  const orch = s.orchestrator || {};

  const modules = [
    {
      name: "Telegram Bot",
      online: true,
      detail: s.bot.promptActive ? "Processing prompt…" : "Idle",
    },
    {
      name: "Copilot ACP",
      online: s.copilot.connected,
      detail: s.copilot.connected ? `Model: ${s.copilot.model || "auto"}` : "Not started",
    },
    {
      name: "HA WebSocket",
      online: orch.haConnected ?? false,
      detail: orch.haConnected ? "Subscribed to events" : "Disconnected",
    },
    {
      name: "Standing Instructions",
      online: orch.started ?? false,
      paused: orch.paused,
      detail: orch.paused
        ? "Paused"
        : `${orch.enabled || 0}/${orch.total || 0} active · ${orch.triggerCount || 0} triggers`,
    },
  ];

  return (
    <>
      <div className="card-grid">
        <div className="card">
          <div className="card-title">⏱️ Uptime</div>
          <div className="card-value">{formatUptime(s.bot.uptime)}</div>
          <div className="card-sub">Since {formatTime(s.bot.startedAt)}</div>
        </div>

        <div className="card">
          <div className="card-title">🤖 Copilot</div>
          <div className="card-value">
            <StatusBadge online={s.copilot.connected} />
          </div>
          <div className="card-sub">Model: {s.copilot.model || "auto"}</div>
        </div>

        <div className="card">
          <div className="card-title">🏠 Home Assistant</div>
          <div className="card-value">
            <StatusBadge online={s.homeAssistant.connected} />
          </div>
          <div className="card-sub">
            {s.homeAssistant.version ? `v${s.homeAssistant.version}` : "—"}
          </div>
        </div>

        <div className="card">
          <div className="card-title">💬 Scopes</div>
          <div className="card-value">{s.scopes.total}</div>
          <div className="card-sub">
            {s.scopes.dm} DM · {s.scopes.group} group · {s.scopes.forum} forum
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <div className="card-title">🔌 Modules</div>
        <ul className="module-list">
          {modules.map((m) => (
            <li key={m.name} className="module-item">
              <span
                className={`status-dot ${m.paused ? "warning" : m.online ? "online" : "offline"}`}
              />
              <span className="module-name">{m.name}</span>
              <span className="module-detail">{m.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
