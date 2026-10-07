/*
 * 團體報到系統｜網站設定（團體頁與掃描頁共用）
 * 每年活動只需要改這個檔案，以及 apps-script/Code.gs 的 CONFIG。
 */
window.SITE_CONFIG = {
  // Apps Script 網頁應用程式網址（部署時「執行身分：我」、「誰可以存取：所有人」）
  API_URL: 'https://script.google.com/a/macros/taiwanpride.lgbt/s/AKfycbzTg5AkU6ncqeVfDms1YcrKmoi9ua_BGdwR8tYmWsFn-WBXfwph0lg_HMM73UM7ePXL/exec',
  EVENT_NAME: '第 24 屆臺灣同志遊行',
  POLL_SECONDS: 5,   // 團體頁多久查詢一次報到狀態
  CHECKIN_DEADLINE: '13:20',   // 團體頁提醒的報到截止時間
};
