# Wren External Security Scanner

A lightweight, self-contained bash script that performs an external security review of a [Wren](https://getwren.co.uk) deployment — or any web application — from any machine you have access to.

**No account required. No data is sent anywhere except the target you specify.**

---

## Quick start

```bash
# Download
curl -O https://raw.githubusercontent.com/getwren/external-scan/main/scan.sh

# Scan your Wren install (quick, ~30 seconds)
bash scan.sh your-school.getwren.co.uk

# Full scan (~5 minutes, all ports, deep TLS, subdomain enumeration)
bash scan.sh your-school.getwren.co.uk --full

# JSON output (for piping to dashboards)
bash scan.sh your-school.getwren.co.uk --json
```

---

## What this scans

| Category | Quick | Full | What it checks |
|----------|-------|------|----------------|
| DNS | ✓ | ✓ | A/AAAA records, Cloudflare IP verification, wildcard DNS, SPF, DMARC |
| Port scan | Top 1000 | All 65535 | Open ports, dangerous service classification (DB ports, Telnet, FTP) |
| TLS / Certificate | ✓ | ✓ | Cert expiry, CN/SAN, deprecated protocols (SSLv2/3, TLS 1.0/1.1), TLS 1.3 |
| TLS cipher depth | — | ✓ | Weak cipher testing (RC4, NULL, EXPORT suites) |
| HTTP security headers | ✓ | ✓ | HSTS, X-Frame-Options, X-Content-Type-Options, CSP, Referrer-Policy, Permissions-Policy |
| Server fingerprinting | ✓ | ✓ | Suppressed Server/X-Powered-By headers |
| HTTPS redirect | ✓ | ✓ | HTTP → HTTPS enforcement |
| Sensitive paths | ✓ | ✓ | /.git/, /.env, /backup, /phpmyadmin, /wp-admin, /composer.json, /Dockerfile, etc. |
| Admin paths | ✓ | ✓ | /admin, /dashboard, /panel — checks for auth protection |
| Directory listing | ✓ | ✓ | "Index of /" detection on common paths |
| Subdomain enumeration | ✓ | ✓ | Certificate transparency logs (crt.sh), with Cloudflare verification per subdomain |
| Open redirects | ✓ | ✓ | 14 common URL parameters (url=, next=, redirect=, etc.) |

---

## What this does NOT scan

This tool performs **external surface-area testing only**. It does not and cannot check:

- Authentication bypass or credential testing
- Business logic flaws (e.g. one user seeing another's data)
- SQL injection or XSS in application inputs
- API authorisation (whether logged-in users can access resources they shouldn't)
- Data exfiltration or insider threats
- Network-internal vulnerabilities (database misconfigs, container escape)
- Social engineering or phishing susceptibility
- Anything requiring a valid user session

**For production deployments that process child data, commission a professional penetration test.** This script is a first-pass check, not a substitute.

---

## How to interpret findings

### ✓ Pass
The check completed and no issue was found. Green.

### ⚠ Warn
Something is present but not critically risky — or a best-practice recommendation isn't met. Investigate when convenient.

Common warnings and what to do:
- **A record not in Cloudflare IP range** — your origin server IP may be discoverable. Not a crisis if Cloudflare is in use, but worth checking.
- **No SPF/DMARC record** — makes email spoofing easier. Add DNS TXT records.
- **SSH port (22) open** — expected if you manage the server remotely. Consider restricting to known IPs via firewall.
- **CSP present but contains unsafe-inline** — reduces XSS protection. Refine CSP to remove this.
- **HSTS max-age < 31536000** — increase to 1 year or more.
- **Subdomain not behind Cloudflare** — if you have subdomains on different IPs, those may expose your origin.
- **Server header reveals version** — hide it in nginx/Apache config.

### ✗ Fail
A concrete security issue was found. Address these.

Common failures and how to fix:
- **Certificate expired / expiring in < 14 days** — renew immediately (Let's Encrypt: `certbot renew`)
- **Deprecated TLS protocol accepted (TLS 1.0/1.1)** — disable in nginx: `ssl_protocols TLSv1.2 TLSv1.3;`
- **Port 3306/5432/6379 open (database exposed)** — close firewall port immediately, databases should never be internet-facing
- **/.env accessible (HTTP 200 with secrets)** — critical. Block in nginx: `location ~ /\.env { deny all; }`
- **/.git/ accessible** — exposes source code. Block: `location ~ /\.git { deny all; }`
- **Open redirect found** — validate and sanitise redirect targets server-side

---

## Required tools

| Tool | Purpose | Required |
|------|---------|----------|
| `curl` | HTTP headers, path probing, subdomain API | Yes |
| `openssl` | TLS certificate checks, cipher testing | Yes |
| `dig` | DNS lookups, SPF/DMARC | Recommended |
| `nmap` | Port scanning | Recommended (fallback available without it) |
| `host` | Fallback DNS lookup | Optional |

The script runs without `nmap` (limited port probe) and without `dig` (limited DNS), but results will be less complete.

### macOS (Homebrew)

```bash
brew install nmap
# curl and openssl are pre-installed; dig is pre-installed via bind-tools
```

### Linux (Debian/Ubuntu)

```bash
sudo apt install nmap dnsutils curl openssl
```

### Linux (RHEL/Fedora)

```bash
sudo dnf install nmap bind-utils curl openssl
```

### Termux on Android

```bash
pkg install nmap dnsutils curl openssl-tool
```

---

## Privacy & data handling

- This script **never phones home**. No telemetry, no analytics, no callbacks to Wren servers.
- Scan data is never sent anywhere except the target you specify.
- The only external service queried is [crt.sh](https://crt.sh) (certificate transparency log search), which receives only your target domain name.
- No scan results are stored or transmitted beyond your terminal.

---

## Who built this

I'm Toby Jones — I built [Wren](https://getwren.co.uk) as the management platform for my own early-years nursery, and I'm making it available to other settings.

I am **not** a security company. I built this scanner for my own deployments and as a transparency tool so Wren customers can verify their own setup. It covers the basics you'd want to check before going live.

**Run a real penetration test for serious deployments**, especially if you process children's data. UK data protection law (UK GDPR / DPA 2018) requires appropriate technical measures — a surface scanner like this isn't sufficient on its own.

---

## Using scan results with the Wren dashboard

Wren's admin portal includes a Security Dashboard (Admin → IT Settings → Security). The "External Verification" panel (Flow C) links to this script and can accept JSON output:

```bash
bash scan.sh your-domain.getwren.co.uk --json > scan-result.json
# Upload via the dashboard UI, or POST to your Wren install's /api/admin/security/upload-scan
```

---

## Running from a cron job (automated weekly check)

```bash
# Add to crontab (crontab -e):
0 8 * * 1 bash /path/to/scan.sh your-domain.getwren.co.uk --json > /var/log/wren-scan-latest.json 2>&1
```

---

## Repo structure

```
scan.sh                     Main scanner script
README.md                   This file
LICENSE                     MIT
CHANGELOG.md                Version history
.github/workflows/
  shellcheck.yml            CI: ShellCheck linting on push
examples/
  output-pass.txt           Example output — clean install
  output-fail.txt           Example output — issues found
```

---

## Licence

MIT — see [LICENSE](LICENSE).
