import { useState, useEffect, useCallback } from "react";
import { apiWithRetry } from "../api";

export default function SystemInfo({ toast }) {
  const [info, setInfo] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await apiWithRetry("/system");
      setInfo(data);
    } catch (err) {
      toast(`Failed to load system info: ${err.message}`, "error");
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  if (!info) {
    return (
      <div className="card-grid">
        {[1, 2, 3].map((i) => (
          <div key={i} className="card">
            <div className="skeleton" style={{ height: 20, width: "60%", marginBottom: 8 }} />
            <div className="skeleton" style={{ height: 36, width: "40%" }} />
          </div>
        ))}
      </div>
    );
  }

  const diskPercent =
    info.disk_total && info.disk_total > 0
      ? Math.round((info.disk_used / info.disk_total) * 100)
      : null;

  const diskColor =
    diskPercent > 90 ? "var(--red)" : diskPercent > 75 ? "var(--yellow)" : "var(--green)";

  return (
    <div className="card-grid">
      <div className="card">
        <div className="card-title">💻 Host</div>
        <div className="card-value" style={{ fontSize: "1.1rem" }}>
          {info.hostname}
        </div>
        <div className="card-sub">
          {info.board && <span>{info.board} · </span>}
          {info.os_version && <span>HAOS {info.os_version} · </span>}
          {info.ha_arch && <span>{info.ha_arch}</span>}
        </div>
        {info.kernel && (
          <div className="card-sub" style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
            {info.kernel}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">💾 Disk</div>
        <div className="card-value">
          {diskPercent !== null ? (
            <span style={{ color: diskColor }}>{diskPercent}%</span>
          ) : (
            "—"
          )}
        </div>
        <div className="card-sub">
          {info.disk_used != null && info.disk_total != null
            ? `${info.disk_used.toFixed(1)} / ${info.disk_total.toFixed(1)} GB`
            : "—"}
        </div>
        {diskPercent !== null && (
          <div
            style={{
              marginTop: "0.5rem",
              height: "6px",
              background: "var(--bg-tertiary)",
              borderRadius: "3px",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${diskPercent}%`,
                height: "100%",
                background: diskColor,
                borderRadius: "3px",
                transition: "width 300ms ease",
              }}
            />
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">🏠 Home Assistant</div>
        <div className="card-value" style={{ fontSize: "1.1rem" }}>
          {info.ha_version || "—"}
        </div>
        <div className="card-sub">
          {info.disk_free != null ? `${info.disk_free.toFixed(1)} GB free` : ""}
        </div>
      </div>
    </div>
  );
}
