# Disposable SSH server for exercising OmnySSH against a real sshd — locally and in
# the electron package's integration tests (`npm run test:integration`) — without
# risking a real machine. See README.md in this directory. Never for production use:
# password auth is on and the credentials are fixed and public (they're right here).
FROM alpine:3.20

RUN apk add --no-cache openssh sudo bash \
    && ssh-keygen -A \
    && adduser -D -s /bin/bash omnyssh \
    && echo 'omnyssh:omnyssh' | chpasswd \
    && mkdir -p /home/omnyssh/.ssh \
    && chmod 700 /home/omnyssh/.ssh \
    && echo 'omnyssh ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/omnyssh \
    && chmod 440 /etc/sudoers.d/omnyssh \
    # A couple of sample files so the SFTP browser and the Monaco file editor have
    # something to show without the tester having to create fixtures by hand.
    && mkdir -p /home/omnyssh/www \
    && echo 'server { listen 80; }' > /home/omnyssh/www/nginx.conf \
    && printf 'db:\n  host: localhost\n  port: 5432\n' > /home/omnyssh/config.yml \
    && chown -R omnyssh:omnyssh /home/omnyssh

# `buildReloadSshdCommand`/`buildRollbackCommand` (packages/electron/src/core/ssh/
# session.ts) shell out to `service sshd reload` on a box with no systemd — this alpine
# base has neither, so a tiny shim stands in for it (below).
COPY service /usr/sbin/service
COPY sshd_config /etc/ssh/sshd_config
RUN chmod +x /usr/sbin/service && chmod 644 /etc/ssh/sshd_config

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
