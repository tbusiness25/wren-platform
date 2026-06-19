# Changelog

All notable changes to the Wren External Security Scanner.

## [1.0.0] — 2026-04-26

### Added
- Initial release
- DNS checks: A/AAAA records, Cloudflare IP range verification, wildcard DNS, SPF, DMARC
- Port scanning: nmap top-1000 (quick) / all-65535 (full) with dangerous-port classification
- Fallback port probe via bash /dev/tcp when nmap is unavailable
- TLS checks: certificate expiry, CN/SAN verification, deprecated protocol detection (SSLv2/3, TLS1.0/1.1), TLS 1.3 support, weak cipher detection (full mode)
- HTTP security header checks: HSTS, X-Frame-Options, X-Content-Type-Options, CSP, Referrer-Policy, Permissions-Policy, server fingerprinting, X-Powered-By, CORS
- Common-path probing: 29 sensitive paths (.git, .env, backups, admin panels, config files)
- Admin path accessibility tests
- Directory listing detection
- Subdomain enumeration via crt.sh certificate transparency API
- Open redirect testing on 14 common URL parameters
- Human-readable output with ✓/⚠/✗ indicators and colour
- JSON output mode (--json) for machine-readable results / dashboard integration
- Quick (~30s) and full (~5min) scan modes
- Graceful tool-availability fallbacks (nmap optional, dig optional)
