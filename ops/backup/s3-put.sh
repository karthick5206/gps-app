#!/usr/bin/env bash
# Upload one backup bundle to S3 with plain curl (SigV4 signing built into curl >= 7.75; no AWS CLI needed).
#   S3_BUCKET=veetrax-backups S3_REGION=ap-south-1 S3_PREFIX=prod/ \
#   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...  bash s3-put.sh /var/backups/veetrax/veetrax-<ts>.tar.gpg
# Use from backup.conf:  UPLOAD_CMD='bash /mnt/d/Vibhav/gps-app/ops/backup/s3-put.sh {file}'
# Credentials: a dedicated IAM user limited to s3:PutObject on this bucket/prefix (ops/backup/aws/iam-backup-writer.json).
# Content-MD5 is sent because buckets with Object Lock require an integrity header on PUT; S3 rejects corrupted uploads.
set -euo pipefail
FILE="${1:?bundle file}"
: "${S3_BUCKET:?}" "${S3_REGION:=ap-south-1}" "${AWS_ACCESS_KEY_ID:?}" "${AWS_SECRET_ACCESS_KEY:?}"
KEY="${S3_PREFIX:-}$(basename "$FILE")"
MD5=$(openssl dgst -md5 -binary "$FILE" | base64)
code=$(curl -sS -o /tmp/s3-put.$$ -w '%{http_code}' --fail-with-body \
  --aws-sigv4 "aws:amz:${S3_REGION}:s3" --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" \
  -H "Content-MD5: ${MD5}" -H "x-amz-server-side-encryption: AES256" -H "x-amz-storage-class: ${S3_STORAGE_CLASS:-STANDARD}" \
  -T "$FILE" "https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${KEY}") || true
if [ "$code" != "200" ]; then echo "S3 upload failed (HTTP $code): $(head -c 300 /tmp/s3-put.$$)"; rm -f /tmp/s3-put.$$; exit 1; fi
rm -f /tmp/s3-put.$$
echo "uploaded s3://${S3_BUCKET}/${KEY}"
