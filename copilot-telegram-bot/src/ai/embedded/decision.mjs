// ============================================================
// Phase B — SDK Comparison & Decision Matrix
// ============================================================
// This is the decision gate document for the embedded SDK choice.
// Run with: node src/ai/embedded/decision.mjs

const COMPARISON = {
    vercelAiSdk: {
        name: "Vercel AI SDK v6",
        package: "ai + @ai-sdk/anthropic + @ai-sdk/openai",
        version: "6.x (May 2026)",
        pros: [
            "Multi-provider out of the box (Anthropic, OpenAI, Google, Mistral, xAI, Ollama)",
            "Unified API: generateText/streamText works across all providers",
            "Built-in agent loop (ToolLoopAgent) with maxSteps",
            "Native MCP client (experimental_createMCPClient) — can connect to our existing MCP servers",
            "Zod schema validation for tool inputs — type-safe",
            "Token usage tracking built-in",
            "Active ecosystem, well-maintained, Vercel backing",
            "Provider switching is a one-line change",
        ],
        cons: [
            "Abstraction overhead — another layer between us and the API",
            "MCP client is still 'experimental_' prefix (may change)",
            "Zod dependency adds bundle size",
            "Less control over raw request/response format",
            "Breaking changes between major versions (v5→v6 migration was significant)",
        ],
        fitForEzra: {
            multiModel: "⭐ Excellent — MM-1 requirement is trivially satisfied",
            toolCalling: "⭐ Excellent — Zod schemas + automatic tool loop",
            streaming: "⭐ Excellent — streamText is battle-tested",
            mcpIntegration: "✅ Good — can consume our existing si-mcp, ha-mcp, tg-ux servers",
            workerPool: "✅ Good — each generateText call is independent, easy to parallelize",
            tokenTracking: "⭐ Excellent — usage object on every response",
        },
    },
    anthropicDirect: {
        name: "Anthropic SDK Direct",
        package: "@anthropic-ai/sdk",
        version: "0.x (2026)",
        pros: [
            "Minimal abstraction — direct API access",
            "Full control over message format, tool_use blocks, system prompts",
            "No extra dependencies beyond the SDK itself",
            "Streaming via .stream() + event handlers",
            "Official SDK, guaranteed API compatibility",
            "Anthropic-specific features available immediately (no waiting for wrapper support)",
        ],
        cons: [
            "Single provider — need separate SDK for OpenAI, Google, etc.",
            "Manual agent loop — must implement tool_use → tool_result cycling ourselves",
            "No built-in MCP client — would need to build or use separate MCP library",
            "No Zod integration — must validate tool inputs manually",
            "Multi-model (MM-1) requires writing a resolver with per-provider adapters",
        ],
        fitForEzra: {
            multiModel: "❌ Poor — would need adapter per provider (significant work)",
            toolCalling: "✅ Good — tool_use is well-designed but manual loop needed",
            streaming: "✅ Good — event-based streaming works",
            mcpIntegration: "⚠️ Fair — no built-in MCP client, must consume tools manually",
            workerPool: "✅ Good — each messages.create is independent",
            tokenTracking: "✅ Good — usage in response, but manual aggregation",
        },
    },
};

const DECISION = {
    recommendation: "Vercel AI SDK v6",
    confidence: "HIGH",
    rationale: [
        "Multi-model (MM-1) is a core v6 requirement — Vercel satisfies it trivially, Anthropic direct requires building a full adapter layer",
        "MCP client support means we can reuse our existing MCP servers (si-mcp, ha-mcp, tg-ux, pkm-tools) without re-implementing tools as Zod functions",
        "ToolLoopAgent maps directly to our agent loop concept — less code to write and maintain",
        "Provider switching enables the cost routing described in the design (Haiku for triage, Opus for complex tasks)",
        "The abstraction cost is worth it — we get battle-tested streaming, retries, and error handling for free",
    ],
    risks: [
        "experimental_ MCP client API may change — mitigate with thin wrapper",
        "Vercel SDK major versions break things — pin version, test on upgrade",
        "Anthropic-specific features (prompt caching, extended thinking) may lag behind direct SDK",
        "CRITICAL: Token cost shift from Copilot subscription to per-token billing (~$50-75/mo est.)",
        "HIGH: MCP server lifecycle — bot must spawn/manage MCP servers (currently Copilot CLI does this)",
        "HIGH: In-process blast radius — agent crash = bot crash (no subprocess isolation)",
        "HIGH: Conversation history management — must build from scratch (ACP managed server-side)",
    ],
    phaseC_implications: [
        "C1 (Embedded runtime): Use Vercel AI SDK's streamText as the core agent loop",
        "C1 BLOCKER: MCP server lifecycle manager (~200-300 LOC) — spawn, healthcheck, restart MCP servers",
        "C1 BLOCKER: Conversation history management — message arrays, token counting, summarization",
        "C1: Error recovery — retry, backoff, key rotation, model failover",
        "C1: AbortController integration for Steer mode (cancel running streamText)",
        "C2 (Model resolver): Leverage SDK's multi-provider — configure providers, add cost routing",
        "C2: Token budgets — daily/weekly caps per tier, per task type",
        "C2: Prompt caching strategy — verify Vercel SDK support for Anthropic cache_control",
        "C3 (Worker pool): Each worker gets its own streamText call — test 5 concurrent calls",
        "C3: Consider worker_threads for true isolation (shared-nothing)",
        "C4 (Listeners): No SDK impact — listeners are pure code (E-core)",
        "C5 (Queue modes): Implement at orchestrator level — SDK handles individual turns",
    ],
    migrationStrategy: [
        "Phase 1: Replace overflow/background → embedded SDK (lower blast radius)",
        "Phase 2: Run primary ACP + embedded background for 1-2 weeks (side-by-side)",
        "Phase 3: Replace primary → embedded SDK",
        "Phase 4: Keep ACPManager as cold fallback for GitHub/Copilot-specific tasks",
    ],
    apiKeyRequirement: "ANTHROPIC_API_KEY must be added to add-on config.yaml options schema",
    nextSteps: [
        "Add ANTHROPIC_API_KEY to add-on options (config.yaml + config.mjs)",
        "Sam provides API key — run spike-vercel.mjs to validate live",
        "If live test passes, proceed to C1 with Vercel AI SDK",
        "If issues found, fall back to Anthropic SDK direct (spike-anthropic.mjs ready)",
    ],
};

// --- Pretty print ---
console.log("╔══════════════════════════════════════════╗");
console.log("║   Phase B — Embedded SDK Decision Gate   ║");
console.log("╚══════════════════════════════════════════╝\n");

for (const [key, sdk] of Object.entries(COMPARISON)) {
    console.log(`\n## ${sdk.name} (${sdk.package})`);
    console.log(`   Version: ${sdk.version}\n`);
    console.log("   Pros:");
    sdk.pros.forEach(p => console.log(`   ✅ ${p}`));
    console.log("\n   Cons:");
    sdk.cons.forEach(c => console.log(`   ❌ ${c}`));
    console.log("\n   Fit for Ezra v6:");
    for (const [k, v] of Object.entries(sdk.fitForEzra)) {
        console.log(`   ${v} — ${k}`);
    }
}

console.log("\n" + "=".repeat(50));
console.log(`\n## RECOMMENDATION: ${DECISION.recommendation}`);
console.log(`   Confidence: ${DECISION.confidence}\n`);
console.log("   Rationale:");
DECISION.rationale.forEach(r => console.log(`   • ${r}`));
console.log("\n   Risks:");
DECISION.risks.forEach(r => console.log(`   ⚠️ ${r}`));
console.log("\n   Phase C Implications:");
DECISION.phaseC_implications.forEach(i => console.log(`   → ${i}`));
console.log("\n   Migration Strategy:");
DECISION.migrationStrategy.forEach((s, i) => console.log(`   ${i + 1}. ${s}`));
console.log("\n   Next Steps:");
DECISION.nextSteps.forEach((s, i) => console.log(`   ${i + 1}. ${s}`));
