#!/bin/sh
set -eu
printf 'Hello %s\n' "${1:-World}"
