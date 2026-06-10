import { useState, useEffect, useCallback } from "react";
import { api } from "../api";

export default function UsersRoles({ toast, readOnly = false }) {
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

  const loadAudit = useCallback(async (page = 0, customQs = null) => {
    try {
      const qs = customQs || `limit=30&offset=${page * 30}`;
      const data = await api(`/rbac/audit?${qs}`);
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
      {readOnly && (
        <div className="card" style={{ marginBottom: "0.75rem", color: "var(--text-secondary)" }}>
          WebUI access-control writes require your Home Assistant user ID to be listed in <code>webui_operator_ids</code>. Audit and read views remain available.
        </div>
      )}
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

      {tab === "users" && <UsersTab users={users} roles={roles} toast={toast} reload={reload} readOnly={readOnly} />}
      {tab === "roles" && <RolesTab roles={roles} toast={toast} reload={reload} readOnly={readOnly} />}
      {tab === "overrides" && <OverridesTab overrides={overrides} roles={roles} toast={toast} reload={reload} readOnly={readOnly} />}
      {tab === "audit" && <AuditTab audit={audit} page={auditPage} loadAudit={loadAudit} />}
      {tab === "invites" && <InvitesTab roles={roles} toast={toast} readOnly={readOnly} />}
    </div>
  );
}

// ── Users Tab ──────────────────────────────────────────

function UsersTab({ users, roles, toast, reload, readOnly }) {
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
                <button className="btn btn-sm" disabled={readOnly} onClick={() => { setEditingUser(u.userId); setEditRole(u.role); }}>
                  ✏️
                </button>
                <button className="btn btn-sm btn-danger" disabled={readOnly} onClick={() => handleRevoke(u.userId)}>
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
            {editingUser === u.userId && !readOnly && (
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

function RolesTab({ roles, toast, reload, readOnly }) {
  const [showCreate, setShowCreate] = useState(false);
  const [newRole, setNewRole] = useState({ name: "", rank: 50, capabilities: [], icon: "", description: "" });
  const [expandedRole, setExpandedRole] = useState(null);
  const [editingRole, setEditingRole] = useState(null);
  const [editForm, setEditForm] = useState({});

  const allCaps = [
    "entity:read", "entity:search", "entity:control:safe", "entity:control:sensitive",
    "automation:read", "automation:write", "dashboard:read", "dashboard:write",
    "si:manage:own", "si:manage:all", "user:manage", "role:manage",
    "system:manage", "dev:tools", "agent:memory", "background:task", "reminder:manage",
  ];

  const capGroups = {
    "Entity": ["entity:read", "entity:search", "entity:control:safe", "entity:control:sensitive"],
    "Automation": ["automation:read", "automation:write"],
    "Dashboard": ["dashboard:read", "dashboard:write"],
    "Standing Instructions": ["si:manage:own", "si:manage:all"],
    "Admin": ["user:manage", "role:manage", "system:manage", "dev:tools"],
    "Other": ["agent:memory", "background:task", "reminder:manage"],
  };

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

  const startEdit = (r) => {
    setEditingRole(r.name);
    setEditForm({
      rank: r.rank,
      icon: r.icon || "",
      description: r.description || "",
      capabilities: [...(r.capabilities || [])],
    });
  };

  const handleSaveEdit = async () => {
    try {
      await api(`/rbac/roles/${encodeURIComponent(editingRole)}`, {
        method: "PUT", body: JSON.stringify(editForm),
      });
      toast(`Role "${editingRole}" updated`);
      setEditingRole(null);
      reload();
    } catch (err) { toast(err.message, "error"); }
  };

  const toggleCap = (cap, forNew = false) => {
    if (forNew) {
      const caps = newRole.capabilities.includes(cap)
        ? newRole.capabilities.filter(c => c !== cap)
        : [...newRole.capabilities, cap];
      setNewRole({ ...newRole, capabilities: caps });
    } else {
      const caps = editForm.capabilities.includes(cap)
        ? editForm.capabilities.filter(c => c !== cap)
        : [...editForm.capabilities, cap];
      setEditForm({ ...editForm, capabilities: caps });
    }
  };

  const CapPicker = ({ selected, onToggle }) => (
    <div style={{ marginTop: "0.5rem" }}>
      {Object.entries(capGroups).map(([group, caps]) => (
        <div key={group} style={{ marginBottom: "0.4rem" }}>
          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", fontWeight: 600, marginBottom: "0.2rem" }}>
            {group}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
            {caps.map(cap => (
              <button key={cap} className={`btn btn-sm ${selected.includes(cap) ? "btn-primary" : ""}`}
                style={{ fontSize: "0.75rem", padding: "0.15rem 0.4rem" }}
                onClick={() => onToggle(cap)}>
                {selected.includes(cap) ? "✓ " : ""}{cap.split(":").pop()}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );

  const sorted = [...roles].sort((a, b) => b.rank - a.rank);

  return (
    <div>
      <div style={{ marginBottom: "0.75rem" }}>
        <button className="btn btn-primary" disabled={readOnly} onClick={() => setShowCreate(!showCreate)}>
          + New Role
        </button>
      </div>

      {showCreate && !readOnly && (
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
          <CapPicker selected={newRole.capabilities} onToggle={(cap) => toggleCap(cap, true)} />
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
            <button className="btn btn-primary btn-sm" onClick={handleCreate}>Create</button>
            <button className="btn btn-sm" onClick={() => setShowCreate(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="instr-list">
        {sorted.map(r => (
          <div key={r.name} className="instr-card">
            <div className="instr-header" onClick={() => setExpandedRole(expandedRole === r.name ? null : r.name)}
              style={{ cursor: "pointer" }}>
              <div className="instr-desc">
                {r.icon || "🔹"} <strong>{r.name}</strong>
                <span style={{ color: "var(--text-secondary)", marginLeft: "0.5rem" }}>
                  rank {r.rank} — {r.description || ""}
                </span>
              </div>
              <div className="instr-actions" onClick={e => e.stopPropagation()}>
                {!r.builtin && (
                  <>
                    <button className="btn btn-sm" disabled={readOnly} onClick={() => startEdit(r)}>✏️</button>
                    <button className="btn btn-sm btn-danger" disabled={readOnly} onClick={() => handleDelete(r.name)}>🗑️</button>
                  </>
                )}
                {r.builtin && (
                  <button className="btn btn-sm" disabled={readOnly} onClick={() => startEdit(r)}>✏️</button>
                )}
              </div>
            </div>
            <div className="instr-meta">
              {r.builtin && <span className="instr-tag">built-in</span>}
              {r.inherits && <span>inherits: {r.inherits}</span>}
              <span>{(r.effectiveCapabilities || []).length} capabilities</span>
            </div>

            {editingRole === r.name && !readOnly && (
              <div style={{ marginTop: "0.5rem", padding: "0.5rem", background: "var(--bg-input)", borderRadius: "var(--radius-sm)" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <div>
                    <label style={labelStyle}>Rank</label>
                    <input style={inputStyle} type="number" value={editForm.rank}
                      onChange={e => setEditForm({ ...editForm, rank: parseInt(e.target.value) || 0 })} />
                  </div>
                  <div>
                    <label style={labelStyle}>Icon</label>
                    <input style={inputStyle} value={editForm.icon}
                      onChange={e => setEditForm({ ...editForm, icon: e.target.value })} />
                  </div>
                  <div>
                    <label style={labelStyle}>Description</label>
                    <input style={inputStyle} value={editForm.description}
                      onChange={e => setEditForm({ ...editForm, description: e.target.value })} />
                  </div>
                </div>
                <label style={labelStyle}>Capabilities</label>
                <CapPicker selected={editForm.capabilities} onToggle={(cap) => toggleCap(cap)} />
                <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                  <button className="btn btn-primary btn-sm" onClick={handleSaveEdit}>💾 Save</button>
                  <button className="btn btn-sm" onClick={() => setEditingRole(null)}>Cancel</button>
                </div>
              </div>
            )}

            {expandedRole === r.name && editingRole !== r.name && (
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

function OverridesTab({ overrides, roles, toast, reload, readOnly }) {
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
        <button className="btn btn-primary" disabled={readOnly} onClick={() => setShowCreate(!showCreate)}>
          + New Override
        </button>
      </div>

      {showCreate && !readOnly && (
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
                  <button className="btn btn-sm btn-danger" disabled={readOnly} onClick={() => handleDelete(o)}>🗑️</button>
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
  const [eventFilter, setEventFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");

  const filteredLoadAudit = useCallback(async (p = 0) => {
    const qs = new URLSearchParams({ limit: "30", offset: String(p * 30) });
    if (eventFilter) qs.set("event", eventFilter);
    if (actorFilter) qs.set("actor", actorFilter);
    loadAudit(p, qs.toString());
  }, [eventFilter, actorFilter, loadAudit]);

  const eventIcon = (ev) => {
    if (ev?.startsWith("ROLE_GRANT")) return "✅";
    if (ev?.startsWith("ROLE_REVOKE")) return "🗑️";
    if (ev?.startsWith("ROLE_CREATE")) return "🆕";
    if (ev?.startsWith("ROLE_UPDATE")) return "✏️";
    if (ev?.startsWith("ROLE_DELETE")) return "❌";
    if (ev?.startsWith("ROLE_EXPIRE")) return "⏳";
    if (ev?.startsWith("OVERRIDE")) return "🔒";
    if (ev?.startsWith("INVITE")) return "🔗";
    if (ev?.startsWith("TOOL_DENY")) return "🚫";
    return "📋";
  };

  const eventTypes = ["ROLE_GRANT", "ROLE_REVOKE", "ROLE_CREATE", "ROLE_UPDATE", "ROLE_DELETE",
    "ROLE_EXPIRE", "OVERRIDE_ADD", "OVERRIDE_REMOVE", "INVITE_CREATE", "INVITE_USE",
    "INVITE_REVOKE", "TOOL_DENY"];

  if (entries.length === 0 && !eventFilter && !actorFilter) {
    return <div className="empty-state"><div className="icon">📋</div><p>No audit log entries yet.</p></div>;
  }

  return (
    <div>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem", flexWrap: "wrap" }}>
        <select style={{ ...selectStyle, width: "auto" }} value={eventFilter}
          onChange={e => setEventFilter(e.target.value)}>
          <option value="">All events</option>
          {eventTypes.map(t => <option key={t} value={t}>{eventIcon(t)} {t}</option>)}
        </select>
        <input style={{ ...inputStyle, width: "150px" }} placeholder="Filter by actor…"
          value={actorFilter} onChange={e => setActorFilter(e.target.value)} />
        <button className="btn btn-sm" onClick={() => filteredLoadAudit(0)}>🔍 Filter</button>
        {(eventFilter || actorFilter) && (
          <button className="btn btn-sm" onClick={() => { setEventFilter(""); setActorFilter(""); loadAudit(0); }}>
            ✕ Clear
          </button>
        )}
      </div>

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
          <button className="btn btn-sm" disabled={page === 0} onClick={() => filteredLoadAudit(page - 1)}>← Prev</button>
          <span style={{ color: "var(--text-secondary)", lineHeight: "1.8" }}>
            Page {page + 1} of {totalPages} ({total} entries)
          </span>
          <button className="btn btn-sm" disabled={page >= totalPages - 1} onClick={() => filteredLoadAudit(page + 1)}>Next →</button>
        </div>
      )}
    </div>
  );
}

// ── Invites Tab ────────────────────────────────────────

function InvitesTab({ roles, toast, readOnly }) {
  const [form, setForm] = useState({ role: "guest", expiresAt: "", roleExpiresAt: "" });
  const [result, setResult] = useState(null);
  const [invites, setInvites] = useState([]);
  const [filter, setFilter] = useState("all");

  const loadInvites = useCallback(async () => {
    try {
      const qs = filter !== "all" ? `?status=${filter}` : "";
      setInvites(await api(`/rbac/invites${qs}`));
    } catch {}
  }, [filter]);

  useEffect(() => { loadInvites(); }, [loadInvites]);

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
      loadInvites();
    } catch (err) { toast(err.message, "error"); }
  };

  const handleRevoke = async (id) => {
    if (!confirm("Revoke this invite?")) return;
    try {
      await api("/rbac/invites", { method: "DELETE", body: JSON.stringify({ id }) });
      toast("Invite revoked");
      loadInvites();
    } catch (err) { toast(err.message, "error"); }
  };

  const assignableRoles = roles.filter(r => r.name !== "owner");
  const statusBadge = (s) => {
    const colors = { active: "#4caf50", used: "#888", expired: "#ff9800" };
    return (
      <span style={{
        background: colors[s] || "#666", color: "#fff", borderRadius: "4px",
        padding: "0.1rem 0.4rem", fontSize: "0.75rem", fontWeight: 600,
      }}>{s}</span>
    );
  };

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
        <button className="btn btn-primary" disabled={readOnly} onClick={handleCreate}>Generate Invite</button>
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

      <div style={{ marginTop: "1rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
          <h3 style={{ fontSize: "1rem", margin: 0 }}>📋 Existing Invites</h3>
          <select style={{ ...selectStyle, width: "auto" }} value={filter}
            onChange={e => setFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="used">Used</option>
            <option value="expired">Expired</option>
          </select>
        </div>
        {invites.length === 0 ? (
          <div className="empty-state" style={{ padding: "1rem" }}><p>No invites found.</p></div>
        ) : (
          <div className="instr-list">
            {invites.map(inv => (
              <div key={inv.id} className="instr-card" style={{ padding: "0.5rem 0.75rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>
                    {statusBadge(inv.status)}{" "}
                    <strong>{inv.role}</strong>{" "}
                    <span style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
                      {inv.id}
                    </span>
                  </span>
                  <div style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
                    <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                      {inv.createdAt?.slice(0, 10)}
                    </span>
                    {inv.status === "active" && (
                      <button className="btn btn-sm btn-danger" disabled={readOnly} onClick={() => handleRevoke(inv.id)}>🗑️</button>
                    )}
                  </div>
                </div>
                {inv.usedBy && (
                  <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.2rem" }}>
                    Used by: {inv.usedBy}
                  </div>
                )}
                {inv.expiresAt && (
                  <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                    Expires: {inv.expiresAt.slice(0, 16).replace("T", " ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
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
