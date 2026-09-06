#!/usr/bin/env bash
# One-time Same Page infrastructure. No credentials are generated or printed here.
set -euo pipefail
project=same-page-clyapps
region=us-central1
number="$(gcloud projects describe "$project" --format='value(projectNumber)')"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project "$project" --quiet
for account in same-page-renderer same-page-deployer; do
  gcloud iam service-accounts describe "$account@$project.iam.gserviceaccount.com" --project "$project" >/dev/null 2>&1 || \
    gcloud iam service-accounts create "$account" --project "$project" --display-name "$account" --quiet
done
gcloud artifacts repositories describe same-page-renderer --location "$region" --project "$project" >/dev/null 2>&1 || \
  gcloud artifacts repositories create same-page-renderer --location "$region" --project "$project" --repository-format docker --quiet
gcloud secrets describe same-page-renderer-signing --project "$project" >/dev/null 2>&1 || \
  gcloud secrets create same-page-renderer-signing --replication-policy automatic --project "$project" --quiet
gcloud secrets add-iam-policy-binding same-page-renderer-signing --project "$project" \
  --member "serviceAccount:same-page-renderer@$project.iam.gserviceaccount.com" --role roles/secretmanager.secretAccessor --quiet >/dev/null
gcloud projects add-iam-policy-binding "$project" --member "serviceAccount:same-page-deployer@$project.iam.gserviceaccount.com" --role roles/run.admin --condition=None --quiet >/dev/null
gcloud artifacts repositories add-iam-policy-binding same-page-renderer --project "$project" --location "$region" \
  --member "serviceAccount:same-page-deployer@$project.iam.gserviceaccount.com" --role roles/artifactregistry.writer --quiet >/dev/null
gcloud iam service-accounts add-iam-policy-binding "same-page-renderer@$project.iam.gserviceaccount.com" --project "$project" \
  --member "serviceAccount:same-page-deployer@$project.iam.gserviceaccount.com" --role roles/iam.serviceAccountUser --quiet >/dev/null
gcloud iam workload-identity-pools describe github-actions --project "$project" --location global >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools create github-actions --project "$project" --location global --display-name 'GitHub Actions' --quiet
gcloud iam workload-identity-pools providers describe same-page --project "$project" --location global --workload-identity-pool github-actions >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools providers create-oidc same-page --project "$project" --location global --workload-identity-pool github-actions \
    --issuer-uri https://token.actions.githubusercontent.com \
    --attribute-mapping 'google.subject=assertion.sub,attribute.repository_id=assertion.repository_id' \
    --attribute-condition "assertion.repository_id == '1351049987' && assertion.repository_owner_id == '297624398' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == 'itscly2026/same-page/.github/workflows/ci.yml@refs/heads/main'" --quiet
gcloud iam service-accounts add-iam-policy-binding "same-page-deployer@$project.iam.gserviceaccount.com" --project "$project" \
  --member "principalSet://iam.googleapis.com/projects/$number/locations/global/workloadIdentityPools/github-actions/attribute.repository_id/1351049987" \
  --role roles/iam.workloadIdentityUser --quiet >/dev/null
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo itscly2026/same-page --body "projects/$number/locations/global/workloadIdentityPools/github-actions/providers/same-page"
gh variable set GCP_DEPLOY_SERVICE_ACCOUNT --repo itscly2026/same-page --body "same-page-deployer@$project.iam.gserviceaccount.com"
