(function () {
  'use strict';

  const state = {
    imageDataUrl: null,
    items: [],      // { id, label, price }
    people: [],     // { id, name }
    assignments: {}  // itemId -> [personId, ...]
  };

  let nextItemId = 1;
  let nextPersonId = 1;

  const steps = ['step-upload', 'step-items', 'step-people', 'step-assign', 'step-summary'];

  function showStep(stepId) {
    steps.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('active', id === stepId);
    });
  }

  function getTotalSum() {
    return state.items.reduce((sum, it) => sum + (Number(it.price) || 0), 0);
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
      uploadZone.classList.add('hidden');
    };
    reader.readAsDataURL(file);
  }

  btnScan.addEventListener('click', () => {
    if (!state.imageDataUrl) return;
    const statusEl = document.createElement('div');
    statusEl.className = 'ocr-loading';
    statusEl.innerHTML = '<span class="spinner"></span> Извличане на текст от снимката...';
    imagePreview.appendChild(statusEl);
    btnScan.disabled = true;

    Tesseract.recognize(state.imageDataUrl, 'bul+eng', {
      logger: (m) => { if (m.status) statusEl.innerHTML = '<span class="spinner"></span> ' + m.status; }
    }).then(({ data: { text } }) => {
      statusEl.remove();
      btnScan.disabled = false;
      parseReceiptText(text);
      showStep('step-items');
      renderItems();
    }).catch(() => {
      statusEl.remove();
      btnScan.disabled = false;
      parseReceiptText('');
      showStep('step-items');
      renderItems();
    });
  });

  btnSkipScan.addEventListener('click', () => {
    state.items = [];
    showStep('step-items');
    renderItems();
  });

  function parseReceiptText(text) {
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const parsed = [];
    const priceRegex = /[\d]+[.,]\d{2}$/;
    const numberRegex = /[\d]+[.,]?\d*/g;

    for (const line of lines) {
      const match = line.match(priceRegex);
      if (!match) continue;
      const priceStr = match[0].replace(',', '.');
      const price = parseFloat(priceStr);
      if (isNaN(price) || price <= 0 || price > 99999) continue;
      const label = line.slice(0, match.index).trim();
      if (label.length < 2) continue;
      parsed.push({ label, price });
    }

    if (parsed.length > 0) {
      state.items = parsed.map(({ label, price }) => ({ id: nextItemId++, label, price: formatMoney(price) }));
    } else {
      state.items = [{ id: nextItemId++, label: '', price: '' }];
    }
  }

  // ----- Items -----
  const itemsList = document.getElementById('items-list');
  const totalSumEl = document.getElementById('total-sum');
  const btnAddItem = document.getElementById('btn-add-item');
  const btnToPeople = document.getElementById('btn-to-people');

  function renderItems() {
    itemsList.innerHTML = '';
    state.items.forEach(item => {
      const li = document.createElement('li');
      li.className = 'item-row';
      li.dataset.id = item.id;
      li.innerHTML = `
        <input type="text" class="item-label" placeholder="Артикул" value="${escapeHtml(item.label)}">
        <input type="number" class="item-price" placeholder="0.00" step="0.01" min="0" value="${escapeHtml(item.price)}">
        <button type="button" class="btn btn-danger btn-small btn-remove-item" aria-label="Премахни">✕</button>
      `;
      li.querySelector('.item-label').addEventListener('input', (e) => { item.label = e.target.value; });
      li.querySelector('.item-price').addEventListener('input', (e) => { item.price = e.target.value; updateTotal(); });
      li.querySelector('.btn-remove-item').addEventListener('click', () => {
        state.items = state.items.filter(i => i.id !== item.id);
        delete state.assignments[item.id];
        renderItems();
      });
      itemsList.appendChild(li);
    });
    updateTotal();
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
    state.items.push({ id: nextItemId++, label: '', price: '' });
    renderItems();
  });

  btnToPeople.addEventListener('click', () => {
    state.items = state.items.filter(i => (i.label || '').trim() || (i.price && Number(i.price) > 0));
    if (state.items.length === 0) {
      state.items.push({ id: nextItemId++, label: '', price: '' });
    }
    renderItems();
    showStep('step-people');
    renderPeople();
  });

  // ----- People -----
  const peopleList = document.getElementById('people-list');
  const personNameInput = document.getElementById('person-name');
  const btnAddPerson = document.getElementById('btn-add-person');
  const btnBackItems = document.getElementById('btn-back-items');
  const btnToAssign = document.getElementById('btn-to-assign');

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
      });
      peopleList.appendChild(li);
    });
  }

  function addPerson() {
    const name = (personNameInput.value || '').trim();
    if (!name) return;
    state.people.push({ id: nextPersonId++, name });
    personNameInput.value = '';
    renderPeople();
  }

  btnAddPerson.addEventListener('click', addPerson);
  personNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addPerson(); } });

  btnBackItems.addEventListener('click', () => { showStep('step-items'); renderItems(); });
  btnToAssign.addEventListener('click', () => {
    if (state.people.length === 0) return;
    showStep('step-assign');
    renderAssign();
  });

  // ----- Assign -----
  const assignList = document.getElementById('assign-list');
  const btnBackPeople = document.getElementById('btn-back-people');
  const btnToSummary = document.getElementById('btn-to-summary');

  function renderAssign() {
    assignList.innerHTML = '';
    state.items.forEach(item => {
      const price = Number(item.price) || 0;
      if (price <= 0) return;
      const card = document.createElement('div');
      card.className = 'assign-card';
      const assigned = state.assignments[item.id] || [];
      card.innerHTML = `
        <span class="item-label">${escapeHtml(item.label) || '(без име)'}</span>
        <span class="item-price">${formatMoney(price)} лв</span>
        <div class="assign-checkboxes"></div>
      `;
      const container = card.querySelector('.assign-checkboxes');
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
        });
        label.appendChild(cb);
        label.appendChild(document.createTextNode(escapeHtml(person.name)));
        container.appendChild(label);
      });
      assignList.appendChild(card);
    });
  }

  btnBackPeople.addEventListener('click', () => { showStep('step-people'); renderPeople(); });
  btnToSummary.addEventListener('click', () => {
    showStep('step-summary');
    renderSummary();
  });

  // ----- Summary -----
  const summaryList = document.getElementById('summary-list');
  const btnBackAssign = document.getElementById('btn-back-assign');
  const btnNewBill = document.getElementById('btn-new-bill');

  function renderSummary() {
    const owes = {};
    state.people.forEach(p => { owes[p.id] = 0; });

    state.items.forEach(item => {
      const price = Number(item.price) || 0;
      const personIds = state.assignments[item.id] || [];
      if (personIds.length === 0) return;
      const perPerson = price / personIds.length;
      personIds.forEach(pid => { owes[pid] = (owes[pid] || 0) + perPerson; });
    });

    summaryList.innerHTML = '';
    state.people.forEach(person => {
      const amount = owes[person.id] || 0;
      const card = document.createElement('div');
      card.className = 'summary-card';
      card.innerHTML = `
        <span class="person-name">${escapeHtml(person.name)}</span>
        <span class="person-amount">${formatMoney(amount)} лв</span>
      `;
      summaryList.appendChild(card);
    });
  }

  btnBackAssign.addEventListener('click', () => { showStep('step-assign'); renderAssign(); });
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
    showStep('step-upload');
  });

  renderItems();
})();
