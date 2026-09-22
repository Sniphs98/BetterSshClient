# Disposable SSH server for exercising BetterSshClient against a real sshd — locally and in
# the electron package's integration tests (`npm run test:integration`) — without
# risking a real machine. See README.md in this directory. Never for production use:
# password auth is on and the credentials are fixed and public (they're right here).
FROM alpine:3.20

RUN apk add --no-cache openssh sudo bash \
    && ssh-keygen -A \
    && adduser -D -s /bin/bash better-ssh-client \
    && echo 'better-ssh-client:better-ssh-client' | chpasswd \
    && mkdir -p /home/better-ssh-client/.ssh \
    && chmod 700 /home/better-ssh-client/.ssh \
    && echo 'better-ssh-client ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/better-ssh-client \
    && chmod 440 /etc/sudoers.d/better-ssh-client \
    # A couple of sample files so the SFTP browser and the Monaco file editor have
    # something to show without the tester having to create fixtures by hand.
    && mkdir -p /home/better-ssh-client/www \
    && echo 'server { listen 80; }' > /home/better-ssh-client/www/nginx.conf \
    && printf 'db:\n  host: localhost\n  port: 5432\n' > /home/better-ssh-client/config.yml \
    && chown -R better-ssh-client:better-ssh-client /home/better-ssh-client

# `buildReloadSshdCommand`/`buildRollbackCommand` (packages/electron/src/core/ssh/
# session.ts) shell out to `service sshd reload` on a box with no systemd — this alpine
# base has neither, so a tiny shim stands in for it (below).
COPY service /usr/sbin/service
COPY sshd_config /etc/ssh/sshd_config
RUN chmod +x /usr/sbin/service && chmod 644 /etc/ssh/sshd_config

# A broader fixture set for manually exercising the SFTP browser + Monaco editor: a
# spread of text/code file types (fileEdit.ts recognises far more than the original
# short whitelist), two files that should stay non-editable (random bytes, not real
# images/archives), a nested folder, and two filenames chosen to exercise path
# quoting (a space, and a single quote — the character shellQuote() has to escape for
# the terminal drawer's/Terminal's autocd). See testfiles/readme.txt for the why.
# These are separate from /etc/ssh/sshd_config etc. above — samples only, not wired
# into anything real on this container.
COPY --chown=better-ssh-client:better-ssh-client testfiles /home/better-ssh-client/testfiles/
RUN dd if=/dev/urandom of=/home/better-ssh-client/testfiles/photo.png bs=1024 count=4 2>/dev/null \
    && dd if=/dev/urandom of=/home/better-ssh-client/testfiles/archive.zip bs=1024 count=8 2>/dev/null \
    && yes 'INFO sample log line for exercising the SFTP preview fallback on a file over the 2 MiB edit cap' \
       | head -c 3000000 > /home/better-ssh-client/testfiles/huge.log \
    && chown -R better-ssh-client:better-ssh-client /home/better-ssh-client/testfiles

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
