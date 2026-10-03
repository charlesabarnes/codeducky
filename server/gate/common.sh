# --- Skelbert gate: shared helpers ----------------------------------------------------------
# Fail-open: a missing token, a network error, a timeout or an unexpected answer prints a
# warning and lets the push through. Only a FAIL from the server blocks it.

set -f

SKELBERT_DEFAULT_URL='__SKELBERT_URL__'

skelbert_warn() {
  printf 'skelbert: %s\n' "$*" >&2
}

# The server: git config skelbert.url (per repo or global), else the URL this script came from.
skelbert_url() {
  _u=$(git config --get skelbert.url 2>/dev/null || true)
  [ -n "$_u" ] || _u=$SKELBERT_DEFAULT_URL
  printf '%s' "${_u%/}"
}

# The token: the macOS Keychain item "skelbert", else $SKELBERT_TOKEN.
skelbert_token() {
  _t=''
  if command -v security >/dev/null 2>&1; then
    _t=$(security find-generic-password -s skelbert -w 2>/dev/null || true)
  fi
  [ -n "$_t" ] || _t=${SKELBERT_TOKEN:-}
  printf '%s' "$_t"
}

# owner/name from a remote URL: git@host:owner/name.git, https://host/owner/name, /path/owner/name.git
skelbert_repo_from_url() {
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
skelbert_check() {
  _repo=$1
  _branch=$2
  _base=$(skelbert_url)
  if ! command -v curl >/dev/null 2>&1; then
    skelbert_warn 'curl is not installed; push allowed without the review gate.'
    return 1
  fi
  _token=$(skelbert_token)
  if [ -z "$_token" ]; then
    skelbert_warn 'no token (Keychain item "skelbert" or SKELBERT_TOKEN); push allowed without the review gate.'
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
    skelbert_warn "could not reach $_base (curl exit $_status); push allowed without the review gate."
    return 1
  fi
  _code=$(printf '%s\n' "$_out" | tail -n 1)
  _body=$(printf '%s\n' "$_out" | sed '$d')
  case $_code in
    200) ;;
    401) skelbert_warn "the server at $_base rejected the token; push allowed without the review gate."; return 1 ;;
    *) skelbert_warn "the server at $_base answered HTTP $_code; push allowed without the review gate."; return 1 ;;
  esac
  case $(printf '%s\n' "$_body" | head -n 1) in
    PASS | FAIL) printf '%s\n' "$_body" ;;
    *) skelbert_warn "unexpected answer from $_base; push allowed without the review gate."; return 1 ;;
  esac
}
# --- end of shared helpers ------------------------------------------------------------------
