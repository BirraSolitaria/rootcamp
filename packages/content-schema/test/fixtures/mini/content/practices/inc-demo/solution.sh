#!/bin/sh
set -eu
chmod 755 /srv/demo
touch /srv/demo/report.txt
nohup sh -c 'exec -a demo-service sleep 3600' >/dev/null 2>&1 &
