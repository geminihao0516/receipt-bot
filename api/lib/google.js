// === Google API 模組（Sheets + Drive）===
const { google } = require('googleapis');
const { Readable } = require('stream');
const { CONFIG, getTaiwanToday } = require('./config');

// === Google Auth 快取（Sheets + Drive 共用）===
let cachedGoogleAuth = null;
let cachedSheetsClient = null;
let cachedDriveClient = null;
let cachedAuthExpiry = 0;

// === 取得共用的 Google Auth ===
async function getGoogleAuth() {
    if (cachedGoogleAuth && Date.now() < cachedAuthExpiry) {
        return cachedGoogleAuth;
    }

    let fixedEmail = CONFIG.GOOGLE_SERVICE_ACCOUNT_EMAIL.trim();
    if (fixedEmail.startsWith('eceipt')) {
        fixedEmail = 'r' + fixedEmail;
    }

    // PRIVATE_KEY 已在 config.js 處理過
    const fixedKey = CONFIG.GOOGLE_PRIVATE_KEY;

    console.log('🔄 初始化新的 Google Auth（Sheets + Drive）...');
    cachedGoogleAuth = new google.auth.GoogleAuth({
        credentials: {
            client_email: fixedEmail,
            private_key: fixedKey,
        },
        scopes: [
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive.file'
        ],
    });
    cachedAuthExpiry = Date.now() + 55 * 60 * 1000;

    return cachedGoogleAuth;
}

async function getSheetsClient() {
    if (cachedSheetsClient && Date.now() < cachedAuthExpiry) {
        console.log('📋 使用快取的 Sheets Client');
        return cachedSheetsClient;
    }

    const auth = await getGoogleAuth();
    const client = await auth.getClient();
    cachedSheetsClient = google.sheets({ version: 'v4', auth: client });
    return cachedSheetsClient;
}

async function getDriveClient() {
    if (cachedDriveClient && Date.now() < cachedAuthExpiry) {
        console.log('📁 使用快取的 Drive Client');
        return cachedDriveClient;
    }

    const auth = await getGoogleAuth();
    const client = await auth.getClient();
    cachedDriveClient = google.drive({ version: 'v3', auth: client });
    return cachedDriveClient;
}

// === 上傳圖片到 Google Drive（透過 Apps Script 代理）===
async function uploadImageToDrive(imageData, receiptData) {
    const { buffer, mimeType } = imageData;

    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const masterName = (receiptData.master || '未知').replace(/[\\/:*?"<>|]/g, '_');
    const dateStr = receiptData.date || getTaiwanToday();
    const fileName = `${dateStr}_${masterName}_${timestamp}.jpg`;

    console.log(`📤 上傳圖片到 Drive（via Apps Script）: ${fileName}`);

    const base64Image = buffer.toString('base64');

    const response = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            image: base64Image,
            fileName: fileName,
            folderId: CONFIG.GOOGLE_DRIVE_FOLDER_ID
        })
    });

    const result = await response.json();

    if (!result.success) {
        throw new Error(result.error || 'Apps Script 上傳失敗');
    }

    console.log(`✅ 圖片上傳成功: ${result.webViewLink}`);
    return result.webViewLink;
}

// === 寫入 Google Sheets ===
async function appendToSheet(data, imageUrl = '') {
    if (!CONFIG.GOOGLE_SERVICE_ACCOUNT_EMAIL || !CONFIG.GOOGLE_PRIVATE_KEY) {
        console.warn('⚠️ 未設定 Google Service Account，跳過寫入 Sheet');
        return;
    }

    try {
        const sheets = await getSheetsClient();

        let finalDate = data.date;
        const todayTaiwan = getTaiwanToday();

        if (!finalDate || finalDate.trim() === '') {
            finalDate = todayTaiwan;
            console.log(`⚠️ 收據無日期，使用今天（台灣時間）: ${finalDate}`);
        } else {
            const dateObj = new Date(finalDate + 'T00:00:00');
            const todayObj = new Date(todayTaiwan + 'T00:00:00');

            if (isNaN(dateObj.getTime())) {
                finalDate = todayTaiwan;
                console.log(`⚠️ 日期格式無效 (${data.date})，使用今天: ${finalDate}`);
            } else if (dateObj > todayObj) {
                finalDate = todayTaiwan;
                console.log(`⚠️ 日期是未來 (${data.date})，使用今天: ${finalDate}`);
            } else {
                console.log(`✅ 使用收據日期: ${finalDate}`);
            }
        }

        const rows = data.items.map((item, index) => [
            finalDate,
            data.master,
            item.name,
            item.qty,
            item.price,
            item.total,
            index === 0 ? imageUrl : ''
        ]);

        await sheets.spreadsheets.values.append({
            spreadsheetId: CONFIG.SPREADSHEET_ID,
            range: `${CONFIG.SHEET_NAME}!A:G`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: rows }
        });

        console.log('✅ 已寫入 Google Sheet:', rows.length, '筆資料');

    } catch (error) {
        console.error('❌ 寫入 Sheet 失敗:', error.message);
    }
}

module.exports = {
    uploadImageToDrive,
    appendToSheet,
    getSheetsClient,
    getDriveClient
};
