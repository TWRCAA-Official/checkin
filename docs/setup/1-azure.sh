#!/usr/bin/env bash
# 第 1 段：Azure（在 Azure 入口網站右上角的 Cloud Shell「>_」選 Bash，整段貼上執行）
# 建立 Web App twrcaa-checkin-api（放在現有的 ASP-Staging 方案）、開啟 Managed Identity，
# 以及兩個 Entra app registration（Google 驗證用、GitHub 部署用）。
# 這裡沒有任何機密；跑完會印出第 2、3 段要用的值。
set -euo pipefail

RG='內部系統'
PLAN='ASP-Staging'
APP="${APP:-twrcaa-checkin-api}"   # Web App 名稱要全球唯一；checkin-api 已被別人使用
TENANT='dd841ca6-6d49-4e6e-997a-bf9b4813878d'
SUBSCRIPTION='b66057ec-8fa1-4990-9b38-56a86ada5e63'
GITHUB_SUBJECT='repo:TWRCAA-Official@261663519/checkin@1408825837:environment:production'

az account set --subscription "$SUBSCRIPTION"

echo '== Web App'
PLAN_ID=$(az appservice plan list --query "[?name=='$PLAN'].id | [0]" -o tsv)
[ -n "$PLAN_ID" ] || { echo "找不到 App Service 方案 $PLAN" >&2; exit 1; }
az webapp create --resource-group "$RG" --plan "$PLAN_ID" --name "$APP" --runtime 'NODE:24-lts' -o none
az webapp update --resource-group "$RG" --name "$APP" --https-only true -o none
az webapp config set --resource-group "$RG" --name "$APP" --always-on true --min-tls-version 1.2 --ftps-state Disabled --http20-enabled true -o none
for kind in scm ftp; do
  az resource update --resource-group "$RG" --namespace Microsoft.Web --resource-type basicPublishingCredentialsPolicies \
    --parent "sites/$APP" --name "$kind" --set properties.allow=false -o none
done
az webapp config set --resource-group "$RG" --name "$APP" --generic-configurations '{"healthCheckPath": "/health"}' -o none
WEBAPP_ID=$(az webapp show --resource-group "$RG" --name "$APP" --query id -o tsv)
HOST=$(az webapp show --resource-group "$RG" --name "$APP" --query defaultHostName -o tsv)

echo '== Managed Identity'
MI_PRINCIPAL_ID=$(az webapp identity assign --resource-group "$RG" --name "$APP" --query principalId -o tsv)

echo '== Entra：Google 驗證用（checkin-google-wif）'
WIF_APP_ID=$(az ad app create --display-name 'checkin-google-wif' --sign-in-audience AzureADMyOrg --query appId -o tsv)
az ad app update --id "$WIF_APP_ID" --identifier-uris "api://$WIF_APP_ID"
az ad sp create --id "$WIF_APP_ID" -o none 2>/dev/null || true

echo '== Entra：GitHub 部署用（github-checkin-deploy）'
DEPLOY_APP_ID=$(az ad app create --display-name 'github-checkin-deploy' --sign-in-audience AzureADMyOrg --query appId -o tsv)
DEPLOY_SP_OBJECT_ID=$(az ad sp create --id "$DEPLOY_APP_ID" --query id -o tsv 2>/dev/null || az ad sp show --id "$DEPLOY_APP_ID" --query id -o tsv)
az ad app federated-credential create --id "$DEPLOY_APP_ID" --parameters "{
  \"name\": \"github-production\",
  \"issuer\": \"https://token.actions.githubusercontent.com\",
  \"subject\": \"$GITHUB_SUBJECT\",
  \"audiences\": [\"api://AzureADTokenExchange\"]
}" -o none
# 新建的服務主體有時要幾秒才查得到，失敗就重試
for i in 1 2 3 4 5 6; do
  az role assignment create --assignee-object-id "$DEPLOY_SP_OBJECT_ID" --assignee-principal-type ServicePrincipal \
    --role 'Website Contributor' --scope "$WEBAPP_ID" -o none && break
  sleep 10
done

echo '== 不是機密的應用程式設定'
az webapp config appsettings set --resource-group "$RG" --name "$APP" -o none --settings \
  SPREADSHEET_ID='1Y5RcuDjTv0x2gAZm0PadwdnsFEQqKfJfmFo4EaKYKmk' \
  AZURE_TOKEN_RESOURCE="api://$WIF_APP_ID" \
  ALLOWED_ORIGINS='https://event.taiwanpride.lgbt' \
  SCANNER_URL='https://event.taiwanpride.lgbt/2026/checkin/scan/' \
  SCM_DO_BUILD_DURING_DEPLOYMENT='false'

cat <<EOF

========== 完成，請把下面整段貼給 Claude，並抄進 docs/azure-setup.md 的記錄表格 ==========
MI_PRINCIPAL_ID=$MI_PRINCIPAL_ID
WIF_APP_ID=$WIF_APP_ID
DEPLOY_APP_ID=$DEPLOY_APP_ID
DEPLOY_SP_OBJECT_ID=$DEPLOY_SP_OBJECT_ID
WEBAPP_HOST=$HOST
==========================================================================================
接下來：到 Google Cloud Shell 跑第 2 段（2-google.sh），開頭填入上面的 MI_PRINCIPAL_ID 和 WIF_APP_ID。
EOF
