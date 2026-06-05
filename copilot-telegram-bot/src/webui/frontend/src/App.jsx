import { useState, useCallback } from "react";
import Dashboard from "./components/Dashboard";
import Instructions from "./components/Instructions";
import DocsEditor from "./components/DocsEditor";
import LogViewer from "./components/LogViewer";
import ConfigEditor from "./components/ConfigEditor";
import SystemInfo from "./components/SystemInfo";
import ChatPanel from "./components/ChatPanel";
import Toast from "./components/Toast";

const TABS = [
  { id: "dashboard", label: "📊 Dashboard" },
  { id: "chat", label: "💬 Chat" },
  { id: "instructions", label: "📋 Instructions" },
  { id: "docs", label: "📚 Docs" },
  { id: "logs", label: "📜 Logs" },
  { id: "config", label: "⚙️ Config" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("dashboard");
  const [toasts, setToasts] = useState([]);
  const [instrCount, setInstrCount] = useState(0);
  const [version, setVersion] = useState("—");

  const toast = useCallback((message, type = "success") => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo">
          <span className="logo-icon">🤖</span>
          <strong>Copilot Bot</strong>
        </div>
        <span className="version">v{version}</span>
      </header>

      <nav className="tab-bar">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`tab-btn ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
            {tab.id === "instructions" && (
              <span className="badge">{instrCount}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="tab-content active">
        {activeTab === "dashboard" && (
          <>
            <Dashboard toast={toast} onVersion={setVersion} />
            <div style={{ marginTop: "1.5rem" }}>
              <h3 style={{ fontSize: "1rem", marginBottom: "0.75rem", color: "var(--text-secondary)" }}>
                🖥️ System
              </h3>
              <SystemInfo toast={toast} />
            </div>
          </>
        )}
        {activeTab === "chat" && <ChatPanel toast={toast} />}
        {activeTab === "instructions" && (
          <Instructions toast={toast} onCountChange={setInstrCount} />
        )}
        {activeTab === "docs" && <DocsEditor toast={toast} />}
        {activeTab === "logs" && <LogViewer toast={toast} />}
        {activeTab === "config" && <ConfigEditor toast={toast} />}
      </div>

      <div className="toast-container">
        {toasts.map((t) => (
          <Toast key={t.id} message={t.message} type={t.type} />
        ))}
      </div>
    </div>
  );
}
