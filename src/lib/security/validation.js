import { NextResponse } from "next/server";

const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function sanitizeString(value, { trim = true } = {}) {
  if (typeof value !== "string") return "";
  const normalized = value.normalize("NFKC").replace(CONTROL_CHARS_REGEX, "");
  return trim ? normalized.trim() : normalized;
}

function errorResponse(message, status = 400) {
  return {
    ok: false,
    response: NextResponse.json({ success: false, error: message }, { status }),
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate a decoded JSON payload against an ALLOWLIST schema.
 *
 * Every key the caller may send must be declared in `schema`; anything else
 * is rejected with a 400 (`Unexpected field(s): ...`) instead of being
 * silently dropped or accepted. This is the single choke point for request
 * bodies that write to the database.
 *
 * Per-field rules:
 *   type:      "string" | "number" | "boolean" | "array"
 *   required:  field must be present (undefined/null)
 *   nullable:  an explicit JSON null is accepted and yields null
 *   default:   value used when the field is absent (absent fields yield null
 *              when no default is given, unless omitIfMissing is set)
 *   omitIfMissing: absent fields are NOT added to the output object
 *   minLength / maxLength / pattern / enum: string rules
 *   integer / min / max: number rules
 *   minItems / maxItems / items: array rules
 */
export function validateObject(payload, schema) {
  if (!isPlainObject(payload)) {
    return errorResponse("Payload must be a JSON object");
  }

  const allowedFields = Object.keys(schema);
  const incomingFields = Object.keys(payload);
  const unexpected = incomingFields.filter(
    (field) => !allowedFields.includes(field),
  );

  if (unexpected.length > 0) {
    return errorResponse(`Unexpected field(s): ${unexpected.join(", ")}`);
  }

  const output = {};

  for (const [field, rules] of Object.entries(schema)) {
    if (!rules || typeof rules !== "object" || typeof rules.type !== "string") {
      return {
        ok: false,
        response: NextResponse.json(
          { success: false, error: `Invalid schema rules for ${field}` },
          { status: 500 },
        ),
      };
    }

    const raw = payload[field];

    // Absent (undefined) vs explicitly null are distinct: a required field
    // must be present; an explicit null is only accepted when nullable.
    if (raw === undefined) {
      if (rules.required) {
        return errorResponse(`${field} is required`);
      }
      if (Object.prototype.hasOwnProperty.call(rules, "default")) {
        output[field] = rules.default;
      } else if (!rules.omitIfMissing) {
        output[field] = null;
      }
      continue;
    }

    if (raw === null) {
      if (rules.nullable) {
        output[field] = null;
        continue;
      }
      if (rules.required) {
        return errorResponse(`${field} is required`);
      }
      output[field] = rules.default ?? null;
      continue;
    }

    if (rules.type === "string") {
      if (typeof raw !== "string") {
        return errorResponse(`${field} must be a string`);
      }
      const value = sanitizeString(raw);
      if (rules.minLength && value.length < rules.minLength) {
        return errorResponse(`${field} must be at least ${rules.minLength} characters`);
      }
      if (rules.maxLength && value.length > rules.maxLength) {
        return errorResponse(`${field} must be at most ${rules.maxLength} characters`);
      }
      if (rules.pattern && !rules.pattern.test(value)) {
        return errorResponse(`${field} has invalid format`);
      }
      if (rules.enum && !rules.enum.includes(value)) {
        return errorResponse(`${field} is not an allowed value`);
      }
      output[field] = value;
      continue;
    }

    if (rules.type === "number") {
      const value = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(value)) {
        return errorResponse(`${field} must be a valid number`);
      }
      if (rules.integer && !Number.isInteger(value)) {
        return errorResponse(`${field} must be an integer`);
      }
      if (rules.min !== undefined && value < rules.min) {
        return errorResponse(`${field} must be >= ${rules.min}`);
      }
      if (rules.max !== undefined && value > rules.max) {
        return errorResponse(`${field} must be <= ${rules.max}`);
      }
      output[field] = value;
      continue;
    }

    if (rules.type === "boolean") {
      if (typeof raw !== "boolean") {
        return errorResponse(`${field} must be a boolean`);
      }
      output[field] = raw;
      continue;
    }

    if (rules.type === "array") {
      if (!Array.isArray(raw)) {
        return errorResponse(`${field} must be an array`);
      }
      const items = rules.items;
      const outItems = [];
      for (const item of raw) {
        if (items && typeof items === "object") {
          if (items.type === "string") {
            if (typeof item !== "string") {
              return errorResponse(`${field} must contain only strings`);
            }
            const clean = sanitizeString(item);
            if (items.maxLength && clean.length > items.maxLength) {
              return errorResponse(
                `${field} entries must be at most ${items.maxLength} characters`,
              );
            }
            if (items.enum && !items.enum.includes(clean)) {
              return errorResponse(`${field} contains an invalid value`);
            }
            outItems.push(clean);
            continue;
          }
          if (items.type === "number") {
            const n = typeof item === "number" ? item : Number(item);
            if (!Number.isFinite(n)) {
              return errorResponse(`${field} must contain only numbers`);
            }
            outItems.push(n);
            continue;
          }
        }
        outItems.push(item);
      }
      if (rules.minItems !== undefined && outItems.length < rules.minItems) {
        return errorResponse(`${field} must have at least ${rules.minItems} item(s)`);
      }
      if (rules.maxItems !== undefined && outItems.length > rules.maxItems) {
        return errorResponse(`${field} must have at most ${rules.maxItems} item(s)`);
      }
      output[field] = outItems;
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

export async function parseAndValidateJson(request, schema) {
  let payload;

  try {
    payload = await request.json();
  } catch {
    return errorResponse("Invalid JSON payload");
  }

  return validateObject(payload, schema);
}
