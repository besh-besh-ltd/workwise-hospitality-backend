#!/bin/bash
set -euo pipefail

# ============================================================
# Blue-Green Deployment Script for Backend Docker containers
# Usage: ./deploy.sh <docker-image-uri> <env-file-path>
# ============================================================

IMAGE="$1"
ENV_FILE="$2"
NGINX_CONF="/etc/nginx/conf.d/backend.conf"

BLUE_CONTAINER="backend-blue"
GREEN_CONTAINER="backend-green"
BLUE_PORT=8000
GREEN_PORT=8001
INTERNAL_PORT=8002

HEALTH_TIMEOUT=90
HEALTH_INTERVAL=3

# ── Determine current active container ──────────────────────

get_active_port() {
  if [ -f "$NGINX_CONF" ]; then
    grep -oP 'server 127\.0\.0\.1:\K[0-9]+' "$NGINX_CONF" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

ACTIVE_PORT=$(get_active_port)

if [ "$ACTIVE_PORT" = "$BLUE_PORT" ]; then
  NEW_CONTAINER="$GREEN_CONTAINER"
  NEW_PORT="$GREEN_PORT"
  OLD_CONTAINER="$BLUE_CONTAINER"
  echo ">> Active: blue (:$BLUE_PORT) → Deploying: green (:$GREEN_PORT)"
elif [ "$ACTIVE_PORT" = "$GREEN_PORT" ]; then
  NEW_CONTAINER="$BLUE_CONTAINER"
  NEW_PORT="$BLUE_PORT"
  OLD_CONTAINER="$GREEN_CONTAINER"
  echo ">> Active: green (:$GREEN_PORT) → Deploying: blue (:$BLUE_PORT)"
else
  # First deploy — no active container
  NEW_CONTAINER="$BLUE_CONTAINER"
  NEW_PORT="$BLUE_PORT"
  OLD_CONTAINER=""
  echo ">> First deploy → Starting: blue (:$BLUE_PORT)"
fi

# ── Stop the new container if it exists from a previous failed deploy ──

if docker ps -a --format '{{.Names}}' | grep -q "^${NEW_CONTAINER}$"; then
  echo ">> Cleaning up existing $NEW_CONTAINER container"
  docker stop "$NEW_CONTAINER" 2>/dev/null || true
  docker rm "$NEW_CONTAINER" 2>/dev/null || true
fi

# ── Start new container ─────────────────────────────────────

echo ">> Starting $NEW_CONTAINER on port $NEW_PORT"
docker run -d \
  --name "$NEW_CONTAINER" \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  --stop-timeout=20 \
  --memory=1g \
  -p "127.0.0.1:${NEW_PORT}:${INTERNAL_PORT}" \
  "$IMAGE"

# ── Health check ────────────────────────────────────────────

echo ">> Waiting for health check on port $NEW_PORT..."
ELAPSED=0
HEALTHY=false

while [ $ELAPSED -lt $HEALTH_TIMEOUT ]; do
  RESPONSE=$(curl -sf "http://127.0.0.1:${NEW_PORT}/api/health" 2>/dev/null || echo "")
  if echo "$RESPONSE" | grep -q '"status":"ok"'; then
    HEALTHY=true
    break
  fi
  sleep $HEALTH_INTERVAL
  ELAPSED=$((ELAPSED + HEALTH_INTERVAL))
  echo "   ...waiting ($ELAPSED/${HEALTH_TIMEOUT}s)"
done

if [ "$HEALTHY" = false ]; then
  echo ">> HEALTH CHECK FAILED after ${HEALTH_TIMEOUT}s — rolling back"
  docker logs "$NEW_CONTAINER" --tail 50
  docker stop "$NEW_CONTAINER" 2>/dev/null || true
  docker rm "$NEW_CONTAINER" 2>/dev/null || true
  exit 1
fi

echo ">> Health check passed"

# ── Switch nginx upstream ───────────────────────────────────

echo ">> Updating nginx to route traffic to port $NEW_PORT"
sudo sed -i "s/server 127\.0\.0\.1:[0-9]*/server 127.0.0.1:${NEW_PORT}/" "$NGINX_CONF"
sudo nginx -t && sudo nginx -s reload

echo ">> Nginx reloaded — traffic now on port $NEW_PORT"

# ── Stop old container ──────────────────────────────────────

if [ -n "$OLD_CONTAINER" ]; then
  if docker ps --format '{{.Names}}' | grep -q "^${OLD_CONTAINER}$"; then
    echo ">> Stopping old container: $OLD_CONTAINER"
    # Give nginx time to drain connections
    sleep 5
    docker stop --time=20 "$OLD_CONTAINER" 2>/dev/null || true
    docker rm "$OLD_CONTAINER" 2>/dev/null || true
  fi
fi

# ── Cleanup old images ──────────────────────────────────────

echo ">> Cleaning up unused Docker images"
docker image prune -f 2>/dev/null || true

echo "============================================================"
echo "  Deployment complete"
echo "  Container: $NEW_CONTAINER"
echo "  Port:      $NEW_PORT"
echo "  Image:     $IMAGE"
echo "============================================================"
