import { useState, useEffect, useCallback } from "react";
import { api } from "../api";

// Fields that should be shown as textareas
const TEXTAREA_FIELDS = new Set(["preamble", "copilot_extra_args"]);

// Fields to hide from the editor (managed elsewhere or internal)
const HIDDEN_FIELDS = new Set([]);

export default function ConfigEditor({ toast, readOnly = false }) {
  const [config, setConfig] = useState(null);
  const [options, setOptions] = useState({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showRestart, setShowRestart] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api("/config/options");
      setConfig(data);
      setOptions(data.options);
      setDirty(false);
    } catch (err) {
      toast(`Failed to load config: ${err.message}`, "error");
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleChange = (key, value) => {
    setOptions((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api("/config/options", {
        method: "PUT",
        body: JSON.stringify({ options }),
      });
      setDirty(false);
      setShowRestart(true);
      toast("Configuration saved");
    } catch (err) {
      toast(`Failed to save: ${err.message}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleRestart = async () => {
    if (!confirm("Restart the add-on? The bot will be briefly unavailable.")) return;
    try {
      await api("/config/restart", { method: "POST" });
      toast("Restarting add-on...");
    } catch (err) {
      toast(`Restart failed: ${err.message}`, "error");
    }
  };

  if (!config) {
    return (
      <div style={{ padding: "2rem" }}>
        <div className="skeleton" style={{ height: 24, width: "30%", marginBottom: 16 }} />
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="skeleton" style={{ height: 40, width: "100%", marginBottom: 12 }} />
        ))}
      </div>
    );
  }

  const schema = config.schema || [];

  return (
    <div>
      <div className="instr-toolbar">
        <h2 style={{ fontSize: "1.1rem" }}>Add-on Configuration</h2>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {showRestart && (
            <button className="btn" onClick={handleRestart} disabled={readOnly}>
              🔄 Restart Add-on
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={readOnly || !dirty || saving}
          >
            {saving ? "Saving…" : "💾 Save"}
          </button>
        </div>
      </div>
      {readOnly && (
        <div className="card" style={{ maxWidth: "640px", marginBottom: "0.75rem", color: "var(--text-secondary)" }}>
          WebUI configuration writes require your Home Assistant user ID to be listed in <code>webui_operator_ids</code>.
        </div>
      )}

      <div
        className="card"
        style={{ maxWidth: "640px" }}
      >
        {Object.entries(options)
          .filter(([key]) => !HIDDEN_FIELDS.has(key))
          .map(([key, value]) => {
            const fieldSchema = schema.find((s) => s.name === key) || {};
            const isPassword = fieldSchema.format === "password";
            const isBoolean = typeof value === "boolean";
            const isArray = Array.isArray(value);
            const isTextarea = TEXTAREA_FIELDS.has(key);

            return (
              <div className="form-group" key={key}>
                <label htmlFor={`cfg-${key}`}>
                  {key}
                  {fieldSchema.optional && (
                    <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> (optional)</span>
                  )}
                </label>

                {isBoolean ? (
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={value}
                      disabled={readOnly}
                      onChange={(e) => handleChange(key, e.target.checked)}
                    />
                    {value ? "Enabled" : "Disabled"}
                  </label>
                ) : isArray ? (
                  <textarea
                    id={`cfg-${key}`}
                    value={value.join("\n")}
                    disabled={readOnly}
                    onChange={(e) =>
                      handleChange(
                        key,
                        e.target.value.split("\n").filter((s) => s.trim())
                      )
                    }
                    rows={Math.max(2, value.length + 1)}
                    style={{ fontFamily: "var(--font-mono)" }}
                    placeholder="One value per line"
                  />
                ) : isTextarea ? (
                  <textarea
                    id={`cfg-${key}`}
                    value={value}
                    disabled={readOnly}
                    onChange={(e) => handleChange(key, e.target.value)}
                    rows={3}
                  />
                ) : (
                  <input
                    id={`cfg-${key}`}
                    type={isPassword ? "password" : typeof value === "number" ? "number" : "text"}
                    value={value}
                    disabled={readOnly}
                    onChange={(e) =>
                      handleChange(
                        key,
                        typeof value === "number" ? Number(e.target.value) : e.target.value
                      )
                    }
                  />
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
