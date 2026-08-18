# 🔒 Security Policy

## 🎲 Supported Versions

We actively support and patch the following versions of the casino app:

| Version | Supported              |
| ------- | ---------------------- |
| 1.x.x   | ✅ Actively supported  |
| < 1.0   | ❌ No longer supported |

We recommend all users stay on the latest version to receive security updates and bug fixes.

---

## 🛡️ Security Controls in Place

- API rate limiting for all `/api/*` routes (IP + user scoped) with graceful `429` responses.
- Strict validation and sanitization helpers for JSON payloads in sensitive mutation endpoints.
- CSRF origin protection for cookie-authenticated API mutation requests.
- Baseline secure headers: CSP, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, and strict HSTS in production.
- Structured audit events for authentication failures, moderation/admin actions, and token/balance-changing operations.

---

## 🔁 Secret Rotation Runbook

Rotate these secrets on a regular cadence (recommended: every 90 days, and immediately after any suspected leak):

1. **Clerk keys**
   - Rotate `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`, and any JWT-related signing keys.
   - Update secret values in deployment provider and local environment.
   - Validate sign-in, webhook delivery, and protected API access.

2. **Database credentials**
   - Rotate `DATABASE_URL` credentials.
   - Ensure old credentials are revoked.
   - Run basic read/write health checks and migration connectivity checks.

3. **Post-rotation checks**
   - Confirm no secrets are present in git history, client bundles, or API responses.
   - Monitor audit logs and error rates for at least 24h after rotation.

---

## 🔐 Password Handling Guidance

- Never store plaintext passwords in your own DB.
- Prefer delegating password auth to Clerk entirely.
- If app-level password storage is required for legacy reasons, hash with a strong algorithm (`bcrypt` cost 12+ or `argon2id`) and never log password material.

---

## 📝 Audit Logging Guidance

Capture and retain structured logs (JSON) for:

- Authentication failures / unauthorized access attempts.
- Admin and moderation actions.
- Token and balance-changing operations.

Include timestamp, event type, user id (if present), endpoint, and request metadata. Redact secrets/tokens/passwords from all log payloads.
