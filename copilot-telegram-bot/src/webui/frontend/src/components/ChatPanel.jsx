import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../api";

export default function ChatPanel({ toast }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [currentText, setCurrentText] = useState("");
  const [currentThought, setCurrentThought] = useState("");
  const [tools, setTools] = useState([]); // active tool calls
  const [currentApproval, setCurrentApproval] = useState(null);
  const [approvalPending, setApprovalPending] = useState(false);
  const [currentElicitation, setCurrentElicitation] = useState(null);
  const messagesEndRef = useRef(null);
  const sseRef = useRef(null);
  const inputRef = useRef(null);
  const handleEventRef = useRef(null);

  // Auto-scroll to bottom
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, currentText, scrollToBottom]);

  // Handle chat SSE events
  const handleChatEvent = useCallback((data) => {
    switch (data.type) {
      case "status":
        setConnected(data.connected);
        setBusy(data.busy);
        setCurrentApproval(data.pendingApproval || null);
        setCurrentElicitation(data.pendingElicitation || null);
        break;

      case "connecting":
        setConnected(false);
        setBusy(true);
        break;

      case "user_message":
        setMessages((prev) => [...prev, { role: "user", text: data.text }]);
        break;

      case "message_start":
        setCurrentText("");
        setCurrentThought("");
        setCurrentApproval(null);
        setCurrentElicitation(null);
        setBusy(true);
        break;

      case "text_chunk":
        setCurrentText((prev) => prev + data.text);
        break;

      case "thought":
        setCurrentThought((prev) => prev + data.text);
        break;

      case "tool_start":
        setTools((prev) => [
          ...prev,
          { id: data.toolCallId, name: data.name, status: "running" },
        ]);
        break;

      case "tool_end":
        setTools((prev) =>
          prev.map((t) =>
            t.id === data.toolCallId ? { ...t, status: data.status } : t
          )
        );
        break;

      case "done":
        setCurrentText((prev) => {
          if (prev.trim()) {
            setMessages((msgs) => [...msgs, { role: "assistant", text: prev }]);
          }
          return "";
        });
        setCurrentThought("");
        setTools([]);
        setBusy(false);
        setCurrentApproval(null);
        setApprovalPending(false);
        setCurrentElicitation(null);
        break;

      case "cancelled":
        setCurrentText((prev) => {
          if (prev.trim()) {
            setMessages((msgs) => [
              ...msgs,
              { role: "assistant", text: prev + "\n\n_(cancelled)_" },
            ]);
          }
          return "";
        });
        setTools([]);
        setBusy(false);
        setCurrentApproval(null);
        setApprovalPending(false);
        setCurrentElicitation(null);
        break;

      case "error":
        toast(data.message, "error");
        setBusy(false);
        setApprovalPending(false);
        break;

      case "disconnected":
        setConnected(false);
        setBusy(false);
        toast("Copilot disconnected", "error");
        break;

      case "new_session":
        setMessages([]);
        setCurrentText("");
        setCurrentThought("");
        setTools([]);
        setCurrentApproval(null);
        setApprovalPending(false);
        setCurrentElicitation(null);
        break;

      case "permission_request":
        setCurrentApproval({
          approvalId: data.approvalId,
          title: data.title,
          options: data.options || [],
        });
        setApprovalPending(false);
        break;

      case "elicitation":
        setCurrentElicitation({ message: data.message || "The agent needs your input. Reply below or decline." });
        setBusy(false);
        break;

      case "permission_resolved":
        setCurrentApproval((prev) => (
          prev && prev.approvalId === data.approvalId ? null : prev
        ));
        setApprovalPending(false);
        break;

      default:
        break;
    }
  }, [toast]);

  // Keep ref up to date for SSE closure
  handleEventRef.current = handleChatEvent;

  // SSE connection for chat events
  useEffect(() => {
    const evtSource = new EventSource("./api/chat/stream");
    sseRef.current = evtSource;

    evtSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleEventRef.current(data);
      } catch {}
    };

    evtSource.onerror = () => {
      setConnected(false);
    };

    return () => {
      evtSource.close();
      sseRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || busy) return;

    setInput("");
    setBusy(true);
    try {
      await api("/chat/send", {
        method: "POST",
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      toast(err.message, "error");
    }
    inputRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const newSession = async () => {
    try {
      await api("/chat/new", { method: "POST" });
      setMessages([]);
      setCurrentText("");
      toast("New session started");
    } catch (err) {
      toast(err.message, "error");
    }
  };

  const stopPrompt = async () => {
    try {
      await api("/chat/stop", { method: "POST" });
    } catch (err) {
      toast(err.message, "error");
    }
  };

  const respondToApproval = async (optionId) => {
    if (!currentApproval || approvalPending) return;
    setApprovalPending(true);
    try {
      await api("/chat/approval", {
        method: "POST",
        body: JSON.stringify({
          approvalId: currentApproval.approvalId,
          optionId,
        }),
      });
    } catch (err) {
      toast(err.message, "error");
      setApprovalPending(false);
    }
  };

  const declineElicitation = async () => {
    try {
      await api("/chat/elicitation", {
        method: "POST",
        body: JSON.stringify({ action: "decline" }),
      });
      setCurrentElicitation(null);
    } catch (err) {
      toast(err.message, "error");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 140px)" }}>
      {/* Toolbar */}
      <div className="instr-toolbar" style={{ flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <h2 style={{ fontSize: "1.1rem" }}>Copilot Chat</h2>
          <span
            className={`status-badge ${connected ? "online" : "offline"}`}
            style={{ fontSize: "0.75rem" }}
          >
            <span className={`status-dot ${connected ? "online" : "offline"}`} />
            {connected ? "Connected" : busy ? "Connecting…" : "Disconnected"}
          </span>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {busy && (
            <button className="btn btn-sm btn-danger" onClick={stopPrompt}>
              ⏹ Stop
            </button>
          )}
          <button className="btn btn-sm" onClick={newSession}>
            + New Session
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
        }}
      >
        {messages.length === 0 && !currentText && !busy && (
          <div className="empty-state" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div>
              <div className="icon">💬</div>
              <p>Send a message to start chatting with Copilot. This uses a dedicated session separate from Telegram.</p>
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}

        {/* Active tool calls */}
        {tools.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
            {tools.map((tool) => (
              <ToolCallCard key={tool.id} tool={tool} />
            ))}
          </div>
        )}

        {currentApproval && (
          <ApprovalCard
            approval={currentApproval}
            disabled={approvalPending}
            onSelect={respondToApproval}
          />
        )}

        {currentElicitation && (
          <ElicitationCard
            elicitation={currentElicitation}
            onDecline={declineElicitation}
          />
        )}

        {/* Streaming thought */}
        {currentThought && (
          <div
            style={{
              padding: "0.5rem 0.75rem",
              background: "var(--bg-tertiary)",
              borderRadius: "var(--radius-sm)",
              fontSize: "0.8rem",
              color: "var(--text-muted)",
              fontStyle: "italic",
              whiteSpace: "pre-wrap",
              maxHeight: "100px",
              overflow: "hidden",
            }}
          >
            💭 {currentThought.slice(-200)}
          </div>
        )}

        {/* Streaming text */}
        {currentText && (
          <MessageBubble message={{ role: "assistant", text: currentText }} streaming />
        )}

        {/* Thinking indicator */}
        {busy && !currentText && !currentThought && tools.length === 0 && (
          <div
            style={{
              padding: "0.75rem 1rem",
              color: "var(--text-muted)",
              fontSize: "0.9rem",
            }}
          >
            <span className="thinking-dots">Thinking</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div
        style={{
          flexShrink: 0,
          padding: "0.75rem 1rem",
          borderTop: "1px solid var(--border)",
          background: "var(--bg-secondary)",
          display: "flex",
          gap: "0.5rem",
          alignItems: "flex-end",
        }}
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={connected ? "Type a message… (Enter to send)" : "Type a message… (will auto-connect)"}
          disabled={false}
          rows={1}
          style={{
            flex: 1,
            padding: "0.6rem 0.75rem",
            background: "var(--bg-input)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            color: "var(--text-primary)",
            fontFamily: "var(--font)",
            fontSize: "0.9rem",
            resize: "none",
            minHeight: "40px",
            maxHeight: "120px",
            outline: "none",
          }}
        />
        <button
          className="btn btn-primary"
          onClick={sendMessage}
          disabled={busy || !input.trim()}
          style={{ height: "40px" }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ message, streaming }) {
  const isUser = message.role === "user";

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
      }}
    >
      <div
        style={{
          maxWidth: "85%",
          padding: "0.65rem 1rem",
          borderRadius: "var(--radius)",
          background: isUser ? "var(--accent)" : "var(--bg-card)",
          color: isUser ? "#fff" : "var(--text-primary)",
          border: isUser ? "none" : "1px solid var(--border)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontSize: "0.9rem",
          lineHeight: "1.5",
          position: "relative",
        }}
      >
        {message.text}
        {streaming && <span className="cursor-blink">▌</span>}
      </div>
    </div>
  );
}

function ToolCallCard({ tool }) {
  const statusIcon =
    tool.status === "running" ? "⏳" : tool.status === "completed" ? "✅" : "❌";

  return (
    <div
      style={{
        padding: "0.4rem 0.75rem",
        background: "var(--bg-tertiary)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        fontSize: "0.8rem",
        color: "var(--text-secondary)",
        display: "flex",
        alignItems: "center",
        gap: "0.4rem",
      }}
    >
      <span>{statusIcon}</span>
      <span style={{ fontFamily: "var(--font-mono)" }}>{tool.name}</span>
    </div>
  );
}

function ApprovalCard({ approval, disabled, onSelect }) {
  return (
    <div
      style={{
        padding: "0.8rem 0.9rem",
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
      }}
    >
      <div style={{ fontSize: "0.9rem", whiteSpace: "pre-wrap" }}>
        {approval.title}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        {approval.options.map((option) => (
          <button
            key={option.optionId}
            className="btn btn-sm"
            disabled={disabled}
            onClick={() => onSelect(option.optionId)}
          >
            {option.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function ElicitationCard({ elicitation, onDecline }) {
  return (
    <div
      style={{
        padding: "0.8rem 0.9rem",
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
      }}
    >
      <div style={{ fontSize: "0.9rem", whiteSpace: "pre-wrap" }}>
        {elicitation.message}
      </div>
      <div style={{ fontSize: "0.82rem", color: "var(--text-secondary)" }}>
        Reply in the chat box below to answer, or decline if you do not want to continue.
      </div>
      <div>
        <button className="btn btn-sm btn-danger" onClick={onDecline}>
          Decline
        </button>
      </div>
    </div>
  );
}
