import { useState } from "react";
import { api } from "../api";

function toLocalDatetime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseFloatOrNull(val) {
  if (!val && val !== 0) return null;
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : null;
}

export default function InstructionModal({ instruction, onClose, onSaved, toast }) {
  const isEdit = !!instruction;

  const [desc, setDesc] = useState(instruction?.description || "");
  const [triggerType, setTriggerType] = useState(instruction?.trigger?.type || "state_change");
  const [actionType, setActionType] = useState(instruction?.action?.type || "wake_agent");

  // State change fields
  const entityVal = instruction?.trigger?.entity_id;
  const [entity, setEntity] = useState(
    Array.isArray(entityVal) ? entityVal.join(", ") : entityVal || ""
  );
  const [from, setFrom] = useState(instruction?.trigger?.from || "");
  const [to, setTo] = useState(instruction?.trigger?.to || "");
  const [above, setAbove] = useState(instruction?.trigger?.above ?? "");
  const [below, setBelow] = useState(instruction?.trigger?.below ?? "");
  const [attribute, setAttribute] = useState(instruction?.trigger?.attribute || "");

  // Cron
  const [cron, setCron] = useState(instruction?.trigger?.expression || "");

  // Timer
  const [fireAt, setFireAt] = useState(
    instruction?.trigger?.fire_at ? toLocalDatetime(new Date(instruction.trigger.fire_at)) : ""
  );

  // Action fields
  const [prompt, setPrompt] = useState(instruction?.action?.prompt || "");
  const [message, setMessage] = useState(instruction?.action?.message || "");

  // Options
  const [cooldown, setCooldown] = useState(instruction?.cooldown_seconds ?? 300);
  const [maxTriggers, setMaxTriggers] = useState(instruction?.max_triggers ?? "");
  const [oneShot, setOneShot] = useState(instruction?.one_shot || false);

  const [saving, setSaving] = useState(false);

  const buildBody = () => {
    const body = {
      description: desc.trim(),
      cooldown_seconds: parseInt(cooldown) || 0,
      one_shot: oneShot,
      max_triggers: maxTriggers ? parseInt(maxTriggers) : null,
    };

    if (triggerType === "state_change") {
      const raw = entity.trim();
      body.trigger = {
        type: "state_change",
        entity_id: raw.includes(",") ? raw.split(",").map((s) => s.trim()).filter(Boolean) : raw,
        from: from.trim() || null,
        to: to.trim() || null,
        above: parseFloatOrNull(above),
        below: parseFloatOrNull(below),
        attribute: attribute.trim() || null,
      };
    } else if (triggerType === "cron") {
      body.trigger = { type: "cron", expression: cron.trim() };
    } else if (triggerType === "timer") {
      body.trigger = {
        type: "timer",
        fire_at: fireAt ? new Date(fireAt).toISOString() : "",
      };
    }

    if (actionType === "wake_agent") {
      body.action = { type: "wake_agent", prompt: prompt.trim() };
    } else if (actionType === "notify") {
      body.action = { type: "notify", message: message.trim() };
    }

    return body;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const body = buildBody();
      if (isEdit) {
        await api(`/instructions/${encodeURIComponent(instruction.id)}`, {
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
      onSaved();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Delete this instruction?")) return;
    try {
      await api(`/instructions/${encodeURIComponent(instruction.id)}`, {
        method: "DELETE",
      });
      toast("Instruction deleted");
      onSaved();
    } catch (err) {
      toast(err.message, "error");
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">
          <span>{isEdit ? "Edit Instruction" : "New Instruction"}</span>
          <button className="btn-icon" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="form-group">
          <label>Description</label>
          <input
            type="text"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="What does this instruction do?"
          />
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Trigger Type</label>
            <select value={triggerType} onChange={(e) => setTriggerType(e.target.value)}>
              <option value="state_change">State Change</option>
              <option value="cron">Cron Schedule</option>
              <option value="timer">Timer (One-time)</option>
            </select>
          </div>
          <div className="form-group">
            <label>Action Type</label>
            <select value={actionType} onChange={(e) => setActionType(e.target.value)}>
              <option value="wake_agent">Wake Agent</option>
              <option value="notify">Notify</option>
            </select>
          </div>
        </div>

        {/* State Change fields */}
        {triggerType === "state_change" && (
          <>
            <div className="form-group">
              <label>Entity ID</label>
              <input
                type="text"
                value={entity}
                onChange={(e) => setEntity(e.target.value)}
                placeholder="sensor.temperature"
              />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>From State</label>
                <input
                  type="text"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  placeholder="Any (optional)"
                />
              </div>
              <div className="form-group">
                <label>To State</label>
                <input
                  type="text"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="Any (optional)"
                />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Above (numeric)</label>
                <input
                  type="number"
                  step="any"
                  value={above}
                  onChange={(e) => setAbove(e.target.value)}
                  placeholder="Optional"
                />
              </div>
              <div className="form-group">
                <label>Below (numeric)</label>
                <input
                  type="number"
                  step="any"
                  value={below}
                  onChange={(e) => setBelow(e.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>
            <div className="form-group">
              <label>Attribute</label>
              <input
                type="text"
                value={attribute}
                onChange={(e) => setAttribute(e.target.value)}
                placeholder="Optional — e.g. brightness"
              />
            </div>
          </>
        )}

        {/* Cron fields */}
        {triggerType === "cron" && (
          <div className="form-group">
            <label>Cron Expression</label>
            <input
              type="text"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="0 8 * * *"
            />
            <div className="form-hint">min hour day month weekday (0=Sun)</div>
          </div>
        )}

        {/* Timer fields */}
        {triggerType === "timer" && (
          <div className="form-group">
            <label>Fire At</label>
            <input
              type="datetime-local"
              value={fireAt}
              onChange={(e) => setFireAt(e.target.value)}
            />
          </div>
        )}

        {/* Action fields */}
        {actionType === "wake_agent" && (
          <div className="form-group">
            <label>Agent Prompt</label>
            <textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should the agent do?"
            />
          </div>
        )}

        {actionType === "notify" && (
          <div className="form-group">
            <label>Notification Message</label>
            <textarea
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Message to send"
            />
          </div>
        )}

        {/* Options */}
        <div className="form-row">
          <div className="form-group">
            <label>Cooldown (seconds)</label>
            <input
              type="number"
              min={0}
              value={cooldown}
              onChange={(e) => setCooldown(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>Max Triggers</label>
            <input
              type="number"
              min={1}
              value={maxTriggers}
              onChange={(e) => setMaxTriggers(e.target.value)}
              placeholder="Unlimited"
            />
          </div>
        </div>

        <div className="form-group">
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={oneShot}
              onChange={(e) => setOneShot(e.target.checked)}
            />
            One-shot (disable after first trigger)
          </label>
        </div>

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          {isEdit && (
            <button type="button" className="btn btn-danger" onClick={handleDelete}>
              Delete
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
