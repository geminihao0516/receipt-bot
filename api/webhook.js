// ============================================
// Line 收據 Bot - Vercel Serverless Function
// 使用 Gemini 2.5 Flash + Google Sheets
// ============================================

// === 設定（從環境變數讀取）===
const { google } = require('googleapis');

const CONFIG = {
    // === LINE API ===
    LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN,

    // === Gemini API ===
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,

    // === Gemini 模型設定（不同功能可用不同模型）===
    GEMINI_MODEL_RECEIPT: process.env.GEMINI_MODEL_RECEIPT || 'gemini-2.5-flash',   // 收據辨識
    GEMINI_MODEL_AUDIO: process.env.GEMINI_MODEL_AUDIO || 'gemini-2.5-flash',       // 語音辨識
    GEMINI_MODEL_AMULET: process.env.GEMINI_MODEL_AMULET || 'gemini-2.5-flash',     // 佛牌文案
    GEMINI_MODEL_FORTUNE: process.env.GEMINI_MODEL_FORTUNE || 'gemini-2.5-flash',   // 命理翻譯
    GEMINI_MODEL_PARSE: process.env.GEMINI_MODEL_PARSE || 'gemini-2.5-flash',       // 文字解析

    // === Google Sheets ===
    SPREADSHEET_ID: process.env.SPREADSHEET_ID,
    SHEET_NAME: '收據記錄',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    GOOGLE_PRIVATE_KEY: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n').replace(/"/g, ''),

    // === 限制常數 ===
    MAX_IMAGE_SIZE_MB: 4,
    MAX_AUDIO_SIZE_MB: 10,
    MAX_AUDIO_DURATION_MS: 60000,  // 一般語音記帳 60 秒限制
    MAX_LINE_MESSAGE_LENGTH: 4500  // LINE 限制 5000，保留 buffer
};

// === 智慧模型選擇 ===
function selectModel(task, context = {}) {
    const { duration = 0, hasUserInfo = false } = context;

    switch (task) {
        case 'audio':
            // 語音 > 60秒用 Pro
            return duration > 60000 ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
        case 'fortune':
            // 命理語音 > 3分鐘用 Pro
            return duration > 180000 ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
        case 'amulet':
            // 有用戶資訊用 Flash，沒有用 Pro（需要更多推測）
            return hasUserInfo ? 'gemini-2.5-flash' : 'gemini-2.5-pro';
        case 'receipt':
        case 'parse':
        default:
            return 'gemini-2.5-flash';
    }
}

// === 用戶模式追蹤（in-memory，Vercel 可能重啟會清空）===
// 格式: userId -> { mode: 'receipt' | 'amulet' | 'fortune', description: '暂存的文字描述' }
const userModeMap = new Map();

module.exports = async (req, res) => {
    // GET 請求：驗證用
    if (req.method === 'GET') {
        return res.status(200).json({ status: 'ok' });
    }

    // POST 請求：處理 Line 訊息
    if (req.method === 'POST') {
        // 輸出完整請求內容
        console.log('收到 Webhook 請求, events:', req.body?.events?.length || 0);
        const events = req.body?.events || [];
        console.log('Events 數量:', events.length);

        // 同步處理每個事件（必須在返回前完成）
        for (const event of events) {
            try {
                console.log('處理 event:', event.type, event.message?.type);
                if (event.type !== 'message') continue;

                const userId = event.source.userId || 'unknown';

                if (event.message.type === 'image') {
                    // 根據用戶模式決定處理方式
                    const userState = userModeMap.get(userId) || { mode: 'receipt' };
                    if (userState.mode === 'amulet') {
                        await handleAmuletImageMessage(event, userState.description || '');
                        userModeMap.delete(userId); // 處理完自動切回收據模式
                    } else {
                        await handleImageMessage(event);
                    }
                } else if (event.message.type === 'text') {
                    await handleTextMessage(event);
                } else if (event.message.type === 'audio') {
                    // 根據用戶模式決定處理方式
                    const userState = userModeMap.get(userId) || { mode: 'receipt' };
                    if (userState.mode === 'fortune') {
                        await handleFortuneAudioMessage(event);
                        userModeMap.delete(userId); // 處理完自動切回收據模式
                    } else {
                        await handleAudioMessage(event);
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

        // 從 Line 下載圖片
        const imageData = await getImageFromLine(messageId);

        // Gemini 2.5 Flash 辨識
        const receiptData = await recognizeReceipt(imageData);

        // 處理完全無法辨識的情況
        if (!receiptData) {
            await replyToLine(replyToken,
                '❌ 完全無法辨識，請確認：\n' +
                '1. 是否為收據照片\n' +
                '2. 照片是否清晰\n' +
                '3. 光線是否充足\n\n' +
                '❌ อ่านไม่ได้ กรุณาตรวจสอบ:\n' +
                '1. เป็นรูปใบเสร็จหรือไม่\n' +
                '2. รูปชัดหรือไม่\n' +
                '3. แสงเพียงพอหรือไม่'
            );
            return;
        }

        // 檢查是否有 note 說明問題
        if (receiptData.note && (
            receiptData.note.includes('模糊') ||
            receiptData.note.includes('無法辨識') ||
            receiptData.note.includes('不清楚')
        )) {
            await replyToLine(replyToken,
                `⚠️ 圖片品質問題\n${receiptData.note}\n\n` +
                '建議：\n' +
                '📸 重新拍攝清晰照片\n' +
                '✏️ 或手動輸入：師傅 品項 數量 單價'
            );
            return;
        }

        // 檢查是否有商品項目
        if (!receiptData.items || receiptData.items.length === 0) {
            // 有部分信息但沒有商品
            if (receiptData.master || receiptData.date) {
                await replyToLine(replyToken,
                    `⚠️ 只辨識到部分信息：\n` +
                    `店家：${receiptData.master || '未知'}\n` +
                    `日期：${receiptData.date || '未知'}\n\n` +
                    `無法辨識商品明細，請：\n` +
                    `📸 重新拍攝或\n` +
                    `✏️ 手動輸入明細`
                );
            } else {
                await replyToLine(replyToken, '❌ 辨識失敗，請重拍清晰照片\n❌ อ่านไม่ได้ ถ่ายใหม่ชัดๆนะ');
            }
            return;
        }

        // 辨識成功，格式化回覆
        const summary = formatSummary(receiptData);
        await replyToLine(replyToken, summary);

        // 寫入 Google Sheet
        await appendToSheet(receiptData);

    } catch (error) {
        console.error('handleImageMessage error:', error);

        // 處理特定錯誤類型
        if (error.message === 'QUOTA_EXCEEDED') {
            await replyToLine(event.replyToken,
                '❌ 免費額度已滿，請稍後再試\n' +
                '❌ เกินโควต้าแล้ว ลองใหม่ทีหลังนะ\n\n' +
                '💡 或手動輸入：師傅 品項 數量 單價\n' +
                '💡 หรือพิมพ์เอง: อาจารย์ ของ จำนวน ราคา'
            );
        } else if (error.message === 'IMAGE_TOO_LARGE') {
            await replyToLine(event.replyToken,
                '❌ 圖片檔案過大 (>4MB)\n' +
                '請壓縮後重新上傳\n\n' +
                '❌ ไฟล์ใหญ่เกินไป (>4MB)\n' +
                'กรุณาบีบอัดแล้วส่งใหม่'
            );
        } else {
            await replyToLine(event.replyToken,
                '❌ 系統錯誤，請稍後再試\n' +
                '❌ ผิดพลาด ลองใหม่ภายหลัง'
            );
        }
    }
}

// === 處理佛牌聖物圖片訊息 ===
async function handleAmuletImageMessage(event, userDescription = '') {
    try {
        const messageId = event.message.id;
        const replyToken = event.replyToken;

        // 從 Line 下載圖片
        const imageData = await getImageFromLine(messageId);

        console.log('📿 佛牌辨識，用戶描述:', userDescription || '(無)');

        // Gemini 辨識佛牌並生成文案（傳入用戶提供的描述）
        const amuletText = await recognizeAmulet(imageData, userDescription);

        if (!amuletText) {
            await replyToLine(replyToken,
                '❌ 無法辨識此圖片，請確認：\n' +
                '1. 是否為佛牌/聖物照片\n' +
                '2. 照片是否清晰\n' +
                '3. 光線是否充足\n\n' +
                '❌ อ่านไม่ได้ กรุณาตรวจสอบ:\n' +
                '1. เป็นรูปพระหรือไม่\n' +
                '2. รูปชัดหรือไม่\n' +
                '3. แสงเพียงพอหรือไม่\n\n' +
                '💡 可附上師父名稱/佛牌名重新傳送\n' +
                '💡 ส่งพร้อมชื่ออาจารย์/ชื่อพระได้'
            );
            return;
        }

        // 成功辨識，回傳文案（可能很長需要分段）
        const userId = event.source.userId || null;
        await replyToLine(replyToken, amuletText, userId);

    } catch (error) {
        console.error('handleAmuletImageMessage error:', error);

        if (error.message === 'QUOTA_EXCEEDED') {
            await replyToLine(event.replyToken,
                '❌ 免費額度已滿，請稍後再試\n' +
                '❌ เกินโควต้าแล้ว ลองใหม่ทีหลังนะ'
            );
        } else if (error.message === 'IMAGE_TOO_LARGE') {
            await replyToLine(event.replyToken,
                '❌ 圖片檔案過大 (>4MB)\n' +
                '請壓縮後重新上傳\n\n' +
                '❌ ไฟล์ใหญ่เกินไป (>4MB)\n' +
                'กรุณาบีบอัดแล้วส่งใหม่'
            );
        } else {
            await replyToLine(event.replyToken,
                '❌ 系統錯誤，請稍後再試\n' +
                '❌ ผิดพลาด ลองใหม่ภายหลัง'
            );
        }
    }
}

// === 處理命理語音翻譯訊息 ===
async function handleFortuneAudioMessage(event) {
    try {
        const messageId = event.message.id;
        const replyToken = event.replyToken;
        const duration = event.message.duration; // 語音長度（毫秒）

        console.log(`收到命理語音: ${messageId}, 長度: ${duration}ms`);

        // 語音長度不限制
        console.log(`📝 命理語音長度: ${(duration / 1000 / 60).toFixed(1)} 分鐘`);

        // 從 Line 下載語音
        const audioData = await getAudioFromLine(messageId);

        // Gemini 語音識別
        const recognizedText = await recognizeAudio(audioData);

        if (!recognizedText || recognizedText.trim() === '') {
            await replyToLine(replyToken,
                '❌ 無法識別語音，請重新錄製\n' +
                '建議：\n' +
                '1. 說話清晰\n' +
                '2. 環境安靜\n' +
                '3. 靠近麥克風\n\n' +
                '❌ ฟังไม่ชัด กรุณาอัดใหม่\n' +
                'คำแนะนำ:\n' +
                '1. พูดชัดๆ\n' +
                '2. ที่เงียบๆ\n' +
                '3. ใกล้ไมค์');
            return;
        }

        console.log(`✅ 命理語音識別成功，字數: ${recognizedText.length}`);

        // 使用命理老師提示詞進行翻譯（根據語音長度選擇模型）
        const fortuneText = await translateFortuneText(recognizedText, duration);

        if (!fortuneText) {
            await replyToLine(replyToken,
                '❌ 翻譯處理失敗，請稍後再試\n' +
                '❌ แปลไม่ได้ ลองใหม่ทีหลัง');
            return;
        }

        // 回傳翻譯結果
        await replyToLine(replyToken, fortuneText);

    } catch (error) {
        console.error('handleFortuneAudioMessage error:', error);
        if (error.message === 'QUOTA_EXCEEDED') {
            await replyToLine(event.replyToken,
                '❌ 免費額度已滿，請稍後再試\n' +
                '❌ เกินโควต้าแล้ว ลองใหม่ทีหลังนะ');
        } else if (error.message === 'AUDIO_TOO_LARGE') {
            await replyToLine(event.replyToken,
                '❌ 語音檔案太大\n' +
                '❌ ไฟล์เสียงใหญ่เกินไป');
        } else {
            await replyToLine(event.replyToken,
                '❌ 處理失敗，請重試\n' +
                '❌ ผิดพลาด ลองใหม่นะ');
        }
    }
}

// === Gemini 命理翻譯（台灣命理老師口吻）===
async function translateFortuneText(text, duration = 0) {
    const prompt = `【角色設定】

你是一位資深的台灣命理老師，長年從事一對一諮詢。說話風格親切穩重、不誇大、不渲染，語氣自然真誠，就像坐在緣主對面慢慢解說。你的重點是把話說清楚、說到心裡，而不是使用術語或理論名詞。

【核心任務】

我將提供一份來自泰國命理師的解讀素材，可能是語音逐字稿、泰文原文，或初步翻譯的中文內容。

請你完整理解該素材後，以素材本身的敘述順序與重點為主軸進行整理與重寫，轉化為一篇「台灣命理老師口吻」的一對一解說文。

全文長度約 800 至 1000 字，重點在於讓緣主聽得懂、聽得進去，而不是完整覆蓋所有命理面向。

【敘述視角與語氣】

全篇一律使用第二人稱，直接對緣主說話。

語氣需自然、沉穩、有節奏，貼近實際面對面諮詢時的說話方式，而非書面報告或教科書語氣。

可參考的自然說法例如：
「這一段時間你在工作上，會慢慢感覺到方向有些不一樣。」
「錢的部分，不是沒有進來，而是比較需要你自己顧好流向。」

【台灣語感指引】

可自然融入以下類型語感，但不需刻意每句都使用：
穩紮穩打、見好就收、順著走就好、不要太衝、量力而為、把話想過再說、慢慢來比較快

【內容組織原則（重要）】

一、內容段落的先後順序，必須以提供的檔案或音檔實際提到的順序為準，不可自行調整成固定模板。

二、若素材先談工作，再談感情或健康，請依該順序撰寫；若內容反覆穿插，請整理成語意連貫但不違背原意的段落。

三、下列面向僅作為「可能出現的主題參考」，不是必須完整涵蓋：
事業與工作、財運狀況、健康與生活、整體提醒與祝福。

四、素材未提及的面向，請直接略過，不需補寫或推論。

【嚴格禁用詞彙】

全文不得出現以下任何字詞：
資料、文本、原文、命盤、內容、文件、分析、顯示、指出

【禁止事項】

一、不可出現任何泰文。
若素材中有咒語或祝福語，僅可轉述為「這是一段祈福的話語，象徵平安與加持」。

二、不可虛構或補齊素材未提及的命理資訊。
只能在原有敘述基礎上進行語感轉化與順寫整理。

【格式限制】

一、全文僅使用純文字段落。
二、不使用任何 Markdown 語法或視覺標記。
三、不使用項目符號、編號列表或括號補充說明。
四、不使用 emoji 或特殊符號。

【語氣限制】

避免過度口語或聊天感的詞語，例如：
咱們、嘿嘿、來來來、 啦啦啦

不加入玩笑、流行語或與命理無關的閒聊。

【素材不足時的處理原則】

請嚴格以提供的素材為依據整理與轉述。
有提到的才寫，沒提到的就不寫，不補、不猜、不延伸。

【最終輸出要求】

請直接輸出完整解說文。
不加任何前言、說明或提示語。
文章結尾請以溫暖、穩定、具有方向感的提醒與祝福作結。

【素材內容】
${text}`;

    // 智慧選擇模型：> 3分鐘用 Pro
    const model = selectModel('fortune', { duration });
    console.log(`🔮 命理翻譯使用模型: ${model} (語音長度: ${(duration / 1000 / 60).toFixed(1)}分鐘)`);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.7,  // 適中創意度
                    maxOutputTokens: 4096  // 較長解說文
                }
            })
        });

        const result = await response.json();

        // 處理錯誤
        if (result.error) {
            console.error('❌ Gemini Fortune API 錯誤:', JSON.stringify(result.error, null, 2));
            if (result.error.code === 429 || result.error.status === 'RESOURCE_EXHAUSTED') {
                throw new Error('QUOTA_EXCEEDED');
            }
            return null;
        }

        if (!result.candidates || !result.candidates[0]) {
            console.error('❌ Gemini Fortune API 無回應');
            return null;
        }

        const fortuneText = result.candidates[0].content.parts[0].text;
        console.log('🔮 命理翻譯成功，字數:', fortuneText.length);

        return fortuneText;

    } catch (error) {
        if (error.message === 'QUOTA_EXCEEDED') throw error;
        console.error('❌ 命理翻譯錯誤:', error);
        return null;
    }
}


// === Gemini 佛牌聖物辨識與文案生成 ===
async function recognizeAmulet(imageData, userDescription = '') {
    const { buffer: imageBuffer, mimeType } = imageData;
    const sizeInMB = imageBuffer.length / (1024 * 1024);

    // 檢查圖片大小
    if (sizeInMB > 4) {
        console.warn(`⚠️ 圖片過大: ${sizeInMB.toFixed(2)}MB`);
        throw new Error('IMAGE_TOO_LARGE');
    }

    const base64Image = imageBuffer.toString('base64');

    // 用戶提供的資訊區塊（如果有）
    const userInfoSection = userDescription
        ? `\n【用戶提供的資訊 - 請優先參考】\n${userDescription}\n\n請務必將用戶提供的師父名稱、佛牌名稱、功效等資訊融入文案中！\n`
        : '';

    // 專業佛牌聖物文案提示詞
    const prompt = `你是一位「泰國佛牌聖物與法事翻譯」專家，兼具「宗教文化顧問」及「跨市場在地化行銷編輯」身份。
${userInfoSection}
【重要格式規範】
⚠️ 文案將用於LINE發送，請嚴格遵守：
→ 禁止Markdown語法（無粗體、標題符號、項目符號）
→ 使用表情符號（✨🙏📿💰⚠️）作為段落區隔
→ 每段控制3-5行，總字數800-1200字
→ 條列項目用①②③或→開頭，不用「-」「•」「*」

【核心原則】
① 文化尊重：基於泰國宗教文化，避免過度神化或不實宣傳
② 資訊透明：當圖像資訊不足時，明確標示「根據法相/風格推測」

【圖像分析】
請根據圖片完成以下分析：

「聖物鑑別」
→ 類別：佛牌（正牌/陰牌）、符管、冠蘭聖物、法刀、路翁、魂魄勇或其他
→ 法相/主題：崇迪、必打、四面神、象神、澤度金、坤平將軍、古曼童、人緣鳥等

「師父與法脈」
→ 從僧袍顏色、刺符圖案、特定標記推測師父身份或法脈
→ 判斷是佛寺法會還是阿贊私人法壇

「材質與工藝」
→ 主要材料：經粉、廟土、香灰、金屬（銅、銀、阿巴嘎）、草藥、聖木、特殊料
→ 風格：古樸、華麗、寫實，以及新舊程度

「功效推論」
→ 法相＋師父法門＋加持儀式＋材料＝主要功效

【輸出格式】

✨[功效關鍵詞] + [聖物類型] ✨
[師父/寺廟名] 佛曆[年份] [版本/材質]

🙏 師父傳承
（40-60字：師父修行背景、擅長法門，建立權威性）

📿 聖物故事
（80-120字：製作緣起、材料特殊之處、加持過程的神聖與嚴謹）

💰 傳統功效
① 財運事業：正財、偏財、攬客、助生意
② 人緣魅力：異性緣、桃花、貴人運
③ 避險擋災：擋降、避官非、防小人

👤 適合對象
① （具體情境1）
② （具體情境2）
③ （具體情境3）

🔮 材質用料
（列出可辨識材料，若推測請註明「據信加入」）

📖 佩戴方式
→ 佩戴位置
→ 注意事項

🔸 心咒
先唸三遍：
納摩達薩 帕嘎瓦多 阿拉哈多 三藐三菩陀薩

再唸X遍：
（繁體中文音譯心咒，若無特定心咒則註明：誠心默念祈願即可）

⚠️ 注意事項
① 正牌不可佩戴低於腰部
② 洗澡、就寢時建議取下以示尊重
③ （其他適用注意事項）

【寫作原則】
✅ 無法確認的資訊標註「依外觀推測」「據信」
✅ 使用「信眾認為」「相傳」避免絕對承諾
❌ 避免保證靈驗、必定成功等誇大詞彙
❌ 不虛構不存在的師父或寺廟`;

    // 智慧選擇模型：有用戶資訊用 Flash，否則用 Pro
    const hasUserInfo = userDescription && userDescription.trim().length > 0;
    const model = selectModel('amulet', { hasUserInfo });
    console.log(`📿 佛牌文案使用模型: ${model} (有用戶資訊: ${hasUserInfo})`);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: prompt },
                        { inline_data: { mime_type: mimeType, data: base64Image } }
                    ]
                }],
                generationConfig: {
                    temperature: 0.7,  // 稍高一點以增加文案創意
                    maxOutputTokens: 4096  // 較長文案
                }
            })
        });

        const result = await response.json();

        // 處理 429 Rate Limit
        if (result.error) {
            console.error('❌ Gemini Amulet API 錯誤:', JSON.stringify(result.error, null, 2));
            if (result.error.code === 429 || result.error.status === 'RESOURCE_EXHAUSTED') {
                throw new Error('QUOTA_EXCEEDED');
            }
            return null;
        }

        if (!result.candidates || !result.candidates[0]) {
            console.error('❌ Gemini Amulet API 無回應');
            return null;
        }

        const finishReason = result.candidates[0].finishReason;
        if (finishReason === 'SAFETY') {
            console.error('❌ 內容被安全過濾器阻擋');
            return null;
        }

        const amuletText = result.candidates[0].content.parts[0].text;
        console.log('📿 佛牌文案生成成功，字數:', amuletText.length);

        return amuletText;

    } catch (error) {
        if (error.message === 'QUOTA_EXCEEDED' || error.message === 'IMAGE_TOO_LARGE') throw error;
        console.error('❌ 佛牌辨識錯誤:', error);
        return null;
    }
}

// === Quick Reply 按鈕定義 ===
const QUICK_REPLY_ITEMS = {
    items: [
        {
            type: 'action',
            action: {
                type: 'camera',
                label: '📷 拍收據 / ถ่ายรูป'
            }
        },
        {
            type: 'action',
            action: {
                type: 'cameraRoll',
                label: '🖼️ 傳照片 / รูปภาพ'
            }
        },
        {
            type: 'action',
            action: {
                type: 'message',
                label: '📿 佛牌文案 / พระ',
                text: '佛牌'
            }
        },
        {
            type: 'action',
            action: {
                type: 'message',
                label: '🎙️ 語音 / เสียง',
                text: '語音'
            }
        },
        {
            type: 'action',
            action: {
                type: 'message',
                label: '🔮 語音翻譯 / แปล',
                text: '語音翻譯'
            }
        },
        {
            type: 'action',
            action: {
                type: 'message',
                label: '❓ 說明 / คู่มือ',
                text: '說明'
            }
        }
    ]
};

// === 處理文字訊息 ===
async function handleTextMessage(event) {
    try {
        const text = event.message.text.trim();
        const replyToken = event.replyToken;

        console.log('收到文字訊息:', text);

        // 說明指令 (Help / Guide)
        if (['?', '？', '說明', 'คู่มือ'].includes(text)) {
            await replyToLine(replyToken,
                '📖 使用說明 / คู่มือ\n\n' +
                '📷 拍照記帳 → 拍收據 AI 辨識\n' +
                '📿 佛牌文案 → 拍佛牌 AI 寫文案\n' +
                '🎙️ 語音記帳 → 錄語音 AI 辨識後記帳\n' +
                '🔮 語音翻譯 → 命理語音翻成中文解說\n' +
                '✏️ 文字記帳 → 師傅 品項 數量 單價\n\n' +
                '📷 ถ่ายรูปใบเสร็จ → AI อ่านให้\n' +
                '📿 ถ่ายรูปพระ → AI เขียนบทความ\n' +
                '🎙️ อัดเสียง → AI ฟังแล้วบันทึก\n' +
                '🔮 แปลเสียง → แปลโหราศาสตร์เป็นจีน\n' +
                '✏️ พิมพ์ → อาจารย์ ของ จำนวน ราคา\n\n' +
                '👇 點按鈕開始 / กดปุ่มเลย');
            return;
        }

        // 語音教學指令 (Voice Guide)
        if (['語音', 'เสียง'].includes(text)) {
            await replyToLine(replyToken,
                '🎙️ 語音記帳教學\n\n' +
                '① 點輸入框旁的「🎤」\n' +
                '② 按住說話\n' +
                '③ 放開發送\n\n' +
                '💬 範例：「阿贊南奔 金箔 十個 五百」\n\n' +
                '🎙️ วิธีอัดเสียง\n\n' +
                '① กดไอคอน「🎤」\n' +
                '② กดค้างพูด\n' +
                '③ ปล่อยส่ง\n\n' +
                '💬 ตัวอย่าง: "หลวงปู่ทวด ทอง 10 500"');
            return;
        }

        // 佛牌文案模式（點擊後下一張圖片會辨識佛牌）
        if (['佛牌', 'พระ', 'พระเครื่อง'].includes(text)) {
            const userId = event.source.userId || 'unknown';
            userModeMap.set(userId, { mode: 'amulet', description: '' });
            await replyToLine(replyToken,
                '📿 佛牌聖物文案模式\n\n' +
                '① 先傳文字（可選）\n' +
                '→ 師父名稱、佛牌名、功效\n\n' +
                '② 再傳佛牌照片\n' +
                '→ AI 合併資訊生成文案\n\n' +
                '① พิมพ์ข้อมูล (ถ้ามี)\n' +
                '→ ชื่ออาจารย์ ชื่อพระ พุทธคุณ\n\n' +
                '② ส่งรูปพระ\n\n' +
                '💡 輸入「取消」可退出\n' +
                '💡 พิมพ์ "ยกเลิก" เพื่อออก');
            return;
        }

        // 語音翻譯模式（點擊後上傳的語音會進行命理解讀翻譯）
        if (['語音翻譯', 'แปล', 'แปลเสียง'].includes(text)) {
            const userId = event.source.userId || 'unknown';
            userModeMap.set(userId, { mode: 'fortune', description: '' });
            await replyToLine(replyToken,
                '🔮 語音翻譯模式\n\n' +
                '請上傳命理語音檔案（m4a）\n' +
                'AI 會將內容轉化為台灣命理老師解說文\n\n' +
                '🔮 โหมดแปลเสียง\n\n' +
                'อัปโหลดไฟล์เสียงโหราศาสตร์ (m4a)\n' +
                'AI จะแปลเป็นคำอธิบายของครูโหราศาสตร์\n\n' +
                '💡 輸入「取消」可退出\n' +
                '💡 พิมพ์ "ยกเลิก" เพื่อออก');
            return;
        }

        // 取消佛牌模式
        if (['取消', 'ยกเลิก', 'cancel'].includes(text.toLowerCase())) {
            const userId = event.source.userId || 'unknown';
            if (userModeMap.has(userId)) {
                userModeMap.delete(userId);
                await replyToLine(replyToken,
                    '✅ 已取消佛牌模式\n' +
                    '✅ ยกเลิกโหมดพระแล้ว\n\n' +
                    '請點選下方按鈕繼續使用\n' +
                    'กดปุ่มด้านล่างเพื่อใช้งานต่อ');
                return;
            }
        }

        // 檢查是否在佛牌模式下傳文字（暂存描述）
        const userId = event.source.userId || 'unknown';
        const userState = userModeMap.get(userId);
        if (userState && userState.mode === 'amulet') {
            // 靜默暫存用戶提供的文字描述（不回覆，省 LINE 訊息次數）
            userState.description = (userState.description ? userState.description + '\n' : '') + text;
            userModeMap.set(userId, userState);
            console.log(`� 佛牌模式靜默暫存: ${text}`);
            // 不回覆，等圖片一起處理
            return;
        }

        // 範例指令 (Example)
        if (['範例', 'ตัวอย่าง'].includes(text)) {
            await replyToLine(replyToken,
                '💡 輸入範例 (可直接複製) / ตัวอย่าง:\n\n' +
                '🔻 中文格式 / รูปแบบจีน:\n' +
                '阿贊南奔 金箔 10 500\n\n' +
                '🔻 泰文格式 / รูปแบบไทย:\n' +
                'หลวงปู่ทวด ทอง 10 500\n' +
                '(Bot 會自動翻譯 / ระบบจะแปลภาษาให้)\n\n' +
                '✨ 試試看吧！ / ลองดูนะครับ');
            return;
        }

        // 先嘗試本地解析（節省 API 調用）
        let data = parseTextLocally(text);

        // 如果本地解析失敗，才使用 Gemini API
        if (!data) {
            console.log('本地解析失敗，使用 Gemini API');
            data = await parseTextWithGemini(text);
        } else {
            console.log('✅ 本地解析成功，節省 API 調用');
        }

        if (data && data.items && data.items.length > 0) {
            const summary = formatSummary(data);
            await replyToLine(replyToken, summary);

            // 寫入 Google Sheet
            await appendToSheet(data);
        } else {
            // 無法解析為記帳資料，給予用戶提示
            console.log('文字無法解析為收據:', text);
            await replyToLine(replyToken,
                '⚠️ 無法解析為記帳資料\n\n' +
                '請使用以下格式：\n' +
                '師傅名 品項 數量 單價\n\n' +
                '範例：\n' +
                '• 阿贊南奔 金箔 10 500\n' +
                '• หลวงปู่ทวด ทอง 10 500\n\n' +
                '⚠️ ไม่ใช่ข้อมูลบัญชี\n\n' +
                'รูปแบบที่ถูกต้อง:\n' +
                'อาจารย์ รายการ จำนวน ราคา\n\n' +
                'ตัวอย่าง:\n' +
                '• หลวงปู่ทวด ทอง 10 500\n' +
                '• อาจารย์นำบุญ ทองคำ 5 1000\n\n' +
                '💡 或點擊「範例」查看更多格式\n' +
                '💡 หรือกด "ตัวอย่าง" ดูเพิ่มเติม'
            );
        }

    } catch (error) {
        console.error('handleTextMessage error:', error);
        if (error.message === 'QUOTA_EXCEEDED') {
            await replyToLine(event.replyToken, '❌ 額度已滿 / เกินโควต้าแล้ว');
        }
    }
}

// === 處理語音訊息 ===
async function handleAudioMessage(event) {
    try {
        const messageId = event.message.id;
        const replyToken = event.replyToken;
        const duration = event.message.duration; // 語音長度（毫秒）

        console.log(`收到語音訊息: ${messageId}, 長度: ${duration}ms`);

        // 檢查語音長度（避免太長的語音）
        if (duration > CONFIG.MAX_AUDIO_DURATION_MS) {
            await replyToLine(replyToken,
                '⚠️ 語音太長，請控制在 60 秒內\n' +
                '⚠️ เสียงยาวเกินไป กรุณาไม่เกิน 60 วินาที'
            );
            return;
        }

        // 注意：不要在這裡發送"處理中"訊息！
        // LINE Reply Token 只能使用一次，要保留給最終結果

        // 從 Line 下載語音
        const audioData = await getAudioFromLine(messageId);

        // Gemini 語音識別（支援中文+泰文）
        const recognizedText = await recognizeAudio(audioData);

        if (!recognizedText || recognizedText.trim() === '') {
            await replyToLine(replyToken,
                '❌ 無法識別語音，請重新錄製\n' +
                '建議：\n' +
                '1. 說話清晰\n' +
                '2. 環境安靜\n' +
                '3. 靠近麥克風\n\n' +
                '❌ ฟังไม่ชัด กรุณาอัดใหม่\n' +
                'คำแนะนำ:\n' +
                '1. พูดชัดๆ\n' +
                '2. ที่เงียบๆ\n' +
                '3. ใกล้ไมค์'
            );
            return;
        }

        console.log(`✅ 語音識別成功: ${recognizedText}`);

        // 使用現有的文字解析流程
        const data = await parseTextWithGemini(recognizedText);

        if (data && data.items && data.items.length > 0) {
            const summary = formatSummary(data);
            await replyToLine(replyToken,
                `🎤 語音識別結果：\n"${recognizedText}"\n\n` +
                summary
            );

            // 寫入 Google Sheet
            await appendToSheet(data);
        } else {
            // 無法解析為記帳資料，回傳識別的文字
            await replyToLine(replyToken,
                `🎤 語音識別：\n"${recognizedText}"\n\n` +
                '⚠️ 無法解析為記帳資料\n' +
                '格式範例：師傅名 品項 數量 單價\n\n' +
                '⚠️ ไม่ใช่ข้อมูลบัญชี\n' +
                'ตัวอย่าง: อาจารย์ ของ จำนวน ราคา'
            );
        }

    } catch (error) {
        console.error('handleAudioMessage error:', error);
        if (error.message === 'QUOTA_EXCEEDED') {
            await replyToLine(event.replyToken,
                '❌ 免費額度已滿，請稍後再試\n' +
                '❌ เกินโควต้าแล้ว ลองใหม่ทีหลังนะ'
            );
        } else if (error.message === 'AUDIO_TOO_LARGE') {
            await replyToLine(event.replyToken,
                '❌ 語音檔案太大\n' +
                '❌ ไฟล์เสียงใหญ่เกินไป'
            );
        } else {
            await replyToLine(event.replyToken,
                '❌ 語音識別失敗，請重試\n' +
                '❌ ฟังไม่ได้ ลองใหม่นะ'
            );
        }
    }
}

// === 本地解析文字（節省 API 調用）===
function parseTextLocally(text) {
    try {
        // 清理文字
        text = text.trim();

        // 檢測泰文：如果包含泰文字符，強制使用 Gemini 翻譯
        const thaiPattern = /[\u0E00-\u0E7F]/;
        if (thaiPattern.test(text)) {
            console.log('📝 偵測到泰文輸入，使用 Gemini 翻譯成繁體中文(泰文)格式');
            return null;  // 返回 null 讓 Gemini 處理翻譯
        }

        // 嘗試多種常見格式
        // 格式1: 師傅 品項 數量 單價 (空格分隔)
        // 格式2: 師傅 品項 數量*單價
        // 格式3: 師傅,品項,數量,單價 (逗號分隔)

        // 移除多餘空格
        const normalized = text.replace(/\s+/g, ' ');

        // 嘗試匹配: 任意文字 任意文字 數字 數字
        // 例如: "阿贊南奔 金箔 10 500"
        const pattern1 = /^(.+?)\s+(.+?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/;
        const match1 = normalized.match(pattern1);

        if (match1) {
            const [, master, itemName, qty, price] = match1;
            const quantity = parseFloat(qty);
            const unitPrice = parseFloat(price);
            const total = quantity * unitPrice;

            console.log(`📝 本地解析成功: 師傅=${master}, 品項=${itemName}, 數量=${quantity}, 單價=${unitPrice}`);

            return {
                date: '',  // 留空，會在 appendToSheet 自動填入今天
                master: master.trim(),
                items: [{
                    name: itemName.trim(),
                    qty: quantity,
                    price: unitPrice,
                    total: total
                }],
                note: ''
            };
        }

        // 嘗試匹配: 品項 數量 單價 (沒有師傅名)
        // 例如: "金箔 10 500"
        const pattern2 = /^(.+?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/;
        const match2 = normalized.match(pattern2);

        if (match2) {
            const [, itemName, qty, price] = match2;
            const quantity = parseFloat(qty);
            const unitPrice = parseFloat(price);
            const total = quantity * unitPrice;

            console.log(`📝 本地解析成功 (無師傅): 品項=${itemName}, 數量=${quantity}, 單價=${unitPrice}`);

            return {
                date: '',
                master: '',  // 沒有師傅名
                items: [{
                    name: itemName.trim(),
                    qty: quantity,
                    price: unitPrice,
                    total: total
                }],
                note: ''
            };
        }

        // 無法用簡單正則匹配，返回 null
        console.log('❌ 本地解析失敗，格式不符合簡單模式');
        return null;

    } catch (error) {
        console.error('本地解析錯誤:', error);
        return null;
    }
}

// === Gemini 解析文字指令 (新功能) ===
async function parseTextWithGemini(text) {
    const prompt = `你是一個收據記帳助手。請分析使用者的輸入文字，並轉換成 JSON 格式。
使用者輸入：${text}

**最重要規則：泰文必須翻譯成繁體中文！**

翻譯規則：
1. 所有泰文都必須翻譯成「繁體中文(泰文原文)」格式
2. 師傅名翻譯範例：
   - หลวงปู่ทวด → 龍波(หลวงปู่ทวด)
   - อาจารย์นำบุญ → 阿贊南奔(อาจารย์นำบุญ)
   - หลวงพ่อ → 龍婆(หลวงพ่อ)
3. 品項翻譯範例：
   - ทอง → 金(ทอง)
   - ทองคำ → 金箔(ทองคำ)
   - ตะกรุด → 符管(ตะกรุด)
   - พระ → 佛牌(พระ)
4. 英文縮寫：Lp→龍波, Aj→阿贊, Phra→帕
5. 品項名稱要簡短，不超過20字
6. **日期規則**：使用者輸入中如果沒有明確日期，填空字串""，不要猜測！
7. 如果只有文字沒數字，這可能不是記帳指令，請回傳 null

回傳 JSON 格式：
{
  "date": "YYYY-MM-DD 或空字串",
  "master": "繁體中文(泰文)",
  "items": [{"name": "繁體中文(泰文)", "qty": 數量, "price": 單價, "total": 總額}],
  "note": ""
}
沒數量填1，沒單價用總額。只回純 JSON，不要 markdown。`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL_PARSE}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 1024,
                    responseMimeType: "application/json"
                }
            })
        });

        const result = await response.json();

        // 處理 Quota 錯誤
        if (result.error) {
            if (result.error.code === 429 || result.error.status === 'RESOURCE_EXHAUSTED') {
                throw new Error('QUOTA_EXCEEDED');
            }
            console.error('Gemini Text API error:', result.error);
            return null;
        }

        if (!result.candidates || !result.candidates[0]) return null;

        const rawText = result.candidates[0].content.parts[0].text;
        console.log('Gemini 文字解析原始回應:', rawText.substring(0, 200) + '...');

        return extractJSON(rawText, '文字解析');

    } catch (error) {
        if (error.message === 'QUOTA_EXCEEDED') throw error;
        console.error('Gemini Text Parse Error:', error);
        return null;
    }
}

// === 從 Line 下載圖片 ===
async function getImageFromLine(messageId) {
    const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`
        }
    });

    // 檢查 LINE API 回應
    if (!response.ok) {
        console.error(`❌ LINE 圖片下載失敗: ${response.status} ${response.statusText}`);
        throw new Error('LINE_API_ERROR');
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const imageBuffer = Buffer.from(await response.arrayBuffer());

    console.log(`下載圖片: ${(imageBuffer.length / 1024).toFixed(2)}KB, MIME: ${contentType}`);

    return { buffer: imageBuffer, mimeType: contentType };
}

// === 從 Line 下載語音 ===
async function getAudioFromLine(messageId) {
    const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`
        }
    });

    // 檢查 LINE API 回應
    if (!response.ok) {
        console.error(`❌ LINE 語音下載失敗: ${response.status} ${response.statusText}`);
        throw new Error('LINE_API_ERROR');
    }

    const rawContentType = response.headers.get('content-type') || 'audio/m4a';
    const audioBuffer = Buffer.from(await response.arrayBuffer());

    // 轉換 MIME type：LINE 的 audio/x-m4a 和 audio/m4a 需轉換為 Gemini 支援的 audio/mp4
    let contentType = rawContentType;
    if (rawContentType.includes('m4a') || rawContentType.includes('aac')) {
        contentType = 'audio/mp4';
        console.log(`🔄 MIME 轉換: ${rawContentType} → ${contentType}`);
    }

    console.log(`下載語音: ${(audioBuffer.length / 1024).toFixed(2)}KB, 原始MIME: ${rawContentType}, 使用MIME: ${contentType}`);

    // 檢查檔案大小
    const sizeInMB = audioBuffer.length / (1024 * 1024);
    if (sizeInMB > CONFIG.MAX_AUDIO_SIZE_MB) {
        throw new Error('AUDIO_TOO_LARGE');
    }

    return { buffer: audioBuffer, mimeType: contentType };
}

// === Gemini 語音識別（支援中文+泰文）===
async function recognizeAudio(audioData) {
    const { buffer: audioBuffer, mimeType } = audioData;
    const base64Audio = audioBuffer.toString('base64');

    const prompt = `請將這段語音轉換成文字。

語言：可能是繁體中文、泰文或兩者混合
要求：
1. 準確轉錄所有聽到的內容
2. 保持原語言，不要翻譯
3. 如果同時有中文和泰文，都要寫出來
4. 去掉語氣詞（嗯、啊等）

只回傳轉錄的文字，不要有其他說明。`;

    // 使用 Gemini 2.5 Flash
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL_AUDIO}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: prompt },
                        { inline_data: { mime_type: mimeType, data: base64Audio } }
                    ]
                }],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 1024
                }
            })
        });

        const result = await response.json();

        console.log('📥 Gemini 語音 API 回應狀態:', response.status);

        // 處理錯誤
        if (result.error) {
            console.error('❌ Gemini 語音 API 錯誤:', JSON.stringify(result.error, null, 2));
            if (result.error.code === 429 || result.error.status === 'RESOURCE_EXHAUSTED') {
                throw new Error('QUOTA_EXCEEDED');
            }
            // 格式不支援的錯誤
            if (result.error.message && result.error.message.includes('Unsupported')) {
                console.error('❌ 音訊格式不支援:', mimeType);
            }
            return null;
        }

        if (!result.candidates || !result.candidates[0]) {
            console.error('❌ Gemini 語音 API 無回應，完整結果:', JSON.stringify(result, null, 2));
            return null;
        }

        // 檢查 finishReason
        const finishReason = result.candidates[0].finishReason;
        if (finishReason === 'SAFETY') {
            console.error('❌ 語音內容被安全過濾器阻擋');
            return null;
        }

        if (!result.candidates[0].content || !result.candidates[0].content.parts || !result.candidates[0].content.parts[0]) {
            console.error('❌ Gemini 語音 API 回應格式異常:', JSON.stringify(result.candidates[0], null, 2));
            return null;
        }

        const recognizedText = result.candidates[0].content.parts[0].text.trim();
        console.log('📝 Gemini 語音識別成功:', recognizedText);

        return recognizedText;

    } catch (error) {
        if (error.message === 'QUOTA_EXCEEDED') throw error;
        console.error('❌ 語音識別錯誤:', error.message || error);
        console.error('❌ 錯誤堆疊:', error.stack);
        return null;
    }
}

// === Gemini 2.5 Flash 辨識 ===
async function recognizeReceipt(imageData) {
    const { buffer: imageBuffer, mimeType } = imageData;
    const sizeInMB = imageBuffer.length / (1024 * 1024);

    // 檢查圖片大小
    if (sizeInMB > 4) {
        console.warn(`⚠️ 圖片過大: ${sizeInMB.toFixed(2)}MB (建議 < 4MB)`);
        throw new Error('IMAGE_TOO_LARGE');
    }

    if (sizeInMB < 0.01) {
        console.warn(`⚠️ 圖片過小: ${(sizeInMB * 1024).toFixed(2)}KB，可能無法辨識`);
    }

    const base64Image = imageBuffer.toString('base64');

    const prompt = `辨識收據，回傳簡潔的JSON。

規則：
1. 必須回傳JSON，即使模糊也要盡力辨識
2. 泰文翻譯成中文，簡化格式：「中文(泰文)」，不要太長
3. 品項名稱要簡短，去掉多餘描述
4. Lp→龍波, Aj→阿贊, Phra→帕
5. **日期規則**：只有在收據上清楚看到日期時才填寫，否則填空字串""，不要猜測！

JSON格式（盡量簡潔）：
{
  "date": "YYYY-MM-DD 或 空字串（看不到日期時）",
  "master": "店家名",
  "items": [{"name": "品項", "qty": 1, "price": 0, "total": 0}],
  "note": ""
}

範例：
{"date":"2024-01-15","master":"阿贊南奔","items":[{"name":"金箔","qty":10,"price":500,"total":5000}],"note":""}
{"date":"","master":"龍波","items":[{"name":"符管","qty":1,"price":1000,"total":1000}],"note":"收據無日期"}

重要：
- 品項名稱不要超過20字
- 日期如果看不清楚，填空字串""，不要隨便猜！`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL_RECEIPT}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                parts: [
                    { text: prompt },
                    { inline_data: { mime_type: mimeType, data: base64Image } }
                ]
            }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 8192,  // 增加到 8192 以處理複雜收據
                responseMimeType: "application/json"
            }
        })
    });

    const result = await response.json();

    // 處理 429 Rate Limit (Quota Exceeded)
    if (result.error) {
        console.error('❌ Gemini API 錯誤:', JSON.stringify(result.error, null, 2));
        if (result.error.code === 429 || result.error.status === 'RESOURCE_EXHAUSTED') {
            throw new Error('QUOTA_EXCEEDED');
        }
        console.error('❌ Gemini 返回錯誤，無法辨識');
        return null;
    }

    if (!result.candidates || !result.candidates[0]) {
        console.error('❌ Gemini API 回應格式錯誤（無 candidates）');
        console.error('完整回應:', JSON.stringify(result, null, 2));
        return null;
    }

    // 檢查 finishReason（可能被過濾或截斷）
    const finishReason = result.candidates[0].finishReason;
    if (finishReason && finishReason !== 'STOP') {
        console.warn(`⚠️ Gemini finishReason: ${finishReason}`);
        if (finishReason === 'SAFETY') {
            console.error('❌ 內容被安全過濾器阻擋');
            return null;
        }
        if (finishReason === 'MAX_TOKENS') {
            console.warn('⚠️ 輸出被截斷（內容太長），嘗試解析不完整的 JSON');
            // 繼續嘗試解析，可能可以部分成功
        }
    }

    const rawText = result.candidates[0].content.parts[0].text;
    console.log('📝 Gemini 圖片辨識原始回應:', rawText);

    // 如果是 MAX_TOKENS，嘗試修復被截斷的 JSON
    if (finishReason === 'MAX_TOKENS') {
        const repaired = repairTruncatedJSON(rawText);
        if (repaired) {
            console.log('✅ 成功修復被截斷的 JSON');
            return repaired;
        }
    }

    // 改進的 JSON 解析邏輯
    return extractJSON(rawText, '圖片辨識');
}

// === 修復被截斷的 JSON（處理 MAX_TOKENS 錯誤）===
function repairTruncatedJSON(rawText) {
    try {
        console.log('🔧 嘗試修復被截斷的 JSON...');

        // 移除尾部不完整的內容，補上必要的結束符號
        let repaired = rawText.trim();

        // 計算未閉合的括號數量
        let openBraces = (repaired.match(/\{/g) || []).length;
        let closeBraces = (repaired.match(/\}/g) || []).length;
        let openBrackets = (repaired.match(/\[/g) || []).length;
        let closeBrackets = (repaired.match(/\]/g) || []).length;

        // 移除最後一個不完整的 key-value 對
        // 例如：..."qty": 會被移除
        repaired = repaired.replace(/,?\s*"[^"]*"\s*:\s*[^,\}\]]*$/, '');

        // 補齊缺少的括號
        const bracesToAdd = openBrackets - closeBrackets;
        const bracesToAddBraces = openBraces - closeBraces;

        for (let i = 0; i < bracesToAdd; i++) {
            repaired += ']';
        }
        for (let i = 0; i < bracesToAddBraces; i++) {
            repaired += '}';
        }

        console.log('🔧 修復後的 JSON:', repaired.substring(0, 300) + '...');

        // 嘗試解析修復後的 JSON
        const parsed = JSON.parse(repaired);

        // 添加警告訊息到 note
        if (!parsed.note) {
            parsed.note = '⚠️ 收據內容太長，部分商品可能未完整辨識';
        } else {
            parsed.note = parsed.note + ' (部分內容被截斷)';
        }

        return parsed;

    } catch (e) {
        console.error('❌ JSON 修復失敗:', e.message);
        return null;
    }
}

// === 提取和解析 JSON（通用函數）===
function extractJSON(rawText, source = 'API') {
    // 嘗試 1: 直接解析（Gemini 通常會直接返回 JSON）
    try {
        const parsed = JSON.parse(rawText);
        console.log(`✅ ${source} JSON 解析成功 (直接解析)`);
        return parsed;
    } catch (e) {
        // 不是純 JSON，繼續下一步
    }

    // 嘗試 2: 提取 JSON 區塊（處理包含額外文字的情況）
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            console.log(`✅ ${source} JSON 解析成功 (提取後解析)`);
            return parsed;
        } catch (e) {
            console.error(`❌ ${source} JSON 提取後解析失敗:`, e.message);
            console.error('提取的內容:', jsonMatch[0].substring(0, 200));
        }
    }

    // 解析失敗
    console.error(`❌ ${source} 未找到有效的 JSON`);
    console.error('原始回應:', rawText);
    return null;
}



// === 格式化摘要 ===
function formatSummary(data) {
    let total = 0;
    let itemList = '';

    for (const item of data.items) {
        total += item.total;
        itemList += `${item.name}×${item.qty}=${item.total.toLocaleString()}\n`;
    }

    // 如果沒有師傅名，顯示「記帳成功」
    const header = data.master ? `✅ ${data.master}` : '✅ 記帳成功 / บันทึกแล้ว';
    return `${header}\n${itemList}💰 ${total.toLocaleString()}`;
}

// === 回覆 Line ===
async function replyToLine(replyToken, message, userId = null) {
    const MAX_LENGTH = CONFIG.MAX_LINE_MESSAGE_LENGTH;

    console.log('正在回覆:', replyToken.substring(0, 20) + '...', `訊息長度: ${message.length} 字`);

    // 如果訊息太長，需要分段發送
    if (message.length > MAX_LENGTH) {
        console.log(`⚠️ 訊息超過 ${MAX_LENGTH} 字，將分段發送`);
        const segments = splitMessage(message, MAX_LENGTH);

        // 第一段用 reply API
        await sendReply(replyToken, segments[0], true);

        // 後續段落用 push API（需要 userId）
        if (segments.length > 1 && userId) {
            for (let i = 1; i < segments.length; i++) {
                const isLast = (i === segments.length - 1);
                await sendPush(userId, segments[i], isLast);
            }
        }
    } else {
        await sendReply(replyToken, message, true);
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

        // 在 maxLength 內找最後一個換行符號分割，避免文字被切在中間
        let splitIndex = remaining.lastIndexOf('\n', maxLength);
        if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
            // 找不到合適換行，直接在 maxLength 處切
            splitIndex = maxLength;
        }

        segments.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex).trimStart();
    }

    console.log(`📝 訊息分成 ${segments.length} 段`);
    return segments;
}

// === Reply API（使用 replyToken）===
async function sendReply(replyToken, message, includeQuickReply = false) {
    const url = 'https://api.line.me/v2/bot/message/reply';

    const messageObj = {
        type: 'text',
        text: message
    };
    if (includeQuickReply) {
        messageObj.quickReply = QUICK_REPLY_ITEMS;
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`
            },
            body: JSON.stringify({
                replyToken: replyToken,
                messages: [messageObj]
            })
        });

        const result = await response.text();
        console.log('Line Reply API 回應:', response.status, result);

        if (!response.ok) {
            console.error('Line Reply API 錯誤:', response.status, result);
        }
    } catch (error) {
        console.error('sendReply 錯誤:', error);
    }
}

// === Push API（主動發送，不需 replyToken）===
async function sendPush(userId, message, includeQuickReply = false) {
    const url = 'https://api.line.me/v2/bot/message/push';

    const messageObj = {
        type: 'text',
        text: message
    };
    if (includeQuickReply) {
        messageObj.quickReply = QUICK_REPLY_ITEMS;
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`
            },
            body: JSON.stringify({
                to: userId,
                messages: [messageObj]
            })
        });

        const result = await response.text();
        console.log('Line Push API 回應:', response.status, result);

        if (!response.ok) {
            console.error('Line Push API 錯誤:', response.status, result);
        }
    } catch (error) {
        console.error('sendPush 錯誤:', error);
    }
}

// === 寫入 Google Sheets ===
async function appendToSheet(data) {
    if (!CONFIG.GOOGLE_SERVICE_ACCOUNT_EMAIL || !CONFIG.GOOGLE_PRIVATE_KEY) {
        console.warn('⚠️ 未設定 Google Service Account，跳過寫入 Sheet');
        return;
    }

    // 自動修復常見的 Email 複製錯誤
    let fixedEmail = CONFIG.GOOGLE_SERVICE_ACCOUNT_EMAIL.trim();
    if (fixedEmail.startsWith('eceipt')) {
        fixedEmail = 'r' + fixedEmail;
    }

    // 強制修復 Private Key 格式 (處理所有可能的換行問題)
    const fixedKey = CONFIG.GOOGLE_PRIVATE_KEY
        .replace(/\\n/g, '\n')
        .replace(/"/g, '');

    try {
        console.log('正在初始化 Google Auth...');

        // 使用更穩健的 GoogleAuth 方式
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: fixedEmail,
                private_key: fixedKey,
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });

        // 驗證和修正日期
        let finalDate = data.date;

        // 獲取台灣時間的今天日期
        const getTaiwanToday = () => {
            const now = new Date();
            // 轉換為台灣時區 (UTC+8)
            const taiwanTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
            const year = taiwanTime.getFullYear();
            const month = String(taiwanTime.getMonth() + 1).padStart(2, '0');
            const day = String(taiwanTime.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        };

        const todayTaiwan = getTaiwanToday();

        // 如果日期為空或無效，使用今天（台灣時間）
        if (!finalDate || finalDate.trim() === '') {
            finalDate = todayTaiwan;
            console.log(`⚠️ 收據無日期，使用今天（台灣時間）: ${finalDate}`);
        } else {
            // 驗證日期格式是否合理
            const dateObj = new Date(finalDate + 'T00:00:00');
            const todayObj = new Date(todayTaiwan + 'T00:00:00');

            // 檢查日期是否有效且合理（不是未來日期）
            if (isNaN(dateObj.getTime())) {
                // 無效日期，使用今天
                finalDate = todayTaiwan;
                console.log(`⚠️ 日期格式無效 (${data.date})，使用今天（台灣時間）: ${finalDate}`);
            } else if (dateObj > todayObj) {
                // 未來日期，使用今天
                finalDate = todayTaiwan;
                console.log(`⚠️ 日期是未來 (${data.date})，使用今天（台灣時間）: ${finalDate}`);
            } else {
                console.log(`✅ 使用收據日期: ${finalDate}`);
            }
        }

        // 準備寫入資料
        const rows = data.items.map(item => [
            finalDate,          //日期（已驗證）
            data.master,        //師傅/店家
            item.name,          //品項
            item.qty,           //數量
            item.price,         //單價
            item.total,         //總價
            data.note || ''     //備註
        ]);

        await sheets.spreadsheets.values.append({
            spreadsheetId: CONFIG.SPREADSHEET_ID,
            range: `${CONFIG.SHEET_NAME}!A:G`, // 假設資料在 A~G 欄
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: rows }
        });

        console.log('✅ 已寫入 Google Sheet:', rows.length, '筆資料');

    } catch (error) {
        console.error('❌ 寫入 Sheet 失敗:', error.message);
        // 不拋出錯誤，避免影響 Line 回覆
    }
}
