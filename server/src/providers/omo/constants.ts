// Constants for the omo + herdr source.

/** Timeout for a single `herdr` CLI invocation (snapshot / focus). */
export const HERDR_EXEC_TIMEOUT_MS = 3000;
/** Interval between `herdr api snapshot` polls. */
export const HERDR_POLL_INTERVAL_MS = 1000;
/** Max stdout size accepted from `herdr api snapshot`. */
export const HERDR_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

// omoSessionReader
/** Max chars of a tool summary shown in the office bubble. */
export const OMO_SUMMARY_MAX_CHARS = 120;
/** Bytes read from the end of a transcript when looking for the latest session_info name. */
export const OMO_TAIL_READ_BYTES = 256 * 1024;
/** Poll append-only omo transcripts independently of the herdr CLI. */
export const OMO_SESSION_POLL_INTERVAL_MS = 500;
export const OMO_READING_TOOLS = ['read', 'grep', 'glob', 'web_search', 'webfetch'] as const;
export const OMO_SUBAGENT_TOOL_NAMES = ['task'] as const;
