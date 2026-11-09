# Throwaway Ubuntu 24.04 "VM" with systemd, for testing ops/valkey end to end (kit-e2e.sh). Not for production.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq systemd systemd-sysv openssh-server sudo iproute2 iptables kmod >/dev/null \
 && apt-get clean && rm -rf /var/lib/apt/lists/* \
 && systemctl mask systemd-logind getty.target console-getty.service \
 && systemctl enable ssh
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
