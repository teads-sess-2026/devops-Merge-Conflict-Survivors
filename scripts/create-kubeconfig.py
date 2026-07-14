#!/usr/bin/env python3
import os
import subprocess

cluster_name = os.environ['EKS_CLUSTER']
region = os.environ['AWS_REGION']

# Get cluster info
endpoint_cmd = f"aws eks describe-cluster --name {cluster_name} --region {region} --query 'cluster.endpoint' --output text"
ca_cmd = f"aws eks describe-cluster --name {cluster_name} --region {region} --query 'cluster.certificateAuthority.data' --output text"
token_cmd = f"aws eks get-token --cluster-name {cluster_name} --region {region} --query 'status.token' --output text"

endpoint = subprocess.check_output(endpoint_cmd, shell=True).decode().strip()
ca = subprocess.check_output(ca_cmd, shell=True).decode().strip()
token = subprocess.check_output(token_cmd, shell=True).decode().strip()

# Create kubeconfig YAML
kubeconfig = f"""apiVersion: v1
kind: Config
clusters:
- name: eks-cluster
  cluster:
    server: {endpoint}
    certificate-authority-data: {ca}
contexts:
- name: eks-cluster
  context:
    cluster: eks-cluster
    user: eks-cluster
current-context: eks-cluster
users:
- name: eks-cluster
  user:
    token: {token}
"""

os.makedirs(os.path.expanduser("~/.kube"), exist_ok=True)
with open(os.path.expanduser("~/.kube/config"), "w") as f:
    f.write(kubeconfig)

print("Kubeconfig created successfully")
