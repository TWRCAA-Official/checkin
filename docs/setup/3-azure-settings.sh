#!/usr/bin/env bash
# 第 3 段：回到 Azure Cloud Shell，填好第 2 段印出的兩個值再整段貼上。
# 工作人員密碼 STAFF_PIN 是機密，不寫在這裡：最後一步會請你在畫面上輸入（不會顯示、不會留在指令記錄裡）。
set -euo pipefail

RG='內部系統'
APP='checkin-api'
GOOGLE_SERVICE_ACCOUNT='請填：第 2 段印出的 GOOGLE_SERVICE_ACCOUNT'
GOOGLE_WIF_AUDIENCE='請填：第 2 段印出的 GOOGLE_WIF_AUDIENCE'

case "$GOOGLE_SERVICE_ACCOUNT$GOOGLE_WIF_AUDIENCE" in *請填*) echo '請先填好開頭的值' >&2; exit 1;; esac

az webapp config appsettings set --resource-group "$RG" --name "$APP" -o none --settings \
  GOOGLE_SERVICE_ACCOUNT="$GOOGLE_SERVICE_ACCOUNT" \
  GOOGLE_WIF_AUDIENCE="$GOOGLE_WIF_AUDIENCE"

read -rsp '請輸入工作人員密碼（跟試算表選單設定的一樣，輸入時不會顯示）：' STAFF_PIN; echo
[ -n "$STAFF_PIN" ] || { echo '密碼是空的，沒有設定' >&2; exit 1; }
az webapp config appsettings set --resource-group "$RG" --name "$APP" -o none --settings STAFF_PIN="$STAFF_PIN"
unset STAFF_PIN

echo '完成。跟 Claude 說一聲，接下來由 Claude 設定 GitHub 並部署。'
