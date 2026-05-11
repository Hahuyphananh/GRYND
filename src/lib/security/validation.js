import { NextResponse } from "next/server";

const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function sanitizeString(value, { trim = true } = {}) {
  if (typeof value !== "string") return "";
  const normalized = value.normalize("NFKC").replace(CONTROL_CHARS_REGEX, "");
  return trim ? normalized.trim() : normalized;
}

export async function parseAndValidateJson(request, schema) {
  let payload;

  try {
    payload = await request.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: "Invalid JSON payload" },
        { status: 400 },
      ),
    };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: "Payload must be a JSON object" },
        { status: 400 },
      ),
    };
  }

  const allowedFields = Object.keys(schema);
  const incomingFields = Object.keys(payload);
  const unexpected = incomingFields.filter(
    (field) => !allowedFields.includes(field),
  );

  if (unexpected.length > 0) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          error: `Unexpected field(s): ${unexpected.join(", ")}`,
        },
        { status: 400 },
      ),
    };
  }

  const output = {};

  for (const [field, rules] of Object.entries(schema)) {
    const raw = payload[field];
    const isMissing = raw === undefined || raw === null;

    if (isMissing) {
      if (rules.required) {
        return {
          ok: false,
          response: NextResponse.json(
            { success: false, error: `${field} is required` },
            { status: 400 },
          ),
        };
      }
      output[field] = rules.default ?? null;
      continue;
    }

    if (rules.type === "string") {
      const value = sanitizeString(raw);
      if (rules.minLength && value.length < rules.minLength) {
        return {
          ok: false,
          response: NextResponse.json(
            {
              success: false,
              error: `${field} must be at least ${rules.minLength} characters`,
            },
            { status: 400 },
          ),
        };
      }
      if (rules.maxLength && value.length > rules.maxLength) {
        return {
          ok: false,
          response: NextResponse.json(
            {
              success: false,
              error: `${field} must be at most ${rules.maxLength} characters`,
            },
            { status: 400 },
          ),
        };
      }
      if (rules.pattern && !rules.pattern.test(value)) {
        return {
          ok: false,
          response: NextResponse.json(
            { success: false, error: `${field} has invalid format` },
            { status: 400 },
          ),
        };
      }
      output[field] = value;
      continue;
    }

    if (rules.type === "number") {
      const value = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(value)) {
        return {
          ok: false,
          response: NextResponse.json(
            { success: false, error: `${field} must be a valid number` },
            { status: 400 },
          ),
        };
      }
      if (rules.integer && !Number.isInteger(value)) {
        return {
          ok: false,
          response: NextResponse.json(
            { success: false, error: `${field} must be an integer` },
            { status: 400 },
          ),
        };
      }
      if (rules.min !== undefined && value < rules.min) {
        return {
          ok: false,
          response: NextResponse.json(
            { success: false, error: `${field} must be >= ${rules.min}` },
            { status: 400 },
          ),
        };
      }
      if (rules.max !== undefined && value > rules.max) {
        return {
          ok: false,
          response: NextResponse.json(
            { success: false, error: `${field} must be <= ${rules.max}` },
            { status: 400 },
          ),
        };
      }
      output[field] = value;
      continue;
    }

    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: `Unsupported schema type for ${field}` },
        { status: 500 },
      ),
    };
  }

  return { ok: true, data: output };
}
