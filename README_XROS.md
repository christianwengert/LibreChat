
# skopeo
```
# Legacy filenames
docker compose --profile amd64 -f docker-compose.yml -f docker-compose.override.yml config --images | sort -u > images.txt

# Get standard images
mkdir -p exported
while read -r img; do
  out="exported/$(echo "$img" | tr '/:@' '__').tar"
  echo "==> $img  ->  $out"
  skopeo copy --override-os linux --override-arch amd64 \
    "docker://$img" "docker-archive:$out:$img"
done < images.txt

# build the local image for linux/amd64 and load into the daemon
docker buildx create --use --name xbuilder 2>/dev/null || true
docker buildx build --platform=linux/amd64 -t cyberchef-server:latest \
  /Users/christian/src/CyberChef-server --load

# then export it with skopeo from the local daemon
#skopeo copy --override-os linux --override-arch amd64 \
#  docker-daemon:cyberchef-server:latest \
#  docker-archive:exported/cyberchef-server__latest.tar:cyberchef-server:latest
docker save -o exported/cyberchef.tar cyberchef-server:latest 
```

LEGACY BELOW

#Get required images
```
docker compose --profile amd64 -f docker-compose.yml -f docker-compose.override.yml config --images > images.txt
xargs -n1 -P4 -I{} docker pull --platform=linux/amd64 {} < images.txt

# Verify what arch each tag points to locally
while read -r img; do
  printf "%-60s " "$img"
  docker inspect --format '{{.Architecture}}/{{.Os}}' "$img" 2>/dev/null | head -n1
done < images.txt
```

Local builds
```
docker buildx create --use --name xbuilder 2>/dev/null || true
docker buildx build --platform=linux/amd64 \
  -t cyberchef-server:latest /Users/christian/src/CyberChef-server --load

```

old test stuff


```
# docker compose --profile amd64 -f docker-compose.yml -f docker-compose.override.yml config --images > images.txt
```

```
xargs -n1 -P4 -I{} docker pull --platform=linux/amd64 {} < images.txt

```

```
# Rebuild any locally-built images as amd64 and load into the daemon
# Example for your override's CyberChef:
docker buildx create --use --name xbuilder 2>/dev/null || true
docker buildx use xbuilder
docker buildx build --platform=linux/amd64 -t cyberchef-server:latest /Users/christian/src/CyberChef-server --load
```


```
#docker image save --platform=linux/amd64 -o suite-amd64.tar $(cat images.txt)

```

```
# Verify what arch each tag points to locally
while read -r img; do
  printf "%-60s " "$img"
  docker inspect --format '{{.Architecture}}/{{.Os}}' "$img" 2>/dev/null | head -n1
done < images.txt

```


```
docker image save --platform=linux/amd64 -o suite-amd64.tar $(cat images.txt)

```


```
for f in exported/*.tar; do docker load -i "$f"; done
```