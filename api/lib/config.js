// === 設定模組 ===
const CONFIG = {
    // === LINE API ===
    LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN,

    // === Gemini API ===
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,

    // === Gemini 模型設定（不同功能可用不同模型）===
    GEMINI_MODEL_RECEIPT: process.env.GEMINI_MODEL_RECEIPT || 'gemini-2.5-flash',
    GEMINI_MODEL_AUDIO: process.env.GEMINI_MODEL_AUDIO || 'gemini-2.5-flash',
    GEMINI_MODEL_AMULET: process.env.GEMINI_MODEL_AMULET || 'gemini-2.5-flash',
    GEMINI_MODEL_FORTUNE: process.env.GEMINI_MODEL_FORTUNE || 'gemini-2.5-flash',
    GEMINI_MODEL_PARSE: process.env.GEMINI_MODEL_PARSE || 'gemini-2.5-flash',

    // === Google Sheets ===
    SPREADSHEET_ID: process.env.SPREADSHEET_ID,
    SHEET_NAME: '收據記錄',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    GOOGLE_PRIVATE_KEY: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n').replace(/"/g, ''),

    // === Google Drive ===
    GOOGLE_DRIVE_FOLDER_ID: process.env.GOOGLE_DRIVE_FOLDER_ID || '146-54T2RF6XDwceOr60mjl26hRoNGU4C',

    // === 限制常數 ===
    MAX_IMAGE_SIZE_MB: 4,
    MAX_AUDIO_SIZE_MB: 10,
    MAX_VIDEO_SIZE_MB: 20,
    MAX_AUDIO_DURATION_MS: 60000,
    MAX_LINE_MESSAGE_LENGTH: 4500
};

// === 智慧模型選擇 ===
function selectModel(task, context = {}) {
    const { duration = 0, hasUserInfo = false } = context;
    const PRO = 'gemini-2.5-pro';

    switch (task) {
        case 'audio':
            return duration > 60000 ? PRO : CONFIG.GEMINI_MODEL_AUDIO;
        case 'fortune':
            return duration > 180000 ? PRO : CONFIG.GEMINI_MODEL_FORTUNE;
        case 'amulet':
            return hasUserInfo ? CONFIG.GEMINI_MODEL_AMULET : PRO;
        case 'receipt':
            return CONFIG.GEMINI_MODEL_RECEIPT;
        case 'parse':
            return CONFIG.GEMINI_MODEL_PARSE;
        default:
            return CONFIG.GEMINI_MODEL_RECEIPT;
    }
}

// === 取得台灣時間今天日期 ===
function getTaiwanToday() {
    const now = new Date();
    const taiwanTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const year = taiwanTime.getFullYear();
    const month = String(taiwanTime.getMonth() + 1).padStart(2, '0');
    const day = String(taiwanTime.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

module.exports = { CONFIG, selectModel, getTaiwanToday };
