# --- Code Ducky gate: shared helpers ----------------------------------------------------------
# Fail-open: a missing token, a network error, a timeout or an unexpected answer prints a
# warning and lets the push through. Only a FAIL from the server blocks it.

set -f

CODEDUCKY_DEFAULT_URL='__CODEDUCKY_URL__'

codeducky_warn() {
  printf 'codeducky: %s\n' "$*" >&2
}

# The server: git config codeducky.url (per repo or global), else the URL this script came from.
codeducky_url() {
  _u=$(git config --get codeducky.url 2>/dev/null || true)
  [ -n "$_u" ] || _u=$CODEDUCKY_DEFAULT_URL
  printf '%s' "${_u%/}"
}

# The token: the macOS Keychain item "codeducky", else $CODEDUCKY_TOKEN.
codeducky_token() {
  _t=''
  if command -v security >/dev/null 2>&1; then
    _t=$(security find-generic-password -s codeducky -w 2>/dev/null || true)
  fi
  [ -n "$_t" ] || _t=${CODEDUCKY_TOKEN:-}
  printf '%s' "$_t"
}

# owner/name from a remote URL: git@host:owner/name.git, https://host/owner/name, /path/owner/name.git
codeducky_repo_from_url() {
  _r=${1%/}
  _r=${_r%.git}
  _name=${_r##*/}
  _rest=${_r%/*}
  _owner=${_rest##*/}
  _owner=${_owner##*:}
  [ -n "$_owner" ] && [ -n "$_name" ] && [ "$_rest" != "$_r" ] || return 1
  printf '%s/%s' "$_owner" "$_name"
}

# Asks the server about one repo and branch. Prints the answer (PASS or FAIL, "- reason" lines,
# "url <link>") and returns 0, or warns and returns 1 when there is no usable answer.
codeducky_check() {
  _repo=$1
  _branch=$2
  _base=$(codeducky_url)
  if ! command -v curl >/dev/null 2>&1; then
    codeducky_warn 'curl is not installed; push allowed without the review gate.'
    return 1
  fi
  _token=$(codeducky_token)
  if [ -z "$_token" ]; then
    codeducky_warn 'no token (Keychain item "codeducky" or CODEDUCKY_TOKEN); push allowed without the review gate.'
    return 1
  fi
  _out=$(curl -sS --max-time 2 -G \
    -H "Authorization: Bearer $_token" \
    --data-urlencode "repo=$_repo" \
    --data-urlencode "branch=$_branch" \
    --data-urlencode 'format=text' \
    -w '\n%{http_code}' \
    "$_base/api/gate" 2>/dev/null)
  _status=$?
  if [ "$_status" -ne 0 ]; then
    codeducky_warn "could not reach $_base (curl exit $_status); push allowed without the review gate."
    return 1
  fi
  _code=$(printf '%s\n' "$_out" | tail -n 1)
  _body=$(printf '%s\n' "$_out" | sed '$d')
  case $_code in
    200) ;;
    401) codeducky_warn "the server at $_base rejected the token; push allowed without the review gate."; return 1 ;;
    *) codeducky_warn "the server at $_base answered HTTP $_code; push allowed without the review gate."; return 1 ;;
  esac
  case $(printf '%s\n' "$_body" | head -n 1) in
    PASS | FAIL) printf '%s\n' "$_body" ;;
    *) codeducky_warn "unexpected answer from $_base; push allowed without the review gate."; return 1 ;;
  esac
}
# --- end of shared helpers ------------------------------------------------------------------
