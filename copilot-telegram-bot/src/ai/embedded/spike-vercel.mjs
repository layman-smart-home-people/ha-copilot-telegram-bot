// ============================================================
// Phase B Spike — Vercel AI SDK v6 proof-of-concept
// ============================================================
// Goal: Validate that we can call Claude directly (no subprocess),
// use one tool, and get streaming response — all in-process.
//
// This file is NOT wired into the bot. It's a standalone spike
// that can be run with: node src/ai/embedded/spike-vercel.mjs
//
// Requires: ANTHROPIC_API_KEY env var + npm install ai @ai-sdk/anthropic

import { generateText, streamText, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

// --- Minimal tool: simulates an HA state query ---
const getEntityState = tool({
    description: "Get the current state of a Home Assistant entity",
    parameters: z.object({
        entity_id: z.string().describe("The entity ID (e.g. sensor.temperature)"),
    }),
    execute: async ({ entity_id }) => {
        // In production, this would call the HA REST API
        console.log(`  [TOOL] getEntityState called: ${entity_id}`);
        return {
            entity_id,
            state: "23.5",
            attributes: { unit_of_measurement: "°C", friendly_name: "Living Room Temperature" },
            last_changed: new Date().toISOString(),
        };
    },
});

// --- Test 1: Non-streaming with tool call ---
async function testGenerateText() {
    console.log("\n=== Test 1: generateText + tool call ===");
    const startMs = Date.now();

    const { text, toolCalls, toolResults, usage } = await generateText({
        model: anthropic("claude-sonnet-4-20250514"),
        system: "You are Ezra, an AI home assistant. Use the getEntityState tool to answer questions about the home.",
        prompt: "What is the living room temperature?",
        tools: { getEntityState },
        maxSteps: 3,
    });

    const elapsed = Date.now() - startMs;
    console.log(`  Text: ${text}`);
    console.log(`  Tool calls: ${toolCalls?.length || 0}`);
    console.log(`  Tool results: ${toolResults?.length || 0}`);
    console.log(`  Tokens: ${usage?.promptTokens}in / ${usage?.completionTokens}out`);
    console.log(`  Elapsed: ${elapsed}ms`);

    return {
        pass: !!(text && toolCalls?.length > 0),
        text,
        toolCalls: toolCalls?.length || 0,
        elapsed,
        usage,
    };
}

// --- Test 2: Streaming with tool call ---
async function testStreamText() {
    console.log("\n=== Test 2: streamText + tool call ===");
    const startMs = Date.now();
    let chunks = 0;
    let fullText = "";

    const result = streamText({
        model: anthropic("claude-sonnet-4-20250514"),
        system: "You are Ezra, an AI home assistant. Use the getEntityState tool when asked about entity states.",
        prompt: "What's the current temperature in the living room?",
        tools: { getEntityState },
        maxSteps: 3,
    });

    for await (const chunk of result.textStream) {
        chunks++;
        fullText += chunk;
        process.stdout.write(chunk);
    }
    console.log(); // newline after stream

    const elapsed = Date.now() - startMs;
    const usage = await result.usage;
    console.log(`  Chunks received: ${chunks}`);
    console.log(`  Full text length: ${fullText.length}`);
    console.log(`  Tokens: ${usage?.promptTokens}in / ${usage?.completionTokens}out`);
    console.log(`  Elapsed: ${elapsed}ms`);

    return {
        pass: chunks > 0 && fullText.length > 0,
        chunks,
        textLength: fullText.length,
        elapsed,
        usage,
    };
}

// --- Test 3: MCP client connection (structural validation only) ---
async function testMcpClient() {
    console.log("\n=== Test 3: MCP client (structural) ===");

    // This validates the import path exists — actual connection requires a running MCP server
    try {
        const { experimental_createMCPClient: createMCPClient } = await import("ai");
        console.log(`  MCP client factory: ${typeof createMCPClient}`);

        if (typeof createMCPClient === "function") {
            console.log("  ✅ MCP client available in AI SDK");
            return { pass: true, detail: "MCP client factory is a function" };
        } else {
            console.log("  ⚠️ MCP client import exists but is not a function");
            return { pass: false, detail: `MCP client is ${typeof createMCPClient}` };
        }
    } catch (err) {
        console.log(`  ❌ MCP client not available: ${err.message}`);
        return { pass: false, detail: err.message };
    }
}

// --- Main ---
async function main() {
    console.log("Phase B Spike — Vercel AI SDK v6");
    console.log("================================");

    if (!process.env.ANTHROPIC_API_KEY) {
        console.log("\n⚠️  No ANTHROPIC_API_KEY set — running structural tests only");
        const mcp = await testMcpClient();
        console.log("\n=== Results ===");
        console.log(`  MCP client: ${mcp.pass ? "✅" : "❌"} ${mcp.detail}`);
        console.log("  generateText: ⏭️ skipped (no API key)");
        console.log("  streamText: ⏭️ skipped (no API key)");
        return;
    }

    const results = {};
    try { results.generate = await testGenerateText(); } catch (e) { results.generate = { pass: false, error: e.message }; }
    try { results.stream = await testStreamText(); } catch (e) { results.stream = { pass: false, error: e.message }; }
    try { results.mcp = await testMcpClient(); } catch (e) { results.mcp = { pass: false, error: e.message }; }

    console.log("\n=== Results Summary ===");
    for (const [name, r] of Object.entries(results)) {
        console.log(`  ${name}: ${r.pass ? "✅ PASS" : "❌ FAIL"} ${r.error || ""}`);
    }
}

main().catch(err => {
    console.error("Fatal:", err.message);
    process.exit(1);
});
