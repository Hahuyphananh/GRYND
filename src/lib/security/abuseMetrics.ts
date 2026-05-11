const memoryMetrics = new Map<string, { count: number; lastAt: number }>();

function metricKey(event: string, path = "unknown") {
  return `${event}::${path}`;
}

export function incrementAbuseMetric(event: string, path?: string) {
  const key = metricKey(event, path || "unknown");
  const entry = memoryMetrics.get(key) || { count: 0, lastAt: 0 };
  entry.count += 1;
  entry.lastAt = Date.now();
  memoryMetrics.set(key, entry);
}

export function listAbuseMetrics() {
  return Array.from(memoryMetrics.entries()).map(([key, value]) => {
    const [event, path] = key.split("::");
    return {
      event,
      path,
      count: value.count,
      lastAt: new Date(value.lastAt).toISOString(),
    };
  });
}
