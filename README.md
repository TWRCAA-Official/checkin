# 團體報到掃描頁

第 24 屆臺灣同志遊行團體報到系統的工作人員掃描頁，以 GitHub Pages 發布：
<https://twrcaa-official.github.io/checkin-scanner/>

- `index.html`：掃描頁（即時鏡頭連續掃描、拍照掃描備案、手動輸入代碼）。透過 `fetch` POST 呼叫 Apps Script 的 `doPost` JSON API。
- `apps-script/`：Google 試算表綁定的 Apps Script 程式碼（`Code.gs`、團體頁 `Group.html`、備援掃描頁 `Scan.html`）。修改後需手動貼回 Apps Script 編輯器並重新部署。

## 設定

- `index.html` 的 `CONFIG.API_URL`：Apps Script 網頁應用程式的 `/exec` 網址。
- `Code.gs` 的 `CONFIG.SCANNER_URL`：本頁網址；團體頁的 QR Code 會指向 `SCANNER_URL?code=團體代碼`。留空則改回 Apps Script 掃描頁。

工作人員密碼存在 Apps Script 的指令碼屬性（`STAFF_PIN`），不在這個 repo 裡。

## 部署 Apps Script 的注意事項

- 「執行身分」選「我」，「誰可以存取」須為「所有人」，GitHub Pages 才能呼叫 API。
- 更新時請用「管理部署作業 → 編輯 → 新版本」，網址才不會變；若網址變了，要同步更新 `index.html` 的 `API_URL`。
