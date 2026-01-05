// ============================================
// Line 收據 Bot - Vercel Serverless Function
// 使用 Gemini 2.5 Flash + Google Sheets
// ============================================

// === 設定（從環境變數讀取）===
const { google } = require('googleapis');

const CONFIG = {
    LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    SPREADSHEET_ID: process.env.SPREADSHEET_ID,
    SHEET_NAME: '收據記錄',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    GOOGLE_PRIVATE_KEY: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n').replace(/"/g, '') // 處理換行符號與多餘引號
};

// === 用戶模式追蹤（in-memory，Vercel 可能重啟會清空）===
// 格式: userId -> { mode: 'receipt' | 'amulet', description: '暂存的文字描述' }
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
                    await handleAudioMessage(event);
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

        // 成功辨識，回傳文案
        await replyToLine(replyToken, amuletText);

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

    // 使用 Gemini 2.5 Flash（Pro 免費額度太少容易限流）
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

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
                '🎙️ 語音記帳 → 說話即可記帳\n' +
                '✏️ 文字記帳 → 師傅 品項 數量 單價\n\n' +
                '📷 ถ่ายรูปใบเสร็จ → AI อ่านให้\n' +
                '📿 ถ่ายรูปพระ → AI เขียนบทความ\n' +
                '🎙️ พูด → บันทึกบัญชี\n' +
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
            // 暫存用戶提供的文字描述
            userState.description = (userState.description ? userState.description + '\n' : '') + text;
            userModeMap.set(userId, userState);
            await replyToLine(replyToken,
                '✅ 已收到資訊 / รับข้อมูลแล้ว\n\n' +
                `📝 ${text}\n\n` +
                '💡 可繼續補充或直接傳照片！\n' +
                '💡 พิมพ์เพิ่มหรือส่งรูปได้เลย!\n\n' +
                '📷 等待照片中... / รอรูปอยู่...');
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
        if (duration > 60000) { // 超過 60 秒
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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

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

    const contentType = response.headers.get('content-type') || 'audio/m4a';
    const audioBuffer = Buffer.from(await response.arrayBuffer());

    console.log(`下載語音: ${(audioBuffer.length / 1024).toFixed(2)}KB, MIME: ${contentType}`);

    // 檢查檔案大小（LINE 語音通常 < 10MB）
    const sizeInMB = audioBuffer.length / (1024 * 1024);
    if (sizeInMB > 10) {
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

    // 使用 Gemini 2.5 Flash（和圖片、文字統一模型）
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

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

        // 處理錯誤
        if (result.error) {
            console.error('❌ Gemini 語音 API 錯誤:', JSON.stringify(result.error, null, 2));
            if (result.error.code === 429 || result.error.status === 'RESOURCE_EXHAUSTED') {
                throw new Error('QUOTA_EXCEEDED');
            }
            return null;
        }

        if (!result.candidates || !result.candidates[0]) {
            console.error('❌ Gemini 語音 API 無回應');
            return null;
        }

        const recognizedText = result.candidates[0].content.parts[0].text.trim();
        console.log('📝 Gemini 語音識別:', recognizedText);

        return recognizedText;

    } catch (error) {
        if (error.message === 'QUOTA_EXCEEDED') throw error;
        console.error('❌ 語音識別錯誤:', error);
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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

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
async function replyToLine(replyToken, message) {
    const url = 'https://api.line.me/v2/bot/message/reply';

    console.log('正在回覆:', replyToken.substring(0, 20) + '...', message.substring(0, 50));

    // 建構回覆 Body，附加 Quick Reply
    const body = {
        replyToken: replyToken,
        messages: [{
            type: 'text',
            text: message,
            quickReply: QUICK_REPLY_ITEMS
        }]
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`
            },
            body: JSON.stringify(body)
        });

        const result = await response.text();
        console.log('Line API 回應:', response.status, result);

        if (!response.ok) {
            console.error('Line API 錯誤:', response.status, result);
        }
    } catch (error) {
        console.error('replyToLine 錯誤:', error);
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
