export function apiBase() {
  return process.env.BOUNCER_API_BASE || 'https://api.typesafe.ai';
}

export async function systemOne({ state, questions, model, timeoutMs, apiKey }) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBase()}/v1/systemone`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ state, model, questions }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}`, latencyMs: Date.now() - started };
    const body = await res.json();
    return {
      ok: true,
      answers: body.answers || {},
      model: body.model,
      inputTokens: body.usage?.input_tokens || 0,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : 'network', latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export async function askBatched({ state, questions, batchSize, ...opts }) {
  const keys = Object.keys(questions);
  const chunks = [];
  for (let i = 0; i < keys.length; i += batchSize) {
    chunks.push(Object.fromEntries(keys.slice(i, i + batchSize).map((k) => [k, questions[k]])));
  }
  const results = await Promise.all(chunks.map((chunk) => systemOne({ state, questions: chunk, ...opts })));
  const merged = { answers: {}, inputTokens: 0, failed: 0, total: chunks.length, model: undefined, latencyMs: 0 };
  for (const r of results) {
    merged.latencyMs = Math.max(merged.latencyMs, r.latencyMs);
    if (!r.ok) {
      merged.failed++;
      continue;
    }
    Object.assign(merged.answers, r.answers);
    merged.inputTokens += r.inputTokens;
    merged.model = r.model;
  }
  return merged;
}
