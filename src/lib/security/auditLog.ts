type AuditPayload = Record<string, unknown>;

const MASKED_KEYS = ["password", "token", "secret", "apiKey", "authorization"];

function maskValue(key: string, value: unknown) {
  const lowerKey = key.toLowerCase();
  if (MASKED_KEYS.some((keyword) => lowerKey.includes(keyword.toLowerCase()))) {
    return "[REDACTED]";
  }
  return value;
}

export function auditLog(event: string, payload: AuditPayload = {}) {
  const sanitizedPayload: AuditPayload = {};

  for (const [key, value] of Object.entries(payload)) {
    sanitizedPayload[key] = maskValue(key, value);
  }

  console.info(
    JSON.stringify({
      type: "audit",
      event,
      timestamp: new Date().toISOString(),
      ...sanitizedPayload,
    }),
  );
}
