// ============================================================
// Phase B Test Definitions
// ============================================================
// Tests for requirement: ER-1 (Embedded SDK proof-of-concept)

import { testRegistry } from "./test-registry.mjs";
import { readFile, access } from "node:fs/promises";

// --- ER-1: Embedded SDK proof-of-concept ---
testRegistry.register("ER-1", "B", "Embedded SDK proof-of-concept", async () => {
    const checks = [];

    // Check 1: Spike files exist
    const spikeFiles = [
        new URL("../ai/embedded/spike-vercel.mjs", import.meta.url),
        new URL("../ai/embedded/spike-anthropic.mjs", import.meta.url),
        new URL("../ai/embedded/decision.mjs", import.meta.url),
    ];
    for (const f of spikeFiles) {
        try {
            await access(f);
            checks.push(`PASS: ${f.pathname.split("/").pop()} exists`);
        } catch {
            checks.push(`FAIL: ${f.pathname.split("/").pop()} missing`);
        }
    }

    // Check 2: Decision document recommends an SDK
    try {
        const src = await readFile(
            new URL("../ai/embedded/decision.mjs", import.meta.url), "utf-8"
        );
        if (!src.includes("recommendation:")) {
            checks.push("FAIL: decision.mjs missing recommendation field");
        } else {
            checks.push("PASS: decision.mjs contains SDK recommendation");
        }
    } catch (err) {
        checks.push(`FAIL: cannot read decision.mjs: ${err.message}`);
    }

    // Check 3: Vercel spike has all 3 tests (generateText, streamText, MCP client)
    try {
        const src = await readFile(
            new URL("../ai/embedded/spike-vercel.mjs", import.meta.url), "utf-8"
        );
        const patterns = ["generateText", "streamText", "MCP client"];
        for (const p of patterns) {
            if (!src.includes(p)) {
                checks.push(`FAIL: spike-vercel.mjs missing ${p} test`);
            }
        }
        if (!checks.some(c => c.includes("spike-vercel") && c.startsWith("FAIL"))) {
            checks.push("PASS: spike-vercel.mjs has all 3 test types");
        }
    } catch (err) {
        checks.push(`FAIL: cannot read spike-vercel.mjs: ${err.message}`);
    }

    // Check 4: Anthropic spike has tool use loop + streaming
    try {
        const src = await readFile(
            new URL("../ai/embedded/spike-anthropic.mjs", import.meta.url), "utf-8"
        );
        if (!src.includes("tool_use") || !src.includes(".stream(")) {
            checks.push("FAIL: spike-anthropic.mjs missing tool_use loop or streaming");
        } else {
            checks.push("PASS: spike-anthropic.mjs has tool use loop + streaming");
        }
    } catch (err) {
        checks.push(`FAIL: cannot read spike-anthropic.mjs: ${err.message}`);
    }

    const failed = checks.filter(c => c.startsWith("FAIL"));
    return {
        status: failed.length > 0 ? "fail" : "pass",
        detail: checks.join("; "),
    };
});
