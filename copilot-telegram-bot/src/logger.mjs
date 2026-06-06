// ============================================================
// Structured Logger — ANSI-colored, levelled, module-tagged
// ============================================================
// Usage:
//   import { createLogger } from './logger.mjs';
//   const log = createLogger('telegram');
//   log.info('Connected');     // 07:18:44.512 INFO  [telegram] Connected
//   log.debug('Poll offset');  // (hidden when LOG_LEVEL=info)
//   log.warn('Rate limited');
//   log.error('Send failed');

// ---------- Level definitions ----------

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

// ---------- ANSI colours ----------

const BOLD  = '\x1b[1m';
const RESET = '\x1b[0m';

const LEVEL_STYLE = {
    debug: '\x1b[36m',       // cyan
    info:  '\x1b[32m',       // green
    warn:  `${BOLD}\x1b[33m`, // bold yellow
    error: `${BOLD}\x1b[31m`, // bold red
};

const LEVEL_LABEL = {
    debug: 'DEBUG',
    info:  'INFO ',
    warn:  'WARN ',
    error: 'ERROR',
};

// Rotating palette for module tags
const MODULE_PALETTE = [
    '\x1b[35m',  // magenta
    '\x1b[34m',  // blue
    '\x1b[36m',  // cyan
    '\x1b[33m',  // yellow
    '\x1b[95m',  // bright magenta
    '\x1b[94m',  // bright blue
    '\x1b[96m',  // bright cyan
    '\x1b[93m',  // bright yellow
    '\x1b[92m',  // bright green
    '\x1b[91m',  // bright red
];

// ---------- State ----------

let currentLevel = LEVELS.info;

const moduleColors = new Map();
let colorIndex = 0;

// ---------- Public API ----------

/**
 * Set the minimum log level. Messages below this level are suppressed.
 * @param {string} level — 'debug' | 'info' | 'warn' | 'error'
 */
export function setLogLevel(level) {
    const normalized = (typeof level === 'string' ? level : 'info').toLowerCase().trim();
    if (normalized in LEVELS) {
        currentLevel = LEVELS[normalized];
    }
}

/** Return the current log level name. */
export function getLogLevel() {
    for (const [name, val] of Object.entries(LEVELS)) {
        if (val === currentLevel) return name;
    }
    return 'info';
}

/**
 * Create a named logger for a module.
 *
 * @param {string} module — short module name shown in brackets, e.g. 'telegram', 'acp', 'bridge'
 * @returns {{ debug: (msg: string) => void, info: (msg: string) => void, warn: (msg: string) => void, error: (msg: string) => void }}
 */
export function createLogger(module) {
    // Assign a stable colour to each module name
    if (!moduleColors.has(module)) {
        moduleColors.set(module, MODULE_PALETTE[colorIndex % MODULE_PALETTE.length]);
        colorIndex++;
    }
    const modColor = moduleColors.get(module);
    const tag = `${modColor}[${module}]${RESET}`;

    function emit(level, msg) {
        if (LEVELS[level] < currentLevel) return;
        const ts = formatTime();
        const lvl = `${LEVEL_STYLE[level]}${LEVEL_LABEL[level]}${RESET}`;
        console.log(`${ts} ${lvl} ${tag} ${msg}`);
    }

    return {
        debug: (msg) => emit('debug', msg),
        info:  (msg) => emit('info', msg),
        warn:  (msg) => emit('warn', msg),
        error: (msg) => emit('error', msg),
    };
}

// ---------- Helpers ----------

function formatTime() {
    const d = new Date();
    const h  = String(d.getHours()).padStart(2, '0');
    const m  = String(d.getMinutes()).padStart(2, '0');
    const s  = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${h}:${m}:${s}.${ms}`;
}
