// ============================================================
// Thread Context Utility — single source of truth for threadId injection
// ============================================================
// Every outbound Telegram API call that targets a thread must include
// message_thread_id.  This utility eliminates the ad-hoc
// `if (threadId) params.message_thread_id = threadId` pattern.

/**
 * Inject message_thread_id into Telegram API params.
 * Accepts either a ref object ({ threadId }) or a raw threadId value.
 * Mutates and returns `params` for chaining convenience.
 *
 * @param {object} params — Telegram API params to augment
 * @param {object|string|number|null} threadIdOrRef — ref with .threadId, or raw threadId
 * @returns {object} params (same reference, mutated)
 */
export function withThread(params, threadIdOrRef) {
    const tid = threadIdOrRef && typeof threadIdOrRef === "object"
        ? threadIdOrRef.threadId
        : threadIdOrRef;
    if (tid) params.message_thread_id = tid;
    return params;
}
