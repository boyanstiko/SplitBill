(function () {
  'use strict';

  const STATE_KEY = 'splitbill-state';
  const GEMINI_MODEL = 'gemini-2.5-flash-lite';

  function getGeminiApiKey() {
    return (window.SPLITBILL_CONFIG && window.SPLITBILL_CONFIG.geminiApiKey) || '';
  }

  const RECEIPT_PROMPT = `Разчети касовата бележка на снимката. Извлечи само редове с поръчани артикули.
Пропусни: обща сума, ДДС, бон номер, плащане, касиер, фирма, адрес, дата/час без артикул.
Цените са в EUR (€) или BGN (лв) — върни числото както е на бележката.

ВАЖНО за български бележки — количеството може да е НАД или ПОД името:
A) Име, после "2 x 4.40" и сума 8.80
B) "2x" или "2 x 4.40" и сума 8.80, после името
C) "2x", после име, после сума
За всеки артикул: label=името, qty=броят, price=редовата сума (8.80), НЕ единичната (4.40).

qty е брой (по подразбиране 1). "2 x 4.40" означава qty=2 — задолжително го попълни.
price винаги е общата сума за реда (количество × единична цена).
Не добавяй „×2“ в label — приложението го добавя само.
Върни само валиден JSON по схемата.`;

  const LABEL_UNREADABLE = 'НЕ СЕ ЧЕТЕ';
  const MAX_PRICE = 999999.99;

  const state = {
    imageDataUrl: null,
    items: [],      // { id, label, price, qty }
    people: [],     // { id, name }
    assignments: {}, // itemId -> [personId, ...]
    customQuantities: {} // itemId -> { personId: quantity }
  };

  let nextItemId = 1;
  let nextPersonId = 1;

  const steps = ['step-upload', 'step-items', 'step-people', 'step-assign', 'step-summary'];

  function saveState() {
    const currentStepId = steps.find(id => document.getElementById(id)?.classList.contains('active')) || 'step-upload';
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        currentStep: currentStepId,
        items: state.items,
        people: state.people,
        assignments: state.assignments,
        customQuantities: state.customQuantities,
        nextItemId,
        nextPersonId
      }));
    } catch (e) { /* quota or disabled */ }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.items && Array.isArray(data.items)) {
        state.items = data.items.map(it => {
          const item = { ...it, qty: it.qty != null ? it.qty : 1 };
          applyQtyNormalization(item);
          return item;
        });
      }
      if (data.people && Array.isArray(data.people)) state.people = data.people;
      if (data.assignments && typeof data.assignments === 'object') state.assignments = data.assignments;
      if (data.customQuantities && typeof data.customQuantities === 'object') {
        state.customQuantities = data.customQuantities;
      } else {
        state.customQuantities = {};
      }
      if (typeof data.nextItemId === 'number') nextItemId = data.nextItemId;
      if (typeof data.nextPersonId === 'number') nextPersonId = data.nextPersonId;
      const step = steps.includes(data.currentStep) ? data.currentStep : 'step-upload';
      showStep(step, false);
      if (step === 'step-items') renderItems();
      else if (step === 'step-people') renderPeople();
      else if (step === 'step-assign') renderAssign();
      else if (step === 'step-summary') renderSummary();
      return true;
    } catch (e) { return false; }
  }

  function showStep(stepId, focusAndScroll) {
    const doFocus = focusAndScroll !== false;
    steps.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('active', id === stepId);
    });
    const stepper = document.getElementById('stepper');
    if (stepper) {
      const idx = steps.indexOf(stepId);
      stepper.querySelectorAll('.stepper-dot').forEach((dot, i) => {
        dot.classList.remove('current', 'done');
        dot.removeAttribute('aria-current');
        if (i === idx) { dot.classList.add('current'); dot.setAttribute('aria-current', 'true'); }
        else if (i < idx) dot.classList.add('done');
      });
      stepper.querySelectorAll('.stepper-line').forEach((line, i) => {
        line.classList.toggle('done', i < idx);
      });
    }
    if (doFocus) {
      const main = document.querySelector('.main');
      if (main) main.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const stepEl = document.getElementById(stepId);
      if (stepEl) {
        const focusable = stepEl.querySelector('input:not([type="hidden"]), button:not([disabled])');
        if (focusable) setTimeout(() => focusable.focus(), 100);
      }
    }
  }

  function getTotalSum() {
    return state.items.reduce((sum, it) => sum + (Number(it.price) || 0), 0);
  }

  function formatMoney(n) {
    return Number(n).toFixed(2);
  }

  const INLINE_QTY_PRICE_RE = /(\d+)\s*[xXх×*]\s*([\d]+[.,][\d]{2})\b/g;
  const QTY_PREFIX_RE = /^(\d+)(?:[.,]\d+)?\s*[xXх×*]\s+/;
  const QTY_SUFFIX_RE = /\s*×\d+$/;
  const QTY_PRICE_EXPR_RE = /^(\d+)\s*[xXх×*]\s*([\d]+[.,][\d]{2})$/;

  function parseDecimal(s) {
    return parseFloat(String(s).replace(/\s/g, '').replace(',', '.'));
  }

  function hasQtySuffix(label) {
    return QTY_SUFFIX_RE.test(String(label || '').trim());
  }

  function appendQtySuffix(label, qty) {
    const name = String(label || '').trim().replace(QTY_SUFFIX_RE, '').trim();
    qty = Math.max(1, parseInt(qty, 10) || 1);
    if (qty <= 1 || !name || name.length < 2) return name;
    return name + ' ×' + qty;
  }

  /** Взима qty от параметъра, „2 x …“ в името или вече добавено „×N“. */
  function resolveItemQty(label, qty) {
    let q = Math.max(1, parseInt(qty, 10) || 1);
    const name = String(label || '').trim();
    const prefix = name.match(QTY_PREFIX_RE);
    if (prefix) q = Math.max(q, parseInt(prefix[1], 10) || 1);
    const suffix = name.match(/×(\d+)$/);
    if (suffix) q = Math.max(q, parseInt(suffix[1], 10) || 1);
    let m;
    const inlineRe = new RegExp(INLINE_QTY_PRICE_RE.source, 'g');
    while ((m = inlineRe.exec(name)) !== null) {
      q = Math.max(q, parseInt(m[1], 10) || 1);
    }
    return q;
  }

  /** Ако има количество — добавя „×N“ в името и умножава цената до редовата сума. */
  function normalizeItemQty(label, price, qty) {
    let name = String(label || '').trim();
    let p = Number(price);
    let detectedQty = resolveItemQty(name, qty);
    if (isNaN(p) || p <= 0) {
      return { label: appendQtySuffix(name, detectedQty), price, qty: 1 };
    }

    let unitPrice = null;
    let inlineMatch = null;
    let m;
    while ((m = INLINE_QTY_PRICE_RE.exec(name)) !== null) inlineMatch = m;
    if (inlineMatch) {
      detectedQty = Math.max(detectedQty, parseInt(inlineMatch[1], 10) || 1);
      unitPrice = parseDecimal(inlineMatch[2]);
      name = name.replace(inlineMatch[0], '').replace(/\s+/g, ' ').trim();
    }

    const qtyPrefix = name.match(QTY_PREFIX_RE);
    if (qtyPrefix) {
      detectedQty = Math.max(detectedQty, parseInt(qtyPrefix[1], 10) || 1);
      name = name.slice(qtyPrefix[0].length).trim();
    }

    name = name.replace(QTY_SUFFIX_RE, '').trim();

    if (detectedQty > 1) {
      const expectedTotal = unitPrice != null ? unitPrice * detectedQty : null;
      if (expectedTotal != null) {
        if (Math.abs(p - unitPrice) < 0.02) p = expectedTotal;
        else if (Math.abs(p - expectedTotal) >= 0.02) p = expectedTotal;
      } else if (!looksLikeLineTotal(p, detectedQty)) {
        p = p * detectedQty;
      }
    }

    if (!name || name.length < 2) name = LABEL_UNREADABLE;
    return { label: appendQtySuffix(name, detectedQty), price: formatMoney(p), qty: 1 };
  }

  function looksLikeLineTotal(total, qty) {
    if (qty <= 1) return true;
    const perUnit = total / qty;
    const roundedUnit = Math.round(perUnit * 100) / 100;
    return Math.abs(roundedUnit * qty - total) < 0.02;
  }

  function tryParseQtyPriceExpr(str) {
    const match = String(str || '').trim().match(QTY_PRICE_EXPR_RE);
    if (!match) return null;
    const qty = parseInt(match[1], 10);
    const unitPrice = parseDecimal(match[2]);
    if (!qty || qty < 1 || isNaN(unitPrice) || unitPrice <= 0) return null;
    return { qty, unitPrice };
  }

  function applyQtyNormalization(item) {
    const expr = tryParseQtyPriceExpr(item.price);
    if (expr) {
      const normalized = normalizeItemQty(item.label, expr.unitPrice * expr.qty, expr.qty);
      item.label = normalized.label;
      item.price = normalized.price;
      item.qty = normalized.qty;
      return true;
    }
    const normalized = normalizeItemQty(item.label, item.price, item.qty);
    if (normalized.label !== item.label || normalized.price !== item.price || normalized.qty !== item.qty) {
      item.label = normalized.label;
      item.price = normalized.price;
      item.qty = normalized.qty;
      return true;
    }
    return false;
  }

  // ----- Upload & OCR -----
  const uploadZone = document.getElementById('upload-zone');
  const fileInput = document.getElementById('file-input');
  const imagePreview = document.getElementById('image-preview');
  const btnScan = document.getElementById('btn-scan');
  const btnScanAi = document.getElementById('btn-scan-ai');
  const btnSkipScan = document.getElementById('btn-skip-scan');
  const btnChangePhoto = document.getElementById('btn-change-photo');
  const btnCropPhoto = document.getElementById('btn-crop-photo');
  const cropModal = document.getElementById('crop-modal');
  const cropImage = document.getElementById('crop-image');
  const cropModalBackdrop = document.getElementById('crop-modal-backdrop');
  const btnCloseCrop = document.getElementById('btn-close-crop');
  const btnCropApply = document.getElementById('btn-crop-apply');
  const btnCropSkip = document.getElementById('btn-crop-skip');
  const btnCropCancel = document.getElementById('btn-crop-cancel');

  let cropperInstance = null;
  let pendingCropDataUrl = null;
  let cropFromPreview = false;

  function destroyCropper() {
    if (cropperInstance) {
      cropperInstance.destroy();
      cropperInstance = null;
    }
  }

  function closeCropModal() {
    destroyCropper();
    if (cropModal) cropModal.classList.add('hidden');
    if (cropImage) cropImage.src = '';
    pendingCropDataUrl = null;
    cropFromPreview = false;
  }

  function setImagePreview(dataUrl) {
    state.imageDataUrl = dataUrl;
    const img = document.createElement('img');
    img.src = state.imageDataUrl;
    imagePreview.innerHTML = '';
    imagePreview.appendChild(img);
    imagePreview.classList.remove('hidden');
    btnScan.classList.remove('hidden');
    if (btnScanAi) btnScanAi.classList.remove('hidden');
    btnSkipScan.classList.remove('hidden');
    if (btnChangePhoto) btnChangePhoto.classList.remove('hidden');
    if (btnCropPhoto) btnCropPhoto.classList.remove('hidden');
    uploadZone.classList.add('hidden');
    saveState();
  }

  function initCropper() {
    if (!cropImage || typeof Cropper === 'undefined') return;
    destroyCropper();
    cropperInstance = new Cropper(cropImage, {
      viewMode: 1,
      dragMode: 'move',
      aspectRatio: NaN,
      autoCropArea: 0.85,
      responsive: true,
      restore: false,
      guides: true,
      center: true,
      highlight: true,
      cropBoxMovable: true,
      cropBoxResizable: true,
      toggleDragModeOnDblclick: false
    });
  }

  function openCropModal(dataUrl, fromPreview) {
    if (!cropModal || !cropImage) {
      setImagePreview(dataUrl);
      return;
    }
    cropFromPreview = !!fromPreview;
    pendingCropDataUrl = dataUrl;
    cropModal.classList.remove('hidden');
    destroyCropper();
    cropImage.onload = () => {
      cropImage.onload = null;
      initCropper();
    };
    cropImage.src = dataUrl;
    if (cropImage.complete) {
      cropImage.onload = null;
      initCropper();
    }
  }

  function applyCropResult(dataUrl) {
    closeCropModal();
    setImagePreview(dataUrl);
  }

  function applyCropSelection() {
    if (!cropperInstance) {
      if (pendingCropDataUrl) applyCropResult(pendingCropDataUrl);
      return;
    }
    const canvas = cropperInstance.getCroppedCanvas({
      maxWidth: 4096,
      maxHeight: 4096,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high'
    });
    if (!canvas) {
      if (pendingCropDataUrl) applyCropResult(pendingCropDataUrl);
      return;
    }
    applyCropResult(canvas.toDataURL('image/jpeg', 0.92));
  }

  function cancelCropSelection() {
    const wasRecrop = cropFromPreview;
    closeCropModal();
    if (wasRecrop) return;
    fileInput.value = '';
    uploadZone.classList.remove('hidden');
  }

  if (btnCropApply) btnCropApply.addEventListener('click', applyCropSelection);
  if (btnCropSkip) {
    btnCropSkip.addEventListener('click', () => {
      if (pendingCropDataUrl) applyCropResult(pendingCropDataUrl);
    });
  }
  if (btnCropCancel) btnCropCancel.addEventListener('click', cancelCropSelection);
  if (btnCloseCrop) btnCloseCrop.addEventListener('click', cancelCropSelection);
  if (cropModalBackdrop) cropModalBackdrop.addEventListener('click', cancelCropSelection);
  if (btnCropPhoto) {
    btnCropPhoto.addEventListener('click', () => {
      if (state.imageDataUrl) openCropModal(state.imageDataUrl, true);
    });
  }

  uploadZone.addEventListener('click', () => fileInput.click());
  uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('dragover'); });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('image/')) handleFile(file);
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) handleFile(file);
  });

  function handleFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => openCropModal(e.target.result);
    reader.readAsDataURL(file);
  }

  if (btnChangePhoto) {
    btnChangePhoto.addEventListener('click', () => {
      closeCropModal();
      state.imageDataUrl = null;
      imagePreview.innerHTML = '';
      imagePreview.classList.add('hidden');
      btnScan.classList.add('hidden');
      if (btnScanAi) btnScanAi.classList.add('hidden');
      btnSkipScan.classList.add('hidden');
      btnChangePhoto.classList.add('hidden');
      if (btnCropPhoto) btnCropPhoto.classList.add('hidden');
      uploadZone.classList.remove('hidden');
      fileInput.value = '';
      saveState();
    });
  }

  /** Подобрява canvas за OCR: сиво, контраст и леко изостряне — помага при снимки от камера. */
  function enhanceCanvasForOcr(ctx, width, height) {
    const data = ctx.getImageData(0, 0, width, height);
    const d = data.data;
    const contrast = 1.35;
    const mid = 128;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      let gray = (0.299 * r + 0.587 * g + 0.114 * b);
      gray = Math.max(0, Math.min(255, (gray - mid) * contrast + mid));
      d[i] = d[i + 1] = d[i + 2] = gray;
    }
    ctx.putImageData(data, 0, 0);
  }

  /** Нормализира снимка: resize; по избор grayscale/контраст за Tesseract. */
  function normalizeImage(dataUrl, maxSize, enhance, cb) {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const scale = maxSize && (w > maxSize || h > maxSize)
        ? maxSize / Math.max(w, h)
        : 1;
      const cw = Math.round(w * scale);
      const ch = Math.round(h * scale);
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, cw, ch);
      try {
        if (enhance) enhanceCanvasForOcr(ctx, cw, ch);
        cb(canvas.toDataURL('image/jpeg', 0.92));
      } catch (e) {
        cb(dataUrl);
      }
    };
    img.onerror = () => cb(dataUrl);
    img.src = dataUrl;
  }

  function parseDataUrl(dataUrl) {
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return { mimeType: 'image/jpeg', base64: dataUrl.split(',')[1] || dataUrl };
    return { mimeType: m[1], base64: m[2] };
  }

  function geminiErrorMessage(err, httpStatus, errBody) {
    if (!navigator.onLine) return 'Няма интернет. Провери връзката.';
    if (err && err.name === 'TypeError') {
      return 'Браузърът блокира заявката. Отвори сайта през http://localhost (не като файл).';
    }
    const body = errBody || err?.message || '';
    if (httpStatus === 429 || /RESOURCE_EXHAUSTED|quota/i.test(body)) {
      return 'Лимитът на Gemini е изчерпан. Опитай след минута или ползвай „Разчети снимка“.';
    }
    if (httpStatus === 403 || /API key not valid|PERMISSION_DENIED/i.test(body)) {
      return 'Невалиден API ключ. Провери ключа в Google AI Studio.';
    }
    if (httpStatus === 400) return 'Грешка в заявката към Gemini. Опитай друга снимка.';
    return 'AI не успя. Опитай отново или ползвай „Разчети снимка“.';
  }

  async function scanWithGemini(imageDataUrl) {
    const { mimeType, base64 } = parseDataUrl(imageDataUrl);
    const apiKey = getGeminiApiKey();
    if (!apiKey) throw new Error('Липсва API ключ. Настрои го в Разчети с AI.');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    const body = {
      contents: [{
        parts: [
          { text: RECEIPT_PROMPT },
          { inline_data: { mime_type: mimeType, data: base64 } }
        ]
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            items: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  label: { type: 'STRING' },
                  price: { type: 'NUMBER' },
                  qty: { type: 'INTEGER' }
                },
                required: ['label', 'price']
              }
            }
          },
          required: ['items']
        }
      }
    };
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (err) {
      const msg = geminiErrorMessage(err);
      throw new Error(msg);
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(geminiErrorMessage(null, res.status, errText));
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini не върна резултат. Опитай друга снимка.');
    const parsed = JSON.parse(text);
    if (!parsed.items || !Array.isArray(parsed.items)) throw new Error('Невалиден отговор от Gemini.');
    return parsed.items;
  }

  function applyParsedItems(rawItems) {
    const valid = preprocessRawItems(rawItems).filter(it => {
      const price = Number(it.price);
      return it.label && !isNaN(price) && price > 0 && price <= MAX_PRICE;
    });
    if (valid.length > 0) {
      state.items = valid.map(it => {
        const label = String(it.label).trim();
        const qty = resolveItemQty(label, parseInt(it.qty, 10) || 1);
        const normalized = normalizeItemQty(label, Number(it.price), qty);
        return {
          id: nextItemId++,
          label: normalized.label,
          price: normalized.price,
          qty: normalized.qty
        };
      });
    } else {
      state.items = [{ id: nextItemId++, label: '', price: '', qty: 1 }];
    }
  }

  function setScanButtonsDisabled(disabled) {
    btnScan.disabled = disabled;
    if (btnScanAi) btnScanAi.disabled = disabled;
  }

  function finishScan(statusEl) {
    statusEl.remove();
    setScanButtonsDisabled(false);
    showStep('step-items');
    renderItems();
    saveState();
  }

  function failScan(statusEl, message) {
    statusEl.remove();
    setScanButtonsDisabled(false);
    showToast(message);
  }

  function scanWithTesseract(imageForOcr, statusEl) {
    statusEl.innerHTML = '<span class="spinner"></span> Разчитане на снимката...';
    return Tesseract.recognize(imageForOcr, 'bul+eng', {
      logger: (m) => { if (m.status) statusEl.innerHTML = '<span class="spinner"></span> ' + m.status; },
      tessedit_pageseg_mode: '4'
    }).then(({ data: { text } }) => {
      parseReceiptText(text);
    });
  }

  function startScan(statusMessage) {
    if (!state.imageDataUrl) return null;
    const statusEl = document.createElement('div');
    statusEl.className = 'ocr-loading';
    statusEl.innerHTML = '<span class="spinner"></span> ' + statusMessage;
    imagePreview.appendChild(statusEl);
    setScanButtonsDisabled(true);
    return statusEl;
  }

  btnScan.addEventListener('click', () => {
    const statusEl = startScan('Подготвям снимката...');
    if (!statusEl) return;
    normalizeImage(state.imageDataUrl, 2000, true, (imageForOcr) => {
      scanWithTesseract(imageForOcr, statusEl)
        .then(() => finishScan(statusEl))
        .catch(() => {
          applyParsedItems([]);
          finishScan(statusEl);
        });
    });
  });

  if (btnScanAi) {
    btnScanAi.addEventListener('click', () => {
      if (!getGeminiApiKey()) {
        showToast('Няма API ключ в config.local.js.');
        return;
      }
      const statusEl = startScan('Подготвям снимката...');
      if (!statusEl) return;
      normalizeImage(state.imageDataUrl, 2000, false, async (imageForGemini) => {
        statusEl.innerHTML = '<span class="spinner"></span> Разчитане с AI (Gemini)...';
        try {
          const items = await scanWithGemini(imageForGemini);
          applyParsedItems(items);
          finishScan(statusEl);
        } catch (e) {
          failScan(statusEl, e?.message || 'AI не успя. Опитай отново или ползвай „Разчети снимка“.');
        }
      });
    });
  }

  btnSkipScan.addEventListener('click', () => {
    state.items = [];
    showStep('step-items');
    renderItems();
    saveState();
  });

  const RECEIPT_SKIP_PATTERNS = [
    /^ОБЩА\s+СУМА$/i, /^СУМА$/i, /^В\s+БРОЙ$/i, /^БОН:/i, /^TOTAN$/i,
    /#сума/i, /^Пг\.#\d+\s+СУМА/i, /^\d+\s+артикул$/i
  ];
  function isReceiptSkipLine(line) {
    const t = line.trim();
    return RECEIPT_SKIP_PATTERNS.some(r => r.test(t));
  }

  function isQtyOnlyLine(line) {
    return /^\d+\s*[xXх×*]\s*$/.test(line.trim());
  }

  function matchQtyUnitLine(line) {
    return line.trim().match(/^(\d+)\s*[xXх×*]\s*([\d]+[.,][\d]{2})\s*$/);
  }

  function isPriceLikeLabel(label) {
    return /^[\d]+[.,][\d]{2}$/.test(String(label || '').trim());
  }

  /** Ред само с „2 x 4.40“ и редовата сума вдясно (името е на предишния ред). */
  function parseQtyPriceLine(line) {
    const match = findLastPriceOnLine(line);
    if (!match) return null;
    const lineTotal = parsePriceFromMatch(match);
    if (isNaN(lineTotal) || lineTotal <= 0) return null;
    const before = line.slice(0, match.index).trim();
    const qtyUnit = before.match(/^(\d+)\s*[xXх×*]\s*([\d]+[.,][\d]{2})\s*$/);
    if (!qtyUnit) return null;
    const qty = parseInt(qtyUnit[1], 10);
    const unitPrice = parseDecimal(qtyUnit[2]);
    if (!qty || qty < 1 || isNaN(unitPrice) || unitPrice <= 0) return null;
    return { qty, unitPrice, lineTotal };
  }

  /** Слева артикули от Gemini при различен ред на име/количество/цена. */
  function preprocessRawItems(rawItems) {
    const out = [];
    const pending = { name: '', qty: 1, bundle: null };

    function resetPending() {
      pending.name = '';
      pending.qty = 1;
      pending.bundle = null;
    }

    function emit(label, price, qty) {
      if (!label || !price || price <= 0) return;
      const q = resolveItemQty(label, qty);
      const normalized = normalizeItemQty(label, price, q);
      out.push({ label: normalized.label, price: normalized.price, qty: 1 });
      resetPending();
    }

    for (const it of rawItems || []) {
      const label = String(it.label || '').trim();
      const price = Number(it.price);
      const itemQty = Math.max(1, parseInt(it.qty, 10) || 1);
      if (!label) continue;

      if (isQtyOnlyLine(label)) {
        pending.qty = Math.max(1, parseInt(label, 10) || 1);
        continue;
      }

      const qtyUnitOnly = matchQtyUnitLine(label);
      if (qtyUnitOnly && (isNaN(price) || price <= 0)) {
        pending.qty = parseInt(qtyUnitOnly[1], 10) || 1;
        continue;
      }

      const qtyLineLabel = label.match(/^(\d+)\s*[xXх×*]\s*([\d]+[.,][\d]{2})\s*$/);
      if (qtyLineLabel && !isNaN(price) && price > 0) {
        const q = parseInt(qtyLineLabel[1], 10) || 1;
        if (pending.name) {
          emit(pending.name, price, q);
        } else {
          pending.bundle = { qty: q, price };
        }
        continue;
      }

      if (isNaN(price) || price <= 0) {
        if (pending.bundle) {
          emit(label, pending.bundle.price, pending.bundle.qty);
        } else {
          pending.name = pending.name ? pending.name + ' ' + label : label;
        }
        continue;
      }

      const qtyPrefix = label.match(QTY_PREFIX_RE);
      if (qtyPrefix && pending.name) {
        const rest = label.slice(qtyPrefix[0].length).trim();
        if (isPriceLikeLabel(rest)) {
          emit(pending.name, price, parseInt(qtyPrefix[1], 10) || 1);
          continue;
        }
      }

      if (pending.name) {
        emit(pending.name, price, pending.qty > 1 ? pending.qty : itemQty);
        continue;
      }

      pending.bundle = null;
      emit(label, price, pending.qty > 1 ? pending.qty : itemQty);
    }

    return out.length ? out : (rawItems || []);
  }

  function commitParsedItem(parsed, label, price, qty, unitHint) {
    const resolvedPrice = resolvePriceWithPendingUnit(price, qty, unitHint);
    const normalized = normalizeItemQty(label, resolvedPrice, qty);
    if (!normalized.label || normalized.label === LABEL_UNREADABLE) return false;
    parsed.push(normalized);
    return true;
  }

  function resetReceiptPending(pending) {
    pending.label = '';
    pending.qty = 1;
    pending.unitPrice = null;
    pending.qtyBundle = null;
  }

  function isPriceOnlyLine(line) {
    return /^[\d\s]+[.,][\d]{2}\s*(?:€|eur|лв|лв\.|bgn)?$/i.test(line.trim());
  }

  function isProductNameOnlyLine(line) {
    const t = line.trim();
    if (!t || t.length < 2) return false;
    if (isQtyOnlyLine(t) || matchQtyUnitLine(t)) return false;
    if (isPriceOnlyLine(t)) return false;
    return !findLastPriceOnLine(t);
  }

  function resolvePriceWithPendingUnit(price, qty, unitPrice) {
    if (unitPrice == null) return price;
    const expected = unitPrice * qty;
    if (Math.abs(price - expected) < 0.02) return price;
    if (Math.abs(price - unitPrice) < 0.02) return expected;
    return price;
  }

  /** Намира последната сума във формата число с 2 десетични (и по избор интервали за хиляди). */
  function findLastPriceOnLine(line) {
    const regex = /([\d\s]+)[.,](\d{2})\s*(?:€|eur|лв|лв\.|bgn)?/gi;
    let last = null;
    let m;
    while ((m = regex.exec(line)) !== null) last = m;
    return last;
  }

  function parsePriceFromMatch(match) {
    const numPart = (match[1] || '').replace(/\s/g, '');
    const decPart = match[2] || '00';
    const priceStr = (numPart + '.' + decPart).replace(',', '.');
    return parseFloat(priceStr);
  }

  function parseReceiptText(text) {
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const parsed = [];
    const pending = { label: '', qty: 1, unitPrice: null, qtyBundle: null };

    for (const line of lines) {
      if (isReceiptSkipLine(line)) continue;

      if (isQtyOnlyLine(line)) {
        pending.qty = Math.max(1, parseInt(line, 10) || 1);
        continue;
      }

      const qtyPriceLine = parseQtyPriceLine(line);
      if (qtyPriceLine) {
        if (pending.label) {
          commitParsedItem(parsed, pending.label, qtyPriceLine.lineTotal, qtyPriceLine.qty, qtyPriceLine.unitPrice);
          resetReceiptPending(pending);
          continue;
        }
        pending.qtyBundle = qtyPriceLine;
        continue;
      }

      const qtyUnitMatch = matchQtyUnitLine(line);
      if (qtyUnitMatch) {
        pending.qty = Math.max(1, parseInt(qtyUnitMatch[1], 10) || 1);
        pending.unitPrice = parseDecimal(qtyUnitMatch[2]);
        continue;
      }

      if (isProductNameOnlyLine(line)) {
        if (pending.qtyBundle) {
          commitParsedItem(parsed, line.trim(), pending.qtyBundle.lineTotal, pending.qtyBundle.qty, pending.qtyBundle.unitPrice);
          resetReceiptPending(pending);
          continue;
        }
        pending.label = pending.label ? pending.label + ' ' + line.trim() : line.trim();
        continue;
      }

      const match = findLastPriceOnLine(line);
      if (!match) continue;
      const price = parsePriceFromMatch(match);
      if (isNaN(price) || price <= 0 || price > MAX_PRICE) continue;

      let label = line.slice(0, match.index).trim();
      const priceOnly = isPriceOnlyLine(line);

      if (!label) {
        if (!pending.label) continue;
        label = pending.label;
      }

      let qty = pending.qty;
      let unitHint = pending.unitPrice;
      let linePrice = price;

      const canUseBundle = pending.qtyBundle && (priceOnly || isPriceLikeLabel(label));
      if (canUseBundle) {
        qty = pending.qtyBundle.qty;
        unitHint = pending.qtyBundle.unitPrice;
        linePrice = pending.qtyBundle.lineTotal;
      }

      const qtyMatch = label.match(QTY_PREFIX_RE);
      if (qtyMatch) {
        qty = Math.max(1, parseInt(qtyMatch[1], 10) || 1);
        label = label.slice(qtyMatch[0].length).trim();
      }

      if (isPriceLikeLabel(label) && pending.label) {
        label = pending.label;
      }

      resetReceiptPending(pending);

      if (!label || label.length < 2) continue;

      commitParsedItem(parsed, label, linePrice, qty, unitHint);
    }

    applyParsedItems(parsed);
  }

  // ----- Items -----
  const itemsList = document.getElementById('items-list');
  const totalSumEl = document.getElementById('total-sum');
  const btnAddItem = document.getElementById('btn-add-item');
  const btnToPeople = document.getElementById('btn-to-people');
  const itemsErrorEl = document.getElementById('items-error');

  function renderItems() {
    itemsList.innerHTML = '';
    state.items.forEach(item => {
      const li = document.createElement('li');
      li.className = 'item-row';
      li.dataset.id = item.id;
      li.innerHTML = `
        <input type="text" class="item-label" placeholder="Артикул" value="${escapeHtml(item.label)}">
        <input type="number" class="item-price" placeholder="0.00" step="0.01" min="0" max="9999" value="${escapeHtml(item.price)}">
        <button type="button" class="btn btn-duplicate btn-small btn-duplicate-item" aria-label="Дублирай">⎘</button>
        <button type="button" class="btn btn-danger btn-small btn-remove-item" aria-label="Премахни">✕</button>
      `;
      const labelInput = li.querySelector('.item-label');
      const priceInput = li.querySelector('.item-price');
      labelInput.addEventListener('input', (e) => { item.label = e.target.value; saveState(); });
      priceInput.addEventListener('input', (e) => { item.price = e.target.value; updateTotal(); saveState(); });
      const onQtyBlur = () => {
        if (applyQtyNormalization(item)) {
          labelInput.value = item.label;
          priceInput.value = item.price;
          updateTotal();
          saveState();
        }
      };
      labelInput.addEventListener('blur', onQtyBlur);
      priceInput.addEventListener('blur', onQtyBlur);
      li.querySelector('.btn-duplicate-item').addEventListener('click', () => {
        const copy = { id: nextItemId++, label: item.label, price: item.price, qty: 1 };
        state.items.splice(state.items.indexOf(item) + 1, 0, copy);
        renderItems();
        saveState();
      });
      li.querySelector('.btn-remove-item').addEventListener('click', () => {
        state.items = state.items.filter(i => i.id !== item.id);
        delete state.assignments[item.id];
        if (state.customQuantities) delete state.customQuantities[item.id];
        renderItems();
        saveState();
      });
      itemsList.appendChild(li);
    });
    updateTotal();
    if (itemsErrorEl) itemsErrorEl.classList.add('hidden');
  }

  function updateTotal() {
    totalSumEl.textContent = formatMoney(getTotalSum());
  }

  function escapeHtml(s) {
    if (s == null) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  btnAddItem.addEventListener('click', () => {
    state.items.push({ id: nextItemId++, label: '', price: '', qty: 1 });
    renderItems();
    saveState();
  });

  btnToPeople.addEventListener('click', () => {
    const withPrice = state.items.filter(i => Number(i.price) > 0);
    if (withPrice.length === 0) {
      if (itemsErrorEl) {
        itemsErrorEl.textContent = 'Добави поне един ред с цена преди да продължиш.';
        itemsErrorEl.classList.remove('hidden');
      }
      return;
    }
    state.items = state.items.filter(i => (i.label || '').trim() || (i.price && Number(i.price) > 0));
    if (state.items.length === 0) state.items.push({ id: nextItemId++, label: '', price: '', qty: 1 });
    renderItems();
    showStep('step-people');
    renderPeople();
    saveState();
  });

  // ----- People -----
  const peopleList = document.getElementById('people-list');
  const personNameInput = document.getElementById('person-name');
  const btnAddPerson = document.getElementById('btn-add-person');
  const btnBackItems = document.getElementById('btn-back-items');
  const btnToAssign = document.getElementById('btn-to-assign');
  const peopleErrorEl = document.getElementById('people-error');

  function renderPeople() {
    peopleList.innerHTML = '';
    state.people.forEach(person => {
      const li = document.createElement('li');
      li.className = 'person-tag';
      li.innerHTML = `<span>${escapeHtml(person.name)}</span><button type="button" class="btn-remove-person" aria-label="Премахни">✕</button>`;
      li.querySelector('.btn-remove-person').addEventListener('click', () => {
        state.people = state.people.filter(p => p.id !== person.id);
        Object.keys(state.assignments).forEach(itemId => {
          state.assignments[itemId] = state.assignments[itemId].filter(pid => pid !== person.id);
          if (state.customQuantities && state.customQuantities[itemId]) {
            delete state.customQuantities[itemId][person.id];
            if (state.assignments[itemId].length < 2) {
              delete state.customQuantities[itemId];
            }
          }
        });
        renderPeople();
        saveState();
      });
      peopleList.appendChild(li);
    });
    if (peopleErrorEl) peopleErrorEl.classList.add('hidden');
  }

  function addPerson() {
    const name = (personNameInput.value || '').trim();
    if (!name) return;
    state.people.push({ id: nextPersonId++, name });
    personNameInput.value = '';
    renderPeople();
    saveState();
  }

  btnAddPerson.addEventListener('click', addPerson);
  personNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addPerson(); } });

  btnBackItems.addEventListener('click', () => { showStep('step-items'); renderItems(); saveState(); });
  btnToAssign.addEventListener('click', () => {
    if (state.people.length === 0) {
      if (peopleErrorEl) {
        peopleErrorEl.textContent = 'Добави поне един човек преди да продължиш.';
        peopleErrorEl.classList.remove('hidden');
      }
      return;
    }
    showStep('step-assign');
    renderAssign();
    saveState();
  });

  // ----- Assign -----
  const assignList = document.getElementById('assign-list');
  const btnBackPeople = document.getElementById('btn-back-people');
  const btnToSummary = document.getElementById('btn-to-summary');

  function getItemTotal(item) {
    return Number(item.price) || 0;
  }

  function renderAssign() {
    assignList.innerHTML = '';
    state.items.forEach(item => {
      const total = getItemTotal(item);
      if (total <= 0) return;
      const card = document.createElement('div');
      card.className = 'assign-card';
      const assigned = state.assignments[item.id] || [];
      const itemQty = resolveItemQty(item.label, item.qty);

      card.innerHTML = `
        <span class="item-label">${escapeHtml(item.label) || '(без име)'}</span>
        <span class="item-price">${formatMoney(total)} €</span>
        <p class="assign-per-person"></p>
        <div class="assign-quick">
          <button type="button" class="btn-link assign-all">Всички</button>
          <span> · </span>
          <button type="button" class="btn-link assign-none">Никой</button>
        </div>
        <div class="assign-checkboxes"></div>
        <div class="assign-qty-fields" style="margin-top: 0.5rem; display: flex; flex-direction: column; gap: 0.5rem;"></div>
      `;

      const perPersonEl = card.querySelector('.assign-per-person');
      const container = card.querySelector('.assign-checkboxes');
      const qtyFieldsContainer = card.querySelector('.assign-qty-fields');

      const updateQtyConstraints = (activePid) => {
        const currentAssigned = state.assignments[item.id] || [];
        let sumOfAll = 0;
        
        currentAssigned.forEach(pid => {
          const val = state.customQuantities[item.id]?.[pid];
          const parsedVal = val !== undefined ? parseFloat(val) : (itemQty / currentAssigned.length);
          sumOfAll += isNaN(parsedVal) ? 0 : parsedVal;

          const input = qtyFieldsContainer.querySelector(`input[data-person-id="${pid}"]`);
          if (input) {
            const otherIds = currentAssigned.filter(id => id !== pid);
            const sumOfOthers = otherIds.reduce((sum, id) => {
              const v = state.customQuantities[item.id]?.[id];
              const pV = v !== undefined ? parseFloat(v) : (itemQty / currentAssigned.length);
              return sum + (isNaN(pV) ? 0 : pV);
            }, 0);
            
            input.max = Math.max(0, itemQty - sumOfOthers).toString();
            
            if (pid !== activePid) {
              let currentVal = parseFloat(input.value);
              if (isNaN(currentVal)) currentVal = 0;
              const maxAllowed = itemQty - sumOfOthers;
              if (currentVal > maxAllowed) {
                input.value = currentVal.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
                state.customQuantities[item.id][pid] = maxAllowed;
              }
            }
          }
        });

        const allocatedLabel = qtyFieldsContainer.querySelector('.qty-allocated-label');
        if (allocatedLabel) {
          allocatedLabel.style.color = Math.abs(sumOfAll - itemQty) < 0.01 ? '#68d391' : '#fc8181';
          allocatedLabel.textContent = `Разпределени: ${sumOfAll.toFixed(2).replace(/\.00$/, '')} от ${itemQty} бр.`;
        }
      };

      const rebuildQtyDOM = () => {
        qtyFieldsContainer.innerHTML = '';
        const currentAssigned = state.assignments[item.id] || [];
        
        if (itemQty > 1 && currentAssigned.length >= 2) {
          const header = document.createElement('div');
          header.className = 'qty-fields-header';
          header.style.fontSize = '0.9rem';
          header.style.color = '#cbd5e0';
          header.style.marginTop = '0.6rem';
          header.style.marginBottom = '0.4rem';
          header.style.fontWeight = '600';
          header.textContent = `Разпредели количества (общо ${itemQty} бр.):`;
          qtyFieldsContainer.appendChild(header);

          currentAssigned.forEach(pid => {
            const person = state.people.find(p => p.id === pid);
            if (!person) return;

            const row = document.createElement('div');
            row.className = 'qty-field-row';
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.justifyContent = 'space-between';
            row.style.background = 'rgba(255,255,255,0.04)';
            row.style.padding = '0.4rem 0.6rem';
            row.style.borderRadius = '8px';
            row.style.gap = '0.75rem';

            const nameSpan = document.createElement('span');
            nameSpan.style.fontSize = '0.95rem';
            nameSpan.style.color = '#cbd5e0';
            nameSpan.textContent = person.name;

            const inputWrapper = document.createElement('div');
            inputWrapper.style.display = 'flex';
            inputWrapper.style.alignItems = 'center';
            inputWrapper.style.gap = '0.4rem';

            const qtyInput = document.createElement('input');
            qtyInput.type = 'number';
            qtyInput.dataset.personId = pid;
            qtyInput.style.width = '4.5rem';
            qtyInput.style.minHeight = '36px';
            qtyInput.style.background = 'rgba(0,0,0,0.25)';
            qtyInput.style.border = '1px solid rgba(255,255,255,0.15)';
            qtyInput.style.borderRadius = '6px';
            qtyInput.style.color = '#fff';
            qtyInput.style.textAlign = 'right';
            qtyInput.style.padding = '0.25rem 0.5rem';
            qtyInput.style.fontSize = '16px';
            qtyInput.min = '0';
            qtyInput.step = 'any';

            const currentVal = state.customQuantities[item.id]?.[pid] !== undefined
              ? state.customQuantities[item.id][pid]
              : (itemQty / currentAssigned.length);

            qtyInput.value = currentVal.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');

            qtyInput.addEventListener('input', (e) => {
              let enteredVal = parseFloat(e.target.value);
              if (isNaN(enteredVal) || enteredVal < 0) {
                enteredVal = 0;
              }
              
              const otherIds = currentAssigned.filter(id => id !== pid);
              const sumOfOthers = otherIds.reduce((sum, id) => {
                const v = state.customQuantities[item.id]?.[id];
                const pV = v !== undefined ? parseFloat(v) : (itemQty / currentAssigned.length);
                return sum + (isNaN(pV) ? 0 : pV);
              }, 0);

              const maxVal = itemQty - sumOfOthers;
              if (enteredVal > maxVal) {
                enteredVal = maxVal;
                e.target.value = enteredVal.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
              }

              state.customQuantities[item.id] = state.customQuantities[item.id] || {};
              currentAssigned.forEach(id => {
                if (state.customQuantities[item.id][id] === undefined) {
                  state.customQuantities[item.id][id] = (itemQty / currentAssigned.length);
                }
              });

              state.customQuantities[item.id][pid] = enteredVal;
              saveState();
              updateQtyConstraints(pid);
            });

            const suffixSpan = document.createElement('span');
            suffixSpan.style.fontSize = '0.85rem';
            suffixSpan.style.color = '#718096';
            suffixSpan.textContent = 'бр.';

            inputWrapper.appendChild(qtyInput);
            inputWrapper.appendChild(suffixSpan);

            row.appendChild(nameSpan);
            row.appendChild(inputWrapper);
            qtyFieldsContainer.appendChild(row);
          });

          const footer = document.createElement('div');
          footer.style.display = 'flex';
          footer.style.justifyContent = 'space-between';
          footer.style.fontSize = '0.85rem';
          footer.style.marginTop = '0.25rem';
          footer.style.padding = '0 0.25rem';

          const allocatedSpan = document.createElement('span');
          allocatedSpan.className = 'qty-allocated-label';
          
          footer.appendChild(allocatedSpan);
          qtyFieldsContainer.appendChild(footer);

          updateQtyConstraints(null);
        } else {
          qtyFieldsContainer.innerHTML = '';
        }
      };

      const updatePerPerson = () => {
        const ids = state.assignments[item.id] || [];
        const n = ids.length;
        if (itemQty > 1 && n >= 2) {
          perPersonEl.textContent = 'Цена за 1 бр.: ' + formatMoney(total / itemQty) + ' €';
        } else {
          perPersonEl.textContent = n > 0 ? 'По ' + formatMoney(total / n) + ' € на човек' : '';
        }
      };

      state.people.forEach(person => {
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.personId = person.id;
        cb.checked = assigned.includes(person.id);
        cb.addEventListener('change', () => {
          state.assignments[item.id] = state.assignments[item.id] || [];
          if (cb.checked) {
            state.assignments[item.id].push(person.id);
          } else {
            state.assignments[item.id] = state.assignments[item.id].filter(id => id !== person.id);
            if (state.customQuantities && state.customQuantities[item.id]) {
              delete state.customQuantities[item.id][person.id];
              if (state.assignments[item.id].length < 2) {
                delete state.customQuantities[item.id];
              }
            }
          }
          rebuildQtyDOM();
          updatePerPerson();
          saveState();
        });
        label.appendChild(cb);
        label.appendChild(document.createTextNode(escapeHtml(person.name)));
        container.appendChild(label);
      });

      card.querySelector('.assign-all').addEventListener('click', () => {
        state.assignments[item.id] = state.people.map(p => p.id);
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = true; });
        rebuildQtyDOM();
        updatePerPerson();
        saveState();
      });

      card.querySelector('.assign-none').addEventListener('click', () => {
        state.assignments[item.id] = [];
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
        if (state.customQuantities && state.customQuantities[item.id]) {
          delete state.customQuantities[item.id];
        }
        rebuildQtyDOM();
        updatePerPerson();
        saveState();
      });

      updatePerPerson();
      rebuildQtyDOM();
      assignList.appendChild(card);
    });
  }

  btnBackPeople.addEventListener('click', () => { showStep('step-people'); renderPeople(); saveState(); });
  btnToSummary.addEventListener('click', () => {
    showStep('step-summary');
    renderSummary();
    saveState();
  });

  // ----- Summary -----
  const summaryList = document.getElementById('summary-list');
  const btnBackAssign = document.getElementById('btn-back-assign');
  const btnNewBill = document.getElementById('btn-new-bill');

  const summaryTotalEl = document.getElementById('summary-total');
  const summaryTotalAmountEl = document.getElementById('summary-total-amount');
  const btnCopySummary = document.getElementById('btn-copy-summary');
  const btnDownloadSummaryImage = document.getElementById('btn-download-summary-image');
  const btnShareSummary = document.getElementById('btn-share-summary');

  const personBreakdownModal = document.getElementById('person-breakdown-modal');
  const breakdownModalBackdrop = document.getElementById('breakdown-modal-backdrop');
  const btnCloseBreakdown = document.getElementById('btn-close-breakdown');
  const breakdownPersonNameEl = document.getElementById('breakdown-person-name');
  const breakdownItemsList = document.getElementById('breakdown-items-list');
  const breakdownTotalAmountEl = document.getElementById('breakdown-total-amount');
  const btnCopyBreakdown = document.getElementById('btn-copy-breakdown');
  const btnDownloadBreakdownImage = document.getElementById('btn-download-breakdown-image');
  const btnShareBreakdown = document.getElementById('btn-share-breakdown');

  let openBreakdownPersonId = null;

  function formatPersonAmount(amount) {
    return amount === 0 ? 'Не дължи' : formatMoney(amount) + ' €';
  }

  function computeSummary() {
    const owes = {};
    state.people.forEach(p => { owes[p.id] = 0; });

    state.items.forEach(item => {
      const total = getItemTotal(item);
      const personIds = state.assignments[item.id] || [];
      if (personIds.length === 0) return;
      
      const itemQty = resolveItemQty(item.label, item.qty);
      const customMap = state.customQuantities?.[item.id];
      const hasCustom = itemQty > 1 && personIds.length >= 2 && customMap && Object.keys(customMap).length > 0;

      if (hasCustom) {
        const unitPrice = total / itemQty;
        personIds.forEach(pid => {
          const qtyVal = customMap[pid];
          const personQty = qtyVal !== undefined ? parseFloat(qtyVal) : (itemQty / personIds.length);
          const share = personQty * unitPrice;
          owes[pid] = (owes[pid] || 0) + share;
        });
      } else {
        const perPerson = total / personIds.length;
        personIds.forEach(pid => { owes[pid] = (owes[pid] || 0) + perPerson; });
      }
    });

    const total = getTotalSum();
    const sortedPeople = [...state.people].sort((a, b) => (owes[b.id] || 0) - (owes[a.id] || 0));
    const lines = sortedPeople.map(p => `${p.name}: ${formatPersonAmount(owes[p.id] || 0)}`);

    return { owes, total, sortedPeople, lines };
  }

  function computePersonBreakdown(personId) {
    const person = state.people.find(p => p.id === personId);
    if (!person) return null;

    const entries = [];
    let total = 0;

    state.items.forEach(item => {
      const personIds = state.assignments[item.id] || [];
      if (!personIds.includes(personId)) return;
      
      const itemTotal = getItemTotal(item);
      const itemQty = resolveItemQty(item.label, item.qty);
      const customMap = state.customQuantities?.[item.id];
      const hasCustom = itemQty > 1 && personIds.length >= 2 && customMap && Object.keys(customMap).length > 0;

      let share = 0;
      if (hasCustom) {
        const unitPrice = itemTotal / itemQty;
        const qtyVal = customMap[personId];
        const personQty = qtyVal !== undefined ? parseFloat(qtyVal) : (itemQty / personIds.length);
        share = personQty * unitPrice;
        
        total += share;
        entries.push({
          label: (item.label || '').trim() || '(без име)',
          share,
          itemTotal,
          splitCount: personIds.length,
          customQty: personQty,
          itemQty: itemQty
        });
      } else {
        share = itemTotal / personIds.length;
        total += share;
        entries.push({
          label: (item.label || '').trim() || '(без име)',
          share,
          itemTotal,
          splitCount: personIds.length
        });
      }
    });

    return { person, entries, total };
  }

  function formatPersonBreakdownText(breakdown) {
    const parts = [
      'Разбивка за ' + breakdown.person.name,
      new Date().toLocaleString('bg-BG'),
      ''
    ];
    if (breakdown.entries.length === 0) {
      parts.push('Няма разпределени артикули.');
    } else {
      breakdown.entries.forEach(entry => {
        let line = entry.label + ' — ' + formatMoney(entry.share) + ' €';
        if (entry.customQty !== undefined) {
          line += ' (' + entry.customQty.toFixed(2).replace(/\.00$/, '') + ' бр. от ' + entry.itemQty + ' бр. общо)';
        } else if (entry.splitCount > 1) {
          line += ' (÷ ' + entry.splitCount + ', от ' + formatMoney(entry.itemTotal) + ' €)';
        }
        parts.push(line);
      });
    }
    parts.push('');
    parts.push('Общо: ' + formatMoney(breakdown.total) + ' €');
    return parts.join('\n');
  }

  function formatSummaryText(summary, includeHeader) {
    const parts = [];
    if (includeHeader !== false) {
      parts.push('Раздели сметката');
      parts.push('Обща сума: ' + formatMoney(summary.total) + ' €');
      parts.push(new Date().toLocaleString('bg-BG'));
      parts.push('');
    }
    parts.push(...summary.lines);
    return parts.join('\n');
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderSummaryImageCanvas(summary) {
    const padding = 32;
    const titleHeight = 44;
    const metaHeight = 28;
    const rowHeight = 52;
    const width = 480;
    const height = padding * 2 + titleHeight + metaHeight + metaHeight + summary.sortedPeople.length * rowHeight + 16;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, width, height);

    let y = padding;
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 26px Segoe UI, system-ui, sans-serif';
    ctx.fillText('Раздели сметката', padding, y + 28);
    y += titleHeight;

    ctx.fillStyle = '#94a3b8';
    ctx.font = '16px Segoe UI, system-ui, sans-serif';
    ctx.fillText('Обща сума: ' + formatMoney(summary.total) + ' €', padding, y + 18);
    y += metaHeight;

    ctx.fillStyle = '#718096';
    ctx.font = '14px Segoe UI, system-ui, sans-serif';
    ctx.fillText(new Date().toLocaleString('bg-BG'), padding, y + 16);
    y += metaHeight + 8;

    summary.sortedPeople.forEach(person => {
      const amount = summary.owes[person.id] || 0;
      const cardY = y;
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      roundRect(ctx, padding, cardY, width - padding * 2, rowHeight - 8, 10);
      ctx.fill();

      ctx.fillStyle = '#e8e8e8';
      ctx.font = '600 18px Segoe UI, system-ui, sans-serif';
      ctx.fillText(person.name, padding + 16, cardY + 30);

      const amountText = formatPersonAmount(amount);
      ctx.fillStyle = amount === 0 ? '#94a3b8' : '#68d391';
      ctx.font = (amount === 0 ? '500 ' : '700 ') + '20px Segoe UI, system-ui, sans-serif';
      const textWidth = ctx.measureText(amountText).width;
      ctx.fillText(amountText, width - padding - 16 - textWidth, cardY + 30);

      y += rowHeight;
    });

    return canvas;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function summaryToPngBlob(summary) {
    return new Promise((resolve, reject) => {
      const canvas = renderSummaryImageCanvas(summary);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('PNG не се създаде.'));
      }, 'image/png');
    });
  }

  function renderPersonBreakdownCanvas(breakdown) {
    const padding = 32;
    const titleHeight = 44;
    const metaHeight = 24;
    const rowHeight = 56;
    const totalRowHeight = 40;
    const width = 480;
    const rowCount = Math.max(breakdown.entries.length, 1);
    const height = padding * 2 + titleHeight + metaHeight + rowCount * rowHeight + totalRowHeight + 16;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, width, height);

    let y = padding;
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px Segoe UI, system-ui, sans-serif';
    ctx.fillText('Разбивка за ' + breakdown.person.name, padding, y + 26);
    y += titleHeight;

    ctx.fillStyle = '#718096';
    ctx.font = '14px Segoe UI, system-ui, sans-serif';
    ctx.fillText(new Date().toLocaleString('bg-BG'), padding, y + 14);
    y += metaHeight + 8;

    if (breakdown.entries.length === 0) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '16px Segoe UI, system-ui, sans-serif';
      ctx.fillText('Няма разпределени артикули.', padding, y + 24);
      y += rowHeight;
    } else {
      breakdown.entries.forEach(entry => {
        const cardY = y;
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        roundRect(ctx, padding, cardY, width - padding * 2, rowHeight - 8, 10);
        ctx.fill();

        ctx.fillStyle = '#e2e8f0';
        ctx.font = '600 16px Segoe UI, system-ui, sans-serif';
        const labelLines = wrapCanvasText(ctx, entry.label, width - padding * 2 - 120);
        labelLines.slice(0, 2).forEach((line, i) => {
          ctx.fillText(line, padding + 14, cardY + 22 + i * 18);
        });

        const shareText = formatMoney(entry.share) + ' €';
        ctx.fillStyle = '#68d391';
        ctx.font = '700 18px Segoe UI, system-ui, sans-serif';
        const shareW = ctx.measureText(shareText).width;
        ctx.fillText(shareText, width - padding - 14 - shareW, cardY + 24);

        if (entry.customQty !== undefined) {
          ctx.fillStyle = '#718096';
          ctx.font = '12px Segoe UI, system-ui, sans-serif';
          ctx.fillText(`${entry.customQty.toFixed(2).replace(/\.00$/, '')} бр. от ${entry.itemQty} бр.`, padding + 14, cardY + 44);
        } else if (entry.splitCount > 1) {
          ctx.fillStyle = '#718096';
          ctx.font = '12px Segoe UI, system-ui, sans-serif';
          ctx.fillText('÷ ' + entry.splitCount, padding + 14, cardY + 44);
        }

        y += rowHeight;
      });
    }

    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 18px Segoe UI, system-ui, sans-serif';
    const totalLabel = 'Общо: ';
    const totalValue = formatMoney(breakdown.total) + ' €';
    const totalLabelW = ctx.measureText(totalLabel).width;
    const totalValueW = ctx.measureText(totalValue).width;
    ctx.fillText(totalLabel, width - padding - totalValueW - totalLabelW, y + 28);
    ctx.fillStyle = '#68d391';
    ctx.font = '700 22px Segoe UI, system-ui, sans-serif';
    ctx.fillText(totalValue, width - padding - totalValueW, y + 28);

    return canvas;
  }

  function wrapCanvasText(ctx, text, maxWidth) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = '';
    words.forEach(word => {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    });
    if (line) lines.push(line);
    return lines.length ? lines : [text];
  }

  function personBreakdownToPngBlob(breakdown) {
    return new Promise((resolve, reject) => {
      const canvas = renderPersonBreakdownCanvas(breakdown);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('PNG не се създаде.'));
      }, 'image/png');
    });
  }

  function renderSummary() {
    const summary = computeSummary();

    if (summaryTotalEl) {
      summaryTotalEl.classList.remove('hidden');
      if (summaryTotalAmountEl) summaryTotalAmountEl.textContent = formatMoney(summary.total);
    }

    summaryList.innerHTML = '';
    summary.sortedPeople.forEach(person => {
      const amount = summary.owes[person.id] || 0;
      const card = document.createElement('div');
      card.className = 'summary-card' + (amount === 0 ? ' summary-zero' : '');
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', 'Разбивка за ' + person.name);
      card.innerHTML = `
        <span class="person-name">${escapeHtml(person.name)}</span>
        <span class="person-amount">${formatPersonAmount(amount)}</span>
      `;
      card.addEventListener('click', () => openPersonBreakdown(person.id));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openPersonBreakdown(person.id);
        }
      });
      summaryList.appendChild(card);
    });
  }

  function openPersonBreakdown(personId) {
    const breakdown = computePersonBreakdown(personId);
    if (!breakdown || !personBreakdownModal) return;

    openBreakdownPersonId = personId;
    if (breakdownPersonNameEl) {
      breakdownPersonNameEl.textContent = 'Разбивка за ' + breakdown.person.name;
    }
    if (breakdownTotalAmountEl) {
      breakdownTotalAmountEl.textContent = formatMoney(breakdown.total);
    }

    if (breakdownItemsList) {
      breakdownItemsList.innerHTML = '';
      if (breakdown.entries.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'breakdown-empty';
        empty.textContent = 'Няма разпределени артикули за този човек.';
        breakdownItemsList.appendChild(empty);
      } else {
        breakdown.entries.forEach(entry => {
          const li = document.createElement('li');
          li.className = 'breakdown-item';
          let splitHint = '';
          if (entry.customQty !== undefined) {
             splitHint = `<span class="breakdown-item-split">${entry.customQty.toFixed(2).replace(/\.00$/, '')} бр. от общо ${entry.itemQty} бр. (всеки по ${(entry.itemTotal / entry.itemQty).toFixed(2)} €)</span>`;
          } else if (entry.splitCount > 1) {
             splitHint = `<span class="breakdown-item-split">÷ ${entry.splitCount} (от ${formatMoney(entry.itemTotal)} €)</span>`;
          }
          li.innerHTML = `
            <span class="breakdown-item-label">${escapeHtml(entry.label)}${splitHint}</span>
            <span class="breakdown-item-share">${formatMoney(entry.share)} €</span>
          `;
          breakdownItemsList.appendChild(li);
        });
      }
    }

    personBreakdownModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    if (btnShareBreakdown && navigator.share) btnShareBreakdown.classList.remove('hidden');
  }

  function closePersonBreakdown() {
    if (!personBreakdownModal) return;
    personBreakdownModal.classList.add('hidden');
    document.body.style.overflow = '';
    openBreakdownPersonId = null;
  }

  function getOpenPersonBreakdown() {
    if (openBreakdownPersonId == null) return null;
    return computePersonBreakdown(openBreakdownPersonId);
  }

  function showToast(message) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }

  function copySummaryText() {
    const text = formatSummaryText(computeSummary());
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => showToast('Копирано!'));
    }
    showToast('Копирането не се поддържа в този браузър.');
    return Promise.reject(new Error('clipboard unavailable'));
  }

  function downloadSummaryImage() {
    const summary = computeSummary();
    summaryToPngBlob(summary)
      .then((blob) => {
        downloadBlob(blob, 'razdeli-smetka.png');
        showToast('Свалено!');
      })
      .catch(() => showToast('Снимката не се създаде.'));
  }

  async function shareSummary() {
    if (!navigator.share) {
      showToast('Споделянето не се поддържа — свали снимката.');
      return;
    }
    const summary = computeSummary();
    const text = formatSummaryText(summary);
    try {
      const pngBlob = await summaryToPngBlob(summary);
      const file = new File([pngBlob], 'razdeli-smetka.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: 'Раздели сметката',
          text,
          files: [file]
        });
      } else {
        await navigator.share({ title: 'Раздели сметката', text });
      }
      showToast('Споделено!');
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      try {
        await navigator.share({ title: 'Раздели сметката', text });
        showToast('Споделено!');
      } catch (err2) {
        if (err2 && err2.name === 'AbortError') return;
        showToast('Споделянето не успя.');
      }
    }
  }

  if (btnCopySummary) {
    btnCopySummary.addEventListener('click', () => {
      copySummaryText().catch(() => {});
    });
  }

  function copyPersonBreakdown() {
    const breakdown = getOpenPersonBreakdown();
    if (!breakdown) return;
    const text = formatPersonBreakdownText(breakdown);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => showToast('Копирано!')).catch(() => showToast('Копирането не успя.'));
    } else {
      showToast('Копирането не се поддържа в този браузър.');
    }
  }

  function downloadPersonBreakdownImage() {
    const breakdown = getOpenPersonBreakdown();
    if (!breakdown) return;
    const safeName = breakdown.person.name.replace(/[^\w\u0400-\u04FF]+/g, '-').replace(/^-|-$/g, '') || 'chovek';
    personBreakdownToPngBlob(breakdown)
      .then((blob) => {
        downloadBlob(blob, 'razbivka-' + safeName + '.png');
        showToast('Свалено!');
      })
      .catch(() => showToast('Снимката не се създаде.'));
  }

  async function sharePersonBreakdown() {
    const breakdown = getOpenPersonBreakdown();
    if (!breakdown) return;
    if (!navigator.share) {
      showToast('Споделянето не се поддържа — свали снимката.');
      return;
    }
    const text = formatPersonBreakdownText(breakdown);
    const safeName = breakdown.person.name.replace(/[^\w\u0400-\u04FF]+/g, '-').replace(/^-|-$/g, '') || 'chovek';
    try {
      const pngBlob = await personBreakdownToPngBlob(breakdown);
      const file = new File([pngBlob], 'razbivka-' + safeName + '.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: 'Разбивка за ' + breakdown.person.name,
          text,
          files: [file]
        });
      } else {
        await navigator.share({ title: 'Разбивка за ' + breakdown.person.name, text });
      }
      showToast('Споделено!');
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      try {
        await navigator.share({ title: 'Разбивка за ' + breakdown.person.name, text });
        showToast('Споделено!');
      } catch (err2) {
        if (err2 && err2.name === 'AbortError') return;
        showToast('Споделянето не успя.');
      }
    }
  }

  if (btnCloseBreakdown) btnCloseBreakdown.addEventListener('click', closePersonBreakdown);
  if (breakdownModalBackdrop) breakdownModalBackdrop.addEventListener('click', closePersonBreakdown);
  if (btnCopyBreakdown) btnCopyBreakdown.addEventListener('click', copyPersonBreakdown);
  if (btnDownloadBreakdownImage) btnDownloadBreakdownImage.addEventListener('click', downloadPersonBreakdownImage);
  if (btnShareBreakdown) {
    if (navigator.share) btnShareBreakdown.classList.remove('hidden');
    btnShareBreakdown.addEventListener('click', () => { sharePersonBreakdown(); });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (cropModal && !cropModal.classList.contains('hidden')) {
      cancelCropSelection();
      return;
    }
    if (personBreakdownModal && !personBreakdownModal.classList.contains('hidden')) {
      closePersonBreakdown();
    }
  });

  if (btnDownloadSummaryImage) {
    btnDownloadSummaryImage.addEventListener('click', downloadSummaryImage);
  }

  if (btnShareSummary) {
    if (navigator.share) btnShareSummary.classList.remove('hidden');
    btnShareSummary.addEventListener('click', () => { shareSummary(); });
  }

  btnBackAssign.addEventListener('click', () => { showStep('step-assign'); renderAssign(); saveState(); });
  btnNewBill.addEventListener('click', () => {
    closeCropModal();
    state.imageDataUrl = null;
    state.items = [];
    state.people = [];
    state.assignments = {};
    state.customQuantities = {};
    nextItemId = 1;
    nextPersonId = 1;
    imagePreview.innerHTML = '';
    imagePreview.classList.add('hidden');
    btnScan.classList.add('hidden');
    if (btnScanAi) btnScanAi.classList.add('hidden');
    btnSkipScan.classList.add('hidden');
    if (btnChangePhoto) btnChangePhoto.classList.add('hidden');
    if (btnCropPhoto) btnCropPhoto.classList.add('hidden');
    uploadZone.classList.remove('hidden');
    fileInput.value = '';
    try { localStorage.removeItem(STATE_KEY); } catch (e) {}
    showStep('step-upload');
  });

  // Stepper navigation
  document.getElementById('stepper')?.addEventListener('click', (e) => {
    const dot = e.target.closest('.stepper-dot');
    if (!dot || !dot.dataset.step) return;
    e.preventDefault();
    const stepId = dot.dataset.step;
    const idx = steps.indexOf(stepId);
    if (idx < 0) return;
    showStep(stepId);
    if (stepId === 'step-items') renderItems();
    else if (stepId === 'step-people') renderPeople();
    else if (stepId === 'step-assign') renderAssign();
    else if (stepId === 'step-summary') renderSummary();
  });

  // Always boot freshly to avoid stale cache on reload unless they already restored
  if (!loadState()) {
    try {
      localStorage.removeItem(STATE_KEY);
    } catch (e) { /* ignored */ }
    renderItems();
    showStep('step-upload', false);
  }
})();
