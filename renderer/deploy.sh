#!/usr/bin/env bash
set -euo pipefail
: "${GITHUB_SHA:?verified release SHA required}"
project=same-page-clyapps
region=us-central1
service=same-page-renderer
image="$region-docker.pkg.dev/$project/same-page-renderer/renderer:$GITHUB_SHA"
docker load --input renderer/image.tar
gcloud auth configure-docker "$region-docker.pkg.dev" --quiet
docker tag same-page-renderer:verify "$image"
docker push "$image"
digest="$(gcloud artifacts docker images describe "$image" --project "$project" --format='value(image_summary.digest)')"
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
gcloud run deploy "$service" --project "$project" --region "$region" \
  --image "$region-docker.pkg.dev/$project/same-page-renderer/renderer@$digest" \
  --service-account "same-page-renderer@$project.iam.gserviceaccount.com" \
  --cpu 1 --memory 1Gi --concurrency 1 --min 0 --max 1 \
  --allow-unauthenticated --timeout 180 --cpu-throttling --no-cpu-boost --execution-environment gen2 \
  --set-env-vars "RENDERER_BUILD_ID=$GITHUB_SHA" \
  --set-secrets PDF_RENDERER_SECRET=same-page-renderer-signing:1 \
  --quiet
url="$(gcloud run services describe "$service" --project "$project" --region "$region" --format='value(status.url)')"
PDF_RENDERER_URL="$url" node renderer/probe.mjs "$GITHUB_SHA"
