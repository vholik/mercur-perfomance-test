#!/bin/bash
# Launches the k6 load generator in eu-central-1, the region Medusa Cloud
# runs mercur.medusajs.app in (its CNAME is t1-aws-euc1-cdn.medusajs.app).
# Prints the public IP once the instance is reachable. Terminate it with
# perf/ec2/terminate.sh when the runs are done.
set -euo pipefail

export AWS_REGION=${AWS_REGION:-eu-central-1}
INSTANCE_TYPE=${INSTANCE_TYPE:-c6i.xlarge}
KEY_NAME=${KEY_NAME:-mercur-perf}
PUBKEY=${PUBKEY:-$HOME/.ssh/id_ed25519.pub}
NAME=mercur-perf-k6
HERE="$(cd "$(dirname "$0")" && pwd)"

aws ec2 describe-key-pairs --key-names "$KEY_NAME" >/dev/null 2>&1 ||
  aws ec2 import-key-pair --key-name "$KEY_NAME" --public-key-material "fileb://$PUBKEY" >/dev/null

VPC_ID=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
SG_ID=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$NAME Name=vpc-id,Values=$VPC_ID \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [ -z "$SG_ID" ] || [ "$SG_ID" = "None" ]; then
  SG_ID=$(aws ec2 create-security-group --group-name $NAME --description "k6 load generator" \
    --vpc-id "$VPC_ID" --query GroupId --output text)
  MY_IP=$(curl -s https://checkip.amazonaws.com)
  aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 22 --cidr "$MY_IP/32" >/dev/null
fi

AMI=$(aws ssm get-parameter \
  --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query Parameter.Value --output text)

INSTANCE_ID=$(aws ec2 run-instances \
  --image-id "$AMI" --instance-type "$INSTANCE_TYPE" --key-name "$KEY_NAME" \
  --security-group-ids "$SG_ID" --user-data "file://$HERE/user-data.sh" \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":20,"VolumeType":"gp3"}}]' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
  --query 'Instances[0].InstanceId' --output text)
echo "instance $INSTANCE_ID"
echo "$INSTANCE_ID" > "$HERE/.instance-id"

aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
IP=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "$IP" > "$HERE/.instance-ip"
echo "public ip $IP"
echo "ssh ubuntu@$IP   (k6 is ready when /home/ubuntu/READY exists)"
