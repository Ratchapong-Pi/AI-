const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const QRCode = require('qrcode');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Storage dirs
const CACHE_DIR = path.join(__dirname, 'cache');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Setup multer for local file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOAD_DIR));

// Helper: Cache key by URL or Base64 hash
function getCacheKey(identifier, style = 'natural', targetLang = 'th') {
  return crypto.createHash('md5').update(`${identifier}_${style}_${targetLang}`).digest('hex');
}

// 0. CONFIG STATUS
app.get('/api/config', (req, res) => {
  return res.json({
    hasServerKey: !!process.env.GEMINI_API_KEY,
    maskedKey: process.env.GEMINI_API_KEY ? `${process.env.GEMINI_API_KEY.substring(0, 6)}...${process.env.GEMINI_API_KEY.slice(-4)}` : ''
  });
});


// 1. PROXY IMAGE (to bypass CORS & Hotlink protection)
app.get('/api/proxy-image', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('Image URL is required');

  try {
    const targetUrl = decodeURIComponent(url);
    const parsed = new URL(targetUrl);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Referer': referer ? decodeURIComponent(referer) : `${parsed.protocol}//${parsed.hostname}/`,
      'Origin': `${parsed.protocol}//${parsed.hostname}`
    };

    const response = await axios.get(targetUrl, {
      responseType: 'arraybuffer',
      headers,
      timeout: 20000
    });

    const contentType = response.headers['content-type'] || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(response.data);
  } catch (err) {
    console.error('Proxy image error:', err.message);
    return res.status(500).send(`Failed to fetch image: ${err.message}`);
  }
});

// 2. EXTRACT MANGA IMAGES FROM URL
app.post('/api/fetch-manga-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'URL is required' });

  try {
    const targetUrl = url.trim();

    // Special Handler: MangaDex API (Fast & 100% full-resolution)
    const mangadexMatch = targetUrl.match(/mangadex\.org\/chapter\/([a-f0-9\-]+)/i);
    if (mangadexMatch) {
      const chapterId = mangadexMatch[1];
      try {
        console.log(`[MangaDex] Detected chapter ID: ${chapterId}`);
        const [chInfoRes, atHomeRes] = await Promise.all([
          axios.get(`https://api.mangadex.org/chapter/${chapterId}`, { timeout: 15000 }).catch(() => null),
          axios.get(`https://api.mangadex.org/at-home/server/${chapterId}`, { timeout: 15000 })
        ]);

        let title = 'MangaDex Chapter';
        if (chInfoRes?.data?.data?.attributes) {
          const attr = chInfoRes.data.data.attributes;
          title = attr.title ? `Chapter ${attr.chapter || ''}: ${attr.title}` : `MangaDex Chapter ${attr.chapter || ''}`;
        }

        const baseUrl = atHomeRes.data.baseUrl;
        const hash = atHomeRes.data.chapter.hash;
        const files = atHomeRes.data.chapter.data || [];
        const images = files.map(file => `${baseUrl}/data/${hash}/${file}`);

        if (images.length > 0) {
          return res.json({
            success: true,
            title,
            sourceUrl: targetUrl,
            images,
            count: images.length
          });
        }
      } catch (mdErr) {
        console.error('[MangaDex API error]:', mdErr.message);
      }
    }

    const parsed = new URL(targetUrl);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'ja,en-US,en;q=0.9,th;q=0.8,ko;q=0.7',
      'Referer': `${parsed.protocol}//${parsed.hostname}/`
    };

    let effectiveUrl = targetUrl;
    let response = await axios.get(effectiveUrl, { headers, timeout: 25000 });
    let html = response.data;
    let $ = cheerio.load(html);

    // If series page with chapter links and no direct manga pages found, follow latest chapter
    if (!effectiveUrl.includes('/chapter-') && !effectiveUrl.includes('/ch-')) {
      const chapterLinks = [];
      $('a').each((_, el) => {
        const h = $(el).attr('href');
        if (h && (h.includes('/chapter-') || h.includes('/ch-') || h.includes('/read/'))) {
          try {
            chapterLinks.push(new URL(h, effectiveUrl).href);
          } catch(e) {}
        }
      });

      if (chapterLinks.length > 0) {
        effectiveUrl = chapterLinks[0];
        console.log(`Auto-detected Series page. Fetching chapter: ${effectiveUrl}`);
        response = await axios.get(effectiveUrl, { headers, timeout: 25000 });
        html = response.data;
        $ = cheerio.load(html);
      }
    }

    const title = $('title').text().trim() || $('h1').first().text().trim() || 'Manga Chapter';
    const images = [];
    const seenUrls = new Set();

    // Strategy 1: Look for known manga reader containers or img attributes
    $('img').each((_, el) => {
      const src = $(el).attr('data-src') ||
                  $(el).attr('data-lazy-src') ||
                  $(el).attr('data-original') ||
                  $(el).attr('data-url') ||
                  $(el).attr('srcset')?.split(' ')[0] ||
                  $(el).attr('src');

      if (!src) return;

      // Filter out tiny icons, logos, avatars, ads
      const lower = src.toLowerCase();
      if (lower.includes('avatar') || lower.includes('logo') || lower.includes('icon') || lower.includes('badge') || lower.includes('banner') || lower.includes('.svg') || lower.includes('ad_') || lower.includes('google')) {
        return;
      }

      try {
        const fullUrl = new URL(src, effectiveUrl).href;
        if (!seenUrls.has(fullUrl)) {
          seenUrls.add(fullUrl);
          images.push(fullUrl);
        }
      } catch (e) {}
    });

    // Strategy 2: Look for script JSON image arrays (common in SPA manga sites)
    if (images.length < 3) {
      const scriptMatches = html.match(/(https?:\/\/[^"'\s\\]+\.(?:jpg|jpeg|png|webp))/gi);
      if (scriptMatches) {
        scriptMatches.forEach(imgUrl => {
          const cleanUrl = imgUrl.replace(/\\/g, '');
          const lower = cleanUrl.toLowerCase();
          if (!lower.includes('avatar') && !lower.includes('logo') && !lower.includes('icon') && !seenUrls.has(cleanUrl)) {
            seenUrls.add(cleanUrl);
            images.push(cleanUrl);
          }
        });
      }
    }

    return res.json({
      success: true,
      title,
      sourceUrl: effectiveUrl,
      images,
      count: images.length
    });

  } catch (err) {
    console.error('Fetch manga error:', err.message);
    return res.status(500).json({ success: false, error: `ไม่สามารถดึงรูปภาพจากเว็บนี้ได้: ${err.message}` });
  }
});

// 3. UPLOAD LOCAL IMAGES
app.post('/api/upload-images', upload.array('files', 100), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    const images = req.files.map(file => `/uploads/${file.filename}`);
    return res.json({
      success: true,
      title: 'Uploaded Chapter',
      images,
      count: images.length
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 4. TRANSLATE MANGA PAGE USING GEMINI VISION API
app.post('/api/translate-page', async (req, res) => {
  const {
    imageUrl,
    imageBase64,
    apiKey,
    model = 'gemini-3.6-flash',
    style = 'natural', // natural, shonen, romance, comedic
    targetLang = 'th',
    forceRefresh = false
  } = req.body;

  const activeApiKey = (apiKey && apiKey !== 'SERVER_CONFIGURED') ? apiKey.trim() : process.env.GEMINI_API_KEY;
  if (!activeApiKey) {
    return res.status(400).json({
      success: false,
      error: 'กรุณากรอก Google Gemini API Key ในเมนูตั้งค่าก่อนเริ่มแปล'
    });
  }

  // Check server cache
  const identifier = imageUrl || (imageBase64 ? imageBase64.substring(0, 200) : '');
  const cacheKey = getCacheKey(identifier, style, targetLang);
  const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);

  if (!forceRefresh && fs.existsSync(cachePath)) {
    try {
      const cachedData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      return res.json({ success: true, fromCache: true, ...cachedData });
    } catch (e) {}
  }

  try {
    let base64Data = '';
    let mimeType = 'image/jpeg';

    if (imageBase64) {
      const match = imageBase64.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
      if (match) {
        mimeType = match[1];
        base64Data = match[2];
      } else {
        base64Data = imageBase64;
      }
    } else if (imageUrl) {
      let targetImgUrl = imageUrl;
      let refererHeader = '';

      // Check if it's our proxy URL
      if (imageUrl.includes('/api/proxy-image?')) {
        const queryStr = imageUrl.split('?')[1] || '';
        const params = new URLSearchParams(queryStr);
        targetImgUrl = params.get('url') || imageUrl;
        refererHeader = params.get('referer') || '';
      }

      if (targetImgUrl.startsWith('/uploads/')) {
        const localPath = path.join(__dirname, targetImgUrl);
        const buffer = fs.readFileSync(localPath);
        base64Data = buffer.toString('base64');
        mimeType = targetImgUrl.endsWith('.png') ? 'image/png' : targetImgUrl.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      } else if (targetImgUrl.startsWith('http://') || targetImgUrl.startsWith('https://')) {
        const parsed = new URL(targetImgUrl);
        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Referer': refererHeader || `${parsed.protocol}//${parsed.hostname}/`,
          'Origin': `${parsed.protocol}//${parsed.hostname}`
        };

        const response = await axios.get(targetImgUrl, {
          responseType: 'arraybuffer',
          timeout: 25000,
          headers
        });
        base64Data = Buffer.from(response.data).toString('base64');
        mimeType = response.headers['content-type'] || 'image/jpeg';
      } else {
        throw new Error(`Invalid image URL format: ${imageUrl}`);
      }
    } else {
      return res.status(400).json({ success: false, error: 'No image provided' });
    }

    // System prompt tailored for Manga / Manhwa / Webtoon OCR & translation
    let styleInstruction = 'แปลภาษาไทยให้เป็นธรรมชาติ เข้ากับบริบทการ์ตูน/มังงะ สละสลวย สนุกสนาน มีชีวิตชีวา';
    if (style === 'shonen') styleInstruction = 'แปลแนวโชเน็น/แอ็กชัน ดุดัน เร้าใจ มีพลัง ใช้สำนวนคำพูดแบบการ์ตูนต่อสู้';
    if (style === 'romance') styleInstruction = 'แปลแนวโรแมนติก/ดราม่า อ่อนหวาน ละมุน หรือเจ็บปวดตามอารมณ์ตัวละคร';
    if (style === 'comedic') styleInstruction = 'แปลแนวคอมเมดี้ ตลก กวนๆ ใช้มุกและภาษาพูดที่เข้าใจง่าย สนุกสนาน';

    const promptText = `You are an elite Manga/Manhwa Typesetter & Localization Expert.
Analyze this manga page image thoroughly and identify ALL text elements including speech bubbles, thought bubbles, captions, and sound effects.

For EACH text element:
1. Detect tight 2D bounding box [ymin, xmin, ymax, xmax] in 0-1000 normalized coordinates, tightly bounding the exact text words themselves (hug the text characters tightly, do NOT include empty space below or around the text).
2. Transcribe the original text accurately (Japanese, Korean, English, Chinese).
3. Translate into Thai (${styleInstruction}).
4. Identify the bubble shape: "oval", "circle", "rounded_rect", "rect", "cloud", or "sfx".
5. Identify background color: "#ffffff", "#000000", or exact hex color.
6. Identify text color: "#000000" or "#ffffff".
7. Determine text type: "dialogue", "thought", "narration", "sfx", or "side_text".

Return STRICT JSON matching this structure:
{
  "page_summary": "สรุปสั้นๆ 1 ประโยค",
  "detected_language": "ja" | "ko" | "en" | "zh",
  "bubbles": [
    {
      "box_2d": [ymin, xmin, ymax, xmax],
      "source_text": "元のテキスト",
      "thai_text": "คำแปลภาษาไทย",
      "bubble_shape": "oval",
      "text_type": "dialogue",
      "bg_color": "#ffffff",
      "text_color": "#000000"
    }
  ]
}`;


    // Smart Multi-Quota Model Rotation Pool (Active Quota First)
    const candidateModels = Array.from(new Set([
      'gemini-3.5-flash-lite',
      'gemini-3-flash-preview',
      'gemini-3.6-flash',
      model,
      'gemini-3.1-flash-lite'
    ]));
    let geminiRes = null;
    let lastError = null;





    for (const targetModel of candidateModels) {
      try {
        const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${activeApiKey}`;
        const requestBody = {
          contents: [
            {
              parts: [
                { text: promptText },
                {
                  inline_data: {
                    mime_type: mimeType.split(';')[0],
                    data: base64Data
                  }
                }
              ]
            }
          ],
          generationConfig: {
            response_mime_type: "application/json",
            temperature: 0.3
          }
        };

        geminiRes = await axios.post(geminiEndpoint, requestBody, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 45000
        });

        if (geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
          break; // Success!
        }
      } catch (err) {
        lastError = err;
        console.warn(`Model ${targetModel} failed (${err.response?.status || err.message}), trying next fallback...`);
      }
    }

    if (!geminiRes) {
      throw lastError || new Error('All Gemini model endpoints failed');
    }

    const candidates = geminiRes.data?.candidates;
    if (!candidates || candidates.length === 0) {
      throw new Error('Gemini API returned no candidates');
    }


    const rawText = candidates[0].content?.parts?.[0]?.text;
    if (!rawText) throw new Error('Empty response from Gemini');

    let parsedResult;
    try {
      parsedResult = JSON.parse(rawText);
    } catch (parseErr) {
      // Fallback regex to extract JSON
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedResult = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Could not parse JSON from Gemini response');
      }
    }

    // Save to cache
    const responseData = {
      pageSummary: parsedResult.page_summary || '',
      detectedLanguage: parsedResult.detected_language || 'auto',
      bubbles: (parsedResult.bubbles || []).map((b, idx) => ({
        id: `b_${idx + 1}`,
        box2d: b.box_2d || [0, 0, 0, 0],
        sourceText: b.source_text || '',
        thaiText: b.thai_text || '',
        bubbleShape: b.bubble_shape || 'oval',
        textType: b.text_type || 'dialogue',
        bgColor: b.bg_color || '#ffffff',
        textColor: b.text_color || '#000000'
      }))

    };

    fs.writeFileSync(cachePath, JSON.stringify(responseData, null, 2), 'utf8');

    return res.json({
      success: true,
      fromCache: false,
      ...responseData
    });

  } catch (err) {
    console.error('Translation error:', err.response?.data || err.message);
    const msg = err.response?.data?.error?.message || err.message;
    return res.status(500).json({
      success: false,
      error: `Gemini API Error: ${msg}`
    });
  }
});

// 5. TEST API KEY
app.post('/api/test-key', async (req, res) => {
  const { apiKey, model = 'gemini-3.8-flash' } = req.body;
  const activeApiKey = (apiKey && apiKey !== 'SERVER_CONFIGURED') ? apiKey.trim() : process.env.GEMINI_API_KEY;
  if (!activeApiKey) return res.status(400).json({ success: false, error: 'API key is required' });

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${activeApiKey}`;
    const response = await axios.post(url, {
      contents: [{ parts: [{ text: 'Hello! Respond with {"status":"ok"}' }] }],
      generationConfig: { response_mime_type: 'application/json' }
    }, { timeout: 10000 });

    return res.json({ success: true, message: 'API Key ใช้งานได้ปกติสมบูรณ์!', data: response.data });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    return res.status(400).json({ success: false, error: msg });
  }
});


// 6. NETWORK & QR CODE (FOR MOBILE)
function getLocalIpAddresses() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push({ name, ip: net.address });
      }
    }
  }
  return ips;
}

app.get('/api/network-info', (req, res) => {
  const ips = getLocalIpAddresses();
  // Find Wi-Fi or local LAN 192.168.x.x
  const wifiOrLan = ips.find(i => /wi-?fi|wlan/i.test(i.name)) || ips.find(i => i.ip.startsWith('192.168.')) || ips[0];
  const primaryIp = wifiOrLan ? wifiOrLan.ip : 'localhost';
  const mobileUrl = `http://${primaryIp}:${PORT}`;

  res.json({
    ips,
    primaryIp,
    mobileUrl,
    port: PORT
  });
});

app.get('/api/qrcode', async (req, res) => {
  try {
    let target = req.query.url;
    if (!target) {
      const ips = getLocalIpAddresses();
      const wifiOrLan = ips.find(i => /wi-?fi|wlan/i.test(i.name)) || ips.find(i => i.ip.startsWith('192.168.')) || ips[0];
      const primaryIp = wifiOrLan ? wifiOrLan.ip : 'localhost';
      target = `http://${primaryIp}:${PORT}`;
    }

    const svg = await QRCode.toString(target, {
      type: 'svg',
      margin: 1,
      color: {
        dark: '#ffffff',
        light: '#12161f'
      }
    });

    res.type('image/svg+xml').send(svg);
  } catch (err) {
    res.status(500).send('Error generating QR code');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIpAddresses();
  const wifiOrLan = ips.find(i => /wi-?fi|wlan/i.test(i.name)) || ips.find(i => i.ip.startsWith('192.168.')) || ips[0];
  const primaryIp = wifiOrLan ? wifiOrLan.ip : 'localhost';

  console.log(`====================================================`);
  console.log(`🚀 MangaX AI Translator running!`);
  console.log(`💻 PC / Local:    http://localhost:${PORT}`);
  console.log(`📱 Phone / Wi-Fi:  http://${primaryIp}:${PORT}`);
  console.log(`====================================================`);
});
