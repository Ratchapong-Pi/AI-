/**
 * MangaX AI - Gemini Powered Manga Translator Web App
 */

class MangaTranslatorApp {
  constructor() {
    this.pages = []; // [{ id, url, base64, status: 'pending'|'translating'|'done'|'error', translation: null }]
    this.currentPageIndex = 0;
    this.viewMode = 'webtoon'; // 'webtoon' | 'single'
    this.showOriginal = false;
    this.zoomLevel = 1.0;
    this.activePopoverBubble = null;
    this.isTranslatingBatch = false;

    const storedCleaning = localStorage.getItem('mangax_cleaning_mode');
    const activeCleaning = (storedCleaning === 'smart' || storedCleaning === 'solid' || !storedCleaning) ? 'below' : storedCleaning;
    localStorage.setItem('mangax_cleaning_mode', activeCleaning);

    // User settings
    this.settings = {
      apiKey: localStorage.getItem('mangax_gemini_api_key') || '',
      model: localStorage.getItem('mangax_gemini_model') || 'gemini-3.6-flash',
      style: localStorage.getItem('mangax_trans_style') || 'natural',
      cleaningMode: activeCleaning,
      fontFamily: localStorage.getItem('mangax_font') || "'Kanit', sans-serif",
      fontSizeMultiplier: parseFloat(localStorage.getItem('mangax_font_multiplier') || '1.0'),
      patchOpacity: parseFloat(localStorage.getItem('mangax_patch_opacity') || '0.95'),
      textStroke: localStorage.getItem('mangax_text_stroke') !== 'false',
      autoPreload: localStorage.getItem('mangax_auto_preload') !== 'false'
    };

    // Translation Priority Queue
    this.translationQueue = []; // [pageIndex, ...]
    this.activeWorkers = 0;
    this.maxConcurrent = 1; // Strict queue to prevent 503 high demand spikes
    this.scrollObserver = null;
    this.scrollDebounceTimer = null;
  }

  init() {
    this.bindEvents();
    this.applySettingsToDOM();
    this.checkInitialState();
    this.setupScrollObserver();
    
    if (window.lucide) window.lucide.createIcons();
  }

  setupScrollObserver() {
    if (this.scrollObserver) this.scrollObserver.disconnect();

    this.scrollObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const index = parseInt(entry.target.getAttribute('data-page-index'));
          if (!isNaN(index) && this.pages[index] && this.pages[index].status === 'pending') {
            // Put visible page at the top of the priority queue
            this.enqueuePage(index, true);
          }
        }
      });
    }, {
      rootMargin: '200px 0px 400px 0px',
      threshold: 0.05
    });
  }

  enqueuePage(pageIndex, prioritize = false) {
    const page = this.pages[pageIndex];
    if (!page || page.status === 'done' || page.status === 'translating') return;

    // Remove if already in queue to avoid duplicates
    this.translationQueue = this.translationQueue.filter(idx => idx !== pageIndex);

    if (prioritize) {
      this.translationQueue.unshift(pageIndex); // Place visible page at head of queue
    } else {
      this.translationQueue.push(pageIndex);
    }

    this.processQueue();
  }

  async processQueue() {
    if (this.activeWorkers >= this.maxConcurrent || this.translationQueue.length === 0) return;

    const nextIndex = this.translationQueue.shift();
    if (nextIndex === undefined) return;

    this.activeWorkers++;
    try {
      await this.translatePage(nextIndex);
    } finally {
      this.activeWorkers--;
      // Small pause between pages for smooth API pacing
      setTimeout(() => this.processQueue(), 300);
    }
  }



  bindEvents() {
    // Top Nav buttons
    document.getElementById('btnOpenSourceModal')?.addEventListener('click', () => this.openSourceModal('url'));
    document.getElementById('btnSettings')?.addEventListener('click', () => this.openSettingsModal());
    document.getElementById('btnToggleOriginal')?.addEventListener('click', () => this.toggleOriginalView());
    document.getElementById('btnAutoTranslateAll')?.addEventListener('click', () => this.autoTranslateAll());
    document.getElementById('btnExportPage')?.addEventListener('click', () => this.exportCurrentPage());
    document.getElementById('btnConnectMobile')?.addEventListener('click', () => this.openMobileModal());
    document.getElementById('btnFullscreen')?.addEventListener('click', () => this.toggleFullscreen());

    // Welcome Hero buttons
    document.getElementById('btnHeroUrl')?.addEventListener('click', () => this.openSourceModal('url'));
    document.getElementById('btnHeroUpload')?.addEventListener('click', () => this.openSourceModal('upload'));
    document.getElementById('btnHeroSample')?.addEventListener('click', () => this.openSourceModal('sample'));

    // Mobile Bottom Bar buttons
    document.getElementById('mBtnOpen')?.addEventListener('click', () => this.openSourceModal('url'));
    document.getElementById('mBtnToggleMode')?.addEventListener('click', () => {
      this.setViewMode(this.viewMode === 'webtoon' ? 'single' : 'webtoon');
    });
    document.getElementById('mBtnTranslate')?.addEventListener('click', () => this.autoTranslateAll());
    document.getElementById('mBtnFullscreen')?.addEventListener('click', () => this.toggleFullscreen());
    document.getElementById('mBtnSettings')?.addEventListener('click', () => this.openSettingsModal());

    // Mobile QR Modal
    document.getElementById('btnCopyMobileUrl')?.addEventListener('click', () => this.copyMobileUrl());

    // Mobile FAB (Hold/Tap to show original artwork)
    const fab = document.getElementById('mobileFabOriginal');
    if (fab) {
      fab.addEventListener('touchstart', (e) => {
        e.preventDefault();
        this.setOriginalView(true);
        fab.classList.add('active');
      }, { passive: false });
      fab.addEventListener('touchend', (e) => {
        e.preventDefault();
        this.setOriginalView(false);
        fab.classList.remove('active');
      }, { passive: false });
      fab.addEventListener('touchcancel', () => {
        this.setOriginalView(false);
        fab.classList.remove('active');
      });
      fab.addEventListener('mousedown', () => {
        this.setOriginalView(true);
        fab.classList.add('active');
      });
      fab.addEventListener('mouseup', () => {
        this.setOriginalView(false);
        fab.classList.remove('active');
      });
    }

    // Touch Swipe Gestures
    this.setupTouchGestures();

    // View Mode Switchers
    document.getElementById('modeWebtoon')?.addEventListener('click', () => this.setViewMode('webtoon'));
    document.getElementById('modeSingle')?.addEventListener('click', () => this.setViewMode('single'));

    // Manga Page Slider / Nav
    document.getElementById('btnPrevPage')?.addEventListener('click', () => this.prevPage());
    document.getElementById('btnNextPage')?.addEventListener('click', () => this.nextPage());
    document.getElementById('mangaPageSlider')?.addEventListener('input', (e) => this.goToPage(parseInt(e.target.value) - 1));

    // Zoom Controls
    document.getElementById('btnZoomIn')?.addEventListener('click', () => this.setZoom(this.zoomLevel + 0.15));
    document.getElementById('btnZoomOut')?.addEventListener('click', () => this.setZoom(this.zoomLevel - 0.15));
    document.getElementById('btnFitWidth')?.addEventListener('click', () => this.setZoom(1.0));

    // Modal Backdrop & Close button click handling
    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) backdrop.style.display = 'none';
      });
    });
    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const modal = btn.closest('.modal-backdrop');
        if (modal) modal.style.display = 'none';
      });
    });

    // Source Modal Tabs (handles clicks on icon or button)
    document.querySelectorAll('.modal-tabs .tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const targetBtn = e.currentTarget || e.target.closest('.tab-btn');
        if (!targetBtn) return;
        document.querySelectorAll('.modal-tabs .tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.modal-body .tab-pane').forEach(p => p.classList.remove('active'));
        targetBtn.classList.add('active');
        const tabId = targetBtn.getAttribute('data-tab');
        if (tabId) {
          const pane = document.getElementById(tabId);
          if (pane) pane.classList.add('active');
        }
      });
    });

    // Fetch URL Form
    const btnFetch = document.getElementById('btnFetchUrl');
    const inputUrl = document.getElementById('mangaWebUrl');
    if (btnFetch) {
      btnFetch.addEventListener('click', (e) => {
        e.preventDefault();
        this.fetchFromWebUrl();
      });
    }
    if (inputUrl) {
      inputUrl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.fetchFromWebUrl();
        }
      });
    }



    // Direct Image URLs
    document.getElementById('btnLoadDirectUrls')?.addEventListener('click', () => this.loadDirectImageUrls());

    // File Drop Zone & Picker
    const dropZone = document.getElementById('dropZone');
    const filePicker = document.getElementById('filePicker');
    if (dropZone && filePicker) {
      dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
      dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
      dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files?.length) this.handleUploadedFiles(e.dataTransfer.files);
      });
      filePicker.addEventListener('change', (e) => {
        if (e.target.files?.length) this.handleUploadedFiles(e.target.files);
      });
    }

    // Settings Modal
    document.getElementById('btnTestApiKey')?.addEventListener('click', () => this.testApiKey());
    document.getElementById('btnSaveSettings')?.addEventListener('click', () => this.saveSettings());
    document.getElementById('btnToggleKeyVisibility')?.addEventListener('click', () => {
      const inp = document.getElementById('apiKeyInput');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    document.getElementById('fontSizeMultiplier')?.addEventListener('input', (e) => {
      document.getElementById('fontSizeDisplay').textContent = `${Math.round(e.target.value * 100)}%`;
    });
    document.getElementById('bubblePatchOpacity')?.addEventListener('input', (e) => {
      document.getElementById('patchOpacityDisplay').textContent = `${Math.round(e.target.value * 100)}%`;
    });

    // Popover / Inline Editor actions
    document.getElementById('btnClosePopover')?.addEventListener('click', () => this.closePopover());
    document.getElementById('btnSaveBubbleEdit')?.addEventListener('click', () => this.saveBubbleEdit());
    document.getElementById('btnCopySource')?.addEventListener('click', () => this.copySourceText());
    document.getElementById('btnSpeakSource')?.addEventListener('click', () => this.speakSourceText());

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.setOriginalView(true);
      }
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        if (this.viewMode === 'single') this.nextPage();
      }
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        if (this.viewMode === 'single') this.prevPage();
      }
      if (e.key === 't' || e.key === 'T') {
        this.translatePage(this.currentPageIndex, true);
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.setOriginalView(false);
      }
    });
  }

  async safeFetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      if (res.status === 404 || window.location.hostname.endsWith('github.io')) {
        throw new Error('⚠️ GitHub Pages ไม่รองรับ Node.js: หากเปิดจาก GitHub Pages จะไม่สามารถเชื่อมต่อเซิร์ฟเวอร์แปลหรือดึงภาพได้ กรุณารันด้วย "npm start" บนคอมพิวเตอร์ หรือ Deploy ขึ้น Render.com');
      }
      const text = await res.text();
      throw new Error(`เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง (${res.status}): ${text.slice(0, 80)}`);
    }
    return await res.json();
  }

  async checkInitialState() {
    if (window.location.hostname.endsWith('github.io')) {
      setTimeout(() => {
        this.showToast('⚠️ คุณกำลังเปิดจาก GitHub Pages (ไม่รองรับ Node.js) กรุณารันบนคอมด้วย npm start หรือ Deploy บน Render.com', 'warning');
      }, 1000);
      return;
    }

    try {
      const data = await this.safeFetchJson('/api/config');
      if (data.hasServerKey) {
        if (!this.settings.apiKey) {
          this.settings.apiKey = 'SERVER_CONFIGURED';
        }
        const apiKeyInput = document.getElementById('apiKeyInput');
        if (apiKeyInput && !apiKeyInput.value) {
          apiKeyInput.placeholder = `เชื่อมต่อกับระบบแล้ว (${data.maskedKey})`;
        }
        const statusEl = document.getElementById('apiKeyStatus');
        if (statusEl) {
          statusEl.textContent = `✅ เชื่อมต่อ Gemini API Key ในระบบแล้ว (${data.maskedKey})`;
          statusEl.style.color = 'var(--success)';
        }
        this.showToast('✅ เชื่อมต่อ Gemini AI พร้อมใช้งานแล้ว!', 'success');
      } else if (!this.settings.apiKey) {
        setTimeout(() => {
          this.showToast('ยินดีต้อนรับ! กรุณาใส่ Gemini API Key ในเมนูตั้งค่าเพื่อเริ่มแปล', 'info');
        }, 800);
      }
    } catch (e) {
      console.error(e);
    }
  }

  applySettingsToDOM() {
    document.documentElement.style.setProperty('--font-thai', this.settings.fontFamily);
    document.documentElement.style.setProperty('--font-size-multiplier', this.settings.fontSizeMultiplier);
    document.documentElement.style.setProperty('--patch-opacity', this.settings.patchOpacity);

    const apiKeyInput = document.getElementById('apiKeyInput');
    const modelSelect = document.getElementById('modelSelect');
    const transStyle = document.getElementById('translationStyle');
    const cleaningMode = document.getElementById('cleaningMode');
    const fontSelect = document.getElementById('fontSelect');
    const fontMult = document.getElementById('fontSizeMultiplier');
    const fontDisplay = document.getElementById('fontSizeDisplay');
    const patchOp = document.getElementById('bubblePatchOpacity');
    const patchDisplay = document.getElementById('patchOpacityDisplay');
    const chkTextStroke = document.getElementById('chkTextStroke');
    const chkAutoPreload = document.getElementById('chkAutoPreload');

    if (apiKeyInput && this.settings.apiKey && this.settings.apiKey !== 'SERVER_CONFIGURED') apiKeyInput.value = this.settings.apiKey;
    if (modelSelect) modelSelect.value = this.settings.model;
    if (transStyle) transStyle.value = this.settings.style;
    if (cleaningMode) cleaningMode.value = this.settings.cleaningMode;
    if (fontSelect) fontSelect.value = this.settings.fontFamily;
    if (fontMult) fontMult.value = this.settings.fontSizeMultiplier;
    if (fontDisplay) fontDisplay.textContent = `${Math.round(this.settings.fontSizeMultiplier * 100)}%`;
    if (patchOp) patchOp.value = this.settings.patchOpacity;
    if (patchDisplay) patchDisplay.textContent = `${Math.round(this.settings.patchOpacity * 100)}%`;
    if (chkTextStroke) chkTextStroke.checked = this.settings.textStroke;
    if (chkAutoPreload) chkAutoPreload.checked = this.settings.autoPreload;
  }

  saveSettings() {
    const rawKey = document.getElementById('apiKeyInput').value.trim();
    if (rawKey) {
      this.settings.apiKey = rawKey;
      localStorage.setItem('mangax_gemini_api_key', this.settings.apiKey);
    }
    this.settings.model = document.getElementById('modelSelect').value;
    this.settings.style = document.getElementById('translationStyle').value;
    this.settings.cleaningMode = document.getElementById('cleaningMode').value;
    this.settings.fontFamily = document.getElementById('fontSelect').value;
    this.settings.fontSizeMultiplier = parseFloat(document.getElementById('fontSizeMultiplier').value);
    this.settings.patchOpacity = parseFloat(document.getElementById('bubblePatchOpacity').value);
    this.settings.textStroke = document.getElementById('chkTextStroke').checked;
    this.settings.autoPreload = document.getElementById('chkAutoPreload').checked;

    localStorage.setItem('mangax_gemini_model', this.settings.model);
    localStorage.setItem('mangax_trans_style', this.settings.style);
    localStorage.setItem('mangax_cleaning_mode', this.settings.cleaningMode);
    localStorage.setItem('mangax_font', this.settings.fontFamily);
    localStorage.setItem('mangax_font_multiplier', this.settings.fontSizeMultiplier);
    localStorage.setItem('mangax_patch_opacity', this.settings.patchOpacity);
    localStorage.setItem('mangax_text_stroke', this.settings.textStroke);
    localStorage.setItem('mangax_auto_preload', this.settings.autoPreload);

    this.applySettingsToDOM();
    this.closeModal('settingsModal');
    this.renderCurrentPages();
    this.showToast('บันทึกการตั้งค่าเรียบร้อยแล้ว', 'success');
  }


  async testApiKey() {
    const inputVal = document.getElementById('apiKeyInput').value.trim();
    const model = document.getElementById('modelSelect').value;
    const statusEl = document.getElementById('apiKeyStatus');

    statusEl.textContent = '⏳ กำลังตรวจสอบการเชื่อมต่อกับ Google AI...';
    statusEl.style.color = 'var(--warning)';

    try {
      const data = await this.safeFetchJson('/api/test-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: inputVal || this.settings.apiKey, model })
      });
      if (data.success) {
        statusEl.textContent = '✅ API Key ใช้งานได้ปกติสมบูรณ์!';
        statusEl.style.color = 'var(--success)';
      } else {
        statusEl.textContent = `❌ ผิดพลาด: ${data.error}`;
        statusEl.style.color = 'var(--danger)';
      }
    } catch (e) {
      statusEl.textContent = `❌ ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์: ${e.message}`;
      statusEl.style.color = 'var(--danger)';
    }
  }

  // --- SOURCE IMPORT METHODS ---
  async fetchFromWebUrl() {
    const urlInput = document.getElementById('mangaWebUrl');
    const url = urlInput.value.trim();
    if (!url) {
      this.showToast('กรุณากรอก URL ตอนมังงะ', 'error');
      return;
    }

    const btn = document.getElementById('btnFetchUrl');
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" class="spin"></i> กำลังดึงข้อมูล...';
    if (window.lucide) window.lucide.createIcons();

    try {
      const data = await this.safeFetchJson('/api/fetch-manga-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });

      if (!data.success || !data.images?.length) {
        throw new Error(data.error || 'ไม่พบรูปภาพในหน้านี้');
      }

      this.loadChapterData(data.title, data.images.map(imgUrl => ({
        url: `/api/proxy-image?url=${encodeURIComponent(imgUrl)}&referer=${encodeURIComponent(url)}`
      })));

      this.closeModal('sourceModal');
      this.showToast(`ดึงสำเร็จ! พบทั้งหมด ${data.images.length} หน้า`, 'success');
    } catch (err) {
      this.showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="download-cloud"></i> ดึงรูปภาพ';
      if (window.lucide) window.lucide.createIcons();
    }
  }

  async handleUploadedFiles(files) {
    const formData = new FormData();
    const sortedFiles = Array.from(files).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    sortedFiles.forEach(file => formData.append('files', file));

    this.showToast('กำลังอัปโหลดรูปภาพ...', 'info');

    try {
      const data = await this.safeFetchJson('/api/upload-images', {
        method: 'POST',
        body: formData
      });

      if (!data.success || !data.images?.length) {
        throw new Error(data.error || 'อัปโหลดไม่สำเร็จ');
      }

      this.loadChapterData(data.title || 'ตอนที่อัปโหลด', data.images.map(imgUrl => ({ url: imgUrl })));
      this.closeModal('sourceModal');
      this.showToast(`โหลดสำเร็จ ${data.images.length} หน้า`, 'success');
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  }

  loadDirectImageUrls() {
    const text = document.getElementById('directImageUrls').value.trim();
    if (!text) return;

    const urls = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));
    if (!urls.length) {
      this.showToast('ไม่พบ Image URL ที่ถูกต้อง', 'error');
      return;
    }

    this.loadChapterData('Custom Chapter', urls.map(url => ({
      url: `/api/proxy-image?url=${encodeURIComponent(url)}`
    })));

    this.closeModal('sourceModal');
    this.showToast(`โหลด ${urls.length} รูปเรียบร้อย`, 'success');
  }

  loadSample(type = 'japanese') {
    if (type === 'japanese') {
      this.loadSampleChapter();
    } else {
      this.loadKoreanSampleChapter();
    }
    this.closeModal('sourceModal');
  }

  loadSampleChapter() {
    const sampleImages = [
      'https://raw.githubusercontent.com/kha-white/manga-ocr/master/assets/examples/0.jpg',
      'https://raw.githubusercontent.com/kha-white/manga-ocr/master/assets/examples/1.jpg'
    ];

    this.loadChapterData('ตัวอย่างมังงะญี่ปุ่น (Sample Chapter)', sampleImages.map(imgUrl => ({
      url: `/api/proxy-image?url=${encodeURIComponent(imgUrl)}`
    })));

    this.showToast('โหลดหน้าตัวอย่างเรียบร้อย!', 'success');
  }

  loadKoreanSampleChapter() {
    const sampleImages = [
      'https://raw.githubusercontent.com/kha-white/manga-ocr/master/assets/examples/0.jpg'
    ];

    this.loadChapterData('ตัวอย่างมันฮวาเกาหลี (Korean Webtoon)', sampleImages.map(imgUrl => ({
      url: `/api/proxy-image?url=${encodeURIComponent(imgUrl)}`
    })));
  }

  loadChapterData(title, imageItems) {
    this.pages = imageItems.map((item, idx) => ({
      id: `p_${idx + 1}`,
      pageNumber: idx + 1,
      url: item.url,
      status: 'pending',
      translation: null
    }));

    this.currentPageIndex = 0;
    this.translationQueue = []; // Reset queue for new chapter

    // Update UI Header
    document.getElementById('welcomeHero').style.display = 'none';
    document.getElementById('chapterInfoPill').style.display = 'flex';
    document.getElementById('chapterTitleDisplay').textContent = title;
    document.getElementById('pageCountBadge').textContent = `${this.pages.length} หน้า`;

    // Update Manga slider
    const slider = document.getElementById('mangaPageSlider');
    if (slider) {
      slider.max = this.pages.length;
      slider.value = 1;
    }

    this.setViewMode(this.viewMode);
    this.renderCurrentPages();

    // Auto translate first page immediately via priority queue
    if (this.pages.length > 0) {
      this.enqueuePage(0, true);
    }
  }


  // --- RENDERING ENGINE ---
  setViewMode(mode) {
    this.viewMode = mode;
    const btnWebtoon = document.getElementById('modeWebtoon');
    const btnSingle = document.getElementById('modeSingle');
    const webtoonCont = document.getElementById('webtoonContainer');
    const mangaCont = document.getElementById('mangaContainer');

    if (mode === 'webtoon') {
      btnWebtoon?.classList.add('active');
      btnSingle?.classList.remove('active');
      if (webtoonCont) webtoonCont.style.display = 'flex';
      if (mangaCont) mangaCont.style.display = 'none';
    } else {
      btnSingle?.classList.add('active');
      btnWebtoon?.classList.remove('active');
      if (mangaCont) mangaCont.style.display = 'flex';
      if (webtoonCont) webtoonCont.style.display = 'none';
    }

    const mBtnModeLabel = document.getElementById('mBtnModeLabel');
    if (mBtnModeLabel) {
      mBtnModeLabel.textContent = mode === 'webtoon' ? 'Webtoon' : 'Manga';
    }

    this.renderCurrentPages();
  }

  renderCurrentPages() {
    if (!this.pages.length) return;

    if (this.viewMode === 'webtoon') {
      const container = document.getElementById('pagesList');
      if (!container) return;
      container.innerHTML = '';
      this.pages.forEach((page, idx) => {
        container.appendChild(this.createPageCardElement(page, idx));
      });
    } else {
      const viewport = document.getElementById('mangaViewport');
      const pageText = document.getElementById('mangaCurrentPageText');
      if (!viewport) return;
      viewport.innerHTML = '';

      const currentPage = this.pages[this.currentPageIndex];
      if (currentPage) {
        viewport.appendChild(this.createPageCardElement(currentPage, this.currentPageIndex));
      }
      if (pageText) {
        pageText.textContent = `หน้า ${this.currentPageIndex + 1} / ${this.pages.length}`;
      }
    }

    if (window.lucide) window.lucide.createIcons();
  }

  createPageCardElement(page, index) {
    const card = document.createElement('div');
    card.className = 'page-card';
    card.id = `pageCard_${index}`;
    card.setAttribute('data-page-index', index);

    let statusText = 'ยังไม่ได้แปล';
    let statusClass = 'pending';
    let statusIcon = 'clock';

    if (page.status === 'translating') {
      statusText = 'กำลังแปล...';
      statusClass = 'translating';
      statusIcon = 'loader-2';
    } else if (page.status === 'done') {
      statusText = 'แปลแล้ว';
      statusClass = 'done';
      statusIcon = 'check-circle-2';
    } else if (page.status === 'error') {
      statusText = 'ผิดพลาด';
      statusClass = 'error';
      statusIcon = 'alert-triangle';
    }

    card.innerHTML = `
      <div class="page-card-header">
        <div class="page-badge-group">
          <span class="page-num-tag">หน้า ${index + 1}</span>
          <span class="status-tag ${statusClass}">
            <i data-lucide="${statusIcon}" class="${page.status === 'translating' ? 'spin' : ''}"></i>
            <span>${statusText}</span>
          </span>
        </div>
        <div class="page-actions-group">
          <button class="btn btn-secondary btn-sm" onclick="appUI.enqueuePage(${index}, true)" title="แปลหน้านี้ทันที">
            <i data-lucide="refresh-cw"></i> แปลหน้านี้
          </button>
        </div>
      </div>
      <div class="manga-page-wrapper" id="wrapper_${index}">
        <img src="${page.url}" class="manga-image" id="img_${index}" alt="Manga Page ${index + 1}" loading="lazy" />
        <div class="bubbles-overlay-layer ${this.showOriginal ? 'hide-overlay' : ''}" id="overlay_${index}">
        </div>
      </div>
    `;

    const overlay = card.querySelector(`#overlay_${index}`);
    if (page.translation?.bubbles && overlay) {
      this.populateBubbles(overlay, page.translation.bubbles, index);
    }

    // Attach IntersectionObserver to trigger translation when visible
    if (this.scrollObserver) {
      this.scrollObserver.observe(card);
    }

    return card;
  }


  populateBubbles(overlayElement, bubbles, pageIndex) {
    overlayElement.innerHTML = '';
    if (!bubbles || !bubbles.length) return;

    if (this.settings.cleaningMode === 'below') {
      // MODE: Right underneath original text (NO INPAINTING, NO SEQUENCE NUMBERS, NO ANCHOR BOXES)
      bubbles.forEach(bubble => {
        const [ymin, xmin, ymax, xmax] = bubble.box2d;
        
        const topPct = (ymin / 1000) * 100;
        const leftPct = (xmin / 1000) * 100;
        const widthPct = Math.max(2, ((xmax - xmin) / 1000) * 100);
        const heightPct = Math.max(2, ((ymax - ymin) / 1000) * 100);
        const centerX = Math.min(95, Math.max(5, leftPct + (widthPct / 2)));
        const centerY = Math.min(95, Math.max(5, topPct + (heightPct / 2)));

        const formattedText = this.formatThaiComicText(bubble.thaiText || '');
        const baseFontSize = Math.max(12, Math.min(18, 14 * this.settings.fontSizeMultiplier));

        // Subtitle Pill placed directly centered over the original words (like user requested)
        const badgeItem = document.createElement('div');
        badgeItem.className = 'trans-subtitle-badge';
        badgeItem.id = `bubble_${pageIndex}_${bubble.id}`;
        badgeItem.style.top = `${centerY.toFixed(2)}%`;
        badgeItem.style.left = `${centerX.toFixed(2)}%`;

        badgeItem.innerHTML = `
          <div class="trans-badge-pill" style="font-size: ${baseFontSize.toFixed(1)}px;">
            <span class="badge-text">${formattedText}</span>
          </div>
        `;

        badgeItem.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openBubblePopover(bubble, pageIndex, badgeItem);
        });

        overlayElement.appendChild(badgeItem);
      });
      return;
    }

    // Classic / Inpaint / Overlay modes
    bubbles.forEach(bubble => {
      const [ymin, xmin, ymax, xmax] = bubble.box2d;
      
      const topPct = (ymin / 1000) * 100;
      const leftPct = (xmin / 1000) * 100;
      const widthPct = Math.max(2, ((xmax - xmin) / 1000) * 100);
      const heightPct = Math.max(2, ((ymax - ymin) / 1000) * 100);
      const aspectRatio = widthPct / heightPct;

      // Smart shape detection for bubble inpainting
      let shapeClass = 'shape-oval';
      if (bubble.bubbleShape === 'rect' || bubble.textType === 'narration') {
        shapeClass = 'shape-rect';
      } else if (bubble.bubbleShape === 'rounded_rect' || aspectRatio > 1.8 || aspectRatio < 0.5) {
        shapeClass = 'shape-rounded';
      } else if (bubble.bubbleShape === 'sfx' || bubble.textType === 'sfx') {
        shapeClass = 'shape-sfx';
      } else if (bubble.bubbleShape === 'circle') {
        shapeClass = 'shape-oval';
      }

      const bubbleItem = document.createElement('div');
      bubbleItem.className = `speech-bubble-item ${shapeClass} feather-blend`;
      bubbleItem.id = `bubble_${pageIndex}_${bubble.id}`;
      bubbleItem.style.top = `${topPct}%`;
      bubbleItem.style.left = `${leftPct}%`;
      bubbleItem.style.width = `${widthPct}%`;
      bubbleItem.style.height = `${heightPct}%`;

      // Adaptive Thai font size calculation
      const textLength = (bubble.thaiText || '').length;
      const area = widthPct * heightPct;
      let baseFontSize = Math.sqrt(area / (textLength || 1)) * 3.8 * this.settings.fontSizeMultiplier;
      baseFontSize = Math.max(11, Math.min(26, baseFontSize));

      const isTransparent = this.settings.cleaningMode === 'transparent';
      const isDarkBg = bubble.bgColor === '#000000' || bubble.bgColor === '#000' || bubble.textColor === '#ffffff';
      const strokeClass = this.settings.textStroke ? (isDarkBg ? 'text-stroke-dark' : 'text-stroke-light') : '';
      const finalTextColor = isDarkBg ? '#ffffff' : '#000000';
      const finalBgColor = isDarkBg ? '#000000' : (bubble.bgColor || '#ffffff');

      // Segment Thai text for natural line breaks
      const formattedText = this.formatThaiComicText(bubble.thaiText || '');

      bubbleItem.innerHTML = `
        ${isTransparent ? '' : `<div class="bubble-bg-patch" style="background-color: ${finalBgColor}; opacity: ${this.settings.patchOpacity};"></div>`}
        <div class="bubble-text-content ${strokeClass}" style="color: ${finalTextColor}; font-size: ${baseFontSize.toFixed(1)}px;">
          ${formattedText}
        </div>
      `;

      bubbleItem.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openBubblePopover(bubble, pageIndex, bubbleItem);
      });

      overlayElement.appendChild(bubbleItem);
    });
  }

  // Format Thai Comic text with natural word boundaries
  formatThaiComicText(text) {
    if (!text) return '';
    try {
      if (Intl && Intl.Segmenter) {
        const segmenter = new Intl.Segmenter('th', { granularity: 'word' });
        const segments = Array.from(segmenter.segment(text));
        return segments.map(s => this.escapeHtml(s.segment)).join('​'); // Insert zero-width space for clean line wraps
      }
    } catch (e) {}
    return this.escapeHtml(text);
  }


  // --- TRANSLATION ENGINE ---
  async translatePage(pageIndex, force = false, retryCount = 0) {
    const page = this.pages[pageIndex];
    if (!page || (page.status === 'translating' && retryCount === 0)) return;
    if (page.status === 'done' && !force) return;

    page.status = 'translating';
    this.updatePageCardStatus(pageIndex);

    try {
      const data = await this.safeFetchJson('/api/translate-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl: page.url,
          apiKey: this.settings.apiKey,
          model: this.settings.model,
          style: this.settings.style,
          forceRefresh: force
        })
      });

      if (!data.success) {
        // If 503 or busy, retry gracefully
        if (retryCount < 2 && (data.error?.includes('demand') || data.error?.includes('503') || data.error?.includes('429'))) {
          await new Promise(r => setTimeout(r, 1500));
          return this.translatePage(pageIndex, force, retryCount + 1);
        }
        throw new Error(data.error || 'การแปลล้มเหลว');
      }

      page.status = 'done';
      page.translation = data;
      this.updatePageCardStatus(pageIndex);

      const overlay = document.getElementById(`overlay_${pageIndex}`);
      if (overlay) {
        this.populateBubbles(overlay, data.bubbles, pageIndex);
      }

      // Preload next page into queue smoothly
      if (this.settings.autoPreload && pageIndex + 1 < this.pages.length) {
        const nextPage = this.pages[pageIndex + 1];
        if (nextPage && nextPage.status === 'pending') {
          this.enqueuePage(pageIndex + 1, false);
        }
      }

    } catch (err) {
      console.error(err);
      page.status = 'error';
      this.updatePageCardStatus(pageIndex);
      if (!err.message?.includes('demand')) {
        this.showToast(`หน้า ${pageIndex + 1}: ${err.message}`, 'error');
      }
    }
  }


  updatePageCardStatus(pageIndex) {
    const page = this.pages[pageIndex];
    const card = document.getElementById(`pageCard_${pageIndex}`);
    if (!card) return;

    const statusTag = card.querySelector('.status-tag');
    if (!statusTag) return;

    statusTag.className = `status-tag ${page.status}`;
    let icon = 'clock';
    let text = 'ยังไม่ได้แปล';

    if (page.status === 'translating') {
      icon = 'loader-2';
      text = 'กำลังแปล...';
    } else if (page.status === 'done') {
      icon = 'check-circle-2';
      text = 'แปลแล้ว';
    } else if (page.status === 'error') {
      icon = 'alert-triangle';
      text = 'ผิดพลาด';
    }

    statusTag.innerHTML = `<i data-lucide="${icon}" class="${page.status === 'translating' ? 'spin' : ''}"></i><span>${text}</span>`;
    if (window.lucide) window.lucide.createIcons();
  }

  async autoTranslateAll() {
    if (!this.pages.length) {
      this.showToast('ไม่มีหน้ามังงะที่ต้องแปล', 'warning');
      return;
    }

    if (this.isTranslatingBatch) {
      this.showToast('ระบบกำลังแปลอยู่แล้ว', 'info');
      return;
    }

    this.isTranslatingBatch = true;
    this.showToast('เริ่มแปลมังงะอัตโนมัติ...', 'info');

    for (let i = 0; i < this.pages.length; i++) {
      if (this.pages[i].status !== 'done') {
        await this.translatePage(i);
        // Small pause between pages to respect rate limits
        await new Promise(r => setTimeout(r, 400));
      }
    }

    this.isTranslatingBatch = false;
    this.showToast('แปลครบทุกหน้าแล้ว!', 'success');
  }

  // --- INTERACTIVE BUBBLE POPOVER & EDITOR ---
  openBubblePopover(bubble, pageIndex, bubbleElement) {
    this.activePopoverBubble = { bubble, pageIndex, element: bubbleElement };
    const popover = document.getElementById('bubbleEditorPopover');
    const sourceTextEl = document.getElementById('popoverSourceText');
    const thaiInput = document.getElementById('popoverThaiInput');
    const badge = document.getElementById('popoverTypeBadge');

    sourceTextEl.textContent = bubble.sourceText || '(ไม่มีข้อความดั้งเดิม)';
    thaiInput.value = bubble.thaiText || '';
    badge.textContent = bubble.textType === 'sfx' ? 'เอฟเฟกต์ (SFX)' : bubble.textType === 'narration' ? 'คำบรรยาย' : 'บทสนทนา';

    const rect = bubbleElement.getBoundingClientRect();
    let top = rect.bottom + window.scrollY + 10;
    let left = rect.left + window.scrollX;

    if (left + 330 > window.innerWidth) left = window.innerWidth - 340;
    if (left < 10) left = 10;
    if (top + 220 > window.innerHeight + window.scrollY) {
      top = rect.top + window.scrollY - 230;
    }

    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
    popover.style.display = 'block';

    thaiInput.focus();
  }

  closePopover() {
    document.getElementById('bubbleEditorPopover').style.display = 'none';
    this.activePopoverBubble = null;
  }

  saveBubbleEdit() {
    if (!this.activePopoverBubble) return;
    const { bubble, pageIndex, element } = this.activePopoverBubble;
    const newText = document.getElementById('popoverThaiInput').value.trim();

    bubble.thaiText = newText;
    const textContentEl = element.querySelector('.bubble-text-content');
    if (textContentEl) {
      textContentEl.textContent = newText;
    }

    this.closePopover();
    this.showToast('อัปเดตคำแปลเรียบร้อย', 'success');
  }

  copySourceText() {
    if (!this.activePopoverBubble) return;
    navigator.clipboard.writeText(this.activePopoverBubble.bubble.sourceText || '');
    this.showToast('คัดลอกข้อความต้นฉบับแล้ว', 'info');
  }

  speakSourceText() {
    if (!this.activePopoverBubble) return;
    const text = this.activePopoverBubble.bubble.sourceText;
    if (!text || !window.speechSynthesis) return;

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ja-JP';
    window.speechSynthesis.speak(utterance);
  }

  // --- VIEW CONTROLS ---
  toggleOriginalView() {
    this.setOriginalView(!this.showOriginal);
  }

  setOriginalView(show) {
    this.showOriginal = show;
    const btn = document.getElementById('btnToggleOriginal');
    btn?.classList.toggle('active', show);

    document.querySelectorAll('.bubbles-overlay-layer').forEach(layer => {
      layer.style.opacity = show ? '0' : '1';
    });
  }

  setZoom(level) {
    this.zoomLevel = Math.max(0.5, Math.min(2.0, level));
    const label = document.getElementById('zoomLabel');
    if (label) label.textContent = `${Math.round(this.zoomLevel * 100)}%`;

    const container = document.querySelector('.reader-container');
    if (container) {
      container.style.maxWidth = `${Math.round(900 * this.zoomLevel)}px`;
    }
  }

  nextPage() {
    if (this.currentPageIndex + 1 < this.pages.length) {
      this.goToPage(this.currentPageIndex + 1);
    }
  }

  prevPage() {
    if (this.currentPageIndex - 1 >= 0) {
      this.goToPage(this.currentPageIndex - 1);
    }
  }

  goToPage(index) {
    this.currentPageIndex = index;
    const slider = document.getElementById('mangaPageSlider');
    if (slider) slider.value = index + 1;

    this.renderCurrentPages();
    
    if (this.pages[index] && this.pages[index].status === 'pending') {
      this.enqueuePage(index, true);
    }
  }


  // --- EXPORT RENDERED PAGE TO CANVAS / IMAGE ---
  async exportCurrentPage() {
    const pageIndex = this.viewMode === 'single' ? this.currentPageIndex : 0;
    const page = this.pages[pageIndex];
    if (!page) {
      this.showToast('ไม่มีหน้าที่จะบันทึก', 'error');
      return;
    }

    this.showToast('กำลังสร้างรูปภาพ...', 'info');

    const img = document.getElementById(`img_${pageIndex}`);
    if (!img) return;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = img.naturalWidth || img.width || 800;
    canvas.height = img.naturalHeight || img.height || 1200;

    // Draw base image
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // Draw speech bubbles if translated
    if (page.translation?.bubbles && !this.showOriginal) {
      page.translation.bubbles.forEach(b => {
        // Draw inpaint bubble shape (Oval / Rect)
        const isDarkBg = b.bgColor === '#000000' || b.bgColor === '#000' || b.textColor === '#ffffff';
        const finalBgColor = isDarkBg ? '#000000' : (b.bgColor || '#ffffff');
        const finalTextColor = isDarkBg ? '#ffffff' : '#000000';

        ctx.fillStyle = finalBgColor;
        ctx.globalAlpha = this.settings.patchOpacity;

        ctx.beginPath();
        if (b.textType === 'narration') {
          ctx.roundRect(x, y, w, h, 6);
        } else {
          ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.globalAlpha = 1.0;

        // Draw Thai text with outline stroke
        ctx.fillStyle = finalTextColor;
        const textLen = (b.thaiText || '').length || 1;
        const baseFontSize = Math.max(12, Math.min(36, Math.sqrt((w * h) / textLen) * 0.9 * this.settings.fontSizeMultiplier));
        ctx.font = `bold ${baseFontSize.toFixed(0)}px 'Kanit', sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        if (this.settings.textStroke) {
          ctx.strokeStyle = isDarkBg ? '#000000' : '#ffffff';
          ctx.lineWidth = 3;
          this.wrapCanvasText(ctx, b.thaiText, x + w / 2, y + h / 2, w * 0.85, baseFontSize * 1.3, true);
        }

        this.wrapCanvasText(ctx, b.thaiText, x + w / 2, y + h / 2, w * 0.85, baseFontSize * 1.3, false);
      });
    }

    const link = document.createElement('a');
    link.download = `mangax_page_${pageIndex + 1}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    this.showToast('บันทึกรูปภาพเรียบร้อย!', 'success');

  }

  wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight) {
    const words = text.split('');
    let line = '';
    const lines = [];

    for (let n = 0; n < words.length; n++) {
      const testLine = line + words[n];
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidth && n > 0) {
        lines.push(line);
        line = words[n];
      } else {
        line = testLine;
      }
    }
    lines.push(line);

    const totalHeight = lines.length * lineHeight;
    let startY = y - (totalHeight / 2) + (lineHeight / 2);

    for (let k = 0; k < lines.length; k++) {
      ctx.fillText(lines[k], x, startY + (k * lineHeight));
    }
  }

  // --- MODAL UTILS ---
  openSourceModal(tabId = 'url') {
    const modal = document.getElementById('sourceModal');
    if (modal) {
      modal.style.display = 'flex';
      const targetTabBtn = document.querySelector(`.tab-btn[data-tab="tab-${tabId}"]`);
      if (targetTabBtn) targetTabBtn.click();
    }
  }

  openSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (modal) modal.style.display = 'flex';
  }

  async openMobileModal() {
    const modal = document.getElementById('mobileModal');
    if (!modal) return;
    modal.style.display = 'flex';

    try {
      const data = await this.safeFetchJson('/api/network-info');
      const input = document.getElementById('mobileUrlDisplay');
      const qrImg = document.getElementById('qrCodeImg');
      if (input && data.mobileUrl) input.value = data.mobileUrl;
      if (qrImg && data.mobileUrl) qrImg.src = `/api/qrcode?url=${encodeURIComponent(data.mobileUrl)}&t=${Date.now()}`;
    } catch (err) {
      console.error(err);
    }
  }

  copyMobileUrl() {
    const input = document.getElementById('mobileUrlDisplay');
    if (input && input.value) {
      navigator.clipboard.writeText(input.value).then(() => {
        this.showToast('✅ คัดลอกลิงก์เรียบร้อย! นำไปเปิดในเบราว์เซอร์มือถือได้เลย', 'success');
      }).catch(() => {
        input.select();
        document.execCommand('copy');
        this.showToast('✅ คัดลอกลิงก์เรียบร้อย', 'success');
      });
    }
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    }
  }

  setupTouchGestures() {
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartTime = 0;

    const mangaViewport = document.getElementById('mangaViewport');
    if (mangaViewport) {
      mangaViewport.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
          touchStartX = e.touches[0].clientX;
          touchStartY = e.touches[0].clientY;
          touchStartTime = Date.now();
        }
      }, { passive: true });

      mangaViewport.addEventListener('touchend', (e) => {
        if (e.changedTouches.length === 1) {
          const deltaX = e.changedTouches[0].clientX - touchStartX;
          const deltaY = e.changedTouches[0].clientY - touchStartY;
          const elapsed = Date.now() - touchStartTime;

          // Horizontal swipe detection (> 45px, duration < 500ms)
          if (Math.abs(deltaX) > 45 && Math.abs(deltaX) > Math.abs(deltaY) * 1.4 && elapsed < 500) {
            if (deltaX < 0) {
              this.nextPage(); // Swipe left to next page
            } else {
              this.prevPage(); // Swipe right to prev page
            }
          } else if (Math.abs(deltaX) < 15 && Math.abs(deltaY) < 15 && elapsed < 350) {
            // Screen Tap Zones in Single Manga Mode:
            const screenW = window.innerWidth;
            const tapX = e.changedTouches[0].clientX;
            if (tapX < screenW * 0.3) {
              this.prevPage();
            } else if (tapX > screenW * 0.7) {
              this.nextPage();
            }
          }
        }
      }, { passive: true });
    }
  }

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.style.display = 'none';
  }

  showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    if (container.children.length >= 4) {
      container.firstElementChild?.remove();
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    let icon = 'info';
    if (type === 'success') icon = 'check-circle-2';
    if (type === 'error') icon = 'alert-circle';
    if (type === 'warning') icon = 'alert-triangle';

    toast.innerHTML = `<i data-lucide="${icon}"></i> <span>${this.escapeHtml(message)}</span>`;
    container.appendChild(toast);
    if (window.lucide) window.lucide.createIcons();

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

// Instantiate globally on window
let appUI;
function initApp() {
  if (!window.appUI) {
    window.appUI = new MangaTranslatorApp();
    appUI = window.appUI;
    window.appUI.init();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

