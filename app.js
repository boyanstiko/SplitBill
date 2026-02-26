(function () {
  'use strict';

  const STATE_KEY = 'splitbill-state';

  const state = {
    imageDataUrl: null,
    items: [],      // { id, label, price, qty }
    people: [],     // { id, name }
    assignments: {}  // itemId -> [personId, ...]
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
        state.items = data.items.map(it => ({ ...it, qty: it.qty != null ? it.qty : 1 }));
      }
      if (data.people && Array.isArray(data.people)) state.people = data.people;
      if (data.assignments && typeof data.assignments === 'object') state.assignments = data.assignments;
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
    return state.items.reduce((sum, it) => sum + (Number(it.price) || 0) * (it.qty != null ? it.qty : 1), 0);
  }

  function formatMoney(n) {
    return Number(n).toFixed(2);
  }

  // ----- Upload & OCR -----
  const uploadZone = document.getElementById('upload-zone');
  const fileInput = document.getElementById('file-input');
  const imagePreview = document.getElementById('image-preview');
  const btnScan = document.getElementById('btn-scan');
  const btnSkipScan = document.getElementById('btn-skip-scan');
  const btnChangePhoto = document.getElementById('btn-change-photo');

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
    reader.onload = (e) => {
      state.imageDataUrl = e.target.result;
      const img = document.createElement('img');
      img.src = state.imageDataUrl;
      imagePreview.innerHTML = '';
      imagePreview.appendChild(img);
      imagePreview.classList.remove('hidden');
      btnScan.classList.remove('hidden');
      btnSkipScan.classList.remove('hidden');
      if (btnChangePhoto) btnChangePhoto.classList.remove('hidden');
      uploadZone.classList.add('hidden');
      saveState();
    };
    reader.readAsDataURL(file);
  }

  if (btnChangePhoto) {
    btnChangePhoto.addEventListener('click', () => {
      state.imageDataUrl = null;
      imagePreview.innerHTML = '';
      imagePreview.classList.add('hidden');
      btnScan.classList.add('hidden');
      btnSkipScan.classList.add('hidden');
      btnChangePhoto.classList.add('hidden');
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

  /** Нормализира снимка за OCR: ориентация, размер, подобрение контраст за снимки/камера. */
  function normalizeImageForOcr(dataUrl, maxSize, cb) {
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
        enhanceCanvasForOcr(ctx, cw, ch);
        cb(canvas.toDataURL('image/jpeg', 0.95));
      } catch (e) {
        cb(dataUrl);
      }
    };
    img.onerror = () => cb(dataUrl);
    img.src = dataUrl;
  }

  btnScan.addEventListener('click', () => {
    if (!state.imageDataUrl) return;
    const statusEl = document.createElement('div');
    statusEl.className = 'ocr-loading';
    statusEl.innerHTML = '<span class="spinner"></span> Подготвям снимката...';
    imagePreview.appendChild(statusEl);
    btnScan.disabled = true;

    normalizeImageForOcr(state.imageDataUrl, 2000, (imageForOcr) => {
      statusEl.innerHTML = '<span class="spinner"></span> Извличане на текст от снимката...';
      Tesseract.recognize(imageForOcr, 'bul+eng', {
        logger: (m) => { if (m.status) statusEl.innerHTML = '<span class="spinner"></span> ' + m.status; },
        tessedit_pageseg_mode: '4'
      }).then(({ data: { text } }) => {
        statusEl.remove();
        btnScan.disabled = false;
        parseReceiptText(text);
        showStep('step-items');
        renderItems();
        saveState();
      }).catch(() => {
        statusEl.remove();
        btnScan.disabled = false;
        parseReceiptText('');
        showStep('step-items');
        renderItems();
        saveState();
      });
    });
  });

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

  const LABEL_UNREADABLE = 'НЕ СЕ ЧЕТЕ';
  const MAX_PRICE = 999999.99;

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
    const qtyPrefixRegex = /^(\d+)(?:[.,]\d+)?\s*[xX]\s+/;

    for (const line of lines) {
      if (isReceiptSkipLine(line)) continue;
      const match = findLastPriceOnLine(line);
      if (!match) continue;
      const price = parsePriceFromMatch(match);
      if (isNaN(price) || price <= 0 || price > MAX_PRICE) continue;
      let label = line.slice(0, match.index).trim();
      let qty = 1;
      const qtyMatch = label.match(qtyPrefixRegex);
      if (qtyMatch) {
        qty = Math.max(1, parseInt(qtyMatch[1], 10) || 1);
        label = label.slice(qtyMatch[0].length).trim();
      }
      if (!label || label.length < 2) label = LABEL_UNREADABLE;
      parsed.push({ label, price, qty });
    }

    if (parsed.length > 0) {
      state.items = parsed.map(({ label, price, qty }) => ({
        id: nextItemId++,
        label,
        price: formatMoney(price),
        qty: qty || 1
      }));
    } else {
      state.items = [{ id: nextItemId++, label: '', price: '', qty: 1 }];
    }
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
      li.querySelector('.item-label').addEventListener('input', (e) => { item.label = e.target.value; saveState(); });
      li.querySelector('.item-price').addEventListener('input', (e) => { item.price = e.target.value; updateTotal(); saveState(); });
      li.querySelector('.btn-duplicate-item').addEventListener('click', () => {
        const copy = { id: nextItemId++, label: item.label, price: item.price, qty: 1 };
        state.items.splice(state.items.indexOf(item) + 1, 0, copy);
        renderItems();
        saveState();
      });
      li.querySelector('.btn-remove-item').addEventListener('click', () => {
        state.items = state.items.filter(i => i.id !== item.id);
        delete state.assignments[item.id];
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
    return (Number(item.price) || 0) * (item.qty != null ? item.qty : 1);
  }

  function renderAssign() {
    assignList.innerHTML = '';
    state.items.forEach(item => {
      const total = getItemTotal(item);
      if (total <= 0) return;
      const card = document.createElement('div');
      card.className = 'assign-card';
      const assigned = state.assignments[item.id] || [];
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
      `;
      const perPersonEl = card.querySelector('.assign-per-person');
      const container = card.querySelector('.assign-checkboxes');
      const updatePerPerson = () => {
        const ids = state.assignments[item.id] || [];
        const n = ids.length;
        perPersonEl.textContent = n > 0 ? 'По ' + formatMoney(total / n) + ' € на човек' : '';
      };
      state.people.forEach(person => {
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.personId = person.id;
        cb.checked = assigned.includes(person.id);
        cb.addEventListener('change', () => {
          state.assignments[item.id] = state.assignments[item.id] || [];
          if (cb.checked) state.assignments[item.id].push(person.id);
          else state.assignments[item.id] = state.assignments[item.id].filter(id => id !== person.id);
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
        updatePerPerson();
        saveState();
      });
      card.querySelector('.assign-none').addEventListener('click', () => {
        state.assignments[item.id] = [];
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
        updatePerPerson();
        saveState();
      });
      updatePerPerson();
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

  function renderSummary() {
    const owes = {};
    state.people.forEach(p => { owes[p.id] = 0; });

    state.items.forEach(item => {
      const total = getItemTotal(item);
      const personIds = state.assignments[item.id] || [];
      if (personIds.length === 0) return;
      const perPerson = total / personIds.length;
      personIds.forEach(pid => { owes[pid] = (owes[pid] || 0) + perPerson; });
    });

    const total = getTotalSum();
    if (summaryTotalEl) {
      summaryTotalEl.classList.remove('hidden');
      if (summaryTotalAmountEl) summaryTotalAmountEl.textContent = formatMoney(total);
    }

    const sorted = [...state.people].sort((a, b) => (owes[b.id] || 0) - (owes[a.id] || 0));
    summaryList.innerHTML = '';
    sorted.forEach(person => {
      const amount = owes[person.id] || 0;
      const card = document.createElement('div');
      card.className = 'summary-card' + (amount === 0 ? ' summary-zero' : '');
      card.innerHTML = `
        <span class="person-name">${escapeHtml(person.name)}</span>
        <span class="person-amount">${amount === 0 ? 'Не дължи' : formatMoney(amount) + ' €'}</span>
      `;
      summaryList.appendChild(card);
    });
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

  if (btnCopySummary) {
    btnCopySummary.addEventListener('click', () => {
      const owes = {};
      state.people.forEach(p => { owes[p.id] = 0; });
      state.items.forEach(item => {
        const total = getItemTotal(item);
        const personIds = state.assignments[item.id] || [];
        if (personIds.length === 0) return;
        const perPerson = total / personIds.length;
        personIds.forEach(pid => { owes[pid] = (owes[pid] || 0) + perPerson; });
      });
      const lines = state.people.map(p => `${p.name}: ${owes[p.id] === 0 ? 'Не дължи' : formatMoney(owes[p.id]) + ' €'}`);
      const text = lines.join('\n');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => showToast('Копирано!')).catch(() => showToast('Копирането не успя.'));
      } else {
        showToast('Копирането не се поддържа в този браузър.');
      }
    });
  }

  btnBackAssign.addEventListener('click', () => { showStep('step-assign'); renderAssign(); saveState(); });
  btnNewBill.addEventListener('click', () => {
    state.imageDataUrl = null;
    state.items = [];
    state.people = [];
    state.assignments = {};
    nextItemId = 1;
    nextPersonId = 1;
    imagePreview.innerHTML = '';
    imagePreview.classList.add('hidden');
    btnScan.classList.add('hidden');
    btnSkipScan.classList.add('hidden');
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

  if (!loadState()) {
    renderItems();
    showStep('step-upload', false);
  }
})();
