#!/usr/bin/env bash
# Self-managed CA + server certificate for Valkey TLS (MODE=tls). Usage: TLS_SANS="IP:1.2.3.4,DNS:valkey.x" gen-certs.sh <dir>
# Writes ca.key (keep private; only needed to issue new certificates), ca.crt (give to the app), server.key, server.crt.
# Validity: CA 10 years, server 825 days. Renewal: delete server.* and re-run the installer (same CA, app unchanged).
set -euo pipefail
dir="${1:?target directory}"
sans="${TLS_SANS:?set TLS_SANS, e.g. IP:203.0.113.7,DNS:valkey.veetrax.internal}"
mkdir -p "$dir"
cd "$dir"
if [[ ! -s ca.key ]]; then
  openssl genrsa -out ca.key 4096 2>/dev/null
  openssl req -x509 -new -key ca.key -sha256 -days 3650 -subj "/O=VeeTrax/CN=VeeTrax Valkey CA" -out ca.crt
fi
openssl genrsa -out server.key 2048 2>/dev/null
openssl req -new -key server.key -subj "/O=VeeTrax/CN=valkey" -out server.csr
printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n' "$sans" >server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 -sha256 -extfile server.ext -out server.crt 2>/dev/null
rm -f server.csr server.ext
openssl verify -CAfile ca.crt server.crt
