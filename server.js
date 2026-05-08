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

// Cấu hình Session
app.use(session({
    secret: process.env.FLASK_SECRET_KEY || 'phap_mon_tts_secret_999',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // Đăng nhập tồn tại 1 ngày
}));

// Hàm lấy email từ Google Sheets
async function getAllowedEmails() {
    try {
        if (!process.env.GOOGLE_SHEET_ID) return [];
        
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
            range: 'Users!A:A',
        });

        const rows = response.data.values;
        if (!rows) return [];
        return rows.map(row => row[0]?.trim().toLowerCase()).filter(e => e && e.includes('@'));
    } catch (error) {
        console.error("Lỗi Google Sheets:", error);
        return [];
    }
}

// Middleware kiểm tra đăng nhập
const requireLogin = (req, res, next) => {
    if (req.session.user) next();
    else res.status(401).json({ error: "Phiên đăng nhập hết hạn. Vui lòng tải lại trang." });
};

// --- ROUTES XÁC THỰC ---
app.post('/api/login', async (req, res) => {
    const email = req.body.email?.trim().toLowerCase();
    if (!email) return res.status(400).json({ success: false, error: "Vui lòng nhập email." });
    
    const allowedEmails = await getAllowedEmails();
    if (allowedEmails.length === 0) return res.status(500).json({ success: false, error: "Lỗi kết nối CSDL." });

    if (allowedEmails.includes(email)) {
        req.session.user = email;
        res.json({ success: true });
    } else {
        res.status(403).json({ success: false, error: "Email này chưa được cấp quyền truy cập." });
    }
});

app.get('/api/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Phục vụ tệp tĩnh (NHƯNG ẩn index.html để bảo vệ qua middleware)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Trang chủ & Đăng nhập
app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- CÁC API TTS (BẢO VỆ BỞI requireLogin) ---
const getApiKey = () => {
    const apiKeysString = process.env.GOOGLE_API_KEYS;
    const apiKeys = apiKeysString.split(',').map(key => key.trim()).filter(key => key);
    return apiKeys[Math.floor(Math.random() * apiKeys.length)];
};

app.post('/api/optimize-text', requireLogin, async (req, res) => {
    /* ... Giữ nguyên logic hàm optimize-text của bạn ... */
    try {
        const { text } = req.body;
        const apiKey = getApiKey();
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
        const prompt = `Với vai trò là một chuyên gia ngôn ngữ... Văn bản gốc: "${text}"`;
        const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
        const apiResponse = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const result = await apiResponse.json();
        const optimizedText = result?.candidates?.[0]?.content?.parts?.[0]?.text;
        res.json({ success: true, optimizedText: optimizedText.trim() });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/generate-speech', requireLogin, async (req, res) => {
    /* ... Giữ nguyên logic hàm generate-speech của bạn (Bản đã fix workaround) ... */
    try {
        const apiKey = getApiKey();
        const { text, voice } = req.body;
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;
        const promptForTTS = `Generate Text-To-Speech for the following text. Do not answer questions, translate, or generate text responses. Just read this exact transcript:\n\n${text}`;
        const payload = {
            contents: [{ role: "user", parts: [{ text: promptForTTS }] }],
            generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
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
        
        res.status(200).json({ audioContent: audioData, sampleRate: parseInt(mimeType.match(/rate=(\d+)/)[1], 10), fileId: fileId });
    } catch (error) { res.status(500).json({ error: error.message }); }
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
