# 🔒 Security Policy

## 🎲 Supported Versions
We actively support and patch the following versions of the casino app:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | ✅ Actively supported |
| < 1.0   | ❌ No longer supported |

We recommend all users stay on the latest version to receive security updates and bug fixes.

---

## 🛡️ Security Practices
Our platform handles **real-money and token transactions**, so we take security seriously.  
Here are the key measures we follow:

- **End-to-End HTTPS**: All requests use TLS 1.2+ for encrypted communication.  
- **JWT Authentication**: Sessions are signed and verified with Clerk to prevent spoofing.  
- **SQL Injection Protection**: All database queries use parameterized queries via an ORM.  
- **XSS / CSRF Protection**: Sanitization and CSRF tokens are applied across all sensitive routes.  
- **Rate Limiting**: API routes are rate-limited to prevent abuse and brute-force attacks.  
- **Regular Patching**: Dependencies are updated weekly to reduce known vulnerabilities.

---

## 📢 Reporting a Vulnerability
If you discover a security vulnerability, please help us by reporting it responsibly:

📧 **Email:** huyphananhha@gmail.com  )

When reporting, please include:
- A detailed description of the issue  
- Steps to reproduce  
- Any potential impact you foresee  

We will:
1. Acknowledge your report within **48 hours**  
2. Provide a status update within **5 business days**  
3. Work with you on a coordinated disclosure timeline  
4. Credit you (if you’d like) once the issue is resolved
