import { useState, useEffect, useCallback } from "react";
import { api } from "../api";

export default function Chats({ toast }) {
  const [data, setData] = useState({ users: [], groups: [] });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const result = await api("/chats");
      setData(result);
    } catch (err) {
      toast?.(`Failed to load chats: ${err.message}`, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p style={{ color: "var(--text-secondary)" }}>Loading chats...</p>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h3 style={{ margin: 0, fontSize: "1rem", color: "var(--text-secondary)" }}>
          📨 Reachable Chats
        </h3>
        <button className="btn" onClick={load}>🔄 Refresh</button>
      </div>

      {/* Users (DM targets) */}
      <h4 style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: "0.5rem" }}>
        👤 Users ({data.users.length})
      </h4>
      {data.users.length === 0 ? (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>No paired users</p>
      ) : (
        <div className="card-grid" style={{ marginBottom: "1.5rem" }}>
          {data.users.map(u => (
            <div key={u.chatId} className="card" style={{ padding: "0.75rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{u.name}</div>
              <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                {u.username ? `@${u.username}` : ""} · ID: {u.chatId}
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--accent)", marginTop: "0.25rem" }}>
                {u.role}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Groups */}
      <h4 style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: "0.5rem" }}>
        👥 Groups ({data.groups.length})
      </h4>
      {data.groups.length === 0 ? (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>No allowed groups</p>
      ) : (
        data.groups.map(g => (
          <div key={g.chatId} className="card" style={{ padding: "0.75rem", marginBottom: "0.75rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>{g.name}</span>
                {g.isForum && <span style={{ marginLeft: "0.5rem", fontSize: "0.75rem", color: "var(--accent)" }}>Forum</span>}
              </div>
              <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                {g.memberCount ? `${g.memberCount} members` : ""} · ID: {g.chatId}
              </span>
            </div>
            {g.error && (
              <div style={{ fontSize: "0.8rem", color: "var(--danger)", marginTop: "0.25rem" }}>
                ⚠️ {g.error}
              </div>
            )}
            {g.members.length > 0 && (
              <div style={{ marginTop: "0.5rem", fontSize: "0.8rem" }}>
                <div style={{ color: "var(--text-secondary)", marginBottom: "0.25rem" }}>Admins:</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                  {g.members.filter(m => !m.isBot).map(m => (
                    <span key={m.userId} style={{
                      background: "var(--bg-secondary)", padding: "0.2rem 0.5rem",
                      borderRadius: "4px", fontSize: "0.75rem"
                    }}>
                      {m.name}{m.username ? ` @${m.username}` : ""}{" "}
                      <span style={{ color: "var(--text-secondary)" }}>({m.status})</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
