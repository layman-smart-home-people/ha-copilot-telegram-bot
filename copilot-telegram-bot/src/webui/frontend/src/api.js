import { pushError } from "./components/ErrorCollector";

const BASE = "";

export async function api(path, opts = {}) {
  try {
    const res = await fetch(`${BASE}/api${path}`, {
      headers: { "Content-Type": "application/json", ...opts.headers },
      ...opts,
    });
    if (res.status === 204) return null;
    const data = await res.json();
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
