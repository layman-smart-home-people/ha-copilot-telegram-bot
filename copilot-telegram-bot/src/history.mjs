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
     * @param {{ role: "user"|"bot", text: string, messageId?: number, replyToMessageId?: number, timestamp?: number }} entry
     */
    push(entry) {
        this.#buffer.push({
            role: entry.role,
            text: (entry.text || "").substring(0, 2000),
            messageId: entry.messageId || null,
            replyToMessageId: entry.replyToMessageId || null,
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
        if (!messageId) return null;
        return this.#buffer.find(e => e.messageId === messageId) || null;
    }

    /**
     * Walk the reply chain starting from a messageId.
     * Returns messages from oldest to newest (parent first).
     * @param {number} messageId - Starting message to walk up from
     * @param {number} maxDepth - Max number of parent messages to collect
     * @param {number} maxChars - Total character budget
     * @returns {Array<{role: string, text: string, messageId: number}>}
     */
    getReplyChain(messageId, maxDepth = 5, maxChars = 2000) {
        const chain = [];
        let totalChars = 0;
        let currentId = messageId;

        while (currentId && chain.length < maxDepth) {
            const entry = this.findByMessageId(currentId);
            if (!entry) break;

            const maxForThis = Math.min(500, maxChars - totalChars);
            if (maxForThis <= 50) break;

            let text = entry.text;
            if (text.length > maxForThis) text = text.substring(0, maxForThis) + "…";

            chain.unshift({ role: entry.role, text, messageId: entry.messageId });
            totalChars += text.length;

            currentId = entry.replyToMessageId;
        }

        return chain;
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
