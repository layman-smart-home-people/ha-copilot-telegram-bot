// ============================================================
// Copilot CLI Bootstrap — Auto-download on first start
// ============================================================
// Downloads the GitHub Copilot CLI binary if not present.
// Used when copilot_binary is "auto" and no binary is found.

import { existsSync, mkdirSync, createWriteStream, chmodSync, renameSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { dirname } from "node:path";
import { createLogger } from "./logger.mjs";

const log = createLogger("bootstrap");

const INSTALL_DIR = "/data/copilot/bin";
const BINARY_PATH = `${INSTALL_DIR}/copilot`;
const VERSION_FILE = `${INSTALL_DIR}/.version`;
const RELEASE_BASE = "https://github.com/github/copilot-cli/releases/latest/download";

/**
 * Detect the architecture string used in GitHub release asset names.
 * @returns {"x64"|"arm64"}
 */
function detectArch() {
    const arch = process.arch;
    if (arch === "x64" || arch === "ia32") return "x64";
    if (arch === "arm64") return "arm64";
    const uname = execSync("uname -m", { encoding: "utf-8" }).trim();
    if (uname === "x86_64" || uname === "amd64") return "x64";
    if (uname === "aarch64" || uname === "arm64") return "arm64";
    throw new Error(`Unsupported architecture: ${arch} (uname: ${uname})`);
}

/**
 * Download a file from a URL to a local path.
 * @param {string} url
 * @param {string} destPath
 */
async function downloadFile(url, destPath) {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
        throw new Error(`Download failed: ${res.status} ${res.statusText} from ${url}`);
    }
    const fileStream = createWriteStream(destPath);
    await pipeline(res.body, fileStream);
}

/**
 * Verify SHA256 checksum of a file.
 * @param {string} filePath
 * @param {string} expectedHash
 * @returns {boolean}
 */
function verifyChecksum(filePath, expectedHash) {
    const hash = createHash("sha256");
    hash.update(readFileSync(filePath));
    return hash.digest("hex") === expectedHash;
}

/**
 * Ensure the Copilot CLI binary is available.
 * If the binary exists, returns its path immediately.
 * If not, downloads it from GitHub releases.
 *
 * @param {string} [targetPath] — where to install (default: /data/copilot/bin/copilot)
 * @returns {Promise<string>} path to the binary
 * @throws {Error} if download fails
 */
export async function ensureCopilotBinary(targetPath = BINARY_PATH) {
    if (existsSync(targetPath)) {
        return targetPath;
    }

    log.info("Copilot CLI binary not found — downloading from GitHub...");

    const arch = detectArch();
    const tarballName = `copilot-linux-${arch}.tar.gz`;
    const downloadUrl = `${RELEASE_BASE}/${tarballName}`;
    const checksumsUrl = `${RELEASE_BASE}/SHA256SUMS.txt`;

    // Ensure install directory exists
    const installDir = dirname(targetPath);
    mkdirSync(installDir, { recursive: true });

    const tmpTarball = `${installDir}/.copilot-download.tar.gz`;
    const tmpBinary = `${installDir}/.copilot-tmp`;

    try {
        // Download tarball
        log.info(`Downloading ${downloadUrl}...`);
        await downloadFile(downloadUrl, tmpTarball);
        log.info("Download complete. Verifying...");

        // Attempt checksum verification
        try {
            const checksumRes = await fetch(checksumsUrl, { redirect: "follow" });
            if (checksumRes.ok) {
                const checksumText = await checksumRes.text();
                const line = checksumText.split("\n").find(l => l.includes(tarballName));
                if (line) {
                    const expectedHash = line.split(/\s+/)[0];
                    if (verifyChecksum(tmpTarball, expectedHash)) {
                        log.info("SHA256 checksum verified ✓");
                    } else {
                        throw new Error("SHA256 checksum mismatch — download may be corrupted");
                    }
                } else {
                    log.warn("Tarball not found in SHA256SUMS.txt — checksum verification skipped");
                }
            }
        } catch (checksumErr) {
            if (checksumErr.message.includes("mismatch")) throw checksumErr;
            log.warn(`Checksum verification skipped: ${checksumErr.message}`);
        }

        // Extract binary from tarball
        execSync(`tar -xzf "${tmpTarball}" -C "${installDir}" copilot`, {
            stdio: "pipe",
        });

        // The tarball extracts `copilot` directly (or in a subdirectory)
        const extractedPath = `${installDir}/copilot`;
        if (!existsSync(extractedPath)) {
            // Try extracting everything and finding the binary
            execSync(`tar -xzf "${tmpTarball}" -C "${installDir}"`, { stdio: "pipe" });
            if (!existsSync(extractedPath)) {
                throw new Error("Binary not found in tarball after extraction");
            }
        }

        // Make executable
        chmodSync(extractedPath, 0o755);

        // If target is different from extracted location, move it
        if (extractedPath !== targetPath) {
            renameSync(extractedPath, targetPath);
        }

        // Record version
        try {
            const version = execSync(`"${targetPath}" version`, {
                encoding: "utf-8",
                timeout: 10000,
            }).trim();
            mkdirSync(dirname(VERSION_FILE), { recursive: true });
            writeFileSync(VERSION_FILE, version, "utf-8");
            log.info(`Installed: ${version}`);
        } catch {
            log.info("Installed successfully (version check skipped)");
        }

        return targetPath;
    } finally {
        // Cleanup temp files
        try { if (existsSync(tmpTarball)) unlinkSync(tmpTarball); } catch {}
        try { if (existsSync(tmpBinary)) unlinkSync(tmpBinary); } catch {}
    }
}

/**
 * Ensure the Copilot config directory exists.
 * @param {string} configDir
 */
export function ensureCopilotConfigDir(configDir) {
    if (configDir && !existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
        log.info(`Created config directory: ${configDir}`);
    }
}
