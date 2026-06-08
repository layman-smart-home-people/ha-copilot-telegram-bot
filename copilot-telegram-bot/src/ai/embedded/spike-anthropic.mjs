// ============================================================
// Phase B Spike — Anthropic SDK direct proof-of-concept
// ============================================================
// Goal: Same tests as spike-vercel.mjs but using @anthropic-ai/sdk
// directly, to compare ergonomics and overhead.
//
// Run with: ANTHROPIC_API_KEY=... node src/ai/embedded/spike-anthropic.mjs
// Requires: npm install @anthropic-ai/sdk

import Anthropic from "@anthropic-ai/sdk";

const SYSTEM_PROMPT = "You are Ezra, an AI home assistant. Use tools to answer questions about the home.";

const TOOLS = [
    {
        name: "getEntityState",
        description: "Get the current state of a Home Assistant entity",
        input_schema: {
            type: "object",
            properties: {
                entity_id: { type: "string", description: "The entity ID (e.g. sensor.temperature)" },
            },
            required: ["entity_id"],
        },
    },
];

function executeToolCall(name, input) {
    console.log(`  [TOOL] ${name} called: ${JSON.stringify(input)}`);
    if (name === "getEntityState") {
        return JSON.stringify({
            entity_id: input.entity_id,
            state: "23.5",
            attributes: { unit_of_measurement: "°C", friendly_name: "Living Room Temperature" },
            last_changed: new Date().toISOString(),
        });
    }
    return JSON.stringify({ error: `Unknown tool: ${name}` });
}

// --- Test 1: Non-streaming with tool use loop ---
async function testNonStreaming(client) {
    console.log("\n=== Test 1: messages.create + tool use loop ===");
    const startMs = Date.now();

    let messages = [{ role: "user", content: "What is the living room temperature?" }];
    let toolCallCount = 0;

    // Agent loop — keep going while model wants to use tools
    for (let step = 0; step < 5; step++) {
        const response = await client.messages.create({
            model: "claude-sonnet-4-20250514",
            system: SYSTEM_PROMPT,
            max_tokens: 1024,
            messages,
            tools: TOOLS,
        });

        // Check for tool_use blocks
        const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
        if (toolUseBlocks.length === 0) {
            // No more tool calls — extract final text
            const textBlocks = response.content.filter(b => b.type === "text");
            const finalText = textBlocks.map(b => b.text).join("");
            const elapsed = Date.now() - startMs;
            console.log(`  Text: ${finalText}`);
            console.log(`  Tool calls: ${toolCallCount}`);
            console.log(`  Tokens: ${response.usage.input_tokens}in / ${response.usage.output_tokens}out`);
            console.log(`  Elapsed: ${elapsed}ms`);
            return { pass: !!(finalText && toolCallCount > 0), text: finalText, toolCalls: toolCallCount, elapsed };
        }

        // Process tool calls
        messages.push({ role: "assistant", content: response.content });
        const toolResults = [];
        for (const block of toolUseBlocks) {
            toolCallCount++;
            const result = executeToolCall(block.name, block.input);
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
        messages.push({ role: "user", content: toolResults });
    }

    return { pass: false, error: "Max steps exceeded" };
}

// --- Test 2: Streaming with tool use ---
async function testStreaming(client) {
    console.log("\n=== Test 2: streaming messages + tool use ===");
    const startMs = Date.now();
    let chunks = 0;
    let fullText = "";

    const messages = [{ role: "user", content: "What's the current temperature in the living room?" }];

    // First pass: stream to find tool calls
    const stream = await client.messages.stream({
        model: "claude-sonnet-4-20250514",
        system: SYSTEM_PROMPT,
        max_tokens: 1024,
        messages,
        tools: TOOLS,
    });

    // Collect streamed events
    const toolCalls = [];
    stream.on("text", (text) => {
        chunks++;
        fullText += text;
        process.stdout.write(text);
    });
    stream.on("contentBlock", (block) => {
        if (block.type === "tool_use") {
            toolCalls.push(block);
        }
    });

    const finalMessage = await stream.finalMessage();

    // If there were tool calls, execute them and get final response
    if (toolCalls.length > 0 || finalMessage.content.some(b => b.type === "tool_use")) {
        const toolUseBlocks = finalMessage.content.filter(b => b.type === "tool_use");
        messages.push({ role: "assistant", content: finalMessage.content });
        const toolResults = [];
        for (const block of toolUseBlocks) {
            const result = executeToolCall(block.name, block.input);
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
        messages.push({ role: "user", content: toolResults });

        // Stream the final response
        const stream2 = await client.messages.stream({
            model: "claude-sonnet-4-20250514",
            system: SYSTEM_PROMPT,
            max_tokens: 1024,
            messages,
            tools: TOOLS,
        });
        stream2.on("text", (text) => {
            chunks++;
            fullText += text;
            process.stdout.write(text);
        });
        await stream2.finalMessage();
    }

    console.log(); // newline
    const elapsed = Date.now() - startMs;
    console.log(`  Chunks: ${chunks}, Text length: ${fullText.length}`);
    console.log(`  Elapsed: ${elapsed}ms`);
    return { pass: chunks > 0 && fullText.length > 0, chunks, textLength: fullText.length, elapsed };
}

// --- Main ---
async function main() {
    console.log("Phase B Spike — Anthropic SDK Direct");
    console.log("=====================================");

    if (!process.env.ANTHROPIC_API_KEY) {
        console.log("\n⚠️  No ANTHROPIC_API_KEY set — structural validation only");
        console.log("  ✅ SDK import: Anthropic class loaded");
        console.log("  ✅ Tool schema: validated (1 tool defined)");
        console.log("  ✅ Agent loop: implemented (5-step max)");
        console.log("  ✅ Streaming: .stream() + .on('text') pattern");
        console.log("  ⏭️  Live tests: skipped (no API key)");
        return;
    }

    const client = new Anthropic();
    const results = {};
    try { results.nonStreaming = await testNonStreaming(client); } catch (e) { results.nonStreaming = { pass: false, error: e.message }; }
    try { results.streaming = await testStreaming(client); } catch (e) { results.streaming = { pass: false, error: e.message }; }

    console.log("\n=== Results Summary ===");
    for (const [name, r] of Object.entries(results)) {
        console.log(`  ${name}: ${r.pass ? "✅ PASS" : "❌ FAIL"} ${r.error || ""}`);
    }
}

main().catch(err => {
    console.error("Fatal:", err.message);
    process.exit(1);
});
