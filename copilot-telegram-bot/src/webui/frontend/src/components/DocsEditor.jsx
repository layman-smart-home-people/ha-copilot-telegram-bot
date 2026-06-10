import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../api";

export default function DocsEditor({ toast, readOnly = false }) {
  const [docs, setDocs] = useState([]);
  const [activeDoc, setActiveDoc] = useState(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const textareaRef = useRef(null);

  const loadDocs = useCallback(async () => {
    try {
      const data = await api("/docs");
      setDocs(data);
    } catch (err) {
      toast(`Failed to load docs: ${err.message}`, "error");
    }
  }, [toast]);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  const openDoc = async (name) => {
    if (dirty && activeDoc && name !== activeDoc) {
      if (!confirm("Unsaved changes will be lost. Continue?")) return;
    }
    try {
      const data = await api(`/docs/${encodeURIComponent(name)}`);
      setActiveDoc(name);
      setContent(data.content);
      setDirty(false);
    } catch (err) {
      toast(`Failed to load ${name}: ${err.message}`, "error");
    }
  };

  const saveDoc = async () => {
    if (!activeDoc) return;
    try {
      await api(`/docs/${encodeURIComponent(activeDoc)}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });
      setDirty(false);
      toast(`Saved ${activeDoc}`);
    } catch (err) {
      toast(`Failed to save: ${err.message}`, "error");
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = textareaRef.current;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const newVal = content.substring(0, start) + "  " + content.substring(end);
      setContent(newVal);
      setDirty(true);
      // Restore cursor after React re-render
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      saveDoc();
    }
  };

  const mainDocs = docs.filter((d) => d.type === "main");
  const skills = docs.filter((d) => d.type === "skill");
  const dailyLogs = docs.filter((d) => d.type === "daily_log");

  return (
    <div className="docs-layout">
      <div className="docs-sidebar">
        <div className="docs-sidebar-title">Files</div>
        <ul className="docs-file-list">
          <li className="docs-file-item section-header">Agent Config</li>
          {mainDocs.map((d) => (
            <li
              key={d.name}
              className={`docs-file-item ${d.name === activeDoc ? "active" : ""}`}
              onClick={() => openDoc(d.name)}
              title={d.path}
            >
              📄 {d.name}
            </li>
          ))}
          {skills.length > 0 && (
            <>
              <li className="docs-file-item section-header">Skills</li>
              {skills.map((d) => (
                <li
                  key={d.name}
                  className={`docs-file-item ${d.name === activeDoc ? "active" : ""}`}
                  onClick={() => openDoc(d.name)}
                >
                  🔧 {d.name.replace("skills/", "")}
                </li>
              ))}
            </>
          )}
          {dailyLogs.length > 0 && (
            <>
              <li className="docs-file-item section-header">Daily Logs</li>
              {dailyLogs.map((d) => (
                <li
                  key={d.name}
                  className={`docs-file-item ${d.name === activeDoc ? "active" : ""}`}
                  onClick={() => openDoc(d.name)}
                >
                  📅 {d.name.replace("memory/", "")}
                </li>
              ))}
            </>
          )}
        </ul>
      </div>

      <div className="docs-editor">
        {readOnly && (
          <div className="card" style={{ marginBottom: "0.75rem", color: "var(--text-secondary)" }}>
            WebUI doc editing requires your Home Assistant user ID to be listed in <code>webui_operator_ids</code>.
          </div>
        )}
        {!activeDoc ? (
          <div className="docs-empty">Select a file to view or edit</div>
        ) : (
          <div id="docs-active" style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            <div className="docs-editor-header">
              <span className="docs-editor-filename">
                {activeDoc}
                {!readOnly && dirty && <span style={{ color: "var(--yellow)", marginLeft: "0.5rem" }}>●</span>}
              </span>
              <button className="btn btn-sm" onClick={saveDoc} disabled={readOnly || !dirty}>
                💾 Save
              </button>
            </div>
            <div className="docs-editor-content">
              <textarea
                ref={textareaRef}
                value={content}
                onChange={(e) => {
                  if (readOnly) return;
                  setContent(e.target.value);
                  setDirty(true);
                }}
                onKeyDown={handleKeyDown}
                spellCheck={false}
                readOnly={readOnly}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
