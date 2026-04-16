# Security Guide

## 🚨 CRITICAL: Credential Exposure Incident

**Date:** 2025-11-27  
**Status:** REMEDIATED

### What Happened
LinkedIn authentication credentials (`auth.json` files) were accidentally committed to version control, exposing:
- `li_at` tokens (primary authentication)
- `JSESSIONID` (session identifiers)
- `li_rm` (remember me tokens)
- Multiple tracking cookies

### Immediate Actions Taken
1. ✅ Removed `auth.json` files from git tracking
2. ✅ Purged files from entire git history using `git filter-branch`
3. ✅ Added credential patterns to `.gitignore`
4. ✅ Created template files (`auth.json.example`)
5. ✅ Set up pre-commit hooks for secret scanning

---

## 🔐 Required Actions for You

### 1. Rotate All LinkedIn Credentials **IMMEDIATELY**

Since these credentials were exposed in version control, you **MUST** invalidate them:

#### Steps to Rotate LinkedIn Session:
1. Log out of LinkedIn on all devices
2. Go to: https://www.linkedin.com/psettings/sessions
3. Click "Sign out of all sessions"
4. Change your LinkedIn password (recommended)
5. Enable 2FA if not already enabled: https://www.linkedin.com/psettings/two-step-verification
6. Generate new session cookies by logging in again
7. Update your local `auth.json` files with the new credentials

### 2. Monitor for Unauthorized Access

- Check LinkedIn account activity: https://www.linkedin.com/psettings/sessions
- Review recent login locations
- Check for suspicious messages or connection requests
- Enable email notifications for security events

**GOOD NEWS:** No remote repository was found, so credentials were NOT pushed to GitHub/GitLab/etc.

---

## 🛡️ Secure Credential Management

### Setting Up Credentials

1. **Copy the template:**
   ```bash
   cp workers/scraper/auth.json.example workers/scraper/auth.json
   cp workers/sender/auth.json.example workers/sender/auth.json
   ```

2. **Add your credentials** to the new `auth.json` files

3. **Verify they're ignored:**
   ```bash
   git status
   # auth.json files should NOT appear
   ```

### Best Practices

- ✅ **DO** use `auth.json` for local development (already in `.gitignore`)
- ✅ **DO** rotate credentials regularly (every 90 days minimum)
- ❌ **DON'T** commit any files containing secrets
- ❌ **DON'T** share credentials via chat/email/Slack

---

## 🔍 Pre-Commit Hooks

Pre-commit hooks have been configured to scan for secrets before each commit.

### Install Pre-Commit
```bash
pip install pre-commit
pre-commit install
```

### Manual Scan
```bash
# Scan all files
pre-commit run --all-files
```

---

## Additional Resources

- [LinkedIn Account Security](https://www.linkedin.com/help/linkedin/answer/a1338610)
- [OWASP Secrets Management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
- [Pre-Commit Framework](https://pre-commit.com/)

## Hostinger VPS deployment security

For the single-VPS rollout, treat the VPS as a private runtime with one public edge:

- Keep only the reverse proxy ports open to the internet.
- Keep only `80` and `443` open publicly; keep the web app on `3000` behind the proxy.
- Keep `workers/scraper/auth.json`, `workers/sender/auth.json`, and logs on persistent disk.
- Do not expose the worker processes directly on public ports.
- Keep the `web`, `agent`, `sender`, `sender_message_only`, and `sender_followup` service names stable across the compose file and runbook so production and troubleshooting stay aligned.

Rollout phases:
1. Public-first: the web UI is public, but privileged worker entrypoints stay internal.
2. Auth gate later: once Supabase login lands, require authenticated sessions before reaching protected UI actions or worker-triggering routes.
