#!/bin/sh
# Installs the Episteme desktop program on macOS or Linux from the latest GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/Jiarong-Song233/Episteme/main/scripts/install.sh | sh
#
# It downloads the package and SHA256SUMS from the same release and refuses to install a package whose checksum does
# not match. Everything goes under the current user's home; no sudo. It changes nothing else: connecting an agent is
# a separate, explicit step (EPISTEME_CONNECT=claude,codex before running, or the program's "接入 Agent" page).
#
# EPISTEME_VERSION=v0.2.0 picks a release instead of the latest one.
set -eu

repo='Jiarong-Song233/Episteme'
mcp='http://127.0.0.1:4322/mcp'

say() { printf 'episteme: %s\n' "$1"; }
fail() { printf 'episteme: %s\n' "$1" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail 'curl is needed'

os=$(uname -s)
arch=$(uname -m)
case "$os/$arch" in
  Darwin/arm64) pattern='_aarch64.dmg' ;;
  Darwin/x86_64) pattern='_x64.dmg' ;;
  Linux/x86_64) pattern='_amd64.AppImage' ;;
  *) fail "no package for $os $arch yet; see https://github.com/$repo/releases" ;;
esac

if [ -n "${EPISTEME_VERSION:-}" ]; then
  api="https://api.github.com/repos/$repo/releases/tags/$EPISTEME_VERSION"
else
  api="https://api.github.com/repos/$repo/releases/latest"
fi
release=$(curl -fsSL -H 'User-Agent: episteme-install' "$api") ||
  fail "no published release found at $api; releases may not be published yet"

# The release JSON lists each asset's download URL; pick ours without needing jq.
urls=$(printf '%s' "$release" | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(https[^"]*\)"$/\1/')
package_url=$(printf '%s\n' "$urls" | grep -- "$pattern\$" | head -n 1 || true)
sums_url=$(printf '%s\n' "$urls" | grep '/SHA256SUMS$' | head -n 1 || true)
[ -n "$package_url" ] || fail "this release has no package matching *$pattern"
[ -n "$sums_url" ] || fail 'this release has no SHA256SUMS'
name=${package_url##*/}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

say "downloading $name"
curl -fsSL -o "$work/$name" "$package_url"
curl -fsSL -o "$work/SHA256SUMS" "$sums_url"

expected=$(awk -v n="$name" '{ f=$2; sub(/^\*/, "", f); if (f == n) print tolower($1) }' "$work/SHA256SUMS")
[ -n "$expected" ] || fail "SHA256SUMS does not list $name"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$work/$name" | awk '{ print tolower($1) }')
else
  actual=$(shasum -a 256 "$work/$name" | awk '{ print tolower($1) }')
fi
[ "$actual" = "$expected" ] || fail "checksum mismatch for $name; nothing was installed"
say 'checksum matches'

case "$os" in
  Darwin)
    mount="$work/mount"
    mkdir -p "$mount" "$HOME/Applications"
    hdiutil attach -nobrowse -quiet -mountpoint "$mount" "$work/$name"
    rm -rf "$HOME/Applications/Episteme.app"
    cp -R "$mount/Episteme.app" "$HOME/Applications/"
    hdiutil detach -quiet "$mount"
    program="$HOME/Applications/Episteme.app"
    say "installed to $program"
    ;;
  Linux)
    bin="$HOME/.local/bin"
    mkdir -p "$bin" "$HOME/.local/share/applications"
    install -m 0755 "$work/$name" "$bin/episteme"
    cat >"$HOME/.local/share/applications/episteme.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Episteme
Exec=$bin/episteme
Categories=Education;
EOF
    program="$bin/episteme"
    say "installed to $program"
    ;;
esac

connected=no
case ",${EPISTEME_CONNECT:-}," in
  *,claude,*)
    connected=yes
    if command -v claude >/dev/null 2>&1; then
      claude mcp add --transport http --scope user episteme "$mcp" && say 'connected Claude Code'
    else
      say 'Claude Code (claude) is not on PATH; skipped'
    fi
    ;;
esac
case ",${EPISTEME_CONNECT:-}," in
  *,codex,*)
    connected=yes
    if command -v codex >/dev/null 2>&1; then
      codex mcp add episteme --url "$mcp" && say 'connected Codex'
    else
      say 'Codex (codex) is not on PATH; skipped'
    fi
    ;;
esac
if [ "$connected" = no ]; then
  say "to connect an agent later, open the program's 接入 Agent page, or run:"
  printf '  claude mcp add --transport http --scope user episteme %s\n' "$mcp"
  printf '  codex mcp add episteme --url %s\n' "$mcp"
fi

case "$os" in
  Darwin) open "$program" ;;
  Linux) (nohup "$program" >/dev/null 2>&1 &) ;;
esac
say 'started Episteme'
