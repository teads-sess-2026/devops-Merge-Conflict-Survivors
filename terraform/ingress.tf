# Traefik is deployed via FluxCD HelmRelease in k8s/traefik/
# See k8s/traefik/traefik-release.yaml
#
# After flux reconciles, get the ELB hostname with:
# kubectl get svc -n traefik traefik -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
# Then add *.eks.domainname.eu -> CNAME -> <that hostname> in Cloudflare
