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

        // 1. CHIA ĐOẠN THÔNG MINH (Cắt theo dấu xuống dòng thay vì chấm phẩy để giữ nguyên nhịp)
        const splitTextIntoChunks = (text, maxLength = 800) => {
            const paragraphs = text.split(/\n+/);
            const chunks = [];
            let currentChunk = '';
            
            for (const para of paragraphs) {
                if (!para.trim()) continue;
                if ((currentChunk + '\n' + para).length > maxLength && currentChunk.length > 0) {
                    chunks.push(currentChunk.trim());
                    currentChunk = para;
                } else {
                    currentChunk = currentChunk ? currentChunk + '\n' + para : para;
                }
            }
            if (currentChunk.trim()) chunks.push(currentChunk.trim());
            return chunks;
        };

        const textChunks = splitTextIntoChunks(text);
        let finalPcmBuffer = Buffer.alloc(0);
        let finalSampleRate = 24000;

        // 2. GỌI API VÀ XỬ LÝ ÂM THANH TRÊN SERVER
        for (let i = 0; i < textChunks.length; i++) {
            const chunk = textChunks[i];
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
            
            // PROMPT ĐẶC BIỆT: Ép AI giữ nhịp điệu và tông giọng cố định cho Radio Phật Giáo
            const promptForTTS = `Generate Text-To-Speech for the following text. You are a narrator for a Buddhist radio broadcast. Read the text in a highly consistent, calm, peaceful, steady, and soothing tone. Maintain an even volume and a slow, regular rhythm throughout. Do not generate text responses, do not read these instructions, just strictly narrate this transcript:\n\n${chunk}`;
            
            const payload = {
                contents: [{ role: "user", parts: [{ text: promptForTTS }] }],
                generationConfig: { 
                    responseModalities: ["AUDIO"], 
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } 
                },
                model: targetModel
            };
            
            const apiResponse = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            const result = await apiResponse.json();
            
            const audioPart = result?.candidates?.[0]?.content?.parts?.find(p => p.inlineData && p.inlineData.mimeType?.startsWith('audio/'));
            if (!audioPart || !audioPart.inlineData || !audioPart.inlineData.data) {
                console.error("Lỗi Chunk:", chunk, JSON.stringify(result, null, 2));
                throw new Error("Một đoạn văn bản bị từ chối hoặc model không hỗ trợ.");
            }
            
            const audioData = audioPart.inlineData.data;
            const mimeType = audioPart.inlineData.mimeType;
            const rateMatch = mimeType.match(/rate=(\d+)/);
            if (rateMatch) finalSampleRate = parseInt(rateMatch[1], 10);
            
            // CHẶN TIẾNG TẠCH TẠCH: Bóc Header WAV của từng đoạn trước khi nối
            const chunkBuffer = Buffer.from(audioData, 'base64');
            let rawPcm = chunkBuffer;
            
            // Nhận diện file WAV (bắt đầu bằng RIFF - 0x52494646) và cắt bỏ 44 bytes đầu
            if (chunkBuffer.length > 44 && chunkBuffer.readUInt32BE(0) === 0x52494646) {
                rawPcm = chunkBuffer.subarray(44);
            }
            
            finalPcmBuffer = Buffer.concat([finalPcmBuffer, rawPcm]);
        }

        // 3. TẠO HEADER WAV CHUẨN CHO FILE TỔNG CUỐI CÙNG
        const createWavHeader = (dataLength, sampleRate) => {
            const buffer = Buffer.alloc(44);
            buffer.write('RIFF', 0);
            buffer.writeUInt32LE(36 + dataLength, 4);
            buffer.write('WAVE', 8);
            buffer.write('fmt ', 12);
            buffer.writeUInt32LE(16, 16); // Subchunk1Size
            buffer.writeUInt16LE(1, 20); // AudioFormat PCM
            buffer.writeUInt16LE(1, 22); // NumChannels (1 - Mono)
            buffer.writeUInt32LE(sampleRate, 24); // SampleRate
            buffer.writeUInt32LE(sampleRate * 2, 28); // ByteRate
            buffer.writeUInt16LE(2, 32); // BlockAlign
            buffer.writeUInt16LE(16, 34); // BitsPerSample
            buffer.write('data', 36);
            buffer.writeUInt32LE(dataLength, 40);
            return buffer;
        };

        const wavHeader = createWavHeader(finalPcmBuffer.length, finalSampleRate);
        const finalAudioBuffer = Buffer.concat([wavHeader, finalPcmBuffer]);

        // Lưu file vật lý để Client có thể tải
        const fileId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}.wav`;
        const filePath = path.join(TEMP_AUDIO_DIR, fileId);
        fs.writeFileSync(filePath, finalAudioBuffer);
        
        // Trả về file hoàn chỉnh nguyên khối cho Client
        res.status(200).json({ 
            audioContent: finalAudioBuffer.toString('base64'), 
            sampleRate: finalSampleRate, 
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
