# 報到 API 設定步驟（Azure App Service ＋ Google 免金鑰）

API 程式在 `api/`，部署流程在 `.github/workflows/deploy-api.yml`。照下面順序做，每一步做完把「記下」的值填進最後的表格。

整體架構：

```
GitHub Pages（團體頁、掃描頁）
   │  POST JSON
   ▼
Azure App Service checkin-api（Node 24，Always On）
   │  Managed Identity 取得 Entra token
   ▼
Google STS（Workload Identity Federation）→ 模擬服務帳號 checkin-sheets
   │  Sheets API
   ▼
Google 試算表「報到名單」（只分享給服務帳號，沒有金鑰檔）
```

## 1. Azure：建立 Web App

Azure 入口網站 →「建立資源」→「Web 應用程式」：

| 欄位 | 值 |
|---|---|
| 資源群組 | `內部系統` |
| 名稱 | `checkin-api` |
| 發佈 | 程式碼 |
| 執行階段堆疊 | Node 24 LTS |
| 作業系統 | Linux |
| 區域 | West US 3（要跟 `ASP-Staging` 同區） |
| Linux 方案 | `ASP-Staging`（現有的基本 B1，不會多收費） |

建立後：

1. **設定 → 一般設定**：Always On「開啟」、僅限 HTTPS「開啟」、最低 TLS 1.2、SCM 與 FTP 基本驗證「關閉」。啟動命令留空（預設 `npm start`）。
2. **身分識別 → 系統指派**：狀態「開啟」→ 儲存。**記下「物件（主體）識別碼」** → 表格的 `MI_PRINCIPAL_ID`。
3. **監視 → 健康情況檢查**：路徑填 `/health`（可選，App Service 會自動把不健康的執行個體重啟）。
4. 應用程式設定等第 5 步再填。

## 2. Entra：給 Google 驗證用的 app registration

Managed Identity 要「指定對象」才能取得 token，這個 app registration 就是那個對象，不需要 secret。

1. Entra 管理中心 → 應用程式註冊 → 新增註冊：名稱 `checkin-google-wif`，單一租用戶，不用重新導向 URI。
2. **記下「應用程式（用戶端）識別碼」** → 表格的 `WIF_APP_ID`。
3. **公開 API** →「應用程式識別碼 URI」→ 新增 → 用預設的 `api://<WIF_APP_ID>` → 儲存。不需要新增範圍。

## 3. Google Cloud：服務帳號與 Workload Identity Federation

可以用協會現有的 Google Cloud 專案（Google 登入那個），或新開一個（例如 `twpride-checkin`）。

1. **記下專案編號**（數字，在專案資訊卡上）→ 表格的 `GCP_PROJECT_NUMBER`；專案 ID → `GCP_PROJECT_ID`。
2. **API 和服務 → 啟用**：Google Sheets API、IAM Service Account Credentials API、Security Token Service API。
3. **IAM 與管理 → 服務帳號 → 建立**：名稱 `checkin-sheets`，不給任何角色，**不要建立金鑰**。信箱是 `checkin-sheets@<GCP_PROJECT_ID>.iam.gserviceaccount.com`。
4. **IAM 與管理 → Workload Identity Federation → 建立集區**：
   - 集區 ID：`azure-checkin`
   - 提供者：OpenID Connect（OIDC），提供者 ID `azure-checkin`
   - 核發者（Issuer）URL：`https://sts.windows.net/dd841ca6-6d49-4e6e-997a-bf9b4813878d`（依 Google 官方文件，結尾不加斜線）
   - 目標對象：選「允許的目標對象」，填 `api://<WIF_APP_ID>`
   - 屬性對應：`google.subject` = `assertion.sub`
   - 屬性條件：`assertion.sub == "<MI_PRINCIPAL_ID>"`（只允許這台 App Service）
5. **授權 App Service 使用服務帳號**：服務帳號 `checkin-sheets` → 權限 → 授予存取權：
   - 主體：`principal://iam.googleapis.com/projects/<GCP_PROJECT_NUMBER>/locations/global/workloadIdentityPools/azure-checkin/subject/<MI_PRINCIPAL_ID>`
   - 角色：「Workload Identity 使用者」（`roles/iam.workloadIdentityUser`）
6. **把報到試算表分享給服務帳號**：試算表 → 共用 → 貼上服務帳號信箱 → 編輯者。

可能遇到的阻擋：Workspace 若限制對外分享，第 6 步會無法分享給 `iam.gserviceaccount.com`；組織政策若限制 IAM 成員網域，第 5 步可能失敗。這兩種都需要 Workspace／Google Cloud 管理員放行。

## 4. Entra：給 GitHub Actions 部署用的 app registration

做法跟 `github-management-web-deploy` 一樣（見 infra 的 `docs/resources.md`）。

1. 新增註冊：名稱 `github-checkin-deploy`，單一租用戶。**記下應用程式（用戶端）識別碼** → `DEPLOY_APP_ID`，以及服務主體的物件識別碼（「企業應用程式」裡同名項目的物件識別碼）→ `DEPLOY_SP_OBJECT_ID`。
2. **憑證與秘密 → 同盟認證 → 新增**，情境選「其他簽發者」：
   - 簽發者：`https://token.actions.githubusercontent.com`
   - 主體識別碼：`repo:TWRCAA-Official@261663519/checkin@1408825837:environment:production`
   - 對象：`api://AzureADTokenExchange`
   - 名稱：`github-production`

   這是 GitHub 的 immutable subject 格式，跟協會其他 repo 一致。若第一次部署失敗、錯誤訊息出現 `No matching federated identity record found for presented assertion subject '...'`，把引號裡的值改填到主體識別碼即可。
3. **指派角色**（入口網站搜尋不到這類服務主體，用 Cloud Shell）：

   ```bash
   az role assignment create \
     --assignee-object-id <DEPLOY_SP_OBJECT_ID> --assignee-principal-type ServicePrincipal \
     --role "Website Contributor" \
     --scope "$(az webapp show --name checkin-api --resource-group 內部系統 --query id -o tsv)"
   ```

4. **GitHub**：`TWRCAA-Official/checkin` → Settings → Environments → 新增 `production`（部署時的 OIDC 主體會帶這個名稱）。接著到 Settings → Secrets and variables → Actions → **Variables**（repo 層級）新增下列變數；這些都不是機密。還沒設定時，推上 main 只會跑測試、不會部署。

   | 名稱 | 值 |
   |---|---|
   | `AZURE_CLIENT_ID` | `<DEPLOY_APP_ID>` |
   | `AZURE_TENANT_ID` | `dd841ca6-6d49-4e6e-997a-bf9b4813878d` |
   | `AZURE_SUBSCRIPTION_ID` | `b66057ec-8fa1-4990-9b38-56a86ada5e63` |
   | `AZURE_WEBAPP_NAME` | `checkin-api` |

## 5. App Service 應用程式設定

Web App → 設定 → 環境變數 → 應用程式設定：

| 名稱 | 值 |
|---|---|
| `SPREADSHEET_ID` | `1Y5RcuDjTv0x2gAZm0PadwdnsFEQqKfJfmFo4EaKYKmk` |
| `STAFF_PIN` | 工作人員密碼（跟試算表選單設定的一樣；**機密**，只放這裡） |
| `AZURE_TOKEN_RESOURCE` | `api://<WIF_APP_ID>` |
| `GOOGLE_WIF_AUDIENCE` | `//iam.googleapis.com/projects/<GCP_PROJECT_NUMBER>/locations/global/workloadIdentityPools/azure-checkin/providers/azure-checkin` |
| `GOOGLE_SERVICE_ACCOUNT` | `checkin-sheets@<GCP_PROJECT_ID>.iam.gserviceaccount.com` |
| `ALLOWED_ORIGINS` | `https://twrcaa-official.github.io` |
| `SCANNER_URL` | `https://twrcaa-official.github.io/checkin/scan/` |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `false`（沒有相依套件，不需要建置） |

## 6. 部署與驗證

1. GitHub → Actions → Deploy API → Run workflow（之後每次改 `api/` 推上 main 會自動部署）。
2. 開 `https://<預設網址>/health?deep=1`：
   - `{"ok":true,"groups":N}`：成功，N 是試算表裡有代碼的團體數。
   - `Managed Identity …`：第 1 步的系統指派身分識別沒開。
   - `Google STS 交換憑證失敗`：第 3 步第 4 點的 Issuer、目標對象或屬性條件不對。若訊息提到 issuer 不符，把 Issuer URL 結尾加上 `/` 再試。
   - `模擬服務帳號失敗`：第 3 步第 5 點的授權不對，或 IAM Service Account Credentials API 沒啟用。
   - `Sheets API HTTP 403`：試算表沒分享給服務帳號，或 Google Sheets API 沒啟用。

## 7. 自訂網域（可選）

1. Web App → 自訂網域 → 新增：`checkin-api.taiwanpride.lgbt`，憑證選「App Service 受控憑證」。畫面會給一筆 CNAME 和一筆 `asuid` TXT。
2. Cloudflare DNS 新增這兩筆，**維持灰色雲朵（僅 DNS）**，跟 `mm-dev` 一樣，否則受控憑證無法驗證和續期。
3. 驗證通過後，`https://checkin-api.taiwanpride.lgbt/health` 應該回 `{"ok":true}`。

## 8. 切換網站

把 `config.js` 的 `API_URL` 改成新網址（自訂網域或預設網址，結尾加 `/`），推上 main。Apps Script 繼續保留：試算表選單（產生代碼、設定密碼）照用，Apps Script 版頁面當備援。若要切回 Apps Script，只要把 `API_URL` 改回原本的網址。

## 記錄用表格

| 名稱 | 值 |
|---|---|
| `MI_PRINCIPAL_ID` | |
| `WIF_APP_ID` | |
| `GCP_PROJECT_ID` | |
| `GCP_PROJECT_NUMBER` | |
| `DEPLOY_APP_ID` | |
| `DEPLOY_SP_OBJECT_ID` | |
| App Service 預設網址 | |

這些都不是機密，完成後請記到 infra repo 的 `docs/resources.md`。
