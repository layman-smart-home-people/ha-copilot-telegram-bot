// ============================================================
// PkmExtractor — Conversation window tracking + extraction
// ============================================================
// Tracks messages into conversation windows, runs extraction
// pipeline on closed windows (pre-filter → scrub → LLM → store).

import { createLogger } from "../logger.mjs";

const log = createLogger("pkm-extractor");

// ── Pre-filter patterns ────────────────────────────────────

const HA_COMMAND_PATTERNS = [
    /^(turn|switch|set|dim|brighten|toggle|stop|play|pause|resume|next|previous|mute|unmute)\b/i,
    /^(lock|unlock|arm|disarm|open|close|cover)\b/i,
    /^(what(?:'s| is) the (?:temp|time|weather|humidity))/i,
];

const BOT_COMMAND_PATTERN = /^\//;

const TRIVIAL_PATTERNS = [
    /^(ok|okay|k|yes|no|yep|nope|sure|thanks|thx|ty|👍|👌|😊|🙏|lol|haha|cool|nice|great|good)$/i,
    /^[\p{Emoji}\s]{1,5}$/u,
];

// ── Structured data regex patterns ─────────────────────────

const STRUCTURED_PATTERNS = [
    {
        name: "bp",
        regex: /(?:bp|blood pressure)[:\s]*(\d{2,3})\s*\/\s*(\d{2,3})/i,
        extract: (m) => ({
            dataType: "bp", value: parseFloat(m[1]),
            metadata: { systolic: parseInt(m[1]), diastolic: parseInt(m[2]) },
            unit: "mmHg",
        }),
    },
    {
        name: "weight",
        regex: /(?:weight|weigh)[:\s]*(\d{2,3}\.?\d?)\s*(kg|lbs?|pounds?)?/i,
        extract: (m) => ({
            dataType: "weight", value: parseFloat(m[1]),
            unit: m[2]?.toLowerCase()?.startsWith("l") ? "lbs" : "kg",
        }),
    },
    {
        name: "sleep",
        regex: /(?:slept?|sleep)[:\s]*(\d+\.?\d?)\s*(?:h(?:ours?|rs?)?)/i,
        extract: (m) => ({
            dataType: "sleep", value: parseFloat(m[1]), unit: "hours",
        }),
    },
    {
        name: "weight_bare",
        regex: /(\d{2,3}\.?\d?)\s*kg\b/i,
        extract: (m) => ({
            dataType: "weight", value: parseFloat(m[1]), unit: "kg",
        }),
    },
];

const TOPIC_KEYWORDS = {
    People: [
        /\b(family|friend|colleague|coworker|birthday|anniversary|wedding|dad|mom|mum|father|mother|brother|sister|wife|husband|son|daughter|uncle|aunt|nephew|niece|cousin|grandpa|grandma|boss|teacher|doctor)\b/i,
        /\b(met|visited|called|texted|dinner with|lunch with|meeting with)\b/i,
    ],
    Home: [
        /\b(home|house|apartment|flat|kitchen|bedroom|bathroom|living room|garage|garden|yard|renovation|repair|wifi|router|appliance|furniture|cleaning|laundry|cook|recipe|grocery|groceries)\b/i,
        /\b(home assistant|smart home|automation|sensor|temperature|humidity|light|switch|plug|thermostat)\b/i,
    ],
    Life: [
        /\b(health|exercise|workout|gym|run|jog|walk|swim|yoga|meditation|diet|nutrition|sleep|energy|mood|stress|anxiety|happiness|goal|plan|habit|routine|hobby|travel|vacation|trip|book|movie|music|show|game|sport|study|learn|course|class|career|job|work|project|invest|budget|saving|finance|money)\b/i,
    ],
};

// ── Extraction prompt template ─────────────────────────────

function buildExtractionPrompt(messages, securityPrompt) {
    return `${securityPrompt}

Extract factual memories from this conversation. Return a JSON array of 0–5 memories.

For each memory, include:
- title: short summary (10-15 words max)
- content: full factual statement (1-3 sentences, self-contained)
- type: one of: fact, preference, event, meeting, health, journal, reflection
- tags: array of 2-5 category tags
- search_keywords: array of 20-30 keywords including:
  * Exact terms used in the conversation
  * Category/hypernym terms (e.g. "grouper" → "fish", "seafood", "protein")
  * Context terms (e.g. "wedding" → "celebration", "event", "banquet")
  * Location/cuisine/domain terms if applicable
  * Think: what might someone search for 2 years from now to find this?
- importance: 0-1 (0.3=trivial, 0.5=normal, 0.8=significant, 1.0=critical)
- durability: "permanent" (won't change, like birthdays), "normal" (could become outdated), "ephemeral" (short-lived)
- entities: array of {name, type} for named people/places/companies mentioned
- scope_suggestion: "user" (default) or "household" (if a shared family/home decision)

CONVERSATION:
${messages.map(m => `[${m.role}]: ${m.text}`).join("\n")}

Return ONLY a valid JSON array. If nothing is worth remembering, return [].`;
}

function classifyTopics(text) {
    const scores = {};
    const combined = (text || "").toLowerCase();

    for (const [topic, patterns] of Object.entries(TOPIC_KEYWORDS)) {
        let matchCount = 0;
        for (const pattern of patterns) {
            const matches = combined.match(pattern);
            if (matches) matchCount += matches.length;
        }
        if (matchCount > 0) scores[topic] = matchCount;
    }

    return Object.entries(scores)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([name]) => name);
}

// ── PkmExtractor class ─────────────────────────────────────

export class PkmExtractor {
    #store;
    #security;
    #timer = null;

    constructor(store, security) {
        this.#store = store;
        this.#security = security;
    }

    // ── Message tracking ───────────────────────────────────

    /**
     * Track an incoming message into a conversation window.
     * Called by the message handler for every user/agent message.
     * @returns {{ windowId: string, isNew: boolean }} or null if filtered
     */
    trackMessage(userId, chatId, text, role = "user") {
        if (!this.#store.isEnabled(userId)) return null;

        // Pre-filter: skip commands and trivial messages
        if (this.#shouldSkip(text, role)) return null;

        // Check for oversized windows first
        this.#closeOversizedWindows(userId, chatId);

        // Get or create window
        let window = this.#store.getOpenWindow(userId, chatId);
        let isNew = false;

        if (!window) {
            const windowId = this.#store.createWindow(userId, chatId);
            window = { id: windowId };
            isNew = true;
        }

        // Scrub sensitive content before storing
        const { scrubbed } = this.#security.scrubSensitive(text);

        // Append message
        this.#store.appendToWindow(window.id, {
            role,
            text: scrubbed,
            timestamp: new Date().toISOString(),
        });

        return { windowId: window.id, isNew };
    }

    /** Check if message should be skipped (not tracked) */
    #shouldSkip(text, role) {
        if (!text || typeof text !== "string") return true;
        const trimmed = text.trim();
        if (trimmed.length === 0) return true;

        // Skip bot commands
        if (BOT_COMMAND_PATTERN.test(trimmed)) return true;

        // Only filter user messages (agent responses provide context)
        if (role === "user") {
            // Skip HA commands
            if (HA_COMMAND_PATTERNS.some(p => p.test(trimmed))) return true;
            // Skip trivial messages
            if (TRIVIAL_PATTERNS.some(p => p.test(trimmed))) return true;
        }

        return false;
    }

    /** Close oversized windows for a user/chat */
    #closeOversizedWindows(userId, chatId) {
        const settings = this.#store.getSettings(userId);
        const maxMsgs = settings?.max_window_messages || 30;
        const maxHours = settings?.max_window_hours || 4;
        const oversized = this.#store.getOversizedWindows(maxMsgs, maxHours);

        for (const win of oversized) {
            if (win.user_id === userId && (win.chat_id || null) === (chatId || null)) {
                this.#store.closeWindow(win.id);
                log.info(`Auto-closed oversized window ${win.id} (msgs=${win.message_count})`);
            }
        }
    }

    // ── Extraction pipeline ────────────────────────────────

    /**
     * Extract memories from a closed conversation window.
     * @param {object} window - Conversation window from DB
     * @param {Function} llmCall - async (prompt) => response text
     * @returns {Array} Created note IDs
     */
    async extractWindow(window, llmCall) {
        if (!window?.messages) {
            this.#store.markWindowExtracted(window.id, []);
            return [];
        }

        const messages = typeof window.messages === "string"
            ? JSON.parse(window.messages)
            : window.messages;

        if (!Array.isArray(messages) || messages.length === 0) {
            this.#store.markWindowExtracted(window.id, []);
            this.#store.updateExtractionStats(window.user_id, { notesProduced: 0, wasEmpty: true });
            return [];
        }

        // Stage 1: Pre-filter
        const userMsgs = messages.filter(m => m.role === "user");
        const totalChars = userMsgs.reduce((s, m) => s + (m.text?.length || 0), 0);
        if (totalChars < 50) {
            this.#store.markWindowExtracted(window.id, []);
            this.#store.updateExtractionStats(window.user_id, { notesProduced: 0, wasEmpty: true });
            return [];
        }

        // Stage 2: Check for structured data (regex, no LLM needed)
        const structuredNotes = this.#extractStructuredData(messages, window);

        // Stage 3: LLM classification
        let llmNotes = [];
        try {
            const prompt = buildExtractionPrompt(messages, this.#security.getExtractionDefensePrompt());
            const response = await llmCall(prompt);
            llmNotes = this.#parseLlmResponse(response);
        } catch (e) {
            log.error(`Extraction LLM call failed for window ${window.id}: ${e.message}`);
            this.#store.markWindowFailed(window.id);
            this.#store.updateExtractionStats(window.user_id, { notesProduced: 0, failed: true });
            return structuredNotes.map(n => n.id);
        }

        // Stage 4: Store extracted notes
        const noteIds = [...structuredNotes.map(n => n.id)];
        for (const note of llmNotes) {
            try {
                // Validate against injection
                const injection = this.#security.detectInjection(note.content || "");
                const confidence = injection.flagged ? 0.3 : (note.importance || 0.5);

                const result = this.#store.createNote({
                    userId: window.user_id,
                    chatId: window.chat_id,
                    type: note.type || "fact",
                    title: note.title,
                    content: note.content,
                    searchKeywords: note.search_keywords || [],
                    tags: note.tags || [],
                    metadata: note.entities ? { entities: note.entities } : null,
                    sourceType: "extracted",
                    confidence,
                    durability: note.durability || "normal",
                    importance: note.importance || 0.5,
                    scope: "user",
                    conversationId: window.id,
                });
                noteIds.push(result.id);

                // Entity linking
                if (note.entities?.length) {
                    this.#store.processEntities(result.id, window.user_id, note.entities);
                }

                // Auto-topic assignment
                const noteText = `${note.title || ""} ${note.content || ""} ${Array.isArray(note.tags) ? note.tags.join(" ") : ""}`;
                const topicNames = classifyTopics(noteText);
                for (let i = 0; i < topicNames.length; i++) {
                    try {
                        const topic = this.#store.resolveTopicName(window.user_id, topicNames[i]);
                        if (topic) {
                            this.#store.assignNoteToTopic(result.id, topic.id, i === 0);
                        }
                    } catch (e) {
                        log.warn(`Auto-topic assignment failed: ${e.message}`);
                    }
                }

                // Contradiction detection
                this.#store.detectContradictions(result.id, window.user_id, {
                    type: note.type || "fact",
                    title: note.title,
                    content: note.content,
                });
            } catch (e) {
                log.warn(`Failed to store extracted note: ${e.message}`);
            }
        }

        // Stage 5: Mark window as extracted (purge raw messages)
        this.#store.markWindowExtracted(window.id, noteIds);
        this.#store.updateExtractionStats(window.user_id, {
            notesProduced: noteIds.length,
            wasEmpty: noteIds.length === 0,
        });

        log.info(`Extracted ${noteIds.length} notes from window ${window.id}`);
        return noteIds;
    }

    /** Extract structured data using regex patterns (zero LLM cost) */
    #extractStructuredData(messages, window) {
        const results = [];
        for (const msg of messages) {
            if (msg.role !== "user") continue;
            for (const pattern of STRUCTURED_PATTERNS) {
                const match = msg.text?.match(pattern.regex);
                if (match) {
                    const data = pattern.extract(match);
                    try {
                        // Create a note for searchability
                        const noteResult = this.#store.createNote({
                            userId: window.user_id,
                            chatId: window.chat_id,
                            type: "health",
                            title: `${data.dataType}: ${data.value}${data.unit || ""}`,
                            content: `Recorded ${data.dataType}: ${data.value} ${data.unit || ""}`,
                            searchKeywords: [data.dataType, data.unit, "health", "measurement"].filter(Boolean),
                            tags: ["health", data.dataType],
                            sourceType: "extracted",
                            confidence: 0.95,
                            importance: 0.6,
                            scope: "user",
                            conversationId: window.id,
                        });

                        // Also store in structured_data table
                        const sdId = `sd-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
                        this.#store.db.prepare(
                            `INSERT INTO structured_data (id, note_id, user_id, data_type, value, unit, measured_at, metadata)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                        ).run(sdId, noteResult.id, window.user_id, data.dataType, data.value,
                            data.unit || null, new Date().toISOString(),
                            data.metadata ? JSON.stringify(data.metadata) : null);

                        // Auto-assign health data to Life topic
                        try {
                            const lifeTopic = this.#store.resolveTopicName(window.user_id, "Life");
                            if (lifeTopic) {
                                this.#store.assignNoteToTopic(noteResult.id, lifeTopic.id, true);
                            }
                        } catch (e) {
                            log.warn(`Auto-topic for structured data failed: ${e.message}`);
                        }

                        // Contradiction detection — supersede older readings of same type
                        this.#store.detectContradictions(noteResult.id, window.user_id, {
                            type: "health",
                            title: `${data.dataType}: ${data.value}${data.unit || ""}`,
                            content: `Recorded ${data.dataType}: ${data.value} ${data.unit || ""}`,
                            dataType: data.dataType,
                        });

                        results.push(noteResult);
                        log.info(`Extracted structured data: ${data.dataType}=${data.value}`);
                    } catch (e) {
                        log.warn(`Structured data storage failed: ${e.message}`);
                    }
                }
            }
        }
        return results;
    }

    /** Parse LLM response with 4-level JSON fallback */
    #parseLlmResponse(response) {
        if (!response || typeof response !== "string") return [];

        // Level 1: Direct parse
        try {
            const parsed = JSON.parse(response.trim());
            return Array.isArray(parsed) ? parsed.slice(0, 5) : [parsed];
        } catch { /* continue */ }

        // Level 2: Extract from ```json code block
        const codeBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
        if (codeBlockMatch) {
            try {
                const parsed = JSON.parse(codeBlockMatch[1].trim());
                return Array.isArray(parsed) ? parsed.slice(0, 5) : [parsed];
            } catch { /* continue */ }
        }

        // Level 3: Find array in response
        const arrayMatch = response.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
            try {
                const parsed = JSON.parse(arrayMatch[0]);
                return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
            } catch { /* continue */ }
        }

        // Level 4: Find single object
        const objMatch = response.match(/\{[\s\S]*\}/);
        if (objMatch) {
            try {
                const parsed = JSON.parse(objMatch[0]);
                return [parsed];
            } catch { /* continue */ }
        }

        log.warn("Failed to parse LLM extraction response (all 4 levels failed)");
        return [];
    }

    // ── Background timer ───────────────────────────────────

    /**
     * Run periodic maintenance tasks.
     * Called by background timer every 5 minutes.
     * @param {Function} llmCall - async (prompt) => response text
     */
    async runMaintenance(llmCall) {
        try {
            // 1. Close stale windows (all users)
            const staleWindows = this.#store.getAllStaleWindows();
            for (const win of staleWindows) {
                this.#store.closeWindow(win.id);
                log.info(`Closed stale window ${win.id} (user=${win.user_id})`);
            }

            // 2. Extract closed-but-not-extracted windows (requires LLM)
            if (llmCall) {
                const closedWindows = this.#store.db.prepare(
                    `SELECT * FROM conversation_windows WHERE extracted = 0 AND closed_at IS NOT NULL`
                ).all();
                for (const win of closedWindows) {
                    await this.extractWindow(win, llmCall);
                }

                // 3. Retry failed extractions (requires LLM)
                const pendingRetry = this.#store.getPendingExtractionWindows();
                for (const win of pendingRetry) {
                    await this.extractWindow(win, llmCall);
                }
            }

            // 4. Close oversized windows
            const oversized = this.#store.getOversizedWindows();
            for (const win of oversized) {
                this.#store.closeWindow(win.id);
                log.info(`Closed oversized window ${win.id}`);
            }

            // 5. Purge old raw messages (>7 days)
            this.#store.purgeOldRawMessages(7);

            // 6. Purge old audit logs (>90 days)
            this.#store.purgeOldAuditLogs(90);

            // 7. Decay activations
            try {
                const enabledUsers = this.#store.db.prepare(
                    "SELECT user_id FROM pkm_settings WHERE enabled = 1"
                ).all();
                for (const { user_id: userId } of enabledUsers) {
                    this.#store.decayAllActivations(userId);
                }
            } catch (e) {
                log.warn(`Activation decay failed: ${e.message}`);
            }

        } catch (e) {
            log.error(`Maintenance cycle failed: ${e.message}`);
        }
    }

    /**
     * Start the background maintenance timer.
     * @param {Function} llmCall - async (prompt) => response text
     * @param {number} intervalMs - Timer interval (default: 5 min)
     */
    startTimer(llmCall, intervalMs = 5 * 60 * 1000) {
        if (this.#timer) return;
        this.#timer = setInterval(() => this.runMaintenance(llmCall), intervalMs);
        log.info(`Background timer started (interval=${intervalMs / 1000}s)`);
    }

    /**
     * Start housekeeping timer WITHOUT LLM extraction.
     * Runs: close stale windows, close oversized, purge old data, decay activations.
     * Skips: LLM extraction of closed windows.
     */
    startHousekeepingTimer(intervalMs = 5 * 60 * 1000) {
        if (this.#timer) return;
        this.#timer = setInterval(() => this.runMaintenance(null), intervalMs);
        log.info(`Housekeeping timer started (no LLM, interval=${intervalMs / 1000}s)`);
    }

    stopTimer() {
        if (this.#timer) {
            clearInterval(this.#timer);
            this.#timer = null;
            log.info("Background timer stopped");
        }
    }
}

export default PkmExtractor;
