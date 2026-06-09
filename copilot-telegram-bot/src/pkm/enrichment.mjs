// ============================================================
// PkmEnrichment — Auto-generate metadata from memory content
// ============================================================
// Takes a plain text memory string and produces title, type,
// tags, search_keywords, topics, entities, importance, durability.
// Uses compromise.js for NER + RAKE for keyword phrases.
// Zero LLM cost — sub-millisecond on ARM.

import nlp from "compromise";
import { createLogger } from "../logger.mjs";

const log = createLogger("pkm-enrich");

// ── Stop words (excluded from keyword generation) ──────────

const STOP_WORDS = new Set([
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "shall", "can", "need", "must",
    "it", "its", "this", "that", "these", "those", "i", "me", "my", "we",
    "our", "you", "your", "he", "him", "his", "she", "her", "they", "them",
    "their", "who", "whom", "which", "what", "where", "when", "how", "why",
    "not", "no", "nor", "so", "if", "then", "than", "too", "very", "just",
    "about", "also", "into", "over", "after", "before", "between", "under",
    "again", "there", "here", "all", "each", "every", "both", "few", "more",
    "most", "other", "some", "such", "only", "own", "same", "up", "down",
    "out", "off", "once", "now", "s", "t", "re", "ve", "ll", "d", "m",
]);

// ── Type classification patterns ───────────────────────────

const TYPE_PATTERNS = [
    { type: "preference", patterns: [
        /\b(?:prefer|prefers|preferred|like|likes|liked|love|loves|loved|hate|hates|hated|dislike|dislikes|enjoy|enjoys|enjoyed|favourite|favorite|fond of|can't stand)\b/i,
        /\b(?:always want|rather have|go-to|must-have)\b/i,
    ]},
    { type: "event", patterns: [
        /\b(?:went|visited|attended|happened|trip|travel|flew|booked|celebrated|graduated|moved)\b/i,
        /\b(?:ate|dined|restaurant|meal|dinner|lunch|breakfast)\b/i,
    ]},
    { type: "meeting", patterns: [
        /\b(?:met|meeting|discussed|call with|spoke with|talked to|caught up|appointment)\b/i,
    ]},
    { type: "health", patterns: [
        /\b(?:bp|blood pressure|weight|sleep|exercise|workout|gym|run|jog|doctor|clinic|medication|vaccine|allergy|symptom|diagnosis|prescription)\b/i,
    ]},
    { type: "journal", patterns: [
        /\b(?:feel|feeling|today|mood|grateful|stressed|anxious|happy|sad|tired|excited|frustrated)\b/i,
    ]},
    { type: "reflection", patterns: [
        /\b(?:learned|realized|noticed|insight|lesson|takeaway|conclusion|decided)\b/i,
    ]},
];

// ── Hypernym dictionary (word → broader category terms) ────

const HYPERNYMS = {
    // Food
    sushi: ["japanese food", "seafood", "cuisine", "dining"],
    pizza: ["italian food", "cuisine", "dining"],
    pasta: ["italian food", "cuisine", "dining"],
    ramen: ["japanese food", "noodles", "cuisine", "dining"],
    burger: ["american food", "fast food", "cuisine", "dining"],
    steak: ["beef", "meat", "protein", "dining"],
    salmon: ["fish", "seafood", "protein", "dining"],
    grouper: ["fish", "seafood", "protein", "dining"],
    chicken: ["poultry", "meat", "protein"],
    coffee: ["beverage", "drink", "caffeine"],
    tea: ["beverage", "drink"],
    wine: ["alcohol", "beverage", "drink"],
    beer: ["alcohol", "beverage", "drink"],

    // Places
    restaurant: ["dining", "food", "eating out"],
    hotel: ["accommodation", "travel", "lodging"],
    airport: ["travel", "transport"],
    hospital: ["healthcare", "medical"],
    clinic: ["healthcare", "medical"],
    gym: ["fitness", "exercise", "health"],
    school: ["education", "learning"],
    office: ["work", "workplace"],

    // People relations
    wife: ["spouse", "partner", "family", "marriage"],
    husband: ["spouse", "partner", "family", "marriage"],
    daughter: ["child", "family", "kid"],
    son: ["child", "family", "kid"],
    mother: ["parent", "family"],
    father: ["parent", "family"],
    mom: ["parent", "family", "mother"],
    dad: ["parent", "family", "father"],
    brother: ["sibling", "family"],
    sister: ["sibling", "family"],
    friend: ["social", "relationship"],
    colleague: ["work", "coworker", "professional"],
    boss: ["work", "manager", "professional"],
    doctor: ["healthcare", "medical", "professional"],

    // Activities
    wedding: ["celebration", "event", "ceremony", "marriage"],
    birthday: ["celebration", "event", "anniversary"],
    vacation: ["travel", "holiday", "leisure"],
    holiday: ["travel", "vacation", "leisure"],
    concert: ["music", "entertainment", "event"],
    movie: ["entertainment", "film", "leisure"],

    // Tech / Home
    sensor: ["smart home", "automation", "iot"],
    light: ["smart home", "automation", "lighting"],
    switch: ["smart home", "automation"],
    automation: ["smart home", "iot"],
};

// ── Topic classification (matches extractor.mjs patterns) ──

const TOPIC_PATTERNS = {
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

// ── Entity extraction patterns ─────────────────────────────

const RELATION_PATTERNS = [
    { re: /\bmy\s+(wife|husband|spouse|partner|daughter|son|child|mother|father|mom|dad|brother|sister|friend|boss|colleague|doctor|dentist|teacher|neighbor|aunt|uncle|cousin|grandma|grandpa|grandmother|grandfather)\s+(\w+)/gi, nameIdx: 2, relIdx: 1 },
    { re: /\b(\w+)\s+is\s+my\s+(wife|husband|spouse|partner|daughter|son|child|mother|father|mom|dad|brother|sister|friend|boss|colleague|doctor|dentist|teacher|neighbor|aunt|uncle|cousin|grandma|grandpa|grandmother|grandfather)\b/gi, nameIdx: 1, relIdx: 2 },
];

// ── Main enrichment function ───────────────────────────────

/**
 * Auto-enrich a plain text memory into full metadata.
 * @param {string} content — the raw memory text
 * @param {object} [overrides] — optional overrides for any field
 * @returns {object} { title, type, tags, searchKeywords, topics, entities, importance, durability }
 */
export function autoEnrich(content, overrides = {}) {
    if (!content || typeof content !== "string") {
        return { title: "", type: "fact", tags: [], searchKeywords: [], topics: [], entities: [], importance: 0.5, durability: "normal" };
    }

    const trimmed = content.trim();

    const title = overrides.title || generateTitle(trimmed);
    const type = overrides.type || classifyType(trimmed);
    const tags = overrides.tags?.length ? overrides.tags : generateTags(trimmed, type);
    const searchKeywords = generateKeywords(trimmed, title, tags);
    const topics = overrides.topics?.length ? overrides.topics : classifyTopics(trimmed);
    const entities = extractEntities(trimmed);
    const importance = typeof overrides.importance === "number" ? overrides.importance : estimateImportance(trimmed, type, entities);
    const durability = overrides.durability || estimateDurability(trimmed, type);

    return { title, type, tags, searchKeywords, topics, entities, importance, durability };
}

// ── Title generation ───────────────────────────────────────

function generateTitle(text) {
    // Split on sentence boundaries, but preserve abbreviations (Dr., Mr., etc.)
    const cleaned = text.replace(/\b(Dr|Mr|Mrs|Ms|Prof|Jr|Sr|St|Ave|Blvd)\./gi, "$1\u200B");
    const firstSentence = cleaned.split(/[.!?\n]/)[0]?.replace(/\u200B/g, ".").trim() || text;
    if (firstSentence.length <= 80) return firstSentence;
    const truncated = firstSentence.substring(0, 77);
    const lastSpace = truncated.lastIndexOf(" ");
    return (lastSpace > 40 ? truncated.substring(0, lastSpace) : truncated) + "...";
}

// ── Type classification ────────────────────────────────────

function classifyType(text) {
    for (const { type, patterns } of TYPE_PATTERNS) {
        if (patterns.some(p => p.test(text))) return type;
    }
    return "fact";
}

// ── Tag generation ─────────────────────────────────────────

function generateTags(text, type) {
    const tags = new Set();

    // Add type as tag
    tags.add(type);

    // Extract meaningful words (nouns/adjectives heuristic)
    const words = text.toLowerCase()
        .replace(/[^a-z0-9\s'-]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));

    // Count word frequency, take top meaningful ones
    const freq = {};
    for (const w of words) {
        freq[w] = (freq[w] || 0) + 1;
    }

    // Sort by frequency, take top 4
    const sorted = Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([w]) => w);

    for (const w of sorted) tags.add(w);

    // Add topic-based tags
    for (const [topic, patterns] of Object.entries(TOPIC_PATTERNS)) {
        if (patterns.some(p => p.test(text))) {
            tags.add(topic.toLowerCase());
        }
    }

    return [...tags].slice(0, 7);
}

// ── RAKE (Rapid Automatic Keyword Extraction) ─────────────

/**
 * RAKE algorithm: split on stopwords → score candidate phrases
 * by word degree / word frequency. Returns ranked key phrases.
 */
function rake(text) {
    const lower = text.toLowerCase().replace(/[^a-z0-9\s'-]/g, " ");

    // Split into candidate phrases (sequences between stopwords)
    const stopPattern = new RegExp(
        `\\b(?:${[...STOP_WORDS].join("|")})\\b`, "gi"
    );
    const candidates = lower.split(stopPattern)
        .map(p => p.trim())
        .filter(p => p.length > 2 && p.split(/\s+/).length <= 4);

    // Word frequency and degree
    const freq = {};
    const degree = {};
    for (const phrase of candidates) {
        const words = phrase.split(/\s+/).filter(w => w.length > 1);
        for (const w of words) {
            freq[w] = (freq[w] || 0) + 1;
            degree[w] = (degree[w] || 0) + words.length;
        }
    }

    // Score each phrase: sum of (degree / freq) per word
    const phraseScores = {};
    const seen = new Set();
    for (const phrase of candidates) {
        if (seen.has(phrase)) continue;
        seen.add(phrase);
        const words = phrase.split(/\s+/).filter(w => w.length > 1);
        let score = 0;
        for (const w of words) {
            score += (degree[w] || 0) / (freq[w] || 1);
        }
        phraseScores[phrase] = score;
    }

    return Object.entries(phraseScores)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([phrase]) => phrase);
}

// ── Search keyword generation (RAKE + hypernyms) ───────────

function generateKeywords(text, title, tags) {
    const keywords = new Set();

    // 1. RAKE key phrases
    const rakeResults = rake(text);
    for (const phrase of rakeResults) {
        keywords.add(phrase);
        // Also add individual words from multi-word phrases
        for (const w of phrase.split(/\s+/)) {
            if (w.length > 2 && !STOP_WORDS.has(w)) keywords.add(w);
        }
    }

    // 2. Title words
    if (title) {
        const titleWords = title.toLowerCase()
            .replace(/[^a-z0-9\s'-]/g, " ")
            .split(/\s+/)
            .filter(w => w.length > 2 && !STOP_WORDS.has(w));
        for (const w of titleWords) keywords.add(w);
    }

    // 3. Tags
    for (const t of tags) keywords.add(t.toLowerCase());

    // 4. Hypernyms for content words
    const contentWords = text.toLowerCase()
        .replace(/[^a-z0-9\s'-]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));

    for (const w of contentWords) {
        const hyps = HYPERNYMS[w];
        if (hyps) {
            for (const h of hyps) {
                keywords.add(h);
                for (const part of h.split(/\s+/)) {
                    if (part.length > 2) keywords.add(part);
                }
            }
        }
    }

    // 5. compromise.js noun phrases (catch what RAKE might miss)
    try {
        const doc = nlp(text);
        for (const np of doc.nouns().out("array")) {
            const lower = np.toLowerCase();
            if (lower.length > 2 && !STOP_WORDS.has(lower)) keywords.add(lower);
        }
    } catch { /* non-fatal */ }

    return [...keywords].slice(0, 60);
}

// ── Topic classification ───────────────────────────────────

function classifyTopics(text) {
    const scores = {};
    const combined = (text || "").toLowerCase();

    for (const [topic, patterns] of Object.entries(TOPIC_PATTERNS)) {
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

// ── Entity extraction (compromise.js + relation patterns) ──

function extractEntities(text) {
    const entities = [];
    const seen = new Set();

    const addEntity = (name, type, relation) => {
        const key = name.toLowerCase().trim();
        if (key.length < 2 || seen.has(key)) return;
        seen.add(key);
        const entry = { name: name.trim(), type };
        if (relation) entry.relation = relation;
        entities.push(entry);
    };

    // 1. Relation patterns ("my wife Alice", "Bob is my boss")
    for (const { re, nameIdx, relIdx } of RELATION_PATTERNS) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(text)) !== null) {
            const name = match[nameIdx]?.trim();
            const relation = match[relIdx]?.trim().toLowerCase();
            if (name && name[0] === name[0].toUpperCase()) {
                addEntity(name, "person", relation);
            }
        }
    }

    // 2. compromise.js NER — people, places, organizations
    try {
        const doc = nlp(text);
        for (const name of doc.people().out("array")) addEntity(name, "person");
        for (const name of doc.places().out("array")) addEntity(name, "place");
        for (const name of doc.organizations().out("array")) addEntity(name, "organization");
    } catch (e) {
        log.warn(`compromise NER failed: ${e.message}`);
    }

    return entities.slice(0, 10);
}

// ── Importance estimation ──────────────────────────────────

function estimateImportance(text, type, entities) {
    let score = 0.5; // base

    // Type bumps
    if (type === "health") score = Math.max(score, 0.7);
    if (type === "meeting") score = Math.max(score, 0.6);
    if (type === "preference") score = Math.max(score, 0.6);

    // Entity presence bumps
    if (entities.length > 0) score = Math.min(score + 0.1, 1.0);
    if (entities.length > 2) score = Math.min(score + 0.1, 1.0);

    // Length heuristic — longer = more detailed = more important
    if (text.length > 200) score = Math.min(score + 0.1, 1.0);

    // Relationship mentions are important
    if (/\b(?:wife|husband|daughter|son|mother|father|partner|spouse)\b/i.test(text)) {
        score = Math.min(score + 0.15, 1.0);
    }

    return Math.round(score * 100) / 100;
}

// ── Durability estimation ──────────────────────────────────

function estimateDurability(text, type) {
    // Permanent: birthdays, family relations, allergies, chronic conditions
    if (/\b(?:birthday|born|anniversary|allergy|allergic|chronic|maiden name|blood type)\b/i.test(text)) {
        return "permanent";
    }
    if (/\b(?:married|engaged|divorced|graduated)\b/i.test(text)) {
        return "permanent";
    }

    // Ephemeral: mood, weather, current feelings, today-specific
    if (type === "journal") return "ephemeral";
    if (/\b(?:right now|at the moment|currently|today|tonight|this morning|this evening)\b/i.test(text)) {
        return "ephemeral";
    }

    return "normal";
}

// ── Entity-aware message scanning (for prefetch hints) ─────

/**
 * Cheap extraction of potential entity/topic/keyword mentions from a message.
 * Uses compromise.js NER + topic patterns. Sub-millisecond on ARM.
 * @param {string} text — incoming user message
 * @returns {{ entities: string[], topics: string[], keywords: string[] }}
 */
export function scanMessage(text) {
    if (!text || typeof text !== "string") return { entities: [], topics: [], keywords: [] };

    const entities = new Set();
    const topics = new Set();
    const keywords = new Set();

    // compromise.js NER — people, places, organizations
    try {
        const doc = nlp(text);
        for (const name of doc.people().out("array")) entities.add(name);
        for (const name of doc.places().out("array")) entities.add(name);
        for (const name of doc.organizations().out("array")) entities.add(name);

        // Extract nouns as search keywords
        for (const noun of doc.nouns().out("array")) {
            const lower = noun.toLowerCase();
            if (lower.length > 2 && !STOP_WORDS.has(lower)) keywords.add(lower);
        }
    } catch {
        // Fallback: extract proper nouns via capitalization
        for (const word of text.split(/\s+/)) {
            const clean = word.replace(/[^a-zA-Z]/g, "");
            if (clean.length > 1 && clean[0] === clean[0].toUpperCase() && clean[0] !== clean[0].toLowerCase()) {
                if (!STOP_WORDS.has(clean.toLowerCase())) entities.add(clean);
            }
        }
    }

    // Classify topics
    const lower = text.toLowerCase();
    for (const [topic, patterns] of Object.entries(TOPIC_PATTERNS)) {
        if (patterns.some(p => p.test(lower))) {
            topics.add(topic);
        }
    }

    return { entities: [...entities], topics: [...topics], keywords: [...keywords] };
}

export default { autoEnrich, scanMessage, rake };
