// ============================================================
// Error Formatter — Human-friendly error messages for Telegram
// ============================================================
// Maps raw ACP/JSON-RPC errors into concise, emoji-decorated messages.

const ERROR_MAP = new Map([
    // --- JSON-RPC standard codes ---
    [-32700, { emoji: "🔴", label: "Parse Error", hint: "Server received malformed data" }],
    [-32600, { emoji: "🔴", label: "Invalid Request", hint: "Malformed protocol message" }],
    [-32601, { emoji: "🚫", label: "Not Supported", hint: "This feature isn't available in your Copilot version" }],
    [-32602, { emoji: "⚠️", label: "Invalid Parameters", hint: "The request had bad parameters" }],
    [-32603, { emoji: "💥", label: "Internal Error", hint: "Something went wrong on Copilot's end" }],

    // --- Copilot-specific (server error range -32000 to -32099) ---
    [-32000, { emoji: "🔒", label: "Server Error", hint: "Copilot rejected the request" }],
    [-32001, { emoji: "🔒", label: "Auth Required", hint: "Authentication expired or missing" }],
    [-32002, { emoji: "🚫", label: "Rate Limited", hint: "Too many requests — wait a moment" }],
]);

// Patterns matched against error messages for more specific handling
const MESSAGE_PATTERNS = [
    {
        pattern: /image.*(?:not|disabled|policy|unsupported|blocked)/i,
        emoji: "🖼️",
        label: "Images Not Allowed",
        hint: "Your GitHub org/subscription doesn't support image uploads.\nAsk your org admin to enable vision features in Copilot settings.",
    },
    {
        pattern: /content.*policy|policy.*violation|content.*filter/i,
        emoji: "🛡️",
        label: "Content Policy",
        hint: "The request was blocked by content policy filters.",
    },
    {
        pattern: /rate.*limit|too many|429|throttl/i,
        emoji: "⏳",
        label: "Rate Limited",
        hint: "You're sending too fast. Wait a few seconds and use /retry.",
    },
    {
        pattern: /quota|exceeded|limit.*reached|capacity/i,
        emoji: "📊",
        label: "Quota Exceeded",
        hint: "Your Copilot usage limit has been reached.\nCheck your subscription at github.com/settings/copilot.",
    },
    {
        pattern: /auth|unauthorized|401|forbidden|403|not.*authenticated/i,
        emoji: "🔑",
        label: "Auth Error",
        hint: "Authentication failed. Try /session new to restart.",
    },
    {
        pattern: /timeout|timed?\s*out|deadline/i,
        emoji: "⏱️",
        label: "Timeout",
        hint: "The request took too long. Try /retry or a shorter prompt.",
    },
    {
        pattern: /session.*(?:not found|expired|invalid)/i,
        emoji: "📋",
        label: "Session Lost",
        hint: "The session expired. Use /session new to start a new one.",
    },
    {
        pattern: /model.*(?:not|unavailable|invalid|access)/i,
        emoji: "🤖",
        label: "Model Unavailable",
        hint: "That model isn't available on your plan. Use /model to pick another.",
    },
    {
        pattern: /context.*(?:length|window|too long|exceeded|limit)/i,
        emoji: "📏",
        label: "Context Too Long",
        hint: "The conversation is too long. Use /compact to summarize, or /new for a fresh session.",
    },
    {
        pattern: /network|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket/i,
        emoji: "🌐",
        label: "Network Error",
        hint: "Can't reach GitHub servers. Check your internet connection.",
    },
    {
        pattern: /process.*(?:exit|crash|died|killed|signal)/i,
        emoji: "💀",
        label: "Copilot Crashed",
        hint: "The Copilot process died unexpectedly. Use /session new to recover.",
    },
    {
        pattern: /vision|multimodal|image.*input/i,
        emoji: "🖼️",
        label: "Vision Not Available",
        hint: "Image/vision features aren't enabled for your account.\nCheck org settings at github.com → Organization → Copilot → Policies.",
    },
    {
        pattern: /not.*(?:implement|support)|unsupported/i,
        emoji: "🚫",
        label: "Not Supported",
        hint: "This feature isn't supported in the current Copilot version.",
    },
];

/**
 * Format a raw error into a user-friendly Telegram message.
 * @param {Error|string} err - The raw error
 * @returns {string} Formatted error message for Telegram
 */
export function formatError(err) {
    const message = typeof err === "string" ? err : err?.message || "Unknown error";

    // Try to extract ACP error code
    const codeMatch = message.match(/ACP error (-?\d+):/);
    const code = codeMatch ? parseInt(codeMatch[1]) : null;
    const cleanMsg = codeMatch ? message.replace(/ACP error -?\d+:\s*/, "") : message;

    // Check code-based mapping first
    if (code && ERROR_MAP.has(code)) {
        const mapped = ERROR_MAP.get(code);
        // Also check message patterns for more specific hint
        const patternMatch = findPattern(cleanMsg);
        if (patternMatch) {
            return `${patternMatch.emoji} ${patternMatch.label}\n${patternMatch.hint}`;
        }
        return `${mapped.emoji} ${mapped.label}\n${mapped.hint}`;
    }

    // Check message patterns
    const patternMatch = findPattern(message);
    if (patternMatch) {
        return `${patternMatch.emoji} ${patternMatch.label}\n${patternMatch.hint}`;
    }

    // Fallback: clean up the message as much as possible
    const cleaned = cleanMsg
        .replace(/^Error:\s*/i, "")
        .replace(/^ACP\s*/i, "")
        .substring(0, 200);

    return `❌ ${cleaned}\n💡 Use /retry to resend your last message.`;
}

function findPattern(msg) {
    for (const p of MESSAGE_PATTERNS) {
        if (p.pattern.test(msg)) return p;
    }
    return null;
}

/**
 * Determine if an error is retryable.
 */
export function isRetryable(err) {
    const message = typeof err === "string" ? err : err?.message || "";
    return /rate.*limit|timeout|network|ECONNREFUSED|429|503/i.test(message);
}
