// ============================================================
// ChatHistory — Ring buffer for recent messages
// ============================================================
// Stores recent messages in memory for context lookup.
// NOT persisted — lost on restart (Copilot session has its own memory).

const DEFAULT_MAX = 50;

export class ChatHistory {
    #buffer = [];
    #max;

    constructor(maxEntries = DEFAULT_MAX) {
        this.#max = maxEntries;
    }

    /**
     * Add a message to the history.
     * @param {{ role: "user"|"bot", text: string, messageId?: number, timestamp?: number }} entry
     */
    push(entry) {
        this.#buffer.push({
            role: entry.role,
            text: (entry.text || "").substring(0, 2000),
            messageId: entry.messageId || null,
            timestamp: entry.timestamp || Date.now(),
        });
        if (this.#buffer.length > this.#max) {
            this.#buffer.shift();
        }
    }

    /**
     * Get the last N messages.
     */
    getRecent(n = 10) {
        return this.#buffer.slice(-n);
    }

    /**
     * Find a message by its Telegram message_id.
     */
    findByMessageId(messageId) {
        return this.#buffer.find(e => e.messageId === messageId) || null;
    }

    /**
     * Simple substring search across message text.
     */
    search(query, limit = 5) {
        const q = query.toLowerCase();
        return this.#buffer
            .filter(e => e.text.toLowerCase().includes(q))
            .slice(-limit);
    }

    /**
     * Format recent messages as readable text for prompt injection.
     */
    format(n = 10) {
        const entries = this.getRecent(n);
        if (entries.length === 0) return "(no recent messages)";
        return entries.map(e => {
            const who = e.role === "user" ? "👤 User" : "🤖 Bot";
            const time = new Date(e.timestamp).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
            const text = e.text.length > 200 ? e.text.substring(0, 200) + "…" : e.text;
            return `[${time}] ${who}: ${text}`;
        }).join("\n");
    }

    get length() {
        return this.#buffer.length;
    }

    clear() {
        this.#buffer = [];
    }
}
