// ============================================================
// Message Formatting Utilities
// ============================================================

export function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

    // HTML-escape remaining text
    t = escapeHtml(t);

    // Bold+italic: ***text***
    t = t.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");
    // Bold: **text**
    t = t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    // Italic: *text*
    t = t.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
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

    // Horizontal rules
    t = t.replace(/^-{3,}$/gm, "\u2500".repeat(20));
    t = t.replace(/^\*{3,}$/gm, "\u2500".repeat(20));
    t = t.replace(/^_{3,}$/gm, "\u2500".repeat(20));

    // Restore placeholders
    t = t.replace(/\x00(\d+)\x00/g, (_, i) => holds[parseInt(i)]);

    return t;
}

export function chunkMessage(text, maxLen = 4096) {
    const chunks = [];
    let remaining = text;
    while (remaining.length > maxLen) {
        let splitAt = remaining.lastIndexOf("\n\n", maxLen);
        if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", maxLen);
        if (splitAt <= 0) splitAt = maxLen;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).replace(/^\n+/, "");
    }
    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
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
