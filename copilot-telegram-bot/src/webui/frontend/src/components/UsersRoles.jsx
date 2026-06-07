import { useState, useEffect, useCallback } from "react";
import { api } from "../api";

export default function UsersRoles({ toast }) {
  const [tab, setTab] = useState("users");
  const [roles, setRoles] = useState([]);
  const [users, setUsers] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [audit, setAudit] = useState({ entries: [], total: 0 });
  const [auditPage, setAuditPage] = useState(0);

  const loadRoles = useCallback(async () => {
    try { setRoles(await api("/rbac/roles")); } catch {}
  }, []);

  const loadUsers = useCallback(async () => {
    try { setUsers(await api("/rbac/users")); } catch {}
  }, []);

  const loadOverrides = useCallback(async () => {
    try { setOverrides(await api("/rbac/overrides")); } catch {}
  }, []);

  const loadAudit = useCallback(async (page = 0) => {
    try {
      const data = await api(`/rbac/audit?limit=30&offset=${page * 30}`);
      setAudit(data);
      setAuditPage(page);
    } catch {}
  }, []);

  useEffect(() => {
    loadRoles();
    loadUsers();
    loadOverrides();
    loadAudit(0);
  }, [loadRoles, loadUsers, loadOverrides, loadAudit]);

  const reload = () => {
    loadRoles(); loadUsers(); loadOverrides(); loadAudit(auditPage);
  };

  return (
    <div>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        {["users", "roles", "overrides", "audit", "invites"].map(t => (
          <button
            key={t}
            className={`btn ${tab === t ? "btn-primary" : ""}`}
            onClick={() => setTab(t)}
            style={{ textTransform: "capitalize" }}
          >
            {t === "users" ? "👤 Users" : t === "roles" ? "🛡️ Roles" :
             t === "overrides" ? "🔒 Overrides" : t === "audit" ? "📋 Audit" : "🔗 Invites"}
          </button>
        ))}
      </div>

      {tab === "users" && <UsersTab users={users} roles={roles} toast={toast} reload={reload} />}
      {tab === "roles" && <RolesTab roles={roles} toast={toast} reload={reload} />}
      {tab === "overrides" && <OverridesTab overrides={overrides} roles={roles} toast={toast} reload={reload} />}
      {tab === "audit" && <AuditTab audit={audit} page={auditPage} loadAudit={loadAudit} />}
      {tab === "invites" && <InvitesTab roles={roles} toast={toast} />}
    </div>
  );
}

// ── Users Tab ──────────────────────────────────────────

function UsersTab({ users, roles, toast, reload }) {
  const [editingUser, setEditingUser] = useState(null);
  const [editRole, setEditRole] = useState("");

  const handleSetRole = async (userId) => {
    if (!editRole) return;
    try {
      await api(`/rbac/users/${userId}/role`, {
        method: "PUT", body: JSON.stringify({ role: editRole }),
      });
      toast(`Role updated`);
      setEditingUser(null);
      reload();
    } catch (err) { toast(err.message, "error"); }
  };

  const handleRevoke = async (userId) => {
    if (!confirm(`Revoke access for user ${userId}?`)) return;
    try {
      await api(`/rbac/users/${userId}`, { method: "DELETE" });
      toast("User revoked");
      reload();
    } catch (err) { toast(err.message, "error"); }
  };

  if (!users.length) {
    return <div className="empty-state"><div className="icon">👤</div><p>No users registered.</p></div>;
  }

  return (
    <div className="instr-list">
      {users.map(u => {
        const expired = u.expiresAt && new Date(u.expiresAt) < new Date();
        const roleIcon = roles.find(r => r.name === u.role)?.icon || "";
        return (
          <div key={u.userId} className={`instr-card${expired ? " disabled" : ""}`}>
            <div className="instr-header">
              <div className="instr-desc">
                {roleIcon} {u.displayName || u.username || u.userId}
                <span style={{ color: "var(--text-secondary)", marginLeft: "0.5rem" }}>
                  — {u.role}{expired ? " ⚠️ EXPIRED" : ""}
                </span>
              </div>
              <div className="instr-actions" style={{ display: "flex", gap: "0.25rem" }}>
                <button className="btn btn-sm" onClick={() => { setEditingUser(u.userId); setEditRole(u.role); }}>
                  ✏️
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => handleRevoke(u.userId)}>
                  🗑️
                </button>
              </div>
            </div>
            <div className="instr-meta">
              <span>ID: {u.userId}</span>
              {u.username && <><span>·</span><span>@{u.username}</span></>}
              <span>·</span>
              <span>Since {new Date(u.pairedAt).toLocaleDateString()}</span>
              {u.expiresAt && <><span>·</span><span>Expires: {new Date(u.expiresAt).toLocaleDateString()}</span></>}
              <span>·</span>
              <span>{(u.effectiveCapabilities || []).length} capabilities</span>
            </div>
            {editingUser === u.userId && (
              <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <select
                  value={editRole}
                  onChange={e => setEditRole(e.target.value)}
                  style={selectStyle}
                >
                  {roles.map(r => <option key={r.name} value={r.name}>{r.icon} {r.name} (rank {r.rank})</option>)}
                </select>
                <button className="btn btn-primary btn-sm" onClick={() => handleSetRole(u.userId)}>Save</button>
                <button className="btn btn-sm" onClick={() => setEditingUser(null)}>Cancel</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Roles Tab ──────────────────────────────────────────

function RolesTab({ roles, toast, reload }) {
  const [showCreate, setShowCreate] = useState(false);
  const [newRole, setNewRole] = useState({ name: "", rank: 50, capabilities: [], icon: "", description: "" });
  const [expandedRole, setExpandedRole] = useState(null);

  const handleCreate = async () => {
    try {
      await api("/rbac/roles", {
        method: "POST", body: JSON.stringify(newRole),
      });
      toast(`Role "${newRole.name}" created`);
      setShowCreate(false);
      setNewRole({ name: "", rank: 50, capabilities: [], icon: "", description: "" });
      reload();
    } catch (err) { toast(err.message, "error"); }
  };

  const handleDelete = async (name) => {
    if (!confirm(`Delete role "${name}"?`)) return;
    try {
      await api(`/rbac/roles/${encodeURIComponent(name)}`, { method: "DELETE" });
      toast(`Role "${name}" deleted`);
      reload();
    } catch (err) { toast(err.message, "error"); }
  };

  const sorted = [...roles].sort((a, b) => b.rank - a.rank);

  return (
    <div>
      <div style={{ marginBottom: "0.75rem" }}>
        <button className="btn btn-primary" onClick={() => setShowCreate(!showCreate)}>
          + New Role
        </button>
      </div>

      {showCreate && (
        <div className="instr-card" style={{ marginBottom: "0.75rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", marginBottom: "0.5rem" }}>
            <input style={inputStyle} placeholder="Role name (lowercase)" value={newRole.name}
              onChange={e => setNewRole({ ...newRole, name: e.target.value })} />
            <input style={inputStyle} type="number" placeholder="Rank (1-99)" value={newRole.rank}
              onChange={e => setNewRole({ ...newRole, rank: parseInt(e.target.value) || 0 })} />
            <input style={inputStyle} placeholder="Icon (emoji)" value={newRole.icon}
              onChange={e => setNewRole({ ...newRole, icon: e.target.value })} />
            <input style={inputStyle} placeholder="Description" value={newRole.description}
              onChange={e => setNewRole({ ...newRole, description: e.target.value })} />
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button className="btn btn-primary btn-sm" onClick={handleCreate}>Create</button>
            <button className="btn btn-sm" onClick={() => setShowCreate(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="instr-list">
        {sorted.map(r => (
          <div key={r.name} className="instr-card" onClick={() => setExpandedRole(expandedRole === r.name ? null : r.name)}>
            <div className="instr-header">
              <div className="instr-desc">
                {r.icon || "🔹"} <strong>{r.name}</strong>
                <span style={{ color: "var(--text-secondary)", marginLeft: "0.5rem" }}>
                  rank {r.rank} — {r.description || ""}
                </span>
              </div>
              <div className="instr-actions" onClick={e => e.stopPropagation()}>
                {!r.builtin && (
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(r.name)}>🗑️</button>
                )}
              </div>
            </div>
            <div className="instr-meta">
              {r.builtin && <span className="instr-tag">built-in</span>}
              {r.inherits && <span>inherits: {r.inherits}</span>}
              <span>{(r.effectiveCapabilities || []).length} capabilities</span>
            </div>
            {expandedRole === r.name && (
              <div style={{ marginTop: "0.5rem", fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                <strong>Capabilities:</strong>{" "}
                {(r.effectiveCapabilities || []).join(", ") || "none"}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Overrides Tab ──────────────────────────────────────

function OverridesTab({ overrides, roles, toast, reload }) {
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    entity_id: "", target_type: "role", target_id: "",
    grants: "", denies: "",
  });

  const handleCreate = async () => {
    try {
      await api("/rbac/overrides", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          grants: form.grants ? form.grants.split(",").map(s => s.trim()) : [],
          denies: form.denies ? form.denies.split(",").map(s => s.trim()) : [],
        }),
      });
      toast("Override added");
      setShowCreate(false);
      setForm({ entity_id: "", target_type: "role", target_id: "", grants: "", denies: "" });
      reload();
    } catch (err) { toast(err.message, "error"); }
  };

  const handleDelete = async (o) => {
    try {
      await api("/rbac/overrides", {
        method: "DELETE",
        body: JSON.stringify({
          entity_id: o.entity_id, target_type: o.target_type, target_id: o.target_id,
        }),
      });
      toast("Override removed");
      reload();
    } catch (err) { toast(err.message, "error"); }
  };

  return (
    <div>
      <div style={{ marginBottom: "0.75rem" }}>
        <button className="btn btn-primary" onClick={() => setShowCreate(!showCreate)}>
          + New Override
        </button>
      </div>

      {showCreate && (
        <div className="instr-card" style={{ marginBottom: "0.75rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", marginBottom: "0.5rem" }}>
            <input style={inputStyle} placeholder="Entity ID (e.g. light.bedroom, climate.*)"
              value={form.entity_id} onChange={e => setForm({ ...form, entity_id: e.target.value })} />
            <select style={selectStyle} value={form.target_type}
              onChange={e => setForm({ ...form, target_type: e.target.value })}>
              <option value="role">Role</option>
              <option value="user">User</option>
            </select>
            <input style={inputStyle} placeholder={form.target_type === "role" ? "Role name" : "User ID"}
              value={form.target_id} onChange={e => setForm({ ...form, target_id: e.target.value })} />
            <input style={inputStyle} placeholder="Grants (comma-separated capabilities)"
              value={form.grants} onChange={e => setForm({ ...form, grants: e.target.value })} />
            <input style={{ ...inputStyle, gridColumn: "span 2" }} placeholder="Denies (comma-separated capabilities)"
              value={form.denies} onChange={e => setForm({ ...form, denies: e.target.value })} />
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button className="btn btn-primary btn-sm" onClick={handleCreate}>Add</button>
            <button className="btn btn-sm" onClick={() => setShowCreate(false)}>Cancel</button>
          </div>
        </div>
      )}

      {overrides.length === 0 ? (
        <div className="empty-state"><div className="icon">🔒</div><p>No entity overrides configured.</p></div>
      ) : (
        <div className="instr-list">
          {overrides.map((o, i) => (
            <div key={i} className="instr-card">
              <div className="instr-header">
                <div className="instr-desc">
                  <code>{o.entity_id}</code>
                  <span style={{ color: "var(--text-secondary)", margin: "0 0.5rem" }}>→</span>
                  {o.target_type}:<strong>{o.target_id}</strong>
                </div>
                <div className="instr-actions">
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(o)}>🗑️</button>
                </div>
              </div>
              <div className="instr-meta">
                {o.grants?.length > 0 && (
                  <span style={{ color: "var(--green)" }}>✅ {o.grants.join(", ")}</span>
                )}
                {o.denies?.length > 0 && (
                  <span style={{ color: "var(--red)" }}>❌ {o.denies.join(", ")}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Audit Tab ──────────────────────────────────────────

function AuditTab({ audit, page, loadAudit }) {
  const { entries, total } = audit;
  const totalPages = Math.ceil(total / 30);

  const eventIcon = (ev) => {
    if (ev?.startsWith("ROLE_GRANT")) return "✅";
    if (ev?.startsWith("ROLE_REVOKE")) return "🗑️";
    if (ev?.startsWith("ROLE_CREATE")) return "🆕";
    if (ev?.startsWith("ROLE_UPDATE")) return "✏️";
    if (ev?.startsWith("ROLE_DELETE")) return "❌";
    if (ev?.startsWith("ROLE_EXPIRE")) return "⏳";
    if (ev?.startsWith("OVERRIDE")) return "🔒";
    if (ev?.startsWith("INVITE")) return "🔗";
    return "📋";
  };

  if (entries.length === 0) {
    return <div className="empty-state"><div className="icon">📋</div><p>No audit log entries yet.</p></div>;
  }

  return (
    <div>
      <div className="instr-list">
        {entries.map((e, i) => (
          <div key={i} className="instr-card" style={{ padding: "0.5rem 0.75rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>
                {eventIcon(e.event)} <strong>{e.event}</strong>
                <span style={{ color: "var(--text-secondary)", marginLeft: "0.5rem" }}>
                  actor: {e.actor} → target: {e.target}
                </span>
              </span>
              <span style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
                {e.timestamp?.slice(0, 19).replace("T", " ")}
              </span>
            </div>
            {e.details && Object.keys(e.details).length > 0 && (
              <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.25rem" }}>
                {JSON.stringify(e.details)}
              </div>
            )}
          </div>
        ))}
      </div>
      {totalPages > 1 && (
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center", marginTop: "0.75rem" }}>
          <button className="btn btn-sm" disabled={page === 0} onClick={() => loadAudit(page - 1)}>← Prev</button>
          <span style={{ color: "var(--text-secondary)", lineHeight: "1.8" }}>
            Page {page + 1} of {totalPages} ({total} entries)
          </span>
          <button className="btn btn-sm" disabled={page >= totalPages - 1} onClick={() => loadAudit(page + 1)}>Next →</button>
        </div>
      )}
    </div>
  );
}

// ── Invites Tab ────────────────────────────────────────

function InvitesTab({ roles, toast }) {
  const [form, setForm] = useState({ role: "guest", expiresAt: "", roleExpiresAt: "" });
  const [result, setResult] = useState(null);

  const handleCreate = async () => {
    try {
      const data = await api("/rbac/invites", {
        method: "POST",
        body: JSON.stringify({
          role: form.role,
          expiresAt: form.expiresAt || undefined,
          roleExpiresAt: form.roleExpiresAt || undefined,
        }),
      });
      setResult(data);
      toast("Invite created");
    } catch (err) { toast(err.message, "error"); }
  };

  const assignableRoles = roles.filter(r => r.name !== "owner");

  return (
    <div>
      <div className="instr-card">
        <h3 style={{ fontSize: "1rem", marginBottom: "0.75rem" }}>🔗 Create Invite Link</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", marginBottom: "0.5rem" }}>
          <div>
            <label style={labelStyle}>Role</label>
            <select style={selectStyle} value={form.role}
              onChange={e => setForm({ ...form, role: e.target.value })}>
              {assignableRoles.map(r => (
                <option key={r.name} value={r.name}>{r.icon} {r.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Link expires (optional)</label>
            <input style={inputStyle} type="datetime-local" value={form.expiresAt}
              onChange={e => setForm({ ...form, expiresAt: e.target.value })} />
          </div>
          <div>
            <label style={labelStyle}>Access expires (optional)</label>
            <input style={inputStyle} type="datetime-local" value={form.roleExpiresAt}
              onChange={e => setForm({ ...form, roleExpiresAt: e.target.value })} />
          </div>
        </div>
        <button className="btn btn-primary" onClick={handleCreate}>Generate Invite</button>
      </div>

      {result && (
        <div className="instr-card" style={{ marginTop: "0.75rem" }}>
          <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>✅ Invite Created</h3>
          <div style={{ marginBottom: "0.5rem" }}>
            <label style={labelStyle}>Token</label>
            <code style={{ ...inputStyle, display: "block", padding: "0.5rem", userSelect: "all" }}>
              {result.token}
            </code>
          </div>
          <div>
            <label style={labelStyle}>Deep Link</label>
            <code style={{ ...inputStyle, display: "block", padding: "0.5rem", userSelect: "all" }}>
              /start invite_{result.token}
            </code>
          </div>
          <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginTop: "0.5rem" }}>
            Share this deep link with the user. They send it to the bot to get instant access as <strong>{result.role}</strong>.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Shared styles ──────────────────────────────────────

const inputStyle = {
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text-primary)",
  padding: "0.4rem 0.6rem",
  fontSize: "0.9rem",
  width: "100%",
};

const selectStyle = {
  ...inputStyle,
  cursor: "pointer",
};

const labelStyle = {
  fontSize: "0.8rem",
  color: "var(--text-secondary)",
  display: "block",
  marginBottom: "0.2rem",
};
