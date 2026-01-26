// ============================================
// Line 收據 Bot - Vercel Serverless Function
// 模組化版本
// ============================================

// === 引入模組 ===
const { CONFIG, getTaiwanToday } = require('./lib/config');
const { uploadImageToDrive, appendToSheet } = require('./lib/google');
const { getImageFromLine, getAudioFromLine, getVideoFromLine, replyToLine } = require('./lib/line');
const {
    recognizeReceipt, recognizeAudio, recognizeVideoAudio,
    translateFortuneText, recognizeAmuletMultiImage, parseTextWithGemini,
    getApiUsageSummary
} = require('./lib/gemini');

// === 用戶模式追蹤 ===
const userModeMap = new Map();
const USER_MODE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_AMULET_IMAGES = 5;

// === 清理過期的用戶模式 ===
function cleanupExpiredModes() {
    const now = Date.now();
    for (const [userId, state] of userModeMap.entries()) {
        if (state.createdAt && (now - state.createdAt > USER_MODE_TIMEOUT_MS)) {
            console.log(`🧹 清理過期用戶模式: ${userId}`);
            userModeMap.delete(userId);
        }
    }
}

// === 統一訊息常數 ===
const MESSAGES = {
    QUOTA_EXCEEDED: { zh: '❌ 免費額度已滿，請稍後再試', th: '❌ เกินโควต้าแล้ว ลองใหม่ทีหลังนะ' },
    IMAGE_TOO_LARGE: { zh: '❌ 圖片檔案過大 (>4MB)\n請壓縮後重新上傳', th: '❌ ไฟล์ใหญ่เกินไป (>4MB)\nกรุณาบีบอัดแล้วส่งใหม่' },
    AUDIO_TOO_LARGE: { zh: '❌ 語音檔案太大', th: '❌ ไฟล์เสียงใหญ่เกินไป' },
    SYSTEM_ERROR: { zh: '❌ 系統錯誤，請稍後再試', th: '❌ ผิดพลาด ลองใหม่ภายหลัง' }
};

function getMessage(key) {
    const msg = MESSAGES[key] || MESSAGES.SYSTEM_ERROR;
    return `${msg.zh}\n${msg.th}`;
}

async function handleApiError(replyToken, error, context = 'image') {
    console.error(`❌ API 錯誤 (${context}):`, error.message || error);
    const msgKey = MESSAGES[error.message] ? error.message : 'SYSTEM_ERROR';
    await replyToLine(replyToken, getMessage(msgKey));
}

// === 格式化摘要 ===
function formatSummary(data) {
    let total = 0;
    let itemList = '';
    for (const item of data.items) {
        total += item.total;
        itemList += `${item.name}×${item.qty}=${item.total.toLocaleString()}\n`;
    }
    const header = data.master ? `✅ ${data.master}` : '✅ 記帳成功 / บันทึกแล้ว';
    return `${header}\n${itemList}💰 ${total.toLocaleString()}`;
}

// === 本地解析文字 ===
function parseTextLocally(text) {
    try {
        text = text.trim();
        if (/[\u0E00-\u0E7F]/.test(text)) return null; // 泰文用 Gemini

        const normalized = text.replace(/\s+/g, ' ');
        const pattern1 = /^(.+?)\s+(.+?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/;
        const match1 = normalized.match(pattern1);

        if (match1) {
            const [, master, itemName, qty, price] = match1;
            const quantity = parseFloat(qty);
            const unitPrice = parseFloat(price);
            return {
                date: '', master: master.trim(),
                items: [{ name: itemName.trim(), qty: quantity, price: unitPrice, total: quantity * unitPrice }],
                note: ''
            };
        }

        const pattern2 = /^(.+?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/;
        const match2 = normalized.match(pattern2);
        if (match2) {
            const [, itemName, qty, price] = match2;
            const quantity = parseFloat(qty);
            const unitPrice = parseFloat(price);
            return {
                date: '', master: '',
                items: [{ name: itemName.trim(), qty: quantity, price: unitPrice, total: quantity * unitPrice }],
                note: ''
            };
        }
        return null;
    } catch (error) {
        return null;
    }
}

// === 主要 Webhook Handler ===
module.exports = async (req, res) => {
    if (req.method === 'GET') return res.status(200).json({ status: 'ok' });

    if (req.method === 'POST') {
        cleanupExpiredModes();
        const events = req.body?.events || [];
        console.log('收到 Webhook 請求, events:', events.length);

        for (const event of events) {
            try {
                if (event.type !== 'message') continue;
                const userId = event.source.userId || 'unknown';

                if (event.message.type === 'image') {
                    const userState = userModeMap.get(userId) || { mode: 'receipt' };
                    if (userState.mode === 'amulet') {
                        await collectAmuletImage(event, userId, userState);
                    } else {
                        await handleImageMessage(event);
                    }
                } else if (event.message.type === 'text') {
                    await handleTextMessage(event);
                } else if (event.message.type === 'audio') {
                    const userState = userModeMap.get(userId) || { mode: 'receipt' };
                    if (userState.mode === 'fortune') {
                        await handleFortuneAudioMessage(event);
                        userModeMap.delete(userId);
                    } else {
                        await handleAudioMessage(event);
                    }
                } else if (event.message.type === 'file') {
                    const fileName = event.message.fileName || '';
                    const userState = userModeMap.get(userId) || { mode: 'receipt' };
                    if (/\.(m4a|mp3|wav|ogg)$/i.test(fileName)) {
                        if (userState.mode === 'fortune') {
                            await handleFortuneFileMessage(event);
                            userModeMap.delete(userId);
                        } else {
                            await handleAudioFileMessage(event);
                        }
                    } else {
                        await replyToLine(event.replyToken,
                            '⚠️ 不支援此檔案格式\n請使用 LINE 內建錄音或上傳 m4a/mp3\n\n⚠️ ไม่รองรับไฟล์นี้\nใช้การอัดเสียงใน LINE หรืออัปโหลด m4a/mp3');
                    }
                } else if (event.message.type === 'video') {
                    const userState = userModeMap.get(userId) || { mode: 'receipt' };
                    if (userState.mode === 'fortune') {
                        await handleFortuneVideoMessage(event);
                        userModeMap.delete(userId);
                    } else {
                        await replyToLine(event.replyToken,
                            '⚠️ 影片功能僅在「語音翻譯模式」下可用\n請先點選「🔮 語音翻譯」按鈕\n\n⚠️ วิดีโอใช้ได้เฉพาะโหมด「แปลเสียง」\nกด「🔮 แปลเสียง」ก่อนนะ');
                    }
                }
            } catch (error) {
                console.error('處理事件錯誤:', error);
            }
        }
        return res.status(200).json({ status: 'ok' });
    }
    return res.status(405).json({ error: 'Method not allowed' });
};

// === 處理圖片訊息 ===
async function handleImageMessage(event) {
    try {
        const messageId = event.message.id;
        const replyToken = event.replyToken;
        const imageData = await getImageFromLine(messageId);
        const receiptData = await recognizeReceipt(imageData);

        if (!receiptData) {
            await replyToLine(replyToken, '❌ 完全無法辨識，請確認：\n1. 是否為收據照片\n2. 照片是否清晰\n\n❌ อ่านไม่ได้ กรุณาตรวจสอบ:\n1. เป็นรูปใบเสร็จหรือไม่\n2. รูปชัดหรือไม่');
            return;
        }

        if (receiptData.note && (receiptData.note.includes('模糊') || receiptData.note.includes('無法辨識'))) {
            await replyToLine(replyToken, `⚠️ 圖片品質問題\n${receiptData.note}\n\n建議：📸 重新拍攝清晰照片`);
            return;
        }

        if (!receiptData.items?.length) {
            if (receiptData.master || receiptData.date) {
                await replyToLine(replyToken, `⚠️ 只辨識到部分信息：\n店家：${receiptData.master || '未知'}\n日期：${receiptData.date || '未知'}\n\n無法辨識商品明細`);
            } else {
                await replyToLine(replyToken, '❌ 辨識失敗，請重拍清晰照片');
            }
            return;
        }

        // 辨識成功，上傳到 Drive
        let imageUrl = '';
        try {
            imageUrl = await uploadImageToDrive(imageData, receiptData);
            console.log('📤 圖片已上傳到 Drive:', imageUrl);
        } catch (uploadError) {
            console.error('⚠️ 圖片上傳失敗（不影響記帳）:', uploadError.message);
        }

        const summary = formatSummary(receiptData);
        await replyToLine(replyToken, summary);
        await appendToSheet(receiptData, imageUrl);

    } catch (error) {
        await handleApiError(event.replyToken, error, 'receipt');
    }
}

// === 處理文字訊息 ===
async function handleTextMessage(event) {
    try {
        const text = event.message.text.trim();
        const replyToken = event.replyToken;
        const userId = event.source.userId || 'unknown';

        // 說明指令
        if (['?', '？', '說明', 'คู่มือ'].includes(text)) {
            await replyToLine(replyToken,
                '📖 使用說明\n\n📷 拍照記帳 → 拍收據 AI 辨識\n📿 佛牌文案 → 拍佛牌 AI 寫文案\n🎙️ 語音記帳 → 錄語音 AI 辨識\n🔮 語音翻譯 → 命理語音翻成中文\n📊 額度查詢 → 查看 API 使用量');
            return;
        }

        // 額度查詢
        if (['額度', '用量', 'โควต้า', 'quota'].includes(text.toLowerCase())) {
            await replyToLine(replyToken, getApiUsageSummary());
            return;
        }

        // 語音教學
        if (['語音', 'เสียง'].includes(text)) {
            await replyToLine(replyToken, '🎙️ 語音記帳教學\n\n① 點輸入框旁的「🎤」\n② 按住說話\n③ 放開發送\n\n💬 範例：「阿贊南奔 金箔 十個 五百」');
            return;
        }

        // 佛牌文案模式
        if (['佛牌', 'พระ', 'พระเครื่อง'].includes(text)) {
            userModeMap.set(userId, { mode: 'amulet', description: '', images: [], createdAt: Date.now() });
            await replyToLine(replyToken,
                '📿 佛牌聖物文案模式\n\n➀ 可先傳文字描述（選填）\n➁ 傳 1~5 張照片\n➂ 點「完成生成」\n\n👇 點按鈕開始',
                null, 'amulet');
            return;
        }

        // 語音翻譯模式
        if (['語音翻譯', 'แปล', 'แปลเสียง'].includes(text)) {
            userModeMap.set(userId, { mode: 'fortune', createdAt: Date.now() });
            await replyToLine(replyToken,
                '🔮 語音翻譯模式\n\n請上傳命理語音檔案（m4a/mp3）\n或影片檔案（mp4）\n或使用 LINE 內建錄音\n\n👇 點按鈕可取消',
                null, 'fortune');
            return;
        }

        // 取消模式
        if (['取消', 'ยกเลิก', 'cancel'].includes(text.toLowerCase())) {
            if (userModeMap.has(userId)) {
                const state = userModeMap.get(userId);
                const imageCount = state.images?.length || 0;
                userModeMap.delete(userId);
                await replyToLine(replyToken, `✅ 已取消模式${imageCount > 0 ? `（已清除 ${imageCount} 張圖片）` : ''}`);
                return;
            }
        }

        // 完成指令（佛牌模式）
        if (['完成', 'เสร็จ', 'done', '生成'].includes(text.toLowerCase())) {
            const userState = userModeMap.get(userId);
            if (userState?.mode === 'amulet') {
                await processMultiImageAmulet(event, userId, userState);
                return;
            }
        }

        // 清除指令
        if (['清除', 'ล้าง', 'clear', '重來'].includes(text.toLowerCase())) {
            const userState = userModeMap.get(userId);
            if (userState?.mode === 'amulet') {
                const oldCount = userState.images?.length || 0;
                userState.images = [];
                userState.description = '';
                userModeMap.set(userId, userState);
                await replyToLine(replyToken, `🗑️ 已清除 ${oldCount} 張圖片\n可重新開始傳圖`, null, 'amulet');
                return;
            }
        }

        // 佛牌模式下的文字描述
        const userState = userModeMap.get(userId);
        if (userState?.mode === 'amulet') {
            userState.description = (userState.description ? userState.description + '\n' : '') + text;
            userModeMap.set(userId, userState);
            await replyToLine(replyToken, `📝 已收到：${text}\n\n請傳照片 📷`, null, 'amulet');
            return;
        }

        // 嘗試解析為記帳資料
        let data = parseTextLocally(text);
        if (!data) {
            data = await parseTextWithGemini(text);
        }

        if (data?.items?.length) {
            const summary = formatSummary(data);
            await replyToLine(replyToken, summary);
            await appendToSheet(data);
        } else {
            await replyToLine(replyToken,
                '⚠️ 無法解析為記帳資料\n\n請使用格式：\n師傅名 品項 數量 單價\n\n範例：阿贊南奔 金箔 10 500');
        }

    } catch (error) {
        console.error('handleTextMessage error:', error);
        if (error.message === 'QUOTA_EXCEEDED') {
            await replyToLine(event.replyToken, '❌ 額度已滿');
        }
    }
}

// === 收集佛牌圖片 ===
async function collectAmuletImage(event, userId, userState) {
    try {
        const messageId = event.message.id;
        const replyToken = event.replyToken;

        if (!userState.images) userState.images = [];

        if (userState.images.length >= MAX_AMULET_IMAGES) {
            await replyToLine(replyToken, `⚠️ 已達 ${MAX_AMULET_IMAGES} 張上限\n點下方按鈕選擇下一步`, null, 'amulet');
            return;
        }

        const imageData = await getImageFromLine(messageId);
        userState.images.push({
            base64: imageData.buffer.toString('base64'),
            mimeType: imageData.mimeType
        });
        userModeMap.set(userId, userState);

        const count = userState.images.length;
        await replyToLine(replyToken,
            `📷 已收到第 ${count} 張圖片\n${count < MAX_AMULET_IMAGES ? `可繼續傳圖（最多 ${MAX_AMULET_IMAGES} 張）\n` : ''}\n點下方按鈕選擇下一步 👇`,
            null, 'amulet');

    } catch (error) {
        console.error('collectAmuletImage error:', error);
        await replyToLine(event.replyToken, '❌ 圖片處理失敗，請重傳', null, 'amulet');
    }
}

// === 處理多圖佛牌文案生成 ===
async function processMultiImageAmulet(event, userId, userState) {
    try {
        const replyToken = event.replyToken;
        const images = userState.images || [];

        if (!images.length) {
            await replyToLine(replyToken, '⚠️ 還沒有圖片！請先傳佛牌照片', null, 'amulet');
            return;
        }

        const amuletText = await recognizeAmuletMultiImage(images, userState.description || '');

        if (!amuletText) {
            await replyToLine(replyToken, '❌ 無法辨識，請確認圖片清晰', null, 'amulet');
            return;
        }

        userModeMap.delete(userId);
        await replyToLine(replyToken, amuletText, userId);

    } catch (error) {
        console.error('processMultiImageAmulet error:', error);
        if (error.message === 'QUOTA_EXCEEDED') {
            await replyToLine(event.replyToken, '❌ API 額度已滿，請稍後再試', null, 'amulet');
        } else {
            await replyToLine(event.replyToken, '❌ 處理失敗，請重試', null, 'amulet');
        }
    }
}

// === 處理語音訊息 ===
async function handleAudioMessage(event) {
    try {
        const messageId = event.message.id;
        const replyToken = event.replyToken;
        const duration = event.message.duration;

        if (duration > CONFIG.MAX_AUDIO_DURATION_MS) {
            await replyToLine(replyToken, '⚠️ 語音太長，請控制在 60 秒內');
            return;
        }

        const audioData = await getAudioFromLine(messageId);
        const recognizedText = await recognizeAudio(audioData, duration);

        if (!recognizedText?.trim()) {
            await replyToLine(replyToken, '❌ 無法識別語音，請重新錄製\n建議：說話清晰、環境安靜');
            return;
        }

        let data = parseTextLocally(recognizedText);
        if (!data) data = await parseTextWithGemini(recognizedText);

        if (data?.items?.length) {
            const summary = formatSummary(data);
            await replyToLine(replyToken, `🎤 語音識別結果：\n"${recognizedText}"\n\n${summary}`);
            await appendToSheet(data);
        } else {
            await replyToLine(replyToken, `🎤 語音識別：\n"${recognizedText}"\n\n⚠️ 無法解析為記帳資料`);
        }

    } catch (error) {
        await handleApiError(event.replyToken, error, 'audio');
    }
}

// === 處理命理語音訊息 ===
async function handleFortuneAudioMessage(event) {
    try {
        const messageId = event.message.id;
        const replyToken = event.replyToken;
        const duration = event.message.duration;

        const audioData = await getAudioFromLine(messageId);
        const recognizedText = await recognizeAudio(audioData, duration);

        if (!recognizedText?.trim()) {
            await replyToLine(replyToken, '❌ 無法識別語音，請重新錄製', null, 'fortune');
            return;
        }

        const fortuneText = await translateFortuneText(recognizedText, duration);

        if (!fortuneText) {
            await replyToLine(replyToken, '❌ 翻譯處理失敗，請稍後再試', null, 'fortune');
            return;
        }

        await replyToLine(replyToken, fortuneText);

    } catch (error) {
        console.error('handleFortuneAudioMessage error:', error);
        if (error.message === 'QUOTA_EXCEEDED') {
            await replyToLine(event.replyToken, '❌ 免費額度已滿，請稍後再試', null, 'fortune');
        } else {
            await replyToLine(event.replyToken, '❌ 處理失敗，請重試', null, 'fortune');
        }
    }
}

// === 處理命理音訊檔案 ===
async function handleFortuneFileMessage(event) {
    try {
        const messageId = event.message.id;
        const replyToken = event.replyToken;

        const audioData = await getAudioFromLine(messageId);
        const estimatedDuration = Math.max(60000, audioData.buffer.length / 16);
        const recognizedText = await recognizeAudio(audioData, estimatedDuration);

        if (!recognizedText?.trim()) {
            await replyToLine(replyToken, '❌ 無法識別語音，請確認檔案格式正確', null, 'fortune');
            return;
        }

        const fortuneText = await translateFortuneText(recognizedText, estimatedDuration);

        if (!fortuneText) {
            await replyToLine(replyToken, '❌ 翻譯處理失敗，請稍後再試', null, 'fortune');
            return;
        }

        await replyToLine(replyToken, fortuneText);

    } catch (error) {
        console.error('handleFortuneFileMessage error:', error);
        if (error.message === 'QUOTA_EXCEEDED') {
            await replyToLine(event.replyToken, '❌ 免費額度已滿', null, 'fortune');
        } else {
            await replyToLine(event.replyToken, '❌ 處理失敗，請重試', null, 'fortune');
        }
    }
}

// === 處理音訊檔案（記帳用）===
async function handleAudioFileMessage(event) {
    try {
        const messageId = event.message.id;
        const replyToken = event.replyToken;

        const audioData = await getAudioFromLine(messageId);
        const estimatedDuration = Math.max(30000, audioData.buffer.length / 16);
        const recognizedText = await recognizeAudio(audioData, estimatedDuration);

        if (!recognizedText?.trim()) {
            await replyToLine(replyToken, '❌ 無法識別語音，建議使用 LINE 內建錄音');
            return;
        }

        let data = parseTextLocally(recognizedText);
        if (!data) data = await parseTextWithGemini(recognizedText);

        if (data?.items?.length) {
            const summary = formatSummary(data);
            await replyToLine(replyToken, `🎤 語音識別結果：\n"${recognizedText}"\n\n${summary}`);
            await appendToSheet(data);
        } else {
            await replyToLine(replyToken, `🎤 語音識別：\n"${recognizedText}"\n\n⚠️ 無法解析為記帳資料`);
        }

    } catch (error) {
        await handleApiError(event.replyToken, error, 'audio');
    }
}

// === 處理命理影片訊息 ===
async function handleFortuneVideoMessage(event) {
    try {
        const messageId = event.message.id;
        const replyToken = event.replyToken;
        const duration = event.message.duration || 60000;

        const videoData = await getVideoFromLine(messageId);
        const recognizedText = await recognizeVideoAudio(videoData, duration);

        if (!recognizedText?.trim()) {
            await replyToLine(replyToken, '❌ 無法識別影片中的語音\n建議：確認影片有音軌、語音清晰', null, 'fortune');
            return;
        }

        const fortuneText = await translateFortuneText(recognizedText, duration);

        if (!fortuneText) {
            await replyToLine(replyToken, '❌ 翻譯處理失敗，請稍後再試', null, 'fortune');
            return;
        }

        await replyToLine(replyToken, fortuneText);

    } catch (error) {
        console.error('handleFortuneVideoMessage error:', error);
        if (error.message === 'QUOTA_EXCEEDED') {
            await replyToLine(event.replyToken, '❌ 免費額度已滿', null, 'fortune');
        } else if (error.message === 'VIDEO_TOO_LARGE') {
            await replyToLine(event.replyToken, '❌ 影片檔案太大（超過 20MB）\n請壓縮後重試', null, 'fortune');
        } else {
            await replyToLine(event.replyToken, '❌ 處理失敗，請重試', null, 'fortune');
        }
    }
}
