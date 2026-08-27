#!/usr/bin/env bash
# Fills the agent instruction template with a repository name and copies it to the clipboard.
#
#   ./connector-prompt.sh              # prompts for the repo name
#   ./connector-prompt.sh silky-context
#   ./connector-prompt.sh silky-context --print    # stdout only, no clipboard
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
template="$here/AGENT-TEMPLATE.md"
[ -f "$template" ] || { echo "AGENT-TEMPLATE.md not found next to this script" >&2; exit 1; }

repo="${1:-}"
print_only=false
for arg in "$@"; do [ "$arg" = "--print" ] && print_only=true; done
[ "$repo" = "--print" ] && repo=""

if [ -z "$repo" ]; then
  # /dev/tty, not stdin: this stays usable when the script is piped.
  printf 'Repository name (e.g. silky-context, or owner/name): ' > /dev/tty
  read -r repo < /dev/tty
fi

# Trim only. Stripping ALL whitespace would silently turn "bad name" into "badname" and accept it.
repo="$(printf '%s' "$repo" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
[ -n "$repo" ] || { echo "No repository name given." >&2; exit 1; }
# Matches what the server accepts, so a name that fails here would have failed there.
if ! printf '%s' "$repo" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)?$'; then
  echo "\"$repo\" is not a valid repository name. Use a name, or owner/name." >&2
  exit 1
fi

# The prompt is the fenced block between the two --- rules, not the whole file: the notes below
# it are for whoever installs this, and pasting them at an agent would just be noise.
prompt="$(awk '/^```$/{ if (inblock) exit; if (started) { inblock=1; next } } /^---$/{ started=1 } inblock' "$template" \
  | sed "s|{{REPO}}|$repo|g")"

[ -n "$prompt" ] || { echo "Could not extract the prompt block from AGENT-TEMPLATE.md" >&2; exit 1; }

if [ "$print_only" = true ]; then
  printf '%s\n' "$prompt"
  exit 0
fi

copy=""
for c in pbcopy "xclip -selection clipboard" xsel wl-copy clip.exe; do
  if command -v "${c%% *}" >/dev/null 2>&1; then copy="$c"; break; fi
done

if [ -n "$copy" ]; then
  printf '%s' "$prompt" | $copy
  printf 'Copied to clipboard: instructions for %s (%s lines)\n' "$repo" "$(printf '%s\n' "$prompt" | wc -l | tr -d ' ')"
else
  # No clipboard is not a failure — print it so the output is still usable.
  echo "No clipboard tool found; printing instead." >&2
  printf '%s\n' "$prompt"
fi
