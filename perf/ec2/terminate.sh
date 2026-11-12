#!/bin/bash
# Terminates the load generator launched by launch.sh.
set -euo pipefail
export AWS_REGION=${AWS_REGION:-eu-central-1}
HERE="$(cd "$(dirname "$0")" && pwd)"
INSTANCE_ID=${1:-$(cat "$HERE/.instance-id")}
aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --query 'TerminatingInstances[0].CurrentState.Name' --output text
rm -f "$HERE/.instance-id" "$HERE/.instance-ip"
