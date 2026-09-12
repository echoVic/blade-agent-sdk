#!/bin/sh
set -eu
actual=$(sh src/greeting.sh Blade)
if [ "$actual" != 'Hello, Blade!' ]; then
  printf 'FAIL greeting: expected Hello, Blade!; got %s\n' "$actual"
  exit 1
fi
printf 'PASS greeting: Hello, Blade!\n'
actual=$(sh src/greeting.sh)
if [ "$actual" != 'Hello, World!' ]; then
  printf 'FAIL default greeting: expected Hello, World!; got %s\n' "$actual"
  exit 1
fi
printf 'PASS default greeting: Hello, World!\n'
