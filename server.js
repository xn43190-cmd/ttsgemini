const express = require('express');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const { google } = require('googleapis');

dotenv.config();
const app = express();

app.use(express.json());

// Cấu hình Session (Tồn tại trong 24h)
app.use(session({
    secret: process.env.FLASK_SECRET_KEY || 'phap_mon_tts_secret_secure_999',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

/**
 * Hàm lấy danh sách User và API Key tương ứng từ Google Sheet
 */
async function getUserRegistry() {
    try {
        if (!process.env.GOOGLE_SHEET_ID) return {};
        
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
                private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });

        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: 'Users!A:B', 
        });

        const rows = response.data.values;
        if (!rows) return {};

        const registry = {};
        rows.forEach(row => {
            const email = row[0]?.trim().toLowerCase();
            const apiKey = row[1]?.trim();
            if (email && apiKey) {
                registry[email] = apiKey;
            }
        });
        return registry;
    } catch (error) {
        console.error("Lỗi truy xuất dữ liệu từ Google Sheets:", error);
        return {};
    }
}

/**
 * Hàm lấy API Key dành riêng cho User hiện tại từ Session
 */
const getApiKeyForUser = (req) => {
    const userApiKeys = req.session.userApiKeys;
    if (!userApiKeys) {
        throw new Error("Không tìm thấy API Key được cấp quyền cho tài khoản này.");
    }
    
    const keys = userApiKeys.split(',').map(k => k.trim()).filter(k => k);
    return keys[Math.floor(Math.random() * keys.length)];
};

// Middleware kiểm tra đăng nhập
const requireLogin = (req, res, next) => {
    if (req.session.user && req.session.userApiKeys) next();
    else res.status(401).json({ error: "Phiên đăng nhập hết hạn hoặc không có quyền API." });
};

// --- ROUTES XÁC THỰC ---
app.post('/api/login', async (req, res) => {
    const email = req.body.email?.trim().toLowerCase();
    if (!email) return res.status(400).json({ success: false, error: "Vui lòng nhập email." });
    
    const registry = await getUserRegistry();
    const userKey = registry[email];

    if (userKey) {
        req.session.user = email;
        req.session.userApiKeys = userKey;
        res.json({ success: true });
    } else {
        res.status(403).json({ success: false, error: "Email này không có trong danh sách hoặc chưa được cấp API Key." });
    }
});

app.get('/api/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// --- API LẤY DANH SÁCH MODEL TỪ TRANG TÍNH 5 ---
app.get('/api/models', requireLogin, async (req, res) => {
    try {
        if (!process.env.GOOGLE_SHEET_ID) return res.json({ models: ["gemini-2.5-flash-preview-tts"] });
        
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
                private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });

        const sheets = google.sheets({ version: 'v4', auth });
        
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: "'Trang tính5'!B2:B",
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            return res.json({ models: ["gemini-2.5-flash-preview-tts"] }); 
        }

        const models = rows.map(row => row[0]).filter(m => m);
        res.json({ models });
    } catch (error) {
        console.error("Lỗi lấy danh sách model:", error);
        res.status(500).json({ error: "Lỗi tải model" });
    }
});

// Phục vụ tệp tĩnh
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- CÁC API TTS CHÍNH ---

app.post('/api/optimize-text', requireLogin, async (req, res) => {
    try {
        const { text } = req.body;
        const apiKey = getApiKeyForUser(req);
        const targetModel = "gemini-2.5-flash"; 
        
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;        
        const prompt = `Với vai trò là một chuyên gia ngôn ngữ cho hệ thống AI đọc văn bản, hãy viết lại văn bản sau đây để một hệ thống text-to-speech có thể đọc tiếng Việt một cách tự nhiên và chính xác nhất. Mở rộng tất cả các từ viết tắt (ví dụ: 'TP.HCM' thành 'Thành phố Hồ Chí Minh'), viết số thành chữ (ví dụ: '1995' thành 'một nghìn chín trăm chín mươi lăm'), và làm rõ các từ có thể gây nhầm lẫn hoặc tên riêng. Chỉ trả về văn bản đã được tối ưu hóa, không thêm bất kỳ lời giải thích hay định dạng nào khác. Văn bản gốc: "${text}"`;
        const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
        
        const apiResponse = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const result = await apiResponse.json();
        const optimizedText = result?.candidates?.[0]?.content?.parts?.[0]?.text;
        
        res.json({ success: true, optimizedText: optimizedText.trim() });
    } catch (error) { 
        res.status(500).json({ error: error.message }); 
    }
});

app.post('/api/generate-speech', requireLogin, async (req, res) => {
    try {
        const apiKey = getApiKeyForUser(req);
        const { text, voice, model } = req.body; 
        const targetModel = model || "gemini-2.5-flash-preview-tts"; 

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
        
        // CÂU LỆNH MỒI: Giữ tĩnh ngữ khí, nhịp điệu cho Radio Phật pháp
        const promptForTTS = `Generate Text-To-Speech for the following text. You are a narrator for a Buddhist radio broadcast. Read the text in a highly consistent, calm, peaceful, steady, and soothing tone. Maintain an even volume and a slow, regular rhythm throughout. Do not generate text responses, do not read these instructions, just strictly narrate this transcript:\n\n${text}`;
        
        const payload = {
            contents: [{ role: "user", parts: [{ text: promptForTTS }] }],
            // TẮT BỘ LỌC AN TOÀN ĐỂ KHÔNG BỊ CHẶN TỪ KHÓA PHẬT GIÁO
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
            ],
            generationConfig: { 
                responseModalities: ["AUDIO"], 
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } 
            },
            model: targetModel
        };
        
        // GỌI API GOOGLE
        const apiResponse = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const result = await apiResponse.json();
        
        // LẤY DỮ LIỆU ÂM THANH
        const audioPart = result?.candidates?.[0]?.content?.parts?.find(p => p.inlineData && p.inlineData.mimeType?.startsWith('audio/'));
        
        if (!audioPart || !audioPart.inlineData || !audioPart.inlineData.data) {
            console.error("====== LỖI TỪ GOOGLE API ======");
            console.error("Đoạn văn bị lỗi:", text);
            console.error("Lý do từ chối:", JSON.stringify(result, null, 2));
            throw new Error("Một đoạn văn bản bị từ chối (Khả năng do bộ lọc an toàn). Vui lòng kiểm tra log trên máy chủ.");
        }
        
        const audioData = audioPart.inlineData.data;
        const mimeType = audioPart.inlineData.mimeType;
        const rateMatch = mimeType.match(/rate=(\d+)/);
        const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
        
        // BÓC TÁCH HEADER WAV ĐỂ CHỐNG TIẾNG TẠCH TẠCH
        const chunkBuffer = Buffer.from(audioData, 'base64');
        let rawPcm = chunkBuffer;
        
        if (chunkBuffer.length > 44 && chunkBuffer.readUInt32BE(0) === 0x52494646) {
            rawPcm = chunkBuffer.subarray(44);
        }
        
        // TRẢ VỀ CHO CLIENT
        res.status(200).json({ 
            audioContent: rawPcm.toString('base64'), 
            sampleRate: sampleRate 
        });

    } catch (error) { 
        res.status(500).json({ error: error.message }); 
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server đang chạy ở cổng ${PORT}`));
