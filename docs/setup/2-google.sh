#!/usr/bin/env bash
# 第 2 段：Google Cloud（在 console.cloud.google.com 右上角的 Cloud Shell「>_」執行）
# 用法：PROJECT_ID=… MI_PRINCIPAL_ID=… WIF_APP_ID=… bash 2-google.sh（或直接改下面的預設值）
# 建立服務帳號 checkin-sheets（不建立金鑰）與 Workload Identity Federation，
# 只允許 Azure 上的 twrcaa-checkin-api 以這個服務帳號身分存取試算表。
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-請填：Google Cloud 專案 ID}"            # 例如協會現有的專案，或新開的 twpride-checkin
MI_PRINCIPAL_ID="${MI_PRINCIPAL_ID:-請填：第 1 段印出的 MI_PRINCIPAL_ID}"
WIF_APP_ID="${WIF_APP_ID:-請填：第 1 段印出的 WIF_APP_ID}"
TENANT='dd841ca6-6d49-4e6e-997a-bf9b4813878d'

POOL='azure-checkin'
PROVIDER='azure-checkin'
SA_NAME='checkin-sheets'

case "$PROJECT_ID$MI_PRINCIPAL_ID$WIF_APP_ID" in *請填*) echo '請先填好開頭的值' >&2; exit 1;; esac

gcloud config set project "$PROJECT_ID"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
SA_EMAIL="$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"

echo '== 啟用 API'
gcloud services enable sheets.googleapis.com iamcredentials.googleapis.com sts.googleapis.com iam.googleapis.com

echo '== 服務帳號（不建立金鑰）'
gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$SA_NAME" --display-name='團體報到 API（Azure twrcaa-checkin-api 使用）'

echo '== Workload Identity 集區與提供者'
gcloud iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools create "$POOL" --location=global --display-name='Azure twrcaa-checkin-api'
gcloud iam workload-identity-pools providers describe "$PROVIDER" --location=global --workload-identity-pool="$POOL" >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --location=global --workload-identity-pool="$POOL" \
    --issuer-uri="https://sts.windows.net/$TENANT" \
    --allowed-audiences="api://$WIF_APP_ID" \
    --attribute-mapping='google.subject=assertion.sub' \
    --attribute-condition="assertion.sub == '$MI_PRINCIPAL_ID'"

echo '== 授權 Azure twrcaa-checkin-api 使用服務帳號'
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --role='roles/iam.workloadIdentityUser' \
  --member="principal://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/subject/$MI_PRINCIPAL_ID" \
  --format=none

cat <<EOF

========== 完成，請把下面整段貼給 Claude ==========
GCP_PROJECT_ID=$PROJECT_ID
GCP_PROJECT_NUMBER=$PROJECT_NUMBER
GOOGLE_SERVICE_ACCOUNT=$SA_EMAIL
GOOGLE_WIF_AUDIENCE=//iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER
==================================================
接下來（手動）：打開報到試算表 → 共用 → 貼上 $SA_EMAIL → 權限「編輯者」。
然後回 Azure Cloud Shell 跑第 3 段（3-azure-settings.sh）。
EOF
