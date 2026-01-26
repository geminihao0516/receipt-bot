// === LINE API 模組 ===
const { CONFIG } = require('./config');

// === Quick Reply 按鈕定義 ===
const QUICK_REPLY_ITEMS = {
    items: [
        { type: 'action', action: { type: 'camera', label: '📷 拍收據 / ถ่ายรูป' } },
        { type: 'action', action: { type: 'cameraRoll', label: '🖼️ 傳照片 / รูปภาพ' } },
        { type: 'action', action: { type: 'message', label: '📿 佛牌文案 / พระ', text: '佛牌' } },
        { type: 'action', action: { type: 'message', label: '🎙️ 語音 / เสียง', text: '語音' } },
        { type: 'action', action: { type: 'message', label: '🔮 語音翻譯 / แปล', text: '語音翻譯' } },
        { type: 'action', action: { type: 'message', label: '📊 額度 / โควต้า', text: '額度' } },
        { type: 'action', action: { type: 'message', label: '❓ 說明 / คู่มือ', text: '說明' } }
    ]
};

const AMULET_QUICK_REPLY = {
    items: [
        { type: 'action', action: { type: 'camera', label: '📷 拍照 / ถ่ายรูป' } },
        { type: 'action', action: { type: 'cameraRoll', label: '🖼️ 相簿 / อัลบั้ม' } },
        { type: 'action', action: { type: 'message', label: '✅ 完成生成 / เสร็จสร้าง', text: '完成' } },
        { type: 'action', action: { type: 'message', label: '🗑️ 清除重來 / ล้างใหม่', text: '清除' } },
        { type: 'action', action: { type: 'message', label: '❌ 取消離開 / ยกเลิก', text: '取消' } }
    ]
};

const FORTUNE_QUICK_REPLY = {
    items: [
        { type: 'action', action: { type: 'cameraRoll', label: '📁 選檔案 / เลือกไฟล์' } },
        { type: 'action', action: { type: 'message', label: '❌ 取消離開 / ยกเลิก', text: '取消' } }
    ]
};

// === 從 LINE 下載內容（通用函數）===
async function getContentFromLine(messageId, type = 'image') {
    const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;

    const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}` }
    });

    if (!response.ok) {
        console.error(`❌ LINE ${type}下載失敗: ${response.status}`);
        throw new Error('LINE_API_ERROR');
    }

    const rawContentType = response.headers.get('content-type') || (type === 'audio' ? 'audio/m4a' : 'image/jpeg');
    const buffer = Buffer.from(await response.arrayBuffer());
    const sizeKB = (buffer.length / 1024).toFixed(2);

    let mimeType = rawContentType;
    if (type === 'audio' && (rawContentType.includes('m4a') || rawContentType.includes('aac'))) {
        mimeType = 'audio/mp4';
    } else if (type === 'video' && !rawContentType.includes('video/')) {
        mimeType = 'video/mp4';
    }

    console.log(`下載${type}: ${sizeKB}KB, MIME: ${mimeType}`);

    const maxSizeMap = { audio: CONFIG.MAX_AUDIO_SIZE_MB, image: CONFIG.MAX_IMAGE_SIZE_MB, video: CONFIG.MAX_VIDEO_SIZE_MB };
    const maxSizeMB = maxSizeMap[type] || CONFIG.MAX_IMAGE_SIZE_MB;
    if (buffer.length / (1024 * 1024) > maxSizeMB) {
        const errorMap = { audio: 'AUDIO_TOO_LARGE', image: 'IMAGE_TOO_LARGE', video: 'VIDEO_TOO_LARGE' };
        throw new Error(errorMap[type] || 'FILE_TOO_LARGE');
    }

    return { buffer, mimeType };
}

async function getImageFromLine(messageId) { return getContentFromLine(messageId, 'image'); }
async function getAudioFromLine(messageId) { return getContentFromLine(messageId, 'audio'); }
async function getVideoFromLine(messageId) { return getContentFromLine(messageId, 'video'); }

// === 根據類型取得對應的 Quick Reply ===
function getQuickReply(quickReplyType) {
    switch (quickReplyType) {
        case 'amulet': return AMULET_QUICK_REPLY;
        case 'fortune': return FORTUNE_QUICK_REPLY;
        case 'default': return QUICK_REPLY_ITEMS;
        default: return null;
    }
}

// === 分割長訊息 ===
function splitMessage(message, maxLength) {
    const segments = [];
    let remaining = message;

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            segments.push(remaining);
            break;
        }
        let splitIndex = remaining.lastIndexOf('\n', maxLength);
        if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
            splitIndex = maxLength;
        }
        segments.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex).trimStart();
    }

    console.log(`📝 訊息分成 ${segments.length} 段`);
    return segments;
}

// === Reply API ===
async function sendReply(replyToken, message, quickReplyType = 'default') {
    const url = 'https://api.line.me/v2/bot/message/reply';
    const messageObj = { type: 'text', text: message };
    const quickReplyObj = getQuickReply(quickReplyType);
    if (quickReplyObj) messageObj.quickReply = quickReplyObj;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`
            },
            body: JSON.stringify({ replyToken, messages: [messageObj] })
        });
        const result = await response.text();
        console.log('Line Reply API 回應:', response.status, result);
    } catch (error) {
        console.error('sendReply 錯誤:', error);
    }
}

// === Push API ===
async function sendPush(userId, message, quickReplyType = 'default') {
    const url = 'https://api.line.me/v2/bot/message/push';
    const messageObj = { type: 'text', text: message };
    const quickReplyObj = getQuickReply(quickReplyType);
    if (quickReplyObj) messageObj.quickReply = quickReplyObj;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`
            },
            body: JSON.stringify({ to: userId, messages: [messageObj] })
        });
        const result = await response.text();
        console.log('Line Push API 回應:', response.status, result);
    } catch (error) {
        console.error('sendPush 錯誤:', error);
    }
}

// === 回覆 LINE（自動處理長訊息）===
async function replyToLine(replyToken, message, userId = null, quickReplyType = 'default') {
    const MAX_LENGTH = CONFIG.MAX_LINE_MESSAGE_LENGTH;
    console.log('正在回覆:', replyToken.substring(0, 20) + '...', `訊息長度: ${message.length} 字`);

    if (message.length > MAX_LENGTH) {
        console.log(`⚠️ 訊息超過 ${MAX_LENGTH} 字，將分段發送`);
        const segments = splitMessage(message, MAX_LENGTH);
        await sendReply(replyToken, segments[0], quickReplyType);
        if (segments.length > 1 && userId) {
            for (let i = 1; i < segments.length; i++) {
                const isLast = (i === segments.length - 1);
                await sendPush(userId, segments[i], isLast ? quickReplyType : null);
            }
        }
    } else {
        await sendReply(replyToken, message, quickReplyType);
    }
}

module.exports = {
    getImageFromLine,
    getAudioFromLine,
    getVideoFromLine,
    replyToLine,
    sendReply,
    sendPush,
    QUICK_REPLY_ITEMS,
    AMULET_QUICK_REPLY,
    FORTUNE_QUICK_REPLY
};
