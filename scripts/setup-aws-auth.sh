#!/bin/bash
set -e

CLUSTER_NAME=$1
GITHUB_ROLE_ARN=$2
REGION="eu-west-1"

echo "Setting up aws-auth ConfigMap..."

# Get current aws-auth or create template
CURRENT_AUTH=$(kubectl get configmap aws-auth -n kube-system -o json 2>/dev/null || echo "{}")

if [ "$CURRENT_AUTH" = "{}" ]; then
  echo "Creating new aws-auth ConfigMap..."
  cat > /tmp/aws-auth.json <<EOF
{
  "apiVersion": "v1",
  "kind": "ConfigMap",
  "metadata": {
    "name": "aws-auth",
    "namespace": "kube-system"
  },
  "data": {
    "mapRoles": "- rolearn: arn:aws:iam::937697200280:role/eks-node-role-merge-conflict-survivors\n  username: system:node:{{EC2PrivateDNSName}}\n  groups:\n    - system:bootstrappers\n    - system:nodes\n",
    "mapUsers": "- userarn: $GITHUB_ROLE_ARN\n  username: github-actions\n  groups:\n    - system:masters\n"
  }
}
EOF
  kubectl apply -f /tmp/aws-auth.json
else
  echo "Updating existing aws-auth ConfigMap..."
  # Add github-actions-role if not already there
  kubectl patch configmap aws-auth -n kube-system --type merge -p "{\"data\":{\"mapUsers\":\"- userarn: $GITHUB_ROLE_ARN\n  username: github-actions\n  groups:\n    - system:masters\n\"}}" || true
fi

echo "aws-auth ConfigMap is ready"
