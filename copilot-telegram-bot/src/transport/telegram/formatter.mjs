// ============================================================
// Message Formatting Utilities
// ============================================================

export function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Strip HTML tags but preserve readable structure (for fallback when Telegram rejects HTML) */
export function stripHtmlKeepStructure(html) {
    let t = html;
    // Preserve line breaks from block elements
    t = t.replace(/<br\s*\/?>/gi, "\n");
    t = t.replace(/<\/(p|div|blockquote|pre)>/gi, "\n");
    t = t.replace(/<(p|div|blockquote|pre)[^>]*>/gi, "");
    // Strip remaining tags
    t = t.replace(/<[^>]+>/g, "");
    // Decode HTML entities back
    t = t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
    // Collapse excessive blank lines
    t = t.replace(/\n{3,}/g, "\n\n");
    return t.trim();
}

export function markdownToTelegramHtml(md) {
    const holds = [];

    function hold(html) {
        const i = holds.length;
        holds.push(html);
        return `\x00${i}\x00`;
    }

    let t = md;

    // Fenced code blocks: ```lang\ncode\n```
    t = t.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        code = code.replace(/\n$/, "");
        const cls = lang ? ` class="language-${lang}"` : "";
        return hold(`<pre><code${cls}>${escapeHtml(code)}</code></pre>`);
    });

    // Inline code: `code`
    t = t.replace(/`([^`\n]+)`/g, (_, code) => {
        return hold(`<code>${escapeHtml(code)}</code>`);
    });

    // Images: ![alt](url) -> linked text
    t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
        const label = alt || "image";
        return hold(`<a href="${escapeHtml(url)}">[${escapeHtml(label)}]</a>`);
    });

    // Links: [text](url)
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
        return hold(`<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`);
    });

    // Markdown tables: | col | col | → <pre> aligned columns
    t = t.replace(
        /(?:^\|.+\|[ \t]*\n)+/gm,
        (block) => {
            const rows = block.trim().split("\n").map(r =>
                r.replace(/^\||\|$/g, "").split("|").map(c => c.trim())
            );
            // Remove separator rows (---|---|---)
            const filtered = rows.filter(r => !r.every(c => /^[-:]+$/.test(c)));
            if (filtered.length === 0) return block;
            const colCount = Math.max(...filtered.map(r => r.length));
            const widths = Array.from({ length: colCount }, (_, i) =>
                Math.max(...filtered.map(r => (r[i] || "").length), 1)
            );
            const formatted = filtered.map(r =>
                r.map((c, i) => c.padEnd(widths[i] || 1)).join("  │  ")
            ).join("\n");
            return hold(`<pre>${escapeHtml(formatted)}</pre>`);
        }
    );

    // HTML-escape remaining text
    t = escapeHtml(t);

    // Bold+italic: ***text***
    t = t.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");
    // Bold: **text**
    t = t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    // Italic: *text* (CommonMark: no space after opening or before closing *)
    t = t.replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s|\*)\*(?!\*)/g, "<i>$1</i>");
    // Strikethrough: ~~text~~
    t = t.replace(/~~(.+?)~~/g, "<s>$1</s>");

    // Headers: # text -> bold
    t = t.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

    // Blockquotes
    t = t.replace(/(?:^&gt;[ ]?.*$\n?)+/gm, (block) => {
        const lines = block.trimEnd().split("\n");
        const content = lines.map(l => l.replace(/^&gt;[ ]?/, "")).join("\n");
        return `<blockquote>${content}</blockquote>\n`;
    });

    // Unordered lists: - item, * item, + item (with optional nesting)
    t = t.replace(/^([ \t]*)[-*+][ \t]+(.+)$/gm, (_, indent, content) => {
        const depth = Math.floor(indent.replace(/\t/g, "    ").length / 2);
        const bullet = depth === 0 ? "•" : depth === 1 ? "◦" : "▪";
        const pad = "  ".repeat(depth);
        return `${pad}${bullet} ${content}`;
    });

    // Ordered lists: 1. item, 2. item (preserve numbers)
    t = t.replace(/^([ \t]*)(\d+)\.[ \t]+(.+)$/gm, (_, indent, num, content) => {
        const depth = Math.floor(indent.replace(/\t/g, "    ").length / 2);
        const pad = "  ".repeat(depth);
        return `${pad}${num}. ${content}`;
    });

    // Horizontal rules
    t = t.replace(/^-{3,}$/gm, "\u2500".repeat(20));
    t = t.replace(/^\*{3,}$/gm, "\u2500".repeat(20));
    t = t.replace(/^_{3,}$/gm, "\u2500".repeat(20));

    // Restore placeholders
    t = t.replace(/\x00(\d+)\x00/g, (_, i) => holds[parseInt(i)]);

    return t;
}

export function chunkMessage(text, maxLen = 4096) {
    // Convert to HTML first, then chunk — HTML is always longer than markdown
    const html = markdownToTelegramHtml(text);
    return chunkHtml(html, maxLen);
}

/** Chunk pre-converted HTML, closing unclosed tags at chunk boundaries. */
export function chunkHtml(html, maxLen = 4096) {
    const chunks = [];
    let remaining = html;
    while (remaining.length > maxLen) {
        let splitAt = remaining.lastIndexOf("\n\n", maxLen);
        if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", maxLen);
        if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", maxLen);
        if (splitAt <= 0) splitAt = maxLen;

        // Don't split inside an HTML tag or entity
        const lastOpen = remaining.lastIndexOf("<", splitAt);
        const lastClose = remaining.lastIndexOf(">", splitAt);
        if (lastOpen > lastClose) splitAt = lastOpen;
        const lastAmp = remaining.lastIndexOf("&", splitAt);
        const lastSemi = remaining.lastIndexOf(";", splitAt);
        if (lastAmp > lastSemi && splitAt - lastAmp < 8) splitAt = lastAmp;

        let chunk = remaining.slice(0, splitAt);
        remaining = remaining.slice(splitAt).replace(/^\n+/, "");

        // Close any unclosed HTML tags in this chunk
        chunk = closeOpenTags(chunk);
        chunks.push(chunk);
    }
    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
}

/** Track and close unclosed HTML tags to produce valid HTML fragments. */
function closeOpenTags(html) {
    const openTags = [];
    const tagRe = /<\/?([a-z]+)[^>]*>/gi;
    let m;
    while ((m = tagRe.exec(html))) {
        const tag = m[1].toLowerCase();
        if (m[0].startsWith("</")) {
            const idx = openTags.lastIndexOf(tag);
            if (idx !== -1) openTags.splice(idx, 1);
        } else if (!m[0].endsWith("/>")) {
            openTags.push(tag);
        }
    }
    // Close in reverse order
    let closed = html;
    for (let i = openTags.length - 1; i >= 0; i--) {
        closed += `</${openTags[i]}>`;
    }
    return closed;
}

import { basename } from "node:path";

export function describeToolCall(toolName, args) {
    if (!args) return toolName;
    try {
        switch (toolName) {
            case "bash":
            case "powershell": {
                const cmd = args.command || "";
                return cmd.split("\n")[0];
            }
            case "grep": {
                const pat = args.pattern || "";
                const g = args.glob ? ` ${args.glob}` : (args.path ? ` ${basename(args.path)}` : "");
                return `grep "${pat}"${g}`;
            }
            case "glob": return `glob ${args.pattern || ""}`;
            case "view": return args.path ? `view ${basename(args.path)}` : "view";
            case "edit": return args.path ? `edit ${basename(args.path)}` : "edit";
            case "create": return args.path ? `create ${basename(args.path)}` : "create";
            case "task": {
                const desc = args.description || args.agent_type || "";
                return desc ? `task: ${desc}` : "task";
            }
            case "web_fetch":
                try { return `fetch ${new URL(args.url).hostname}`; } catch { return "fetch"; }
            case "sql": return args.description || "sql";
            case "skill": return args.skill ? `skill: ${args.skill}` : "skill";
            case "ask_user": return "waiting for input";
            case "read_agent":
            case "write_agent":
            case "list_agents":
            case "read_bash":
            case "write_bash":
            case "stop_bash":
            case "report_intent":
            case "store_memory":
                return null; // suppress noisy internal tools
            default:
                return toolName.replace(/_/g, " ");
        }
    } catch {
        return toolName;
    }
}
