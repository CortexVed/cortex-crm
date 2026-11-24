/** Métricas de proceso en memoria (por instancia), expuestas a administradores de plataforma. */
const started = Date.now();
const counters = { requests: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0 };
const latencies: number[] = [];
const routes = new Map<string, { n: number; totalMs: number; errors: number }>();

export function recordRequest(route: string, status: number, ms: number) {
  counters.requests++;
  if (status >= 500) counters.s5xx++;
  else if (status >= 400) counters.s4xx++;
  else if (status >= 300) counters.s3xx++;
  else counters.s2xx++;
  latencies.push(ms);
  if (latencies.length > 2000) latencies.shift();
  const r = routes.get(route) ?? { n: 0, totalMs: 0, errors: 0 };
  r.n++;
  r.totalMs += ms;
  if (status >= 500) r.errors++;
  routes.set(route, r);
}

export function metricsSnapshot() {
  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = (p: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]) : 0);
  const mem = process.memoryUsage();
  return {
    uptimeSec: Math.round((Date.now() - started) / 1000),
    ...counters,
    latencyMs: { p50: pct(50), p95: pct(95), p99: pct(99) },
    memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
    topRoutes: [...routes.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 20)
      .map(([route, r]) => ({ route, requests: r.n, avgMs: Math.round(r.totalMs / r.n), errors: r.errors })),
  };
}
