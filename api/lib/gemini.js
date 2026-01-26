// === Gemini API 模組 ===
const { CONFIG, selectModel, getTaiwanToday } = require('./config');
const getFortunePrompt = require('../prompts/fortune');

// === API 用量追蹤 ===
const apiUsageTracker = {
    date: '',
    counts: { receipt: 0, audio: 0, amulet: 0, fortune: 0, parse: 0 }
};

function trackApiUsage(task) {
    const today = getTaiwanToday();
    if (apiUsageTracker.date !== today) {
        apiUsageTracker.date = today;
        apiUsageTracker.counts = { receipt: 0, audio: 0, amulet: 0, fortune: 0, parse: 0 };
        console.log(`📊 API 追蹤：新的一天 ${today}，計數已重置`);
    }
    if (apiUsageTracker.counts[task] !== undefined) {
        apiUsageTracker.counts[task]++;
        console.log(`📊 API 追蹤：${task} +1，今日共 ${apiUsageTracker.counts[task]} 次`);
    }
}

function getApiUsageSummary() {
    const today = getTaiwanToday();
    if (apiUsageTracker.date !== today) {
        apiUsageTracker.date = today;
        apiUsageTracker.counts = { receipt: 0, audio: 0, amulet: 0, fortune: 0, parse: 0 };
    }
    const c = apiUsageTracker.counts;
    const total = c.receipt + c.audio + c.amulet + c.fortune + c.parse;
    return `📊 今日 API 用量 / โควต้าวันนี้\n📅 ${today}\n\n` +
        `📷 收據辨識 / ใบเสร็จ: ${c.receipt} 次\n🎙️ 語音辨識 / เสียง: ${c.audio} 次\n` +
        `📿 佛牌文案 / พระ: ${c.amulet} 次\n🔮 命理翻譯 / โหราศาสตร์: ${c.fortune} 次\n` +
        `✏️ 文字解析 / ข้อความ: ${c.parse} 次\n\n📈 合計 / รวม: ${total} 次\n\n` +
        `💡 Gemini 免費版約 15 RPM / 1500 RPD`;
}

// === 提取和解析 JSON ===
function extractJSON(rawText, source = 'API') {
    try {
        const parsed = JSON.parse(rawText);
        console.log(`✅ ${source} JSON 解析成功 (直接解析)`);
        return parsed;
    } catch (e) { }

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            console.log(`✅ ${source} JSON 解析成功 (提取後解析)`);
            return parsed;
        } catch (e) {
            console.error(`❌ ${source} JSON 提取後解析失敗:`, e.message);
        }
    }
    console.error(`❌ ${source} 未找到有效的 JSON`);
    return null;
}

// === 修復被截斷的 JSON ===
function repairTruncatedJSON(rawText) {
    try {
        let repaired = rawText.trim();
        let openBraces = (repaired.match(/\{/g) || []).length;
        let closeBraces = (repaired.match(/\}/g) || []).length;
        let openBrackets = (repaired.match(/\[/g) || []).length;
        let closeBrackets = (repaired.match(/\]/g) || []).length;

        repaired = repaired.replace(/,?\s*"[^"]*"\s*:\s*[^,\}\]]*$/, '');

        for (let i = 0; i < openBrackets - closeBrackets; i++) repaired += ']';
        for (let i = 0; i < openBraces - closeBraces; i++) repaired += '}';

        const parsed = JSON.parse(repaired);
        parsed.note = (parsed.note || '') + ' (部分內容被截斷)';
        console.log('✅ 成功修復被截斷的 JSON');
        return parsed;
    } catch (e) {
        console.error('❌ JSON 修復失敗:', e.message);
        return null;
    }
}

// === Gemini 收據辨識 ===
async function recognizeReceipt(imageData) {
    const { buffer: imageBuffer, mimeType } = imageData;
    const sizeInMB = imageBuffer.length / (1024 * 1024);

    if (sizeInMB > 4) throw new Error('IMAGE_TOO_LARGE');
    const base64Image = imageBuffer.toString('base64');

    const prompt = `辨識收據，回傳簡潔的JSON。
規則：
1. 必須回傳JSON，即使模糊也要盡力辨識
2. 泰文翻譯成中文，簡化格式：「中文(泰文)」，不要太長
3. 品項名稱要簡短，去掉多餘描述
4. Lp→龍波, Aj→阿贊, Phra→帕
5. **日期規則**：只有在收據上清楚看到日期時才填寫，否則填空字串""，不要猜測！

JSON格式：
{"date": "YYYY-MM-DD 或 空字串","master": "店家名","items": [{"name": "品項", "qty": 1, "price": 0, "total": 0}],"note": ""}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL_RECEIPT}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64Image } }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 8192, responseMimeType: "application/json" }
        })
    });

    const result = await response.json();
    if (result.error) {
        if (result.error.code === 429) throw new Error('QUOTA_EXCEEDED');
        return null;
    }
    if (!result.candidates?.[0]) return null;

    const finishReason = result.candidates[0].finishReason;
    if (finishReason === 'SAFETY') return null;

    const rawText = result.candidates[0].content.parts[0].text;
    trackApiUsage('receipt');

    if (finishReason === 'MAX_TOKENS') {
        const repaired = repairTruncatedJSON(rawText);
        if (repaired) return repaired;
    }

    return extractJSON(rawText, '圖片辨識');
}

// === Gemini 語音識別 ===
async function recognizeAudio(audioData, duration = 0) {
    const { buffer: audioBuffer, mimeType } = audioData;
    const base64Audio = audioBuffer.toString('base64');

    const prompt = `請將這段語音轉換成文字。
語言：可能是繁體中文、泰文或兩者混合
要求：準確轉錄，保持原語言，去掉語氣詞
只回傳轉錄的文字。`;

    const model = selectModel('audio', { duration });
    console.log(`🎙️ 語音識別使用模型: ${model}`);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64Audio } }] }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
            })
        });

        const result = await response.json();
        if (result.error) {
            if (result.error.code === 429) throw new Error('QUOTA_EXCEEDED');
            return null;
        }
        if (!result.candidates?.[0]?.content?.parts?.[0]) return null;

        trackApiUsage('audio');
        return result.candidates[0].content.parts[0].text.trim();
    } catch (error) {
        if (error.message === 'QUOTA_EXCEEDED') throw error;
        console.error('❌ 語音識別錯誤:', error.message);
        return null;
    }
}

// === Gemini 影片音軌識別 ===
async function recognizeVideoAudio(videoData, duration = 0) {
    const { buffer: videoBuffer, mimeType } = videoData;
    const base64Video = videoBuffer.toString('base64');

    const prompt = `請將這段影片中的語音轉換成文字。
語言：可能是繁體中文、泰文或兩者混合
要求：準確轉錄，保持原語言，忽略背景音樂
只回傳轉錄的文字。`;

    const model = selectModel('fortune', { duration });
    console.log(`🎥 影片語音識別使用模型: ${model}`);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64Video } }] }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
            })
        });

        const result = await response.json();
        if (result.error) {
            if (result.error.code === 429) throw new Error('QUOTA_EXCEEDED');
            return null;
        }
        if (!result.candidates?.[0]?.content?.parts?.[0]) return null;

        trackApiUsage('fortune');
        return result.candidates[0].content.parts[0].text.trim();
    } catch (error) {
        if (error.message === 'QUOTA_EXCEEDED') throw error;
        console.error('❌ 影片語音識別錯誤:', error.message);
        return null;
    }
}

// === Gemini 命理翻譯 ===
async function translateFortuneText(text, duration = 0) {
    const prompt = getFortunePrompt(text);
    const model = selectModel('fortune', { duration });
    console.log(`🔮 命理翻譯使用模型: ${model}`);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.7, maxOutputTokens: 8192 }
            })
        });

        const result = await response.json();
        if (result.error) {
            if (result.error.code === 429) throw new Error('QUOTA_EXCEEDED');
            return null;
        }
        if (!result.candidates?.[0]) return null;

        trackApiUsage('fortune');
        return result.candidates[0].content.parts[0].text;
    } catch (error) {
        if (error.message === 'QUOTA_EXCEEDED') throw error;
        console.error('❌ 命理翻譯錯誤:', error);
        return null;
    }
}

// === Gemini 多圖佛牌辨識 ===
async function recognizeAmuletMultiImage(images, userDescription = '') {
    if (!images?.length) return null;

    const userInfoSection = userDescription
        ? `\n【用戶提供的資訊】\n${userDescription}\n請務必將用戶提供的師父名稱、佛牌名稱、功效等資訊融入文案中！\n`
        : '';

    const prompt = `你是一位「泰國佛牌聖物與法事翻譯」專家。
【這是 ${images.length} 張同一件佛牌/聖物的照片】
${userInfoSection}
【格式規範】
⚠️ 禁止Markdown語法，使用表情符號區隔段落
總字數800-1200字

請綜合分析所有圖片，生成完整行銷文案，包含：
✨ 標題（功效+聖物類型）
🙏 師父傳承（40-60字）
📿 聖物故事（80-120字）
💰 傳統功效（財運/人緣/避險）
👤 適合對象
🔮 材質用料
📖 佩戴方式
🔸 心咒
⚠️ 注意事項`;

    const parts = [{ text: prompt }];
    for (const img of images) {
        parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
    }

    const hasUserInfo = userDescription?.trim().length > 0;
    const model = images.length > 2 ? 'gemini-2.5-pro' : selectModel('amulet', { hasUserInfo });
    console.log(`📿 多圖佛牌文案使用模型: ${model}`);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
            })
        });

        const result = await response.json();
        if (result.error) {
            if (result.error.code === 429) throw new Error('QUOTA_EXCEEDED');
            return null;
        }
        if (!result.candidates?.[0]) return null;
        if (result.candidates[0].finishReason === 'SAFETY') return null;

        trackApiUsage('amulet');
        return result.candidates[0].content.parts[0].text;
    } catch (error) {
        if (error.message === 'QUOTA_EXCEEDED') throw error;
        console.error('❌ 多圖佛牌辨識錯誤:', error);
        return null;
    }
}

// === Gemini 解析文字指令 ===
async function parseTextWithGemini(text) {
    const prompt = `你是一個收據記帳助手。請分析文字，轉換成 JSON 格式。
使用者輸入：${text}

**泰文必須翻譯成繁體中文(泰文原文)格式**
日期如果沒有明確提到，填空字串""
如果只有文字沒數字，可能不是記帳指令，回傳 null

JSON格式：
{"date": "","master": "繁體中文(泰文)","items": [{"name": "品項", "qty": 1, "price": 0, "total": 0}],"note": ""}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL_PARSE}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 1024, responseMimeType: "application/json" }
            })
        });

        const result = await response.json();
        if (result.error) {
            if (result.error.code === 429) throw new Error('QUOTA_EXCEEDED');
            return null;
        }
        if (!result.candidates?.[0]) return null;

        trackApiUsage('parse');
        return extractJSON(result.candidates[0].content.parts[0].text, '文字解析');
    } catch (error) {
        if (error.message === 'QUOTA_EXCEEDED') throw error;
        console.error('❌ 文字解析錯誤:', error);
        return null;
    }
}

module.exports = {
    recognizeReceipt,
    recognizeAudio,
    recognizeVideoAudio,
    translateFortuneText,
    recognizeAmuletMultiImage,
    parseTextWithGemini,
    getApiUsageSummary,
    trackApiUsage
};
