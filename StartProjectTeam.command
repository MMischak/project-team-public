#!/bin/zsh
set -e
cd "${0:A:h}"

# Finder does not always inherit the Node version selected in Terminal.
if ! command -v node >/dev/null || [[ $(node -p 'Number(process.versions.node.split(".")[0])') -lt 24 ]]; then
  node_candidates=("$HOME"/.nvm/versions/node/v24*/bin(N))
  if (( ${#node_candidates} )); then
    export PATH="${node_candidates[-1]}:$PATH"
  else
    print 'Project Team needs Node 24 or newer. Install it, then start again.'
    read 'reply?Press Enter to close.'
    exit 1
  fi
fi

if [[ ! -d node_modules ]]; then
  npm ci --cache /tmp/project-team-npm-cache
fi
npm run build
npm start -- --open
