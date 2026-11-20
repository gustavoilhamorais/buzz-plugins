#!/bin/sh
# Launcher Buzz Desktop discovers as ~/.local/bin/buzz-backend-chatsdk (a symlink here).
# The Desktop runs a staged copy of this file, so it uses absolute paths only.
NODE="${BUZZ_CHATSDK_NODE:-$HOME/.local/bin/node}"
[ -x "$NODE" ] || NODE="$(command -v node)"
PACKAGE="${BUZZ_CHATSDK_HOME:-$HOME/Documents/dev/buzz-plugins/chat-adapter-buzz}"
BUZZ_CHATSDK_NODE="$NODE" exec "$NODE" "$PACKAGE/provider/buzz-backend-chatsdk.mjs" "$@"
