# 團體報到系統

臺灣同志遊行團體報到用的網站，以 GitHub Pages 發布，資料存在 Google 試算表。網頁透過 `config.js` 的 `API_URL` 讀寫試算表：

- **Azure API**（`api/`）：Azure App Service 上的 Node 服務，用 Google Workload Identity Federation（免金鑰）讀寫試算表，速度穩定。設定見 [`docs/azure-setup.md`](docs/azure-setup.md)。
- **Apps Script**（`apps-script/`）：原本的做法，保留當備援；試算表選單（產生代碼、設定密碼）也在這裡。

兩者的請求與回應格式相同，切換只要改 `config.js` 的 `API_URL`。

| 頁面 | 網址 | 給誰用 |
|---|---|---|
| 團體頁 | <https://twrcaa-official.github.io/checkin/> | 團體輸入名稱＋報名 Email，取得報到 QR Code |
| 掃描頁 | <https://twrcaa-official.github.io/checkin/scan/> | 工作人員登入後用手機鏡頭連續掃描報到 |

## 檔案

- `index.html`：團體頁。報到完成後畫面會自動變成「已完成報到」。
- `scan/index.html`：掃描頁。登入時下載名單，掃到立刻顯示結果，寫入試算表在背景排隊進行（存在手機裡，斷線也不會遺失）。
- `config.js`：兩頁共用的設定（API 網址、活動名稱、報到截止時間）。
- `api/`：Azure 上的 API（Node 24，沒有相依套件）。`npm test` 跑測試，`node dev/local.js` 用假資料在本機啟動。推上 `main` 由 `.github/workflows/deploy-api.yml` 自動部署。
- `apps-script/`：試算表綁定的 Apps Script（`Code.gs`）。`Group.html`、`Scan.html` 是 Apps Script 版的團體頁與掃描頁，留作備援。

工作人員密碼存在 Azure App Service 的應用程式設定與 Apps Script 的指令碼屬性（都叫 `STAFF_PIN`，兩邊要設成一樣），不在這個 repo 裡。這個 repo 是公開的，請不要放任何報名資料。

## 試算表

分頁「報到名單」欄位：團體代碼｜團體名稱｜報名Email｜大隊｜報到狀態｜報到時間｜經手人

1. B～D 欄貼上團體名稱、報名 Email（多個用逗號分隔）、大隊（名稱裡有紅／橙／黃／綠／藍／紫，團體頁會顯示對應顏色）。A 欄與 E～G 欄留空。
2. 試算表選單「團體報到」→「產生缺少的團體代碼」。
3. 選單「團體報到」→「設定工作人員密碼」。

「初始化工作表」「產生缺少的團體代碼」「設定工作人員密碼」只能從試算表選單執行。

## 明年沿用

1. **試算表**：把今年的試算表「建立副本」（Apps Script 會一起複製），清空「報到名單」第 2 列以下的資料。
2. **Apps Script**（在新試算表的「擴充功能 → Apps Script」）：
   - 把本 repo `apps-script/` 的三個檔案貼進去（確保是最新版）。
   - 修改 `Code.gs` 的 `CONFIG.EVENT_NAME`。若網站網址有變，一併修改 `CONFIG.SCANNER_URL`。
   - 「部署 → 新增部署作業」，類型選「網頁應用程式」，執行身分「我」，誰可以存取「所有人」，複製網頁應用程式網址。
3. **這個 repo**：修改 `config.js` 的 `API_URL`（貼上剛才的網址）與 `EVENT_NAME`，推上 `main` 後 GitHub Pages 會自動更新。
4. 依「試算表」一節貼上團體資料、產生代碼、設定密碼。

### 部署 Apps Script 的注意事項

- 改程式碼後請用「管理部署作業 → 編輯 → 版本：建立新版本」，網址才不會變；若改用「新增部署作業」，網址會變，要同步更新 `config.js`。
- 「誰可以存取」必須是「所有人」，否則 GitHub Pages 會連不上（顯示連線失敗）。
- 新版本部署後約需 1～2 分鐘才完全生效，期間可能偶爾連線失敗。
