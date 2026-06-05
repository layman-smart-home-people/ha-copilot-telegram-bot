import { pushError } from "./components/ErrorCollector";

export async function api(path, opts = {}) {
  try {
    const res = await fetch(`./api${path}`, {
      headers: { "Content-Type": "application/json", ...opts.headers },
      ...opts,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const preview = text.length > 80 ? text.slice(0, 80) + "…" : text;
      throw new Error(`Invalid JSON from server: ${preview}`);
    }
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      pushError(`API ${path}: ${err.message}`);
      throw err;
    }
    return data;
  } catch (err) {
    if (!err.message?.startsWith("API ")) {
      pushError(`API ${path}: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Retry wrapper — retries on failure with exponential backoff.
 * Useful for initial loads that may hit the server during startup.
 */
export async function apiWithRetry(path, opts = {}, { retries = 2, delay = 1500 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api(path, opts);
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, delay * (attempt + 1)));
    }
  }
}
