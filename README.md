# 團體報到系統

臺灣同志遊行團體報到的後端與試算表程式。**網頁已搬到 [`TWRCAA-Official/event`](https://github.com/TWRCAA-Official/event) 的 `2026/checkin/`**：

| 頁面 | 網址 | 給誰用 |
|---|---|---|
| 團體頁 | <https://event.taiwanpride.lgbt/2026/checkin/> | 團體輸入名稱＋報名 Email，取得報到 QR Code |
| 掃描頁 | <https://event.taiwanpride.lgbt/2026/checkin/scan/> | 工作人員登入後用手機鏡頭連續掃描報到 |

網頁透過 `event` repo 裡 `2026/checkin/config.js` 的 `API_URL` 讀寫 Google 試算表，後端二選一：

- **Azure API**（本 repo 的 `api/`）：Azure App Service 上的 Node 服務，用 Google Workload Identity Federation（免金鑰）讀寫試算表，速度穩定。設定見 [`docs/azure-setup.md`](docs/azure-setup.md)。
- **Apps Script**（本 repo 的 `apps-script/`）：原本的做法，保留當備援；試算表選單（產生代碼、設定密碼）也在這裡。

兩者的請求與回應格式相同，切換只要改 `API_URL`。

## 檔案

- `api/`：Azure 上的 API（Node 24，沒有相依套件）。`npm test` 跑測試，`node dev/local.js` 用假資料在本機啟動。推上 `main` 由 `.github/workflows/deploy-api.yml` 自動部署。
- `apps-script/`：試算表綁定的 Apps Script（`Code.gs`）。`Group.html`、`Scan.html` 是 Apps Script 版的團體頁與掃描頁，留作備援。修改後要貼回 Apps Script 編輯器並「管理部署作業 → 編輯 → 建立新版本」。
- `index.html`、`scan/index.html`：舊網址 `twrcaa-official.github.io/checkin/` 的轉址頁，會帶著 `?code=` 轉到 event 網站，讓舊的 QR Code 截圖照樣能用。

工作人員密碼存在 Azure App Service 的應用程式設定與 Apps Script 的指令碼屬性（都叫 `STAFF_PIN`，兩邊要設成一樣），不在這個 repo 裡。這個 repo 是公開的，請不要放任何報名資料。

## 試算表

三種報到各一個分頁，代碼前綴不同（三個分頁之間不會重複），掃描頁掃到哪種代碼就寫進哪個分頁：

| 分頁 | 代碼 | 團體頁網址 | 欄位 |
|---|---|---|---|
| 報到名單（隊伍） | `G-` | `/2026/checkin/` | 團體代碼｜團體名稱｜報名Email｜大隊｜報到狀態｜報到時間｜經手人 |
| 花車報到 | `F-` | `/2026/checkin/?type=float` | 同上 |
| 市集報到（彩虹市集） | `M-` | `/2026/checkin/?type=market` | 攤位代碼｜攤商名稱｜報名Email｜攤位編號｜報到狀態｜報到時間｜經手人｜簽退狀態｜簽退時間｜簽退經手人｜場地狀況｜備註 |

彩虹市集報到後 QR Code 會保留，撤場時工作人員在掃描頁切到「彩虹市集簽退」再掃一次，勾選「已完成現場攤位淨空無毀損」或「特殊事項」（必填備註）後送出，寫入 H～L 欄。

1. 選單「團體報到」→「初始化工作表」：建立三個分頁的標題列（已存在的分頁只會重寫第 1 列）。
2. 各分頁 B～D 欄貼上名稱、報名 Email（多個用逗號分隔）、大隊（市集填攤位編號）。A 欄與 E 欄以後留空。大隊名稱裡有紅／橙／黃／綠／藍／紫，團體頁會顯示對應顏色。
3. 選單「團體報到」→「產生缺少的代碼（隊伍／花車／市集）」。
4. 選單「團體報到」→「設定工作人員密碼」。

「初始化工作表」「產生缺少的代碼」「設定工作人員密碼」只能從試算表選單執行。分頁名稱可用 Azure 應用程式設定 `SHEET_NAME`、`FLOAT_SHEET_NAME`、`MARKET_SHEET_NAME` 修改（Apps Script 改 `KINDS`）。

## 明年沿用

1. **試算表**：把今年的試算表「建立副本」（Apps Script 會一起複製），清空「報到名單」「花車報到」「市集報到」第 2 列以下的資料。
2. **Apps Script**（在新試算表的「擴充功能 → Apps Script」）：
   - 把本 repo `apps-script/` 的三個檔案貼進去（確保是最新版）。
   - 修改 `Code.gs` 的 `CONFIG.EVENT_NAME`。若網站網址有變，一併修改 `CONFIG.SCANNER_URL`。
   - 「部署 → 新增部署作業」，類型選「網頁應用程式」，執行身分「我」，誰可以存取「所有人」，複製網頁應用程式網址。
3. **Azure API**（若使用）：App Service 應用程式設定的 `SPREADSHEET_ID` 改成新試算表、`SCANNER_URL` 改成新年度的掃描頁網址，並把新試算表分享給服務帳號（編輯者）。不用重新部署程式。
4. **網頁**：在 `event` repo 把 `2026/checkin` 複製成新年度資料夾（例如 `2027/checkin`），修改裡面 `config.js` 的 `API_URL`、`EVENT_NAME`、`CHECKIN_DEADLINE`，以及兩個頁面裡 `config.js` 與 favicon 路徑的年份；`build.mjs` 的 `STATIC_SUB_APPS` 加上新資料夾。
5. 依「試算表」一節貼上團體資料、產生代碼、設定密碼（Azure 也要把 `STAFF_PIN` 改成一樣）。

### 部署 Apps Script 的注意事項

- 改程式碼後請用「管理部署作業 → 編輯 → 版本：建立新版本」，網址才不會變；若改用「新增部署作業」，網址會變，要同步更新 event repo 的 `config.js`。
- 「誰可以存取」必須是「所有人」，否則 GitHub Pages 會連不上（顯示連線失敗）。
- 新版本部署後約需 1～2 分鐘才完全生效，期間可能偶爾連線失敗。
