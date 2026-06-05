import { useState, useEffect, useCallback } from "react";
import { api } from "../api";
import InstructionModal from "./InstructionModal";

export default function Instructions({ toast, onCountChange }) {
  const [instructions, setInstructions] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingInstr, setEditingInstr] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api("/instructions");
      setInstructions(data);
      onCountChange(data.length);
    } catch (err) {
      toast(`Failed to load instructions: ${err.message}`, "error");
    }
  }, [toast, onCountChange]);

  useEffect(() => {
    load();
  }, [load]);

  const handleToggle = async (id, currentEnabled) => {
    const action = currentEnabled ? "disable" : "enable";
    try {
      await api(`/instructions/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
      });
      toast(`Instruction ${action}d`);
      load();
    } catch (err) {
      toast(err.message, "error");
    }
  };

  const handleEdit = (instr) => {
    setEditingInstr(instr);
    setModalOpen(true);
  };

  const handleNew = () => {
    setEditingInstr(null);
    setModalOpen(true);
  };

  const handleModalClose = () => {
    setModalOpen(false);
    setEditingInstr(null);
  };

  const handleSaved = () => {
    handleModalClose();
    load();
  };

  if (!instructions.length) {
    return (
      <>
        <div className="instr-toolbar">
          <h2 style={{ fontSize: "1.1rem" }}>Standing Instructions</h2>
          <button className="btn btn-primary" onClick={handleNew}>
            + New Instruction
          </button>
        </div>
        <div className="empty-state">
          <div className="icon">📋</div>
          <p>No standing instructions yet. Create one to automate agent responses.</p>
        </div>
        {modalOpen && (
          <InstructionModal
            instruction={editingInstr}
            onClose={handleModalClose}
            onSaved={handleSaved}
            toast={toast}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="instr-toolbar">
        <h2 style={{ fontSize: "1.1rem" }}>Standing Instructions</h2>
        <button className="btn btn-primary" onClick={handleNew}>
          + New Instruction
        </button>
      </div>

      <div className="instr-list">
        {instructions.map((instr) => (
          <InstructionCard
            key={instr.id}
            instr={instr}
            onToggle={handleToggle}
            onEdit={handleEdit}
          />
        ))}
      </div>

      {modalOpen && (
        <InstructionModal
          instruction={editingInstr}
          onClose={handleModalClose}
          onSaved={handleSaved}
          toast={toast}
        />
      )}
    </>
  );
}

function InstructionCard({ instr, onToggle, onEdit }) {
  const triggerType = instr.trigger?.type || "unknown";
  const actionType = instr.action?.type || "unknown";

  const triggerLabel =
    triggerType === "state_change"
      ? Array.isArray(instr.trigger.entity_id)
        ? instr.trigger.entity_id.join(", ")
        : instr.trigger.entity_id
      : triggerType === "cron"
        ? instr.trigger.expression
        : triggerType === "timer"
          ? new Date(instr.trigger.fire_at).toLocaleString()
          : "—";

  const lastTriggered = instr.last_triggered_at
    ? `Last: ${new Date(instr.last_triggered_at).toLocaleString()}`
    : "Never triggered";

  return (
    <div
      className={`instr-card ${instr.enabled ? "" : "disabled"}`}
      onClick={() => onEdit(instr)}
    >
      <div className="instr-header">
        <div className="instr-desc">{instr.description}</div>
        <div className="instr-actions" onClick={(e) => e.stopPropagation()}>
          <label className="toggle" title={instr.enabled ? "Disable" : "Enable"}>
            <input
              type="checkbox"
              checked={instr.enabled}
              onChange={() => onToggle(instr.id, instr.enabled)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>
      <div className="instr-meta">
        <span className={`instr-tag trigger-${triggerType}`}>{triggerType}</span>
        <span className={`instr-tag action-${actionType}`}>{actionType}</span>
        <span>{triggerLabel}</span>
        <span>·</span>
        <span>{lastTriggered}</span>
        {instr.trigger_count > 0 && <span>· {instr.trigger_count} triggers</span>}
        {instr.cooldown_seconds > 0 && <span>· {instr.cooldown_seconds}s cooldown</span>}
      </div>
    </div>
  );
}
