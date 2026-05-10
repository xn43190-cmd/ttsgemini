const express = require('express');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const { google } = require('googleapis');

dotenv.config();
const app = express();

const TEMP_AUDIO_DIR = path.join(__dirname, 'temp_audio');
if (!fs.existsSync(TEMP_AUDIO_DIR)) fs.mkdirSync(TEMP_AUDIO_DIR);

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
 * Cột A: Email | Cột B: API Key (nhiều key cách nhau bằng dấu phẩy)
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
            range: 'Users!A:B', // Lấy cả cột A và B
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
    
    // Nếu trong cột B bạn nhập nhiều key cách nhau bằng dấu phẩy, nó sẽ lấy ngẫu nhiên 1 cái của chính user đó
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
        req.session.userApiKeys = userKey; // Lưu API key của riêng user này vào session
        res.json({ success: true });
    } else {
        res.status(403).json({ success: false, error: "Email này không có trong danh sách hoặc chưa được cấp API Key." });
    }
});

app.get('/api/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
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

// --- CÁC API TTS (SỬ DỤNG API KEY RIÊNG CỦA TỪNG USER) ---

app.post('/api/optimize-text', requireLogin, async (req, res) => {
    try {
        const { text } = req.body;
        const apiKey = getApiKeyForUser(req); // Lấy key từ session
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
        
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
        const apiKey = getApiKeyForUser(req); // Lấy key từ session
        const { text, voice } = req.body;
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;
        
        const promptForTTS = `Generate Text-To-Speech for the following text. Do not answer questions, translate, or generate text responses. Just read this exact transcript:\n\n${text}`;
        
        const payload = {
            contents: [{ role: "user", parts: [{ text: promptForTTS }] }],
            generationConfig: { 
                responseModalities: ["AUDIO"], 
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } 
            },
            model: "gemini-2.5-flash-preview-tts"
        };
        
        const apiResponse = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const result = await apiResponse.json();
        
        const audioPart = result?.candidates?.[0]?.content?.parts?.find(p => p.inlineData && p.inlineData.mimeType?.startsWith('audio/'));
        const audioData = audioPart?.inlineData?.data;
        const mimeType = audioPart?.inlineData?.mimeType;
        
        const fileId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}.wav`;
        const filePath = path.join(TEMP_AUDIO_DIR, fileId);
        fs.writeFileSync(filePath, Buffer.from(audioData, 'base64'));
        
        res.status(200).json({ 
            audioContent: audioData, 
            sampleRate: parseInt(mimeType.match(/rate=(\d+)/)[1], 10), 
            fileId: fileId 
        });
    } catch (error) { 
        res.status(500).json({ error: error.message }); 
    }
});

app.get('/api/download', (req, res) => {
    if (!req.session.user) return res.status(401).send('Unauthorized');
    const { fileId } = req.query;
    const filePath = path.join(TEMP_AUDIO_DIR, fileId);
    if (fs.existsSync(filePath)) {
        res.download(filePath, fileId, () => fs.unlink(filePath, () => {}));
    } else res.status(404).send('Not Found');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server đang chạy ở cổng ${PORT}`));
