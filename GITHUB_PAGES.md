# 公開網頁、私人 Google Sheets 資料

GitHub Pages 只發布網頁介面。頁面初始不含 EVB 紀錄，使用者必須點選
**Sign in with Google** 並授予唯讀權限，Google Sheets API 才會以該使用者的
權限回傳資料。試算表請維持原本的私人分享設定，不要發布到網路。

這不是「開啟 Sheet 連結就解鎖網頁」：網頁使用 Google OAuth 取得短期授權。
Google 帳號必須已有來源 Sheet 的存取權。若 OAuth 應用程式僅供公司使用，
請在公司的 Google Cloud 組織內選擇 **Internal**，並維持公司帳號的 Sheet 分享範圍。

## 1. Google Cloud 設定

1. 使用公司 Google 帳號登入 https://console.cloud.google.com/ 。建立或選擇公司允許使用的專案。
2. 在 **APIs & Services → Library** 搜尋 **Google Sheets API**，按 **Enable**。
3. 在 **Google Auth platform → Branding** 設定應用程式名稱、支援信箱及聯絡信箱。
4. **Audience** 選擇 **Internal**，限制同一 Google Workspace 組織使用。
   若沒有 Internal 選项，代表這個專案目前不符合條件；請公司管理員協助在公司組織建立。
   若公司改採 External，測試期間需加入 Test users；正式上線可能涉及 Google 驗證及公司管理員核准。
5. 在 **Data Access** 加入唯讀 scope：
   `https://www.googleapis.com/auth/spreadsheets.readonly`。
6. 在 **Clients → Create client** 選擇 **Web application**。
7. 在 **Authorized JavaScript origins** 填入：
   `https://skymizerfuji.github.io`
   只填通訊協定與網域，不加儲存庫路徑，也不加結尾斜線。
   若需要本機測試，再加入實際使用的 `http://localhost` 與 `http://localhost:3000`。
8. 建立後，複製結尾為 `.apps.googleusercontent.com` 的 **Client ID**。
   這是公開識別碼。本實作不需要 Client Secret、API key 或服務帳號金鑰。
   使用 Google 的彈出式 token 流程，不需設定本程式的伺服器 redirect URI。

若看到 `origin_mismatch`，檢查 origin 是否完全相符；若看到 `access blocked`，
請確認 Audience、測試使用者及公司管理員的應用程式政策。若 API 回傳 403，
也需確認 Sheets API 已啟用、OAuth scope 已允許、登入帳號已有來源 Sheet 權限。

## 2. 填入 Client ID

兩種方式擇一：

- 編輯 `site-config.json` 的 `clientId`，再執行 `npm run build:pages`。
- GitHub 儲存庫 **Settings → Secrets and variables → Actions → Variables**
  新增 `GOOGLE_CLIENT_ID`。它不是 secret；工作流程會把它寫入公開網頁設定。

`site-config.json` 也設定 spreadsheetId、sheetName、year。若多個分頁都符合
EVB 表格欄位，填入 sheetName。修改設定後要推送或重新執行部署。
未填入 Client ID 時，公開頁面會保持空白資料，並顯示登入尚未設定。

## 3. GitHub 自動部署

預計儲存庫：`skymizerFuji/evb-platform-history`（若另選名稱，依實際名稱為準）。

1. 在本機以 `gh auth login` 登入 GitHub，或完成助理提供的 device 授權流程。
2. 將本專案推送到 GitHub 的 `main` 分支。免費個人方案的 Pages 使用 public repository。
   這個專案的 `chart/`、`public/` 與測試沒有嵌入真實 EVB 紀錄；不要加入父目錄的
   `table.csv`、`evb_history.html`、截圖或任何資料快照。
3. 在儲存庫 **Settings → Pages → Build and deployment → Source** 選擇 **GitHub Actions**。
4. 到 **Actions → Deploy EVB website to GitHub Pages → Run workflow** 執行第一次部署。
5. 成功後，使用 **Settings → Pages** 顯示的網址。預計為
   `https://skymizerfuji.github.io/evb-platform-history/`；這只是預計網址，尚未部署前不代表已可使用。

往後每次推送 `main`，GitHub Actions 都會從 `chart/` 建立不含紀錄的頁面、
執行登入安全測試，再發布 `index.html` 與 `config.js`。不需執行 Next/vinext 伺服器。
資料在使用者登入後直接從 Google Sheets 讀取，每 60 秒在頁面可見時更新，無需重新部署。

## 資料與登入行為

- access token 和讀入的資料僅保存在目前頁面記憶體，不寫入瀏覽器永久儲存。
- Disconnect 清除本頁資料及 token，不會登出整個 Google 帳號，也不會撤銷其他 Google 應用程式。
- 授權到期、讀取遭拒（401／403／404）時立即清除資料；需再次登入。
- 斷線中的舊請求無法在使用者斷開連線後把資料寫回畫面。
- 使用者撤銷 Sheet 權限後，下一次 API 檢查會清除頁面；無法追溯收回已由合法使用者看過的內容。
- 其他暫時性讀取錯誤保留本次已授權的畫面並顯示錯誤。此頁不把 Sheets 設成公開。
- `chart/` 是本 repository 可獨立建置的來源。父層工作區的 `build_evb_web.py` 也會同步這些來源，
  但父層離線快照不會複製到公開版。

本機測試使用模擬 Google 回應；真實 OAuth、公司政策及 Sheet 權限，需填入正式 Client ID 後驗證。

參考：
- https://developers.google.com/workspace/sheets/api/quickstart/js
- https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid
- https://developers.google.com/identity/oauth2/web/guides/use-token-model
- https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
