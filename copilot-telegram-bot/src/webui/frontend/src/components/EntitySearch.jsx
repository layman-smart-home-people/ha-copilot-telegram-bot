import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../api";

export default function EntitySearch({ value, onChange, placeholder }) {
  const [query, setQuery] = useState(value || "");
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef(null);
  const debounceRef = useRef(null);

  // Sync external value
  useEffect(() => {
    setQuery(value || "");
  }, [value]);

  // Close on outside click
  useEffect(() => {
    const handleClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const search = useCallback(async (q) => {
    if (!q || q.length < 2) {
      setSuggestions([]);
      return;
    }
    setLoading(true);
    try {
      const results = await api(`/entities?q=${encodeURIComponent(q)}`);
      setSuggestions(results.slice(0, 20));
      setOpen(true);
    } catch {
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInput = (e) => {
    const val = e.target.value;
    setQuery(val);
    onChange(val);

    // Debounce search
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 250);
  };

  const selectEntity = (entityId) => {
    // If comma-separated, append
    if (query.includes(",")) {
      const parts = query.split(",").map((s) => s.trim()).filter(Boolean);
      parts[parts.length - 1] = entityId;
      const newVal = parts.join(", ");
      setQuery(newVal);
      onChange(newVal);
    } else {
      setQuery(entityId);
      onChange(entityId);
    }
    setOpen(false);
  };

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      <input
        type="text"
        value={query}
        onChange={handleInput}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        placeholder={placeholder || "sensor.temperature"}
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 100,
            background: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            maxHeight: "200px",
            overflowY: "auto",
            boxShadow: "var(--shadow)",
          }}
        >
          {suggestions.map((s) => (
            <div
              key={s.entity_id}
              onClick={() => selectEntity(s.entity_id)}
              style={{
                padding: "0.4rem 0.6rem",
                cursor: "pointer",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                borderBottom: "1px solid var(--bg-tertiary)",
                fontSize: "0.85rem",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-tertiary)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--accent)" }}>
                {s.entity_id}
              </span>
              <span
                style={{
                  color: "var(--text-muted)",
                  fontSize: "0.75rem",
                  marginLeft: "0.5rem",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: "150px",
                }}
              >
                {s.friendly_name || s.state}
              </span>
            </div>
          ))}
        </div>
      )}
      {loading && (
        <span
          style={{
            position: "absolute",
            right: "8px",
            top: "50%",
            transform: "translateY(-50%)",
            fontSize: "0.75rem",
            color: "var(--text-muted)",
          }}
        >
          ⏳
        </span>
      )}
    </div>
  );
}
