// ============================================================
// File Handler — Download and classify Telegram file attachments
// ============================================================
// Handles photos, documents, and unsupported media types.
// Returns enriched text or rejection messages.

import { createLogger } from "../logger.mjs";

const log = createLogger("file-handler");

const MAX_TEXT_SIZE = 50 * 1024; // 50KB

const TEXT_EXTENSIONS = new Set([
    "yaml", "yml", "json", "py", "js", "mjs", "ts", "tsx",
    "md", "txt", "csv", "log", "xml", "html", "css", "sh",
    "bash", "toml", "ini", "cfg", "conf", "env", "sql",
    "go", "rs", "java", "c", "cpp", "h", "hpp", "rb",
]);

const TEXT_MIMES = new Set([
    "text/plain", "text/html", "text/css", "text/csv",
    "text/xml", "text/markdown", "application/json",
    "application/xml", "application/x-yaml", "application/yaml",
    "application/javascript", "application/x-sh",
]);

export class FileHandler {
    #telegram;

    constructor({ telegram }) {
        this.#telegram = telegram;
    }

    /**
     * Process a message for file attachments.
     * Returns { text, hasFile } where text includes file content or rejection notice.
     */
    async process(msg) {
        // Photo
        if (msg.photo?.length) {
            return this.#handlePhoto(msg);
        }

        // Document
        if (msg.document) {
            return this.#handleDocument(msg);
        }

        // Voice/audio
        if (msg.voice || msg.audio) {
            return {
                text: null,
                rejection: "🎤 I can't process voice/audio messages yet. Please type your message instead.",
            };
        }

        // Video/animation
        if (msg.video || msg.animation || msg.video_note) {
            return {
                text: null,
                rejection: "🎬 I can't process videos. Try sending a screenshot or describing what you need.",
            };
        }

        // Sticker
        if (msg.sticker) {
            const emoji = msg.sticker.emoji || "🙂";
            return {
                text: `[User sent sticker: ${emoji}]`,
                rejection: null,
            };
        }

        // Contact
        if (msg.contact) {
            return {
                text: null,
                rejection: "📇 I can't process contacts directly. Please describe what you need.",
            };
        }

        // Location
        if (msg.location) {
            const { latitude, longitude } = msg.location;
            return {
                text: `[User shared location: ${latitude}, ${longitude}]`,
                rejection: null,
            };
        }

        // No attachment
        return { text: null, rejection: null };
    }

    async #handlePhoto(msg) {
        // Get the largest photo
        const photo = msg.photo[msg.photo.length - 1];
        try {
            const fileInfo = await this.#telegram.getFile(photo.file_id);
            const buffer = await this.#telegram.downloadFile(fileInfo.file_path);

            // Save to temp path for ACP to reference
            const tmpPath = `/tmp/tg_photo_${Date.now()}.jpg`;
            const { writeFileSync } = await import("node:fs");
            writeFileSync(tmpPath, buffer);

            const caption = msg.caption || "";
            const text = caption
                ? `[User sent a photo with caption: "${caption}"]\n[Photo saved at: ${tmpPath}]`
                : `[User sent a photo]\n[Photo saved at: ${tmpPath}]`;

            return { text, rejection: null, photoPath: tmpPath };
        } catch (err) {
            log.error(`Photo download failed: ${err.message}`);
            return {
                text: null,
                rejection: "⚠️ Couldn't download the photo. Please try again.",
            };
        }
    }

    async #handleDocument(msg) {
        const doc = msg.document;
        const fileName = doc.file_name || "unknown";
        const mimeType = doc.mime_type || "";
        const fileSize = doc.file_size || 0;

        // Check if it's a text file
        const ext = fileName.split(".").pop()?.toLowerCase() || "";
        const isText = TEXT_EXTENSIONS.has(ext) || TEXT_MIMES.has(mimeType);

        if (!isText) {
            return {
                text: null,
                rejection: `📄 I received "${fileName}" but I can only read text-based files (code, yaml, json, md, txt, csv, etc).`,
            };
        }

        if (fileSize > MAX_TEXT_SIZE) {
            return {
                text: null,
                rejection: `📄 "${fileName}" is too large (${Math.round(fileSize / 1024)}KB). Max is 50KB.`,
            };
        }

        try {
            const fileInfo = await this.#telegram.getFile(doc.file_id);
            const buffer = await this.#telegram.downloadFile(fileInfo.file_path);
            const content = buffer.toString("utf-8");
            const caption = msg.caption || "";

            const text = caption
                ? `${caption}\n\n[Attached file: ${fileName}]\n\`\`\`\n${content}\n\`\`\``
                : `[Attached file: ${fileName}]\n\`\`\`\n${content}\n\`\`\``;

            log.debug(`Processed document: ${fileName} (${buffer.length} bytes)`);
            return { text, rejection: null };
        } catch (err) {
            log.error(`Document download failed: ${err.message}`);
            return {
                text: null,
                rejection: `⚠️ Couldn't download "${fileName}". Please try again.`,
            };
        }
    }
}
