const axios = require('axios');
const fs = require("fs-extra");
const path = require("path");

// ============================================
// إعداداتك الخاصة - عدلها كما تريد
// ============================================
const configPath = path.join(__dirname, '../../config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch (e) {}

const GEMINI_API_KEY = config.GEMINI_KEY || "AIzaSyDgeT6h52gQK3zt7vBVJZk7LrSFY_j_RL4";
const API_VERSION = "v1beta";
const MODEL_NAME = "gemini-1.5-flash"; // أو gemini-pro
const ADMINBOT = config.ADMINBOT || [];

// ذاكرة المحادثات
const adminContext = new Map();  // ذاكرة غير محدودة للأدمن
const userContext = new Map();   // ذاكرة محدودة للمستخدمين
const MAX_ADMIN_HISTORY = 50;
const MAX_USER_HISTORY = 10;

function isAdmin(id) { return ADMINBOT.includes(id.toString()); }

// ============================================
// 💬 الدردشة مع Gemini
// ============================================
async function chat(uid, msg) {
    const isAdminUser = isAdmin(uid);
    const context = isAdminUser ? adminContext : userContext;
    const maxHistory = isAdminUser ? MAX_ADMIN_HISTORY : MAX_USER_HISTORY;
    
    let history = context.get(uid) || [];
    history.push({ role: "user", parts: [{ text: msg }] });
    
    if (history.length > maxHistory) {
        history = history.slice(-maxHistory);
    }

    try {
        const res = await axios.post(
            `https://generativelanguage.googleapis.com/${API_VERSION}/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`,
            { contents: history },
            { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
        );
        
        const reply = res.data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (reply) {
            history.push({ role: "model", parts: [{ text: reply }] });
            context.set(uid, history);
        }
        return reply || "عذراً، لم أستطع الرد.";
    } catch (err) {
        console.error("Chat Error:", err.response?.data || err.message);
        throw new Error(err.response?.data?.error?.message || err.message);
    }
}

// ============================================
// 👁️ تحليل الصور مع Gemini Vision
// ============================================
async function analyzeImage(imgBuffer, question, uid) {
    const base64Image = imgBuffer.toString('base64');
    const isAdminUser = isAdmin(uid);
    const context = isAdminUser ? adminContext : userContext;
    const maxHistory = isAdminUser ? MAX_ADMIN_HISTORY : MAX_USER_HISTORY;
    
    let history = context.get(uid) || [];
    
    try {
        const visionModels = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro-vision'];
        let reply = "";
        
        for (const model of visionModels) {
            try {
                const res = await axios.post(
                    `https://generativelanguage.googleapis.com/${API_VERSION}/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
                    {
                        contents: [{
                            parts: [
                                { text: question || "صف هذه الصورة بالتفصيل" },
                                { inline_data: { mime_type: "image/jpeg", data: base64Image } }
                            ]
                        }]
                    },
                    { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
                );
                
                reply = res.data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (reply) break;
            } catch (e) {
                continue;
            }
        }
        
        if (!reply) throw new Error("لا يوجد نموذج رؤية متاح");
        
        history.push({ role: "user", parts: [{ text: `[صورة] ${question}` }] });
        history.push({ role: "model", parts: [{ text: reply }] });
        
        if (history.length > maxHistory) history = history.slice(-maxHistory);
        context.set(uid, history);
        
        return reply;
    } catch (err) {
        console.error("Vision Error:", err.message);
        throw new Error(err.message);
    }
}

// ============================================
// 🎨 توليد الصور - Pollinations (مجاني)
// ============================================
async function generateImage(prompt) {
    try {
        const encoded = encodeURIComponent(prompt);
        const seed = Math.floor(Math.random() * 10000);
        const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&seed=${seed}&nologo=true&model=flux`;
        
        const res = await axios.get(url, { 
            responseType: 'arraybuffer', 
            timeout: 120000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        if (!res.data || res.data.length < 100) throw new Error("الصورة فارغة");
        return Buffer.from(res.data);
    } catch (err) {
        throw new Error(`فشل توليد الصورة: ${err.message}`);
    }
}

// ============================================
// 📥 تحميل الصور
// ============================================
async function download(url) {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    return Buffer.from(res.data);
}

// ============================================
// ✅ اختبار الاتصال عند البدء
// ============================================
async function testAPI() {
    try {
        await axios.post(
            `https://generativelanguage.googleapis.com/${API_VERSION}/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`,
            { contents: [{ parts: [{ text: "Hi" }] }] },
            { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
        );
        return { valid: true, model: MODEL_NAME };
    } catch (err) {
        return { valid: false, error: err.response?.data?.error?.message || err.message };
    }
}

// ============================================
// 📨 رسالة الترحيب
// ============================================
async function sendStartupMessage(api) {
    const testResults = await testAPI();
    
    for (const adminId of ADMINBOT) {
        try {
            const thread = await api.getThreadList(1, null, ['INBOX']);
            const adminThread = thread.find(t => t.participantIDs.includes(adminId));
            
            if (adminThread) {
                const msg = testResults.valid ? 
`✨ **${MODEL_NAME} - جاهز!** 🆓

🤖 النموذج: ${testResults.model}

📝 **الأوامر:**
• #ايج [رسالة] - دردشة ذكية
• #ايج ارسم [وصف] - توليد صورة
• رد على صورة + #ايج [سؤال] - تحليل الصورة

👑 **الذاكرة:**
• أدمن: ${MAX_ADMIN_HISTORY} رسالة
• مستخدم: ${MAX_USER_HISTORY} رسائل

✅ مجاني 100%!` :
`❌ **خطأ في الاتصال**

${testResults.error}

تحقق من مفتاح Gemini في config.json`;

                await api.sendMessage(msg, adminThread.threadID);
            }
        } catch (err) {
            console.error("Startup error:", err.message);
        }
    }
}

// ============================================
// 🎯 المعالج الرئيسي - HakimRun
// ============================================
module.exports.HakimRun = async ({ api, event, args, messageReply }) => {
    const { threadID, messageID, senderID } = event;
    
    if (!isAdmin(senderID)) {
        return await api.sendMessage("❌ هذا الأمر للأدمن فقط", threadID, messageID);
    }

    const msg = args.join(" ").trim();
    
    // عرض المساعدة
    if (!msg) {
        return await api.sendMessage(
`✨ **Gemini AI**

💬 **الدردشة:**
• #ايج [رسالتك]

🎨 **الصور:**
• #ايج ارسم [وصف]
• #ايج صورة [وصف]

👁️ **التحليل:**
• رد على صورة + #ايج [سؤال]

👑 **الذاكرة:**
• أدمن: ${MAX_ADMIN_HISTORY} رسالة
• مستخدم: ${MAX_USER_HISTORY} رسائل`,
            threadID, messageID
        );
    }

    try {
        // 🎨 توليد الصور
        if (msg.toLowerCase().match(/^(ارسم|صورة|draw|image)\s+/)) {
            await api.sendMessage("🎨 جاري الرسم... ⏳", threadID, messageID);
            const prompt = msg.replace(/^(ارسم|صورة|draw|image)\s*/i, '').trim();
            const imgBuffer = await generateImage(prompt);
            
            const cacheDir = path.join(__dirname, 'cache');
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
            const cachePath = path.join(cacheDir, `img_${Date.now()}.png`);
            fs.writeFileSync(cachePath, imgBuffer);
            
            await api.sendMessage({
                body: `✅ **تم!**\n📝 ${prompt}\n🎨 Pollinations.ai`,
                attachment: fs.createReadStream(cachePath)
            }, threadID, () => {
                try { fs.unlinkSync(cachePath); } catch(e) {}
            }, messageID);
            return;
        }
        
        // 👁️ تحليل الصور
        if (messageReply) {
            const photo = (messageReply.attachments || []).find(a => a.type === 'photo');
            if (photo?.url) {
                await api.sendMessage("🔍 جاري التحليل... ⏳", threadID, messageID);
                const imgBuffer = await download(photo.url);
                const question = msg || "صف هذه الصورة بالتفصيل";
                const analysis = await analyzeImage(imgBuffer, question, senderID);
                return await api.sendMessage(analysis, threadID, messageID);
            }
        }
        
        // 💬 الدردشة العادية
        const reply = await chat(senderID, msg);
        return await api.sendMessage(reply, threadID, messageID);
        
    } catch (err) {
        const errorMsg = `❌ **حدث خطأ**\n\n${err.message}\n\n💡 حاول مرة أخرى.`;
        return await api.sendMessage(errorMsg, threadID, messageID);
    }
};

// ============================================
// 🔄 المعالج للردود - HakimReply
// ============================================
module.exports.HakimReply = async function({ api, event, HakimReply }) {
    const { threadID, messageID, senderID, body } = event;
    
    if (senderID !== HakimReply.author || !isAdmin(senderID)) return;

    try {
        if (event.messageReply) {
            const photo = (event.messageReply.attachments || []).find(a => a.type === 'photo');
            if (photo?.url) {
                await api.sendMessage("🔍 جاري التحليل...", threadID, messageID);
                const img = await download(photo.url);
                const txt = await analyzeImage(img, body, senderID);
                return await api.sendMessage(txt, threadID, messageID);
            }
        }
        return await api.sendMessage(await chat(senderID, body), threadID, messageID);
    } catch (err) {
        return await api.sendMessage(`❌ خطأ: ${err.message}`, threadID, messageID);
    }
};

// ============================================
// 🚀 التشغيل - HakimInit
// ============================================
let startupSent = false;

module.exports.HakimInit = async function({ api }) {
    if (startupSent) return;
    startupSent = true;
    
    console.log("🚀 Starting Gemini AI Bot...");
    setTimeout(() => sendStartupMessage(api), 5000);
};

// ============================================
// ⚙️ إعدادات الأمر - كما في بوتك الأصلي
// ============================================
module.exports.config = {
    title: "ايج",
    release: "2.0.0",
    clearance: 0,
    author: "Hakim (Gemini Direct)",
    summary: "Gemini AI - اتصال مباشر، ذاكرة مختلفة للأدمن والمستخدمين",
    section: "زكـــــــاء",
    syntax: "#ايج",
    delay: 0,
};
