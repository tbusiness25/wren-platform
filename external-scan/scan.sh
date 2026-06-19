#!/usr/bin/env bash
# scan.sh — Wren External Security Scanner v1.0.0
# Usage: bash scan.sh <domain-or-ip> [--quick|--full] [--json]
# Repo: https://github.com/getwren/external-scan
# Licence: MIT | "Not a security company. Run a real pen test for serious deployments."

# set -e omitted: scanner functions must continue past individual check failures
# (grep exits 1 on no match; $(( 0 )) exits 1; openssl exits 1 on refused connections).
# set -u catches typos in variable names which is the important safety property here.
set -u

# ─── Version ──────────────────────────────────────────────────────────────────
SCAN_VERSION="1.0.0"

# ─── Cloudflare IP ranges (updated 2024) ─────────────────────────────────────
CF_RANGES_V4=(
  "173.245.48.0/20"
  "103.21.244.0/22"
  "103.22.200.0/22"
  "103.31.4.0/22"
  "141.101.64.0/18"
  "108.162.192.0/18"
  "190.93.240.0/20"
  "188.114.96.0/20"
  "197.234.240.0/22"
  "198.41.128.0/17"
  "162.158.0.0/15"
  "104.16.0.0/13"
  "104.24.0.0/14"
  "172.64.0.0/13"
  "131.0.72.0/22"
)

# ─── Colour helpers ───────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
PASS="✓"; WARN="⚠"; FAIL="✗"

# ─── Globals ──────────────────────────────────────────────────────────────────
TARGET=""
MODE="quick"
JSON_OUT=0
START_TIME=""

# Counters
PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

# JSON accumulator
JSON_SECTIONS=()

# Findings accumulator  [ "severity|category|message" ]
FINDINGS=()

# ─── Argument parsing ─────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: bash scan.sh <domain-or-ip> [--quick|--full] [--json]

  --quick   ~30 second scan: top 1000 ports, basic TLS, headers (default)
  --full    ~5 minute scan: all 65535 ports, deep TLS, subdomain enumeration
  --json    Machine-readable JSON output

Examples:
  bash scan.sh demo.getwren.co.uk
  bash scan.sh getwren.co.uk --full
  bash scan.sh 203.0.113.1 --quick --json
EOF
  exit 1
}

[[ $# -lt 1 ]] && usage

TARGET="$1"; shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick) MODE="quick" ;;
    --full)  MODE="full"  ;;
    --json)  JSON_OUT=1   ;;
    -h|--help) usage      ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
  shift
done

# Strip leading https?:// if user pasted a URL
TARGET="${TARGET#https://}"; TARGET="${TARGET#http://}"; TARGET="${TARGET%%/*}"

# ─── Tool availability ────────────────────────────────────────────────────────
HAS_NMAP=0; HAS_OPENSSL=0; HAS_CURL=0; HAS_DIG=0; HAS_HOST=0; HAS_NC=0
command -v nmap    &>/dev/null && HAS_NMAP=1
command -v openssl &>/dev/null && HAS_OPENSSL=1
command -v curl    &>/dev/null && HAS_CURL=1
command -v dig     &>/dev/null && HAS_DIG=1
command -v host    &>/dev/null && HAS_HOST=1
command -v nc      &>/dev/null && HAS_NC=1

# ─── Output helpers ───────────────────────────────────────────────────────────
section_header() {
  [[ $JSON_OUT -eq 1 ]] && return
  echo ""
  echo -e "${CYAN}${BOLD}══════════════════════════════════════════${RESET}"
  echo -e "${CYAN}${BOLD}  $1${RESET}"
  echo -e "${CYAN}${BOLD}══════════════════════════════════════════${RESET}"
}

pass_line() {
  ((PASS_COUNT++)) || true
  [[ $JSON_OUT -eq 0 ]] && echo -e "  ${GREEN}${PASS}${RESET}  $1"
}

warn_line() {
  ((WARN_COUNT++)) || true
  [[ $JSON_OUT -eq 0 ]] && echo -e "  ${YELLOW}${WARN}${RESET}  $1"
  FINDINGS+=("WARN|${CURRENT_SECTION:-general}|$1")
}

fail_line() {
  ((FAIL_COUNT++)) || true
  [[ $JSON_OUT -eq 0 ]] && echo -e "  ${RED}${FAIL}${RESET}  $1"
  FINDINGS+=("FAIL|${CURRENT_SECTION:-general}|$1")
}

info_line() {
  [[ $JSON_OUT -eq 0 ]] && echo -e "  ${BOLD}ℹ${RESET}  $1"
}

# ─── Helper: ip_in_cidr ───────────────────────────────────────────────────────
# Returns 0 (true) if $1 (dotted quad) is within $2 (CIDR)
ip_in_cidr() {
  local ip="$1" cidr="$2"
  local net="${cidr%%/*}" prefix="${cidr##*/}"

  ip2int() {
    local a b c d; IFS='.' read -r a b c d <<< "$1"
    echo $(( (a<<24) | (b<<16) | (c<<8) | d ))
  }

  local ip_int; ip_int=$(ip2int "$ip")
  local net_int; net_int=$(ip2int "$net")
  local mask=$(( 0xFFFFFFFF << (32 - prefix) & 0xFFFFFFFF ))

  [[ $(( ip_int & mask )) -eq $(( net_int & mask )) ]]
}

# ─── Helper: ip_is_cloudflare ─────────────────────────────────────────────────
ip_is_cloudflare() {
  local ip="$1"
  for range in "${CF_RANGES_V4[@]}"; do
    ip_in_cidr "$ip" "$range" && return 0
  done
  return 1
}

# ─── JSON builder helpers ─────────────────────────────────────────────────────
json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

json_section_open()  { JSON_SECTIONS+=("${1}:{"); }
json_section_close() { JSON_SECTIONS+=("END_SECTION"); }
json_kv()           { JSON_SECTIONS+=("\"$(json_str "$1")\":\"$(json_str "$2")\""); }
json_kv_num()       { JSON_SECTIONS+=("\"$(json_str "$1")\":$2"); }
json_kv_bool()      { JSON_SECTIONS+=("\"$(json_str "$1")\":$2"); }
json_array_start()  { JSON_SECTIONS+=("\"$(json_str "$1")\":["); }
json_array_item()   { JSON_SECTIONS+=("ITEM:$(json_str "$1")"); }
json_array_end()    { JSON_SECTIONS+=("END_ARRAY"); }

# ─── Section 1: DNS ───────────────────────────────────────────────────────────
run_dns_check() {
  CURRENT_SECTION="dns"
  section_header "1. DNS"

  local ipv4_addrs=() ipv6_addrs=()

  if [[ $HAS_DIG -eq 1 ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] && ipv4_addrs+=("$line")
    done < <(dig +short A "$TARGET" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')
    while IFS= read -r line; do
      [[ -n "$line" ]] && ipv6_addrs+=("$line")
    done < <(dig +short AAAA "$TARGET" 2>/dev/null | grep -E ':')
  elif [[ $HAS_HOST -eq 1 ]]; then
    while IFS= read -r line; do
      local ip; ip=$(echo "$line" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)
      [[ -n "$ip" ]] && ipv4_addrs+=("$ip")
    done < <(host -t A "$TARGET" 2>/dev/null)
  fi

  if [[ ${#ipv4_addrs[@]} -eq 0 && ${#ipv6_addrs[@]} -eq 0 ]]; then
    fail_line "DNS: No A or AAAA records found for $TARGET"
    return
  fi

  # IPv4
  for ip in "${ipv4_addrs[@]}"; do
    if ip_is_cloudflare "$ip"; then
      pass_line "A record $ip → Cloudflare (origin IP hidden)"
    else
      warn_line "A record $ip → NOT a Cloudflare IP — origin server may be exposed"
    fi
  done

  # IPv6
  if [[ ${#ipv6_addrs[@]} -gt 0 ]]; then
    for ip in "${ipv6_addrs[@]}"; do
      info_line "AAAA record: $ip (manual Cloudflare check needed for IPv6)"
    done
  fi

  # Check for wildcard
  if [[ $HAS_DIG -eq 1 ]]; then
    local wild; wild=$(dig +short A "wildcard-test-$(date +%s).$TARGET" 2>/dev/null | grep -E '^[0-9]' | head -1)
    if [[ -n "$wild" ]]; then
      warn_line "Wildcard DNS detected — *.${TARGET} resolves to $wild"
    else
      pass_line "No wildcard DNS (*.$TARGET doesn't resolve)"
    fi

    # SPF
    local spf; spf=$(dig +short TXT "$TARGET" 2>/dev/null | grep -i 'v=spf' | head -1)
    if [[ -n "$spf" ]]; then
      pass_line "SPF record present: $spf"
    else
      warn_line "No SPF TXT record found — email spoofing risk"
    fi

    # DMARC
    local dmarc; dmarc=$(dig +short TXT "_dmarc.$TARGET" 2>/dev/null | grep -i 'v=DMARC' | head -1)
    if [[ -n "$dmarc" ]]; then
      pass_line "DMARC record present"
    else
      warn_line "No DMARC record at _dmarc.$TARGET"
    fi
  fi

  json_section_open "dns"
  json_kv "target" "$TARGET"
  local joined_v4; joined_v4=$(IFS=','; echo "${ipv4_addrs[*]:-none}")
  json_kv "ipv4" "$joined_v4"
  json_section_close
}

# ─── Section 2: Port scan ─────────────────────────────────────────────────────
run_port_scan() {
  CURRENT_SECTION="ports"
  section_header "2. Port Scan"

  local open_ports=()

  if [[ $HAS_NMAP -eq 1 ]]; then
    local nmap_args=()
    if [[ "$MODE" == "full" ]]; then
      nmap_args=(-p- --min-rate=1000 -T4)
    else
      nmap_args=(--top-ports 1000 -T4)
    fi

    info_line "Running nmap${MODE:+ ($MODE mode)}…"
    local nmap_out
    nmap_out=$(nmap -n "${nmap_args[@]}" "$TARGET" 2>/dev/null)

    while IFS= read -r line; do
      if [[ "$line" =~ ^([0-9]+)/(tcp|udp)[[:space:]]+open ]]; then
        open_ports+=("${BASH_REMATCH[1]}/${BASH_REMATCH[2]}")
      fi
    done <<< "$nmap_out"

    if [[ ${#open_ports[@]} -eq 0 ]]; then
      pass_line "No open ports found (nmap scan)"
    else
      for p in "${open_ports[@]}"; do
        case "${p%%/*}" in
          80|443)  pass_line "Port $p open (expected)" ;;
          22)      warn_line "Port $p open — SSH exposed publicly. Consider restricting." ;;
          21)      fail_line "Port $p open — FTP (plaintext). Strongly discouraged." ;;
          23)      fail_line "Port $p open — Telnet. Immediately close." ;;
          3306)    fail_line "Port $p open — MySQL/MariaDB exposed to internet." ;;
          5432)    fail_line "Port $p open — PostgreSQL exposed to internet." ;;
          6379)    fail_line "Port $p open — Redis exposed (no auth by default)." ;;
          27017)   fail_line "Port $p open — MongoDB exposed to internet." ;;
          8080|8443|8888|9090|3000|3001|5678)
                   warn_line "Port $p open — Non-standard port. Verify it should be public." ;;
          *)       warn_line "Port $p open — Unexpected port." ;;
        esac
      done
    fi
  else
    # Fallback: probe a handful of common dangerous ports using bash /dev/tcp
    info_line "nmap not found — probing common ports via /dev/tcp fallback"
    local probe_ports=(21 22 23 25 80 443 3306 5432 6379 8080 8443 9090)
    for port in "${probe_ports[@]}"; do
      if timeout 3 bash -c ": > /dev/tcp/$TARGET/$port" 2>/dev/null; then
        open_ports+=("$port/tcp")
        case "$port" in
          80|443)  pass_line "Port $port open (expected)" ;;
          22)      warn_line "Port 22 open — SSH exposed publicly." ;;
          21)      fail_line "Port 21 open — FTP plaintext, close it." ;;
          23)      fail_line "Port 23 open — Telnet, close it immediately." ;;
          3306)    fail_line "Port 3306 open — MySQL exposed." ;;
          5432)    fail_line "Port 5432 open — PostgreSQL exposed." ;;
          6379)    fail_line "Port 6379 open — Redis exposed." ;;
          *)       warn_line "Port $port open." ;;
        esac
      fi
    done
    if [[ ${#open_ports[@]} -eq 0 ]]; then
      pass_line "No dangerous common ports open (limited probe — install nmap for full scan)"
    fi
    warn_line "Install nmap for comprehensive port scanning"
  fi

  json_section_open "ports"
  local joined_open; joined_open=$(IFS=','; echo "${open_ports[*]:-none}")
  json_kv "open_ports" "$joined_open"
  json_kv_num "count" "${#open_ports[@]}"
  json_section_close
}

# ─── Section 3: TLS ───────────────────────────────────────────────────────────
run_tls_check() {
  CURRENT_SECTION="tls"
  section_header "3. TLS / Certificate"

  if [[ $HAS_OPENSSL -eq 0 ]]; then
    warn_line "openssl not found — skipping TLS checks"
    return
  fi

  # Grab the certificate
  local cert_info
  cert_info=$(echo | timeout 10 openssl s_client -connect "${TARGET}:443" \
    -servername "$TARGET" 2>/dev/null | openssl x509 -noout -text 2>/dev/null) || {
    fail_line "Could not connect to ${TARGET}:443 — TLS not available or refused"
    return
  }

  # Expiry
  local expiry_str expires_epoch now_epoch days_left
  expiry_str=$(echo | timeout 10 openssl s_client -connect "${TARGET}:443" \
    -servername "$TARGET" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2-)
  if [[ -n "$expiry_str" ]]; then
    expires_epoch=$(date -d "$expiry_str" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "$expiry_str" +%s 2>/dev/null || echo 0)
    now_epoch=$(date +%s)
    days_left=$(( (expires_epoch - now_epoch) / 86400 ))
    if [[ $days_left -lt 0 ]]; then
      fail_line "Certificate EXPIRED $((- days_left)) days ago"
    elif [[ $days_left -lt 14 ]]; then
      fail_line "Certificate expires in $days_left days — renew urgently"
    elif [[ $days_left -lt 30 ]]; then
      warn_line "Certificate expires in $days_left days — schedule renewal"
    else
      pass_line "Certificate valid for $days_left more days (expires: $expiry_str)"
    fi
  fi

  # Subject / CN
  local cn; cn=$(echo "$cert_info" | grep -oP 'CN\s*=\s*\K[^\n,]+' | head -1 || true)
  [[ -n "$cn" ]] && info_line "Certificate CN: $cn"

  # SANs
  local san_line; san_line=$(echo "$cert_info" | grep -A1 'Subject Alternative Name' | tail -1 || true)
  if echo "$san_line" | grep -q "DNS:$TARGET"; then
    pass_line "SAN covers $TARGET"
  elif [[ -n "$san_line" ]]; then
    warn_line "SAN does not directly list $TARGET — check: $san_line"
  fi

  # Issuer — check for known CAs
  local issuer; issuer=$(echo "$cert_info" | grep -oP 'Issuer:.*' | head -1 || true)
  if echo "$issuer" | grep -qiE "Let.s Encrypt|DigiCert|Sectigo|Comodo|GlobalSign|ZeroSSL|Google Trust"; then
    pass_line "Trusted CA: $issuer"
  elif [[ -n "$issuer" ]]; then
    warn_line "Issuer: $issuer — verify this is a trusted CA"
  fi

  # Minimum TLS version
  local tls_versions_ok=1
  declare -A BAD_VER_LABELS
  BAD_VER_LABELS=([ssl2]="SSLv2" [ssl3]="SSLv3" [tls1]="TLS 1.0" [tls1_1]="TLS 1.1")
  for bad_ver in ssl2 ssl3 tls1 tls1_1; do
    local ver_label="${BAD_VER_LABELS[$bad_ver]}"
    local test_out
    test_out=$(echo | timeout 5 openssl s_client \
      -connect "${TARGET}:443" -servername "$TARGET" \
      "-${bad_ver}" 2>&1 || true)
    if echo "$test_out" | grep -q "Cipher is"; then
      fail_line "$ver_label accepted — deprecated protocol, should be disabled"
      tls_versions_ok=0
    fi
  done
  [[ $tls_versions_ok -eq 1 ]] && pass_line "No deprecated TLS/SSL protocols accepted (TLS 1.2+ only)"

  # TLS 1.3 availability
  local tls13_out
  tls13_out=$(echo | timeout 5 openssl s_client \
    -connect "${TARGET}:443" -servername "$TARGET" \
    -tls1_3 2>&1 || true)
  if echo "$tls13_out" | grep -q "Cipher is"; then
    pass_line "TLS 1.3 supported"
  else
    warn_line "TLS 1.3 not supported — consider enabling"
  fi

  # Weak cipher check (full mode only)
  if [[ "$MODE" == "full" ]]; then
    local weak_ciphers=("RC4-SHA" "DES-CBC3-SHA" "NULL-SHA" "EXP-RC4-MD5" "ADH-AES256-SHA")
    for cipher in "${weak_ciphers[@]}"; do
      local c_out
      c_out=$(echo | timeout 5 openssl s_client \
        -connect "${TARGET}:443" -servername "$TARGET" \
        -cipher "$cipher" 2>&1 || true)
      if echo "$c_out" | grep -q "Cipher is"; then
        fail_line "Weak cipher accepted: $cipher"
      fi
    done
    pass_line "No common weak ciphers accepted (RC4, NULL, EXPORT)"
  fi

  json_section_open "tls"
  json_kv "expiry" "${expiry_str:-unknown}"
  json_kv_num "days_remaining" "${days_left:-0}"
  json_kv "cn" "${cn:-unknown}"
  json_section_close
}

# ─── Section 4: HTTP Headers ──────────────────────────────────────────────────
check_header() {
  local name="$1" value="$2" required="${3:-0}"
  if [[ -n "$value" ]]; then
    pass_line "$name: $value"
  else
    if [[ $required -eq 1 ]]; then
      fail_line "$name header missing"
    else
      warn_line "$name header missing (recommended)"
    fi
  fi
}

run_header_check() {
  CURRENT_SECTION="headers"
  section_header "4. HTTP Security Headers"

  if [[ $HAS_CURL -eq 0 ]]; then
    warn_line "curl not found — skipping header checks"
    return
  fi

  local paths=("/")
  [[ "$MODE" == "full" ]] && paths+=("/admin" "/login" "/api/health")

  for path in "${paths[@]}"; do
    local url="https://${TARGET}${path}"
    info_line "Checking headers: $url"

    local raw_headers
    raw_headers=$(curl -sSL --max-time 15 --max-redirs 5 \
      -D - -o /dev/null "$url" 2>/dev/null) || {
      warn_line "Could not reach $url"
      continue
    }

    local hsts x_frame x_cto csp referrer perms server

    hsts=$(echo "$raw_headers" | grep -i '^strict-transport-security:' | head -1 | cut -d: -f2- | tr -d '\r' | xargs)
    x_frame=$(echo "$raw_headers" | grep -i '^x-frame-options:' | head -1 | cut -d: -f2- | tr -d '\r' | xargs)
    x_cto=$(echo "$raw_headers" | grep -i '^x-content-type-options:' | head -1 | cut -d: -f2- | tr -d '\r' | xargs)
    csp=$(echo "$raw_headers" | grep -i '^content-security-policy:' | head -1 | cut -d: -f2- | tr -d '\r' | xargs)
    referrer=$(echo "$raw_headers" | grep -i '^referrer-policy:' | head -1 | cut -d: -f2- | tr -d '\r' | xargs)
    perms=$(echo "$raw_headers" | grep -i '^permissions-policy:' | head -1 | cut -d: -f2- | tr -d '\r' | xargs)
    server=$(echo "$raw_headers" | grep -i '^server:' | head -1 | cut -d: -f2- | tr -d '\r' | xargs)

    # HSTS — required
    if [[ -n "$hsts" ]]; then
      local max_age; max_age=$(echo "$hsts" | grep -oP 'max-age=\K[0-9]+' || echo "0")
      if [[ "$max_age" -ge 31536000 ]]; then
        pass_line "HSTS: $hsts"
      else
        warn_line "HSTS max-age $max_age < 31536000 (1 year minimum recommended)"
      fi
    else
      fail_line "Strict-Transport-Security header missing"
    fi

    check_header "X-Frame-Options" "$x_frame" 0
    check_header "X-Content-Type-Options" "$x_cto" 0

    if [[ -n "$csp" ]]; then
      pass_line "Content-Security-Policy present"
      echo "$csp" | grep -q "unsafe-inline" && warn_line "CSP contains 'unsafe-inline' — reduces protection"
      echo "$csp" | grep -q "unsafe-eval"   && warn_line "CSP contains 'unsafe-eval' — reduces protection"
    else
      warn_line "Content-Security-Policy header missing"
    fi

    check_header "Referrer-Policy" "$referrer" 0
    check_header "Permissions-Policy" "$perms" 0

    # Server header fingerprinting
    if [[ -n "$server" ]]; then
      if echo "$server" | grep -qiE 'nginx/[0-9]|apache/[0-9]|express|node\.js|php/[0-9]'; then
        warn_line "Server header reveals software version: $server"
      else
        pass_line "Server header: $server (no version leak detected)"
      fi
    else
      pass_line "Server header suppressed (good)"
    fi

    # X-Powered-By
    local powered_by; powered_by=$(echo "$raw_headers" | grep -i '^x-powered-by:' | head -1 | cut -d: -f2- | tr -d '\r' | xargs)
    if [[ -n "$powered_by" ]]; then
      warn_line "X-Powered-By header exposes tech stack: $powered_by"
    else
      pass_line "X-Powered-By suppressed (good)"
    fi

    # HTTPS redirect check
    local http_status; http_status=$(curl -sS --max-time 10 -o /dev/null \
      -w '%{http_code}' "http://${TARGET}${path}" 2>/dev/null || echo "000")
    if [[ "$http_status" =~ ^30[0-9]$ ]]; then
      pass_line "HTTP→HTTPS redirect: HTTP $http_status"
    else
      warn_line "HTTP does not redirect to HTTPS (status: $http_status)"
    fi

    # CORS check
    local cors_origin; cors_origin=$(echo "$raw_headers" | grep -i '^access-control-allow-origin:' | head -1 | cut -d: -f2- | tr -d '\r' | xargs)
    if [[ "$cors_origin" == "*" ]]; then
      warn_line "CORS: Access-Control-Allow-Origin: * (open CORS — verify intended)"
    fi
  done

  json_section_open "headers"
  json_kv "hsts" "${hsts:-missing}"
  json_kv "csp" "${csp:-missing}"
  json_kv "x_frame" "${x_frame:-missing}"
  json_section_close
}

# ─── Section 5: Common path probing ──────────────────────────────────────────
run_path_probe() {
  CURRENT_SECTION="paths"
  section_header "5. Common-Path Probing"

  if [[ $HAS_CURL -eq 0 ]]; then
    warn_line "curl not found — skipping path probing"
    return
  fi

  # Paths that should NOT be reachable (return non-200/301/302)
  local sensitive_paths=(
    "/.git/"
    "/.git/config"
    "/.env"
    "/.env.local"
    "/.env.production"
    "/backup"
    "/backups"
    "/backup.zip"
    "/backup.tar.gz"
    "/db.sql"
    "/dump.sql"
    "/server-status"
    "/server-info"
    "/phpmyadmin"
    "/pma"
    "/wp-admin"
    "/wp-login.php"
    "/.htaccess"
    "/composer.json"
    "/package.json"
    "/Dockerfile"
    "/docker-compose.yml"
    "/.dockerignore"
    "/config.php"
    "/config.yml"
    "/config.yaml"
    "/settings.py"
    "/web.config"
    "/id_rsa"
    "/.ssh/id_rsa"
  )

  # Paths that SHOULD exist (informational)
  local info_paths=(
    "/robots.txt"
    "/sitemap.xml"
    "/favicon.ico"
  )

  # Admin paths to test
  local admin_paths=(
    "/admin"
    "/admin/"
    "/admin/login"
    "/dashboard"
    "/manage"
    "/panel"
    "/control"
  )

  local exposed_count=0

  for path in "${sensitive_paths[@]}"; do
    local url="https://${TARGET}${path}"
    local status body
    status=$(curl -sSL --max-time 10 --max-redirs 3 \
      -o /tmp/wren_scan_body -w '%{http_code}' "$url" 2>/dev/null || echo "000")
    body=$(cat /tmp/wren_scan_body 2>/dev/null || true)

    case "$status" in
      200)
        # Special .git check — look for "HEAD" or "[core]" in response
        if [[ "$path" == "/.git/" || "$path" == "/.git/config" ]]; then
          if echo "$body" | grep -qiE '\[core\]|HEAD|ref:|object'; then
            fail_line "EXPOSED: $url (HTTP 200, git repo content visible)"
            ((exposed_count++)) || true
          else
            warn_line "$url returned 200 but body doesn't look like git data"
          fi
        elif [[ "$path" == "/.env" || "$path" == "/.env.local" || "$path" == "/.env.production" ]]; then
          if echo "$body" | grep -qiE '=|PASSWORD|SECRET|TOKEN|KEY'; then
            fail_line "CRITICAL: $url (HTTP 200, looks like env file with secrets!)"
            ((exposed_count++)) || true
          else
            warn_line "$url returned 200 (verify it's not exposing secrets)"
          fi
        else
          warn_line "Accessible: $url (HTTP 200) — verify this should be public"
          ((exposed_count++)) || true
        fi
        ;;
      301|302|307|308)
        pass_line "$url redirects (HTTP $status) — likely protected"
        ;;
      401|403|405)
        pass_line "$url blocked (HTTP $status) — good"
        ;;
      404)
        pass_line "$url → 404 (not exposed)"
        ;;
      000)
        # Connection refused / timeout — acceptable
        pass_line "$url → no response (not exposed)"
        ;;
      *)
        info_line "$url → HTTP $status"
        ;;
    esac
  done

  # Informational paths
  for path in "${info_paths[@]}"; do
    local url="https://${TARGET}${path}"
    local status
    status=$(curl -sSL --max-time 10 --max-redirs 3 \
      -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo "000")
    case "$status" in
      200) info_line "$url exists (HTTP 200)" ;;
      *)   info_line "$url → HTTP $status" ;;
    esac
  done

  # Admin path probing
  for path in "${admin_paths[@]}"; do
    local url="https://${TARGET}${path}"
    local status
    status=$(curl -sSL --max-time 10 --max-redirs 5 \
      -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo "000")
    case "$status" in
      200)
        warn_line "Admin path accessible (HTTP 200): $url — should require auth"
        ;;
      401|403)
        pass_line "Admin path protected (HTTP $status): $url"
        ;;
      302|301)
        pass_line "Admin path redirects (HTTP $status): $url"
        ;;
      404)
        pass_line "Admin path not found: $url"
        ;;
      *)
        info_line "Admin path $url → HTTP $status"
        ;;
    esac
  done

  # Directory listing detection
  local dir_paths=("/" "/assets/" "/images/" "/uploads/" "/files/" "/static/")
  for path in "${dir_paths[@]}"; do
    local url="https://${TARGET}${path}"
    local body
    body=$(curl -sSL --max-time 10 --max-redirs 3 "$url" 2>/dev/null || true)
    if echo "$body" | grep -qiE 'Index of /|Parent Directory|<a href="\.\./"|Directory listing'; then
      fail_line "Directory listing enabled: $url"
    fi
  done

  [[ $exposed_count -eq 0 ]] && pass_line "No sensitive paths exposed"

  json_section_open "paths"
  json_kv_num "exposed_count" "$exposed_count"
  json_section_close
}

# ─── Section 6: Subdomain enumeration ─────────────────────────────────────────
run_subdomain_enum() {
  CURRENT_SECTION="subdomains"
  section_header "6. Subdomain Enumeration (crt.sh)"

  if [[ $HAS_CURL -eq 0 ]]; then
    warn_line "curl not found — skipping subdomain enumeration"
    return
  fi

  info_line "Querying certificate transparency logs (crt.sh)…"

  local ct_out
  ct_out=$(curl -sSL --max-time 30 \
    "https://crt.sh/?q=%.${TARGET}&output=json" 2>/dev/null) || {
    warn_line "crt.sh request failed — check connectivity"
    return
  }

  if [[ -z "$ct_out" ]] || echo "$ct_out" | grep -q "^<!"; then
    warn_line "crt.sh returned no JSON — may be rate-limited or down"
    return
  fi

  # Extract unique subdomains from JSON (name_value field)
  local subdomains=()
  while IFS= read -r sub; do
    # Clean wildcards and deduplicate
    sub="${sub#\*.}"; sub="${sub// /}"
    [[ -z "$sub" ]] && continue
    # Skip if already in list
    local already=0
    for existing in "${subdomains[@]:-}"; do
      [[ "$existing" == "$sub" ]] && already=1 && break
    done
    [[ $already -eq 0 ]] && subdomains+=("$sub")
  done < <(echo "$ct_out" | grep -oP '"name_value"\s*:\s*"\K[^"]+' | sort -u)

  if [[ ${#subdomains[@]} -eq 0 ]]; then
    info_line "No subdomains found in CT logs for $TARGET"
  else
    info_line "Found ${#subdomains[@]} subdomains in CT logs:"
    for sub in "${subdomains[@]}"; do
      if [[ "$sub" == "$TARGET" ]]; then
        pass_line "  $sub (base domain)"
      else
        # Try to resolve each subdomain
        if [[ $HAS_DIG -eq 1 ]]; then
          local sub_ip; sub_ip=$(dig +short A "$sub" 2>/dev/null | grep -E '^[0-9]' | head -1)
          if [[ -n "$sub_ip" ]]; then
            if ip_is_cloudflare "$sub_ip"; then
              pass_line "  $sub → $sub_ip (Cloudflare)"
            else
              warn_line "  $sub → $sub_ip (NOT Cloudflare — origin IP exposed?)"
            fi
          else
            info_line "  $sub (no A record — may be defunct)"
          fi
        else
          info_line "  $sub"
        fi
      fi
    done
  fi

  json_section_open "subdomains"
  local joined_subs; joined_subs=$(IFS=','; echo "${subdomains[*]:-none}")
  json_kv "discovered" "$joined_subs"
  json_kv_num "count" "${#subdomains[@]}"
  json_section_close
}

# ─── Section 7: Open redirect testing ────────────────────────────────────────
run_redirect_test() {
  CURRENT_SECTION="redirects"
  section_header "7. Open Redirect Testing"

  if [[ $HAS_CURL -eq 0 ]]; then
    warn_line "curl not found — skipping redirect tests"
    return
  fi

  local canary="https://example.com/wren-redirect-test"
  local test_params=("url" "redirect" "next" "return" "returnUrl" "return_url" \
    "redirect_to" "redirect_url" "goto" "dest" "destination" "target" "rurl" "location")

  local found_redirect=0

  for param in "${test_params[@]}"; do
    local url="https://${TARGET}/?${param}=${canary}"
    local location
    location=$(curl -sS --max-time 10 --max-redirs 0 \
      -D - -o /dev/null "$url" 2>/dev/null | grep -i '^location:' | cut -d: -f2- | tr -d '\r' | xargs || true)

    if [[ -n "$location" ]] && echo "$location" | grep -q "example.com"; then
      fail_line "Open redirect via ?${param}= → $location"
      found_redirect=1
    fi
  done

  [[ $found_redirect -eq 0 ]] && pass_line "No open redirects found on common parameters"

  json_section_open "redirects"
  json_kv_bool "open_redirect_found" "$([[ $found_redirect -eq 1 ]] && echo true || echo false)"
  json_section_close
}

# ─── Section 8: Directory listing ─────────────────────────────────────────────
# (Already embedded in path probe above — kept as no-op here to preserve section ordering)

# ─── Output: Findings summary ─────────────────────────────────────────────────
print_findings() {
  local elapsed=$1
  [[ $JSON_OUT -eq 1 ]] && return

  echo ""
  echo -e "${CYAN}${BOLD}══════════════════════════════════════════${RESET}"
  echo -e "${CYAN}${BOLD}  FINDINGS SUMMARY${RESET}"
  echo -e "${CYAN}${BOLD}══════════════════════════════════════════${RESET}"

  if [[ ${#FINDINGS[@]} -eq 0 ]]; then
    echo -e "  ${GREEN}No issues found.${RESET}"
  else
    local fails=() warns=()
    for f in "${FINDINGS[@]}"; do
      local sev="${f%%|*}"; local rest="${f#*|}"
      local cat="${rest%%|*}"; local msg="${rest#*|}"
      if [[ "$sev" == "FAIL" ]]; then
        fails+=("  ${RED}[FAIL]${RESET} [${cat}] ${msg}")
      else
        warns+=("  ${YELLOW}[WARN]${RESET} [${cat}] ${msg}")
      fi
    done

    if [[ ${#fails[@]} -gt 0 ]]; then
      echo -e "\n${RED}${BOLD}  Critical findings:${RESET}"
      for f in "${fails[@]}"; do echo -e "$f"; done
    fi

    if [[ ${#warns[@]} -gt 0 ]]; then
      echo -e "\n${YELLOW}${BOLD}  Warnings:${RESET}"
      for w in "${warns[@]}"; do echo -e "$w"; done
    fi
  fi

  echo ""
  echo -e "${BOLD}  Results:${RESET}  ${GREEN}${PASS} Pass: ${PASS_COUNT}${RESET}  " \
    "${YELLOW}${WARN} Warn: ${WARN_COUNT}${RESET}  ${RED}${FAIL} Fail: ${FAIL_COUNT}${RESET}"
  echo -e "  Scan mode: ${MODE} | Target: ${TARGET} | Duration: ${elapsed}s"
  echo -e "  Scanner: Wren External Scanner v${SCAN_VERSION}"
  echo -e "${CYAN}${BOLD}══════════════════════════════════════════${RESET}"
  echo ""
  echo "  This scanner checks surface-level exposure only."
  echo "  For a production deployment, commission a professional penetration test."
  echo ""
}

# ─── JSON output builder ──────────────────────────────────────────────────────
print_json() {
  local elapsed=$1

  # Build findings JSON
  local findings_json="["
  local first=1
  for f in "${FINDINGS[@]}"; do
    local sev="${f%%|*}"; local rest="${f#*|}"
    local cat="${rest%%|*}"; local msg="${rest#*|}"
    [[ $first -eq 0 ]] && findings_json+=","
    findings_json+="{\"severity\":\"$(json_str "$sev")\",\"category\":\"$(json_str "$cat")\",\"message\":\"$(json_str "$msg")\"}"
    first=0
  done
  findings_json+="]"

  cat <<EOF
{
  "scanner": "wren-external-scan",
  "version": "${SCAN_VERSION}",
  "target": "$(json_str "$TARGET")",
  "mode": "$(json_str "$MODE")",
  "scanned_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "duration_seconds": ${elapsed},
  "summary": {
    "pass": ${PASS_COUNT},
    "warn": ${WARN_COUNT},
    "fail": ${FAIL_COUNT}
  },
  "findings": ${findings_json}
}
EOF
}

# ─── Prerequisites check ──────────────────────────────────────────────────────
check_prereqs() {
  [[ $JSON_OUT -eq 0 ]] && cat <<EOF

${BOLD}Wren External Security Scanner v${SCAN_VERSION}${RESET}
Target: ${CYAN}${TARGET}${RESET}  Mode: ${BOLD}${MODE}${RESET}

Tool availability:
$(  [[ $HAS_NMAP    -eq 1 ]] && echo "  ✓ nmap"    || echo "  ⚠ nmap missing — port scan will be limited")
$(  [[ $HAS_OPENSSL -eq 1 ]] && echo "  ✓ openssl" || echo "  ✗ openssl missing — TLS checks skipped")
$(  [[ $HAS_CURL    -eq 1 ]] && echo "  ✓ curl"    || echo "  ✗ curl missing — header/path checks skipped")
$(  [[ $HAS_DIG     -eq 1 ]] && echo "  ✓ dig"     || echo "  ⚠ dig missing — limited DNS checks")
$(  [[ $HAS_HOST    -eq 1 ]] && echo "  ✓ host"    || echo "  ⚠ host missing")
EOF
}

# ─── Main ─────────────────────────────────────────────────────────────────────
main() {
  START_TIME=$(date +%s)
  check_prereqs

  run_dns_check
  run_port_scan
  run_tls_check
  run_header_check
  run_path_probe
  run_subdomain_enum
  run_redirect_test

  local end_time; end_time=$(date +%s)
  local elapsed=$(( end_time - START_TIME ))

  if [[ $JSON_OUT -eq 1 ]]; then
    print_json "$elapsed"
  else
    print_findings "$elapsed"
  fi
}

main
