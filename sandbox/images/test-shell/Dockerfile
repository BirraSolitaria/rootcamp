# syntax=docker/dockerfile:1
# rc/test-shell: the only image under SANDBOX_DRIVER=runc-dev (dev, e2e, sandboxd tests).
# Build context is sandbox/images (it needs common/):
#   docker build -t rc/test-shell -f sandbox/images/test-shell/Dockerfile sandbox/images
ARG ALPINE_IMAGE=alpine:3.22
FROM ${ALPINE_IMAGE}
# coreutils: GNU `timeout --kill-after`; ncurses: tput and terminfo; tini: PID 1 that
# forwards SIGTERM, so `docker stop -t 10` does not wait the full 10 s.
RUN apk add --no-cache bash coreutils curl ncurses ncurses-terminfo-base procps tini tmux
COPY common/tmux.conf /etc/tmux.conf
ENV LANG=C.UTF-8
WORKDIR /root
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sleep", "infinity"]
