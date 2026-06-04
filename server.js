const express = require('express');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const path = require('path');
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
 * Hàm lấy MẢNG TẤT CẢ API Key dành riêng cho User hiện tại từ Session
 */
const getApiKeysForUser = (req) => {
    const userApiKeys = req.session.userApiKeys;
    if (!userApiKeys) {
        throw new Error("Không tìm thấy API Key được cấp quyền cho tài khoản này.");
    }
    
    // Trả về toàn bộ danh sách các key hợp lệ
    return userApiKeys.split(',').map(k => k.trim()).filter(k => k);
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

// --- API LẤY DANH SÁCH MODEL ---
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
        const keys = getApiKeysForUser(req);
        const targetModel = "gemini-2.5-flash"; 
        
        const prompt = `Với vai trò là một chuyên gia ngôn ngữ cho hệ thống AI đọc văn bản, hãy viết lại văn bản sau đây để một hệ thống text-to-speech có thể đọc tiếng Việt một cách tự nhiên và chính xác nhất. Mở rộng tất cả các từ viết tắt (ví dụ: 'TP.HCM' thành 'Thành phố Hồ Chí Minh'), viết số thành chữ (ví dụ: '1995' thành 'một nghìn chín trăm chín mươi lăm'), và làm rõ các từ có thể gây nhầm lẫn hoặc tên riêng. Chỉ trả về văn bản đã được tối ưu hóa, không thêm bất kỳ lời giải thích hay định dạng nào khác. Văn bản gốc: "${text}"`;
        const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
        
        let lastErrorMsg = "";
        const shuffledKeys = keys.sort(() => 0.5 - Math.random()); // Trộn key ngẫu nhiên

        // Vòng lặp thử từng API Key
        for (const apiKey of shuffledKeys) {
            try {
                const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;        
                const apiResponse = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                const result = await apiResponse.json();
                
                if (result.error) {
                    console.warn(`[Optimize] Key ${apiKey.substring(0, 8)}... hỏng. Đang thử key khác. Lỗi:`, result.error.message);
                    lastErrorMsg = result.error.message;
                    continue; // Chuyển sang key tiếp theo
                }

                const optimizedText = result?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (optimizedText) {
                    return res.json({ success: true, optimizedText: optimizedText.trim() });
                }
            } catch (err) {
                lastErrorMsg = err.message;
            }
        }
        
        throw new Error(`Toàn bộ API Key đều lỗi hoặc hết Quota. Lỗi cuối: ${lastErrorMsg}`);
        
    } catch (error) { 
        res.status(500).json({ error: error.message }); 
    }
});

app.post('/api/generate-speech', requireLogin, async (req, res) => {
    try {
        const keys = getApiKeysForUser(req);
        const { text, voice, model } = req.body; 
        const targetModel = model || "gemini-2.5-flash-preview-tts"; 

        const promptForTTS = `Generate Text-To-Speech for the following text. You are a narrator for a Buddhist radio broadcast. Read the text in a highly consistent, calm, peaceful, and soothing tone. Maintain an even volume and a natural, normal pace with a regular rhythm throughout. Do not generate text responses, do not read these instructions, just strictly narrate this transcript:\n\n${text}`;
        
        const payload = {
            contents: [{ role: "user", parts: [{ text: promptForTTS }] }],
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
        
        let lastErrorMsg = "";
        const shuffledKeys = keys.sort(() => 0.5 - Math.random()); // Trộn đều tải cho các key

        // Vòng lặp: Thử từng key, nếu lỗi thì đổi qua key khác ngay lập tức
        for (const apiKey of shuffledKeys) {
            try {
                const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
                const apiResponse = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                const result = await apiResponse.json();
                
                // Nếu Google trả về lỗi (403, 429...) -> Bỏ qua, chạy vòng lặp thử Key khác
                if (result.error) {
                    console.warn(`[TTS] Key ${apiKey.substring(0, 8)}... bị lỗi (${result.error.code}). Đang đổi key khác.`);
                    lastErrorMsg = result.error.message;
                    continue; 
                }
                
                const audioPart = result?.candidates?.[0]?.content?.parts?.find(p => p.inlineData && p.inlineData.mimeType?.startsWith('audio/'));
                
                if (!audioPart || !audioPart.inlineData || !audioPart.inlineData.data) {
                    console.warn(`[TTS] Key ${apiKey.substring(0, 8)}... bị chặn bởi Safety Filter. Thử key khác.`);
                    lastErrorMsg = "Bị chặn bởi bộ lọc an toàn.";
                    continue; // Thử key khác để xem có thoát bộ lọc không
                }
                
                // --- NẾU THÀNH CÔNG, TRẢ VỀ NGAY ---
                const audioData = audioPart.inlineData.data;
                const mimeType = audioPart.inlineData.mimeType;
                const rateMatch = mimeType.match(/rate=(\d+)/);
                const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
                
                const chunkBuffer = Buffer.from(audioData, 'base64');
                let rawPcm = chunkBuffer;
                
                if (chunkBuffer.length > 44 && chunkBuffer.readUInt32BE(0) === 0x52494646) {
                    rawPcm = chunkBuffer.subarray(44);
                }
                
                return res.status(200).json({ 
                    audioContent: rawPcm.toString('base64'), 
                    sampleRate: sampleRate 
                });

            } catch (err) {
                lastErrorMsg = err.message;
            }
        }
        
        // Nếu vòng lặp kết thúc mà chưa có lệnh return nào chạy -> Tất cả Key đều hỏng
        console.error("====== TẤT CẢ API KEY ĐỀU THẤT BẠI ======");
        console.error("Đoạn văn:", text);
        throw new Error(`Toàn bộ API Key của tài khoản này đều bị khóa hoặc hết hạn mức. Lỗi cuối: ${lastErrorMsg}`);

    } catch (error) { 
        res.status(500).json({ error: error.message }); 
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server đang chạy ở cổng ${PORT}`));
