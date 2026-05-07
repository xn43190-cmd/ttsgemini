// Import các thư viện cần thiết
const express = require('express');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs'); // Module để làm việc với file hệ thống

// Kích hoạt dotenv để đọc biến môi trường từ tệp .env (khi chạy local)
dotenv.config();

// Khởi tạo ứng dụng Express
const app = express();

// Đảm bảo thư mục lưu file tạm tồn tại
const TEMP_AUDIO_DIR = path.join(__dirname, 'temp_audio');
if (!fs.existsSync(TEMP_AUDIO_DIR)) {
    fs.mkdirSync(TEMP_AUDIO_DIR);
}

// Sử dụng middleware để xử lý JSON và phục vụ các tệp tĩnh từ thư mục 'public'
// LƯU Ý: Cần đảm bảo bạn đã tạo thư mục 'public' và đặt file index.html vào trong đó
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


// Hàm trợ giúp để lấy một API key ngẫu nhiên (không đổi)
const getApiKey = () => {
    const apiKeysString = process.env.GOOGLE_API_KEYS;
    if (!apiKeysString) {
        throw new Error("Biến môi trường GOOGLE_API_KEYS chưa được cấu hình.");
    }
    const apiKeys = apiKeysString.split(',').map(key => key.trim()).filter(key => key);
    if (apiKeys.length === 0) {
        throw new Error("Danh sách API keys rỗng hoặc không hợp lệ.");
    }
    return apiKeys[Math.floor(Math.random() * apiKeys.length)];
};

// Endpoint để tối ưu hóa văn bản (không đổi)
app.post('/api/optimize-text', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) {
            return res.status(400).json({ error: "Không có văn bản để tối ưu hóa." });
        }
        
        const apiKey = getApiKey();
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;

        const prompt = `Với vai trò là một chuyên gia ngôn ngữ cho hệ thống AI đọc văn bản, hãy viết lại văn bản sau đây để một hệ thống text-to-speech có thể đọc tiếng Việt một cách tự nhiên và chính xác nhất. Mở rộng tất cả các từ viết tắt (ví dụ: 'TP.HCM' thành 'Thành phố Hồ Chí Minh'), viết số thành chữ (ví dụ: '1995' thành 'một nghìn chín trăm chín mươi lăm'), và làm rõ các từ có thể gây nhầm lẫn hoặc tên riêng. Chỉ trả về văn bản đã được tối ưu hóa, không thêm bất kỳ lời giải thích hay định dạng nào khác. Văn bản gốc: "${text}"`;
        
        const payload = {
            contents: [{ role: "user", parts: [{ text: prompt }] }]
        };

        const apiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!apiResponse.ok) {
            const errorData = await apiResponse.json();
            const errorMessage = errorData?.error?.message || `Lỗi từ Gemini API: ${apiResponse.status}`;
            throw new Error(errorMessage);
        }

        const result = await apiResponse.json();
        const optimizedText = result?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!optimizedText) {
            throw new Error("Không thể trích xuất văn bản đã tối ưu hóa từ phản hồi của API.");
        }
        
        res.json({ success: true, optimizedText: optimizedText.trim() });

    } catch (error) {
        console.error('Lỗi khi tối ưu hóa văn bản:', error);
        res.status(500).json({ error: error.message });
    }
});


// Endpoint để xử lý việc tạo giọng đọc (ĐÃ SỬA LỖI VÀ CẬP NHẬT)
app.post('/api/generate-speech', async (req, res) => {
    try {
        const apiKey = getApiKey();
        const { text, voice } = req.body;
        if (!text || !voice) {
            return res.status(400).json({ error: "Thiếu văn bản hoặc giọng đọc." });
        }

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;
        const payload = {
            contents: [{ parts: [{ text }] }],
            generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
            },
            model: "gemini-2.5-flash-preview-tts"
        };
        
        const apiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        // === PHẦN SỬA LỖI NẰM Ở ĐÂY ===
        // Khối xử lý lỗi đã được khôi phục lại đầy đủ
        if (!apiResponse.ok) {
            let googleErrorMsg = `Lỗi từ Google API: ${apiResponse.status} ${apiResponse.statusText}`;
            try {
                const errorData = await apiResponse.json();
                googleErrorMsg = errorData.error.message || JSON.stringify(errorData.error);
            } catch (e) {
                console.error("Không thể phân tích lỗi từ Google API dưới dạng JSON", e);
            }
            throw new Error(googleErrorMsg);
        }

        const result = await apiResponse.json();
        const part = result?.candidates?.[0]?.content?.parts?.[0];
        const audioData = part?.inlineData?.data;
        const mimeType = part?.inlineData?.mimeType;

        if (!audioData || !mimeType) throw new Error("Không nhận được dữ liệu âm thanh hợp lệ từ API.");
        
        // --- PHẦN LOGIC MỚI ĐỂ LƯU FILE ---
        const fileId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}.wav`;
        const filePath = path.join(TEMP_AUDIO_DIR, fileId);
        
        // Chuyển base64 sang buffer và ghi file
        const audioBuffer = Buffer.from(audioData, 'base64');
        fs.writeFileSync(filePath, audioBuffer);

        const sampleRateMatch = mimeType.match(/rate=(\d+)/);
        const sampleRate = sampleRateMatch ? parseInt(sampleRateMatch[1], 10) : 24000;

        // Trả về cả audioContent (để phát) và fileId (để tải)
        res.status(200).json({ 
            audioContent: audioData, 
            sampleRate: sampleRate,
            fileId: fileId 
        });

    } catch (error) {
        console.error('Lỗi trong server:', error);
        res.status(500).json({ error: error.message });
    }
});

// === ENDPOINT MỚI ĐỂ TẢI FILE ===
app.get('/api/download', (req, res) => {
    const { fileId } = req.query;

    if (!fileId || fileId.includes('..') || fileId.includes('/')) {
        return res.status(400).send('File ID không hợp lệ.');
    }

    const filePath = path.join(TEMP_AUDIO_DIR, fileId);

    if (fs.existsSync(filePath)) {
        // res.download() sẽ tự động gửi file và yêu cầu trình duyệt tải xuống
        res.download(filePath, fileId, (err) => {
            if (err) {
                console.error("Lỗi khi gửi file:", err);
            }
            // Tự động xóa file sau khi gửi xong để tiết kiệm dung lượng
            fs.unlink(filePath, (unlinkErr) => {
                if (unlinkErr) console.error("Lỗi khi xóa file tạm:", unlinkErr);
            });
        });
    } else {
        res.status(404).send('Không tìm thấy tệp hoặc tệp đã hết hạn.');
    }
});


// Route để phục vụ trang index.html cho tất cả các yêu cầu GET khác
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/health', (req, res) => {
    res.status(200).json({ status: "OK", server: "Ready" });
});

// Lắng nghe ở cổng được cung cấp bởi Render, hoặc 3000 khi chạy local
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server đang chạy ở cổng ${PORT}`);
});
