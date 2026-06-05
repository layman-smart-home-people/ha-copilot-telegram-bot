import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../api";

const LOG_LEVELS = {
  ERROR: { color: "var(--red)", label: "ERROR" },
  WARNING: { color: "var(--yellow)", label: "WARN" },
  STANDING: { color: "var(--purple)", label: "STANDING" },
  WEBUI: { color: "var(--accent)", label: "WEBUI" },
  ACP: { color: "var(--green)", label: "ACP" },
  INFO: { color: "var(--text-secondary)", label: "INFO" },
};

function classifyLine(line) {
  if (line.includes("ERROR") || line.includes("FATAL")) return "ERROR";
  if (line.includes("WARNING")) return "WARNING";
  if (line.includes("[STANDING]")) return "STANDING";
  if (line.includes("[WEBUI]")) return "WEBUI";
  if (line.includes("ACP")) return "ACP";
  return "INFO";
}

export default function LogViewer({ toast }) {
  const [logs, setLogs] = useState([]);
  const [filter, setFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("ALL");
  const [autoScroll, setAutoScroll] = useState(true);
  const [connected, setConnected] = useState(false);
  const containerRef = useRef(null);
  const sseRef = useRef(null);

  // Load initial logs
  useEffect(() => {
    api("/logs")
      .then((data) => setLogs(data))
      .catch((err) => toast(`Failed to load logs: ${err.message}`, "error"));
  }, [toast]);

  // SSE live stream
  useEffect(() => {
    const evtSource = new EventSource("./api/logs/stream");
    sseRef.current = evtSource;

    evtSource.onopen = () => setConnected(true);
    evtSource.onmessage = (event) => {
      try {
        const entry = JSON.parse(event.data);
        setLogs((prev) => {
          const next = [...prev, entry];
          return next.length > 1000 ? next.slice(-500) : next;
        });
      } catch {}
    };
    evtSource.onerror = () => setConnected(false);

    return () => {
      evtSource.close();
      sseRef.current = null;
    };
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(atBottom);
  }, []);

  const clearLogs = () => setLogs([]);

  // Filter logs
  const filterLower = filter.toLowerCase();
  const filtered = logs.filter((entry) => {
    const level = classifyLine(entry.line);
    if (levelFilter !== "ALL" && level !== levelFilter) return false;
    if (filterLower && !entry.line.toLowerCase().includes(filterLower)) return false;
    return true;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 140px)" }}>
      <div className="instr-toolbar" style={{ flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <h2 style={{ fontSize: "1.1rem" }}>Logs</h2>
          <span
            className={`status-badge ${connected ? "online" : "offline"}`}
            style={{ fontSize: "0.75rem" }}
          >
            <span className={`status-dot ${connected ? "online" : "offline"}`} />
            {connected ? "Live" : "Disconnected"}
          </span>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            type="text"
            placeholder="Filter..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{
              padding: "0.35rem 0.6rem",
              background: "var(--bg-input)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              color: "var(--text-primary)",
              fontFamily: "var(--font)",
              fontSize: "0.85rem",
              width: "160px",
            }}
          />
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            style={{
              padding: "0.35rem 0.5rem",
              background: "var(--bg-input)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              color: "var(--text-primary)",
              fontFamily: "var(--font)",
              fontSize: "0.85rem",
            }}
          >
            <option value="ALL">All levels</option>
            {Object.entries(LOG_LEVELS).map(([key, { label }]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <button className="btn btn-sm" onClick={clearLogs}>
            Clear
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflow: "auto",
          background: "var(--bg-primary)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.8rem",
          lineHeight: "1.6",
          padding: "0.5rem",
        }}
      >
        {filtered.length === 0 ? (
          <div className="empty-state" style={{ padding: "2rem" }}>
            <p>No log entries{filter || levelFilter !== "ALL" ? " matching filters" : ""}</p>
          </div>
        ) : (
          filtered.map((entry, i) => {
            const level = classifyLine(entry.line);
            const levelInfo = LOG_LEVELS[level] || LOG_LEVELS.INFO;
            return (
              <div
                key={`${entry.ts}-${i}`}
                style={{
                  padding: "0.1rem 0.25rem",
                  borderBottom: "1px solid var(--bg-tertiary)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                <span style={{ color: levelInfo.color }}>{entry.line}</span>
              </div>
            );
          })
        )}
      </div>

      {!autoScroll && (
        <button
          className="btn btn-sm btn-primary"
          onClick={() => {
            setAutoScroll(true);
            if (containerRef.current) {
              containerRef.current.scrollTop = containerRef.current.scrollHeight;
            }
          }}
          style={{
            position: "fixed",
            bottom: "2rem",
            right: "2rem",
            zIndex: 50,
          }}
        >
          ↓ Scroll to bottom
        </button>
      )}
    </div>
  );
}
