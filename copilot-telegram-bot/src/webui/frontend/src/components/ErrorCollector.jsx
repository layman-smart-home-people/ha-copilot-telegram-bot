import { useState, useEffect, useCallback, useRef } from "react";

/**
 * Global error collector — captures API errors, unhandled JS errors, and
 * unhandled promise rejections. Shows a floating badge with error count.
 * Clicking it opens a panel where errors can be copied to clipboard.
 */

// Shared error store — modules can push errors here
const errorStore = [];
let listeners = new Set();

function notify() {
  listeners.forEach((fn) => fn([...errorStore]));
}

export function pushError(err) {
  const entry = {
    ts: new Date().toISOString(),
    message: typeof err === "string" ? err : err?.message || String(err),
    stack: err?.stack || null,
  };
  errorStore.push(entry);
  if (errorStore.length > 100) errorStore.shift();
  notify();
}

export default function ErrorCollector() {
  const [errors, setErrors] = useState([]);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const panelRef = useRef(null);

  useEffect(() => {
    listeners.add(setErrors);
    // Seed with any errors already captured
    setErrors([...errorStore]);

    const onError = (event) => {
      pushError(event.error || event.message || "Unknown error");
    };
    const onUnhandled = (event) => {
      pushError(event.reason || "Unhandled promise rejection");
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandled);

    return () => {
      listeners.delete(setErrors);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandled);
    };
  }, []);

  // Close panel on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleCopy = useCallback(async () => {
    const text = errors
      .map((e) => `[${e.ts}] ${e.message}${e.stack ? "\n" + e.stack : ""}`)
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for insecure contexts
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [errors]);

  const handleClear = useCallback(() => {
    errorStore.length = 0;
    notify();
  }, []);

  if (errors.length === 0 && !open) return null;

  return (
    <>
      {/* Floating badge */}
      {errors.length > 0 && (
        <button
          className="error-badge"
          onClick={() => setOpen(!open)}
          title="View captured errors"
        >
          ⚠️ {errors.length}
        </button>
      )}

      {/* Error panel */}
      {open && (
        <div className="error-panel-overlay">
          <div className="error-panel" ref={panelRef}>
            <div className="error-panel-header">
              <span>⚠️ Captured Errors ({errors.length})</span>
              <div className="error-panel-actions">
                <button onClick={handleCopy} className="btn btn-sm">
                  {copied ? "✅ Copied!" : "📋 Copy All"}
                </button>
                <button onClick={handleClear} className="btn btn-sm btn-danger">
                  🗑️ Clear
                </button>
                <button onClick={() => setOpen(false)} className="btn btn-sm">
                  ✕
                </button>
              </div>
            </div>
            <div className="error-panel-body">
              {errors.length === 0 ? (
                <p className="text-muted">No errors captured.</p>
              ) : (
                errors.map((e, i) => (
                  <div key={i} className="error-entry">
                    <div className="error-time">{new Date(e.ts).toLocaleTimeString()}</div>
                    <div className="error-message">{e.message}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
