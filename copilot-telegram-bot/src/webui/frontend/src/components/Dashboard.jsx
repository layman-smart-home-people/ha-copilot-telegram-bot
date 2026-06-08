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
      onVersion(data.bot?.version || "1.0.0");
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
  const pool = s.pool || {};
  const si = s.standing || {};
  const metrics = s.metrics || {};
  const convos = s.conversations || [];

  return (
    <>
      <div className="card-grid">
        <div className="card">
          <div className="card-title">⏱️ Uptime</div>
          <div className="card-value">{formatUptime(s.bot?.uptime)}</div>
          <div className="card-sub">Since {formatTime(s.bot?.startedAt)}</div>
        </div>

        <div className="card">
          <div className="card-title">🤖 Pool</div>
          <div className="card-value">{pool.claimed || 0} / {pool.maxSize || 5}</div>
          <div className="card-sub">
            {pool.idle || 0} idle · {pool.booting || 0} booting
          </div>
        </div>

        <div className="card">
          <div className="card-title">🏠 Home Assistant</div>
          <div className="card-value">
            <StatusBadge online={s.homeAssistant?.connected} />
          </div>
          <div className="card-sub">WebSocket events</div>
        </div>

        <div className="card">
          <div className="card-title">💬 Conversations</div>
          <div className="card-value">{convos.length}</div>
          <div className="card-sub">
            {convos.filter(c => c.state === "prompting").length} active
          </div>
        </div>
      </div>

      {/* Pool Instances */}
      {pool.instances?.length > 0 && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <div className="card-title">🔌 Pool Instances</div>
          <ul className="module-list">
            {pool.instances.map((inst) => (
              <li key={inst.id} className="module-item">
                <span className={`status-dot ${inst.state === "claimed" ? "online" : inst.state === "idle" ? "warning" : "offline"}`} />
                <span className="module-name">{inst.id}</span>
                <span className="module-detail">
                  {inst.model === "fast" ? "⚡Haiku" : inst.model === "reasoning" ? "🧠Opus" : "🔵Sonnet"}
                  {inst.claimedBy ? ` → ${inst.claimedBy}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Metrics + SI */}
      <div className="card-grid" style={{ marginTop: "1rem" }}>
        <div className="card">
          <div className="card-title">📈 Metrics</div>
          <div className="card-value">{metrics.totalPrompts || 0}</div>
          <div className="card-sub">
            prompts · {((metrics.totalMs || 0) / 1000).toFixed(1)}s total
            {metrics.totalCrashes > 0 && ` · ⚠️ ${metrics.totalCrashes} crashes`}
          </div>
        </div>

        <div className="card">
          <div className="card-title">📌 Standing Instructions</div>
          <div className="card-value">
            {si.started ? (
              <StatusBadge online={true} paused={si.paused} />
            ) : (
              <StatusBadge online={false} />
            )}
          </div>
          <div className="card-sub">
            {si.enabled || 0}/{si.total || 0} active · {si.triggerCount || 0} triggers
          </div>
        </div>
      </div>
    </>
  );
}
