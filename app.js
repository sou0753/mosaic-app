'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const stage = $('stage'), viewCanvas = $('viewCanvas');
  const viewCtx = viewCanvas.getContext('2d');
  const canvas = () => document.createElement('canvas');
  const original = canvas(), edited = canvas(), effect = canvas(), stamp = canvas();
  const originalCtx = original.getContext('2d');
  const editCtx = edited.getContext('2d');
  const effectCtx = effect.getContext('2d');
  const stampCtx = stamp.getContext('2d');
  let loaded = false, busy = false, comparing = false;
  let mode = 'pixelate', tool = 'brush', effectKey = '';
  let history = [], future = [], active = null;
  let imageName = '', imageLabel = '';
  const pointers = new Map();
  let gesture = null, panStart = null, suppressUntilUp = false;
  const view = { fit: 1, zoom: 1, x: 0, y: 0, width: 1, height: 1 };
  let exportUrl = '', exportFile = null, exportGeneration = 0;
  let toastTimer, confirmResolve, registration;
  const clamp = (n, low, high) => Math.max(low, Math.min(high, n));

  function notify(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3800);
  }

  function confirmAction(title, message, label = '続ける') {
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = message;
    $('acceptConfirmBtn').textContent = label;
    $('confirmDialog').showModal();
    return new Promise(resolve => { confirmResolve = resolve; });
  }
  function finishConfirm(accepted) {
    $('confirmDialog').close();
    confirmResolve?.(accepted);
    confirmResolve = null;
  }
  $('cancelConfirmBtn').onclick = () => finishConfirm(false);
  $('acceptConfirmBtn').onclick = () => finishConfirm(true);
  $('confirmDialog').addEventListener('cancel', event => { event.preventDefault(); finishConfirm(false); });

  function updateButtons() {
    const locked = !loaded || busy || !!active || pointers.size > 0;
    $('undoBtn').disabled = locked || !history.length;
    $('redoBtn').disabled = locked || !future.length;
    ['saveBtn', 'fitBtn', 'compareBtn'].forEach(id => { $(id).disabled = locked; });
    $('resetBtn').disabled = locked || !history.length;
    $('openBtn').disabled = busy;
    $('brushSize').disabled = tool !== 'brush' || busy;
    $('strengthRange').disabled = mode === 'black' || busy;
    document.querySelectorAll('[data-tool], [data-effect]').forEach(button => { button.disabled = busy || !!active; });
  }
  function setComparison(value) {
    comparing = value;
    $('compareBadge').hidden = !value;
    $('compareBtn').setAttribute('aria-pressed', String(value));
    $('compareBtn').innerHTML = value ? '<span aria-hidden="true">◨</span>加工後' : '<span aria-hidden="true">◧</span>加工前';
    render();
  }
  function fitView() {
    view.fit = Math.min(view.width / original.width, view.height / original.height) * .94;
    view.zoom = 1;
    view.x = (view.width - original.width * view.fit) / 2;
    view.y = (view.height - original.height * view.fit) / 2;
    render();
  }
  function constrainView() {
    const w = original.width * view.fit * view.zoom, h = original.height * view.fit * view.zoom;
    view.x = w <= view.width ? (view.width - w) / 2 : clamp(view.x, view.width - w, 0);
    view.y = h <= view.height ? (view.height - h) / 2 : clamp(view.y, view.height - h, 0);
  }
  function resize() {
    const rect = stage.getBoundingClientRect();
    const oldFit = view.fit;
    const anchor = { x: (view.width / 2 - view.x) / (oldFit * view.zoom), y: (view.height / 2 - view.y) / (oldFit * view.zoom) };
    view.width = rect.width; view.height = rect.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    viewCanvas.width = Math.round(rect.width * dpr);
    viewCanvas.height = Math.round(rect.height * dpr);
    viewCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (loaded) {
      view.fit = Math.min(view.width / original.width, view.height / original.height) * .94;
      view.x = view.width / 2 - anchor.x * view.fit * view.zoom;
      view.y = view.height / 2 - anchor.y * view.fit * view.zoom;
      constrainView();
    }
    render();
  }
  function localPoint(event) {
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function imagePoint(point) {
    const scale = view.fit * view.zoom;
    return { x: (point.x - view.x) / scale, y: (point.y - view.y) / scale };
  }
  function inside(point) { return point.x >= 0 && point.y >= 0 && point.x < original.width && point.y < original.height; }
  function bounded(point) { return { x: clamp(point.x, 0, original.width), y: clamp(point.y, 0, original.height) }; }
  function render() {
    viewCtx.clearRect(0, 0, view.width, view.height);
    if (!loaded) return;
    const scale = view.fit * view.zoom;
    viewCtx.imageSmoothingEnabled = true;
    viewCtx.drawImage(comparing ? original : edited, view.x, view.y, original.width * scale, original.height * scale);
    if (active?.kind === 'rect') {
      const a = active.points[0], b = active.points[1];
      const x = view.x + Math.min(a.x, b.x) * scale, y = view.y + Math.min(a.y, b.y) * scale;
      const w = Math.abs(a.x - b.x) * scale, h = Math.abs(a.y - b.y) * scale;
      viewCtx.fillStyle = '#a8efd825'; viewCtx.fillRect(x, y, w, h);
      viewCtx.strokeStyle = '#c5ffe9'; viewCtx.lineWidth = 1.5; viewCtx.setLineDash([5, 4]);
      viewCtx.strokeRect(x, y, w, h); viewCtx.setLineDash([]);
    }
    $('zoomLabel').textContent = Math.round(view.zoom * 100) + '%';
  }

  async function decode(file) {
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* Try the native image decoder next. */ }
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }
  $('openBtn').onclick = async () => {
    if (history.length && !await confirmAction('別の写真を開きますか？', '編集中の内容は消えます。必要な画像は先に保存してください。', '写真を選ぶ')) return;
    $('fileInput').click();
  };
  $('fileInput').onchange = async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || busy) return;
    busy = true; updateButtons();
    let bitmap, next;
    try {
      bitmap = await decode(file);
      const bw = bitmap.naturalWidth || bitmap.width, bh = bitmap.naturalHeight || bitmap.height;
      if (!bw || !bh) throw new Error('empty image');
      const scale = Math.min(1, 2400 / Math.max(bw, bh), Math.sqrt(4000000 / (bw * bh)));
      const w = Math.max(1, Math.round(bw * scale)), h = Math.max(1, Math.round(bh * scale));
      next = canvas(); next.width = w; next.height = h;
      const ctx = next.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, w, h);
      ctx.getImageData(0, 0, 1, 1); // Confirm decoding and canvas access before replacing the current photo.
      original.width = edited.width = effect.width = w;
      original.height = edited.height = effect.height = h;
      originalCtx.drawImage(next, 0, 0); editCtx.drawImage(next, 0, 0);
      imageName = file.name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 40) || 'photo';
      imageLabel = w + ' × ' + h + (scale < 1 ? ' · 軽量化済み' : ' px');
      $('imageInfo').textContent = imageLabel;
      $('welcome').hidden = true;
      loaded = true; history = []; future = []; active = null; effectKey = '';
      pointers.clear(); gesture = null; panStart = null; suppressUntilUp = false;
      setComparison(false); resize(); fitView();
      if (scale < 1) notify('動作を軽くするため、長辺2400px・最大400万画素以内に調整しました');
    } catch (error) {
      notify('この画像を開けませんでした。JPEG・PNG形式の写真でお試しください。');
    } finally {
      bitmap?.close?.();
      if (next) { next.width = 1; next.height = 1; }
      busy = false; updateButtons();
    }
  };

  // Three separable box passes approximate a Gaussian blur without Canvas.filter.
  // Premultiplied color avoids dark halos around transparent pixels.
  function softwareBlur(image, radius) {
    const { width: w, height: h, data } = image;
    let src = new Uint8ClampedArray(data), dst = new Uint8ClampedArray(data.length);
    for (let i = 0; i < src.length; i += 4) {
      const alpha = src[i + 3] / 255;
      src[i] *= alpha; src[i + 1] *= alpha; src[i + 2] *= alpha;
    }
    const size = radius * 2 + 1;
    for (let pass = 0; pass < 3; pass++) {
      for (let axis = 0; axis < 2; axis++) {
        const length = axis ? h : w, rows = axis ? w : h;
        const stride = axis ? w * 4 : 4;
        for (let row = 0; row < rows; row++) {
          const start = axis ? row * 4 : row * w * 4;
          const sum = [0, 0, 0, 0];
          for (let p = -radius; p <= radius; p++) {
            const i = start + clamp(p, 0, length - 1) * stride;
            for (let c = 0; c < 4; c++) sum[c] += src[i + c];
          }
          for (let p = 0; p < length; p++) {
            const i = start + p * stride;
            const remove = start + clamp(p - radius, 0, length - 1) * stride;
            const add = start + clamp(p + radius + 1, 0, length - 1) * stride;
            for (let c = 0; c < 4; c++) { dst[i + c] = sum[c] / size; sum[c] += src[add + c] - src[remove + c]; }
          }
        }
        [src, dst] = [dst, src];
      }
    }
    for (let i = 0; i < src.length; i += 4) {
      const alpha = src[i + 3] / 255;
      if (alpha) { src[i] /= alpha; src[i + 1] /= alpha; src[i + 2] /= alpha; }
    }
    image.data.set(src); return image;
  }
  function prepareEffect(command) {
    const key = command.mode + ':' + command.strength;
    if (effectKey === key) return;
    effectCtx.clearRect(0, 0, effect.width, effect.height);
    if (command.mode === 'black') {
      effectCtx.fillStyle = '#000'; effectCtx.fillRect(0, 0, effect.width, effect.height);
    } else {
      const temp = canvas();
      const longest = Math.max(original.width, original.height);
      if (command.mode === 'pixelate') {
        const block = Math.max(3, Math.round(longest * (.003 + command.strength * .0005)));
        temp.width = Math.max(1, Math.ceil(original.width / block));
        temp.height = Math.max(1, Math.ceil(original.height / block));
      } else {
        const scale = Math.min(1, 640 / longest);
        temp.width = Math.max(1, Math.round(original.width * scale));
        temp.height = Math.max(1, Math.round(original.height * scale));
      }
      const ctx = temp.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(original, 0, 0, temp.width, temp.height);
      if (command.mode !== 'pixelate') {
        const radius = Math.max(1, Math.round(Math.max(temp.width, temp.height) * (.002 + command.strength * .00035)));
        ctx.putImageData(softwareBlur(ctx.getImageData(0, 0, temp.width, temp.height), radius), 0, 0);
        if (command.mode === 'mist') {
          ctx.globalCompositeOperation = 'source-atop';
          ctx.fillStyle = 'rgba(235,241,245,' + (.10 + command.strength * .0014) + ')';
          ctx.fillRect(0, 0, temp.width, temp.height);
        }
      }
      effectCtx.imageSmoothingEnabled = command.mode !== 'pixelate';
      effectCtx.drawImage(temp, 0, 0, original.width, original.height);
      temp.width = 1; temp.height = 1;
    }
    effectKey = key;
  }
  function brushAt(point, command) {
    const radius = command.radius;
    const left = Math.max(0, Math.floor(point.x - radius)), top = Math.max(0, Math.floor(point.y - radius));
    const right = Math.min(edited.width, Math.ceil(point.x + radius)), bottom = Math.min(edited.height, Math.ceil(point.y + radius));
    const w = right - left, h = bottom - top;
    if (w <= 0 || h <= 0) return;
    stamp.width = w; stamp.height = h;
    const cx = point.x - left, cy = point.y - top;
    if (command.mode === 'mist' || command.mode === 'blur') {
      const gradient = stampCtx.createRadialGradient(cx, cy, radius * (command.mode === 'mist' ? .12 : .65), cx, cy, radius);
      gradient.addColorStop(0, '#000'); gradient.addColorStop(1, 'transparent'); stampCtx.fillStyle = gradient;
    } else stampCtx.fillStyle = '#000';
    stampCtx.beginPath(); stampCtx.arc(cx, cy, radius, 0, Math.PI * 2); stampCtx.fill();
    stampCtx.globalCompositeOperation = 'source-in';
    stampCtx.drawImage(effect, left, top, w, h, 0, 0, w, h);
    editCtx.drawImage(stamp, left, top);
  }
  function paintLine(a, b, command) {
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const count = Math.max(1, Math.ceil(distance / Math.max(1, command.radius * .3)));
    for (let n = 1; n <= count; n++) {
      const t = n / count;
      brushAt({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, command);
    }
  }
  function paintRectangle(command) {
    const [a, b] = command.points;
    const left = Math.floor(Math.min(a.x, b.x)), top = Math.floor(Math.min(a.y, b.y));
    const w = Math.ceil(Math.max(a.x, b.x)) - left, h = Math.ceil(Math.max(a.y, b.y)) - top;
    if (w <= 0 || h <= 0) return;
    if (command.mode !== 'mist') { editCtx.drawImage(effect, left, top, w, h, left, top, w, h); return; }
    stamp.width = w; stamp.height = h;
    stampCtx.drawImage(effect, left, top, w, h, 0, 0, w, h);
    const fade = Math.max(1, Math.min(w, h) * .2);
    stampCtx.globalCompositeOperation = 'destination-in';
    const horizontal = stampCtx.createLinearGradient(0, 0, w, 0);
    horizontal.addColorStop(0, 'transparent'); horizontal.addColorStop(fade / w, '#000');
    horizontal.addColorStop(1 - fade / w, '#000'); horizontal.addColorStop(1, 'transparent');
    stampCtx.fillStyle = horizontal; stampCtx.fillRect(0, 0, w, h);
    const vertical = stampCtx.createLinearGradient(0, 0, 0, h);
    vertical.addColorStop(0, 'transparent'); vertical.addColorStop(fade / h, '#000');
    vertical.addColorStop(1 - fade / h, '#000'); vertical.addColorStop(1, 'transparent');
    stampCtx.fillStyle = vertical; stampCtx.fillRect(0, 0, w, h);
    editCtx.drawImage(stamp, left, top);
  }
  function applyCommand(command) {
    if (command.kind === 'reset') {
      editCtx.clearRect(0, 0, edited.width, edited.height); editCtx.drawImage(original, 0, 0); return;
    }
    prepareEffect(command);
    if (command.kind === 'rect') paintRectangle(command);
    else {
      brushAt(command.points[0], command);
      for (let i = 1; i < command.points.length; i++) paintLine(command.points[i - 1], command.points[i], command);
    }
  }
  function rebuild() {
    editCtx.clearRect(0, 0, edited.width, edited.height); editCtx.drawImage(original, 0, 0);
    const start = history.findLastIndex ? history.findLastIndex(c => c.kind === 'reset') : (() => { for (let i = history.length - 1; i >= 0; i--) if (history[i].kind === 'reset') return i; return -1; })();
    for (let i = start + 1; i < history.length; i++) applyCommand(history[i]);
    render(); updateButtons();
  }
  function cancelStroke() {
    if (!active) return;
    const painted = active.painted; active = null;
    if (painted) rebuild(); else render();
  }
  function beginGesture() {
    cancelStroke(); panStart = null; suppressUntilUp = true;
    const [a, b] = [...pointers.values()];
    const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    gesture = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), zoom: view.zoom, anchor: imagePoint(center) };
  }
  stage.addEventListener('pointerdown', event => {
    if (!loaded || busy || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault(); stage.setPointerCapture(event.pointerId);
    const point = localPoint(event); pointers.set(event.pointerId, point);
    if (pointers.size === 2) { beginGesture(); updateButtons(); return; }
    if (pointers.size > 2 || suppressUntilUp) return;
    if (tool === 'pan') { panStart = { point, x: view.x, y: view.y }; updateButtons(); return; }
    if (comparing) { notify('「加工後」を押すと編集に戻れます'); updateButtons(); return; }
    const image = imagePoint(point);
    if (!inside(image)) { updateButtons(); return; }
    active = { kind: tool, mode, strength: +$('strengthRange').value,
      radius: +$('brushSize').value / (view.fit * view.zoom) / 2,
      points: tool === 'rect' ? [image, image] : [image], pointer: event.pointerId, start: point, painted: false };
    render(); updateButtons();
  });
  stage.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    event.preventDefault();
    const point = localPoint(event); pointers.set(event.pointerId, point);
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      if (!gesture) beginGesture();
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      view.zoom = clamp(gesture.zoom * Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance, 1, 10);
      view.x = center.x - gesture.anchor.x * view.fit * view.zoom;
      view.y = center.y - gesture.anchor.y * view.fit * view.zoom;
      constrainView(); render(); return;
    }
    if (suppressUntilUp) return;
    if (panStart) {
      view.x = panStart.x + point.x - panStart.point.x; view.y = panStart.y + point.y - panStart.point.y;
      constrainView(); render(); return;
    }
    if (!active || active.pointer !== event.pointerId) return;
    const image = bounded(imagePoint(point));
    if (active.kind === 'rect') active.points[1] = image;
    else {
      if (!active.painted && Math.hypot(point.x - active.start.x, point.y - active.start.y) < 3) return;
      prepareEffect(active);
      if (!active.painted) { brushAt(active.points[0], active); active.painted = true; }
      const last = active.points[active.points.length - 1];
      if (Math.hypot(image.x - last.x, image.y - last.y) < .5) return;
      paintLine(last, image, active); active.points.push(image);
    }
    render();
  });
  function endPointer(event, canceled = false) {
    if (!pointers.has(event.pointerId)) return;
    if (active?.pointer === event.pointerId) {
      if (canceled) cancelStroke();
      else {
        if (active.kind === 'rect') active.points[1] = bounded(imagePoint(localPoint(event)));
        const valid = active.kind !== 'rect' || (Math.abs(active.points[0].x - active.points[1].x) * view.fit * view.zoom >= 3 && Math.abs(active.points[0].y - active.points[1].y) * view.fit * view.zoom >= 3);
        if (valid) {
          if (!active.painted) applyCommand(active);
          const { kind, mode, strength, radius, points } = active;
          history.push({ kind, mode, strength, radius, points }); future = [];
        }
        active = null;
      }
    }
    pointers.delete(event.pointerId);
    if (pointers.size >= 2) beginGesture();
    else gesture = null;
    if (pointers.size === 0) { suppressUntilUp = false; panStart = null; }
    render(); updateButtons();
  }
  stage.addEventListener('pointerup', event => endPointer(event));
  stage.addEventListener('pointercancel', event => endPointer(event, true));
  stage.addEventListener('lostpointercapture', event => endPointer(event, true));
  stage.addEventListener('wheel', event => {
    if (!loaded || busy || active) return;
    event.preventDefault();
    const point = localPoint(event), anchor = imagePoint(point);
    view.zoom = clamp(view.zoom * Math.exp(-event.deltaY * .002), 1, 10);
    view.x = point.x - anchor.x * view.fit * view.zoom; view.y = point.y - anchor.y * view.fit * view.zoom;
    constrainView(); render();
  }, { passive: false });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelStroke(); pointers.clear(); gesture = null; panStart = null; suppressUntilUp = false; updateButtons(); }
  });

  document.querySelectorAll('[data-effect]').forEach(button => {
    button.onclick = () => {
      mode = button.dataset.effect; setComparison(false);
      document.querySelectorAll('[data-effect]').forEach(item => {
        const selected = item === button; item.classList.toggle('selected', selected); item.setAttribute('aria-pressed', String(selected));
      });
      $('effectCaption').textContent = { pixelate: 'くっきり、しっかり隠す', blur: '写真になじむ、自然なぼかし', mist: '境界をやわらかく、ふんわり', black: '選んだ部分を黒く塗りつぶす' }[mode];
      updateButtons();
    };
  });
  document.querySelectorAll('[data-tool]').forEach(button => {
    button.onclick = () => {
      tool = button.dataset.tool;
      document.querySelectorAll('[data-tool]').forEach(item => {
        const selected = item === button; item.classList.toggle('selected', selected); item.setAttribute('aria-pressed', String(selected));
      });
      $('gestureHint').textContent = { brush: '1本指で加工 · 2本指で拡大・移動', rect: '対角線にドラッグして選択 · 指を離すと適用', pan: '1本指で移動 · 2本指で拡大・縮小' }[tool];
      updateButtons();
    };
  });
  $('brushSize').oninput = () => { $('brushValue').value = $('brushSize').value; };
  $('strengthRange').oninput = () => { $('strengthValue').value = $('strengthRange').value; };
  $('fitBtn').onclick = fitView;
  $('compareBtn').onclick = () => setComparison(!comparing);
  $('undoBtn').onclick = () => { if (!history.length) return; setComparison(false); future.push(history.pop()); rebuild(); };
  $('redoBtn').onclick = () => { if (!future.length) return; setComparison(false); const command = future.pop(); history.push(command); applyCommand(command); render(); updateButtons(); };
  $('resetBtn').onclick = async () => {
    if (!await confirmAction('加工をリセットしますか？', '最初の写真に戻します。リセット後も「戻す」で取り消せます。', 'リセット')) return;
    setComparison(false); const command = { kind: 'reset' }; history.push(command); future = []; applyCommand(command); render(); updateButtons();
  };

  function discardExport() {
    exportGeneration++; exportFile = null;
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    exportUrl = ''; $('exportPreview').removeAttribute('src'); $('downloadLink').removeAttribute('href');
  }
  async function prepareExport() {
    discardExport(); const generation = exportGeneration;
    $('shareBtn').disabled = true; $('downloadLink').hidden = true;
    $('exportInfo').textContent = '画像を準備しています…';
    const type = $('formatSelect').value;
    let source = edited, flattened;
    if (type === 'image/jpeg') {
      flattened = canvas(); flattened.width = edited.width; flattened.height = edited.height;
      const ctx = flattened.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, flattened.width, flattened.height); ctx.drawImage(edited, 0, 0); source = flattened;
    }
    try {
      const blob = await new Promise(resolve => source.toBlob(resolve, type, .95));
      if (generation !== exportGeneration || !$('saveDialog').open) return;
      if (!blob) throw new Error('export');
      const date = new Date();
      const stamp = date.getFullYear() + String(date.getMonth() + 1).padStart(2, '0') + String(date.getDate()).padStart(2, '0');
      const filename = stamp + '_' + imageName + '-mosaic.' + (type === 'image/png' ? 'png' : 'jpg');
      exportFile = new File([blob], filename, { type }); exportUrl = URL.createObjectURL(blob);
      $('exportPreview').src = exportUrl;
      $('downloadLink').href = exportUrl; $('downloadLink').download = filename; $('downloadLink').hidden = false;
      $('exportInfo').textContent = edited.width + ' × ' + edited.height + ' px · ' + (blob.size / 1048576).toFixed(2) + ' MB';
      const canShare = !!(navigator.share && navigator.canShare?.({ files: [exportFile] }));
      $('shareBtn').hidden = !canShare; $('shareBtn').disabled = !canShare;
      $('saveHelp').textContent = canShare ? '共有メニューの「画像を保存」で写真アプリに保存できます。' : '「ファイルとしてダウンロード」で保存できます。iPhoneでは画像の長押しから保存できる場合もあります。';
    } catch { $('exportInfo').textContent = '画像を作成できませんでした。画面を閉じて、もう一度お試しください。'; }
    finally { if (flattened) { flattened.width = 1; flattened.height = 1; } }
  }
  $('saveBtn').onclick = () => { setComparison(false); $('saveDialog').showModal(); prepareExport(); };
  $('formatSelect').onchange = prepareExport;
  $('closeSaveBtn').onclick = () => $('saveDialog').close();
  $('saveDialog').addEventListener('close', discardExport);
  $('shareBtn').onclick = async () => {
    if (!exportFile) return;
    $('shareBtn').disabled = true;
    try {
      // File preparation happens before this tap, retaining iOS transient activation.
      await navigator.share({ files: [exportFile], title: '加工した写真' });
    } catch (error) {
      if (error.name !== 'AbortError') notify('共有画面を開けませんでした。ダウンロードからも保存できます。');
    } finally { $('shareBtn').disabled = false; }
  };
  document.addEventListener('keydown', event => {
    if ($('saveDialog').open || $('confirmDialog').open || /INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;
    if (event.key === 'Escape') { cancelStroke(); pointers.clear(); gesture = null; panStart = null; suppressUntilUp = false; setComparison(false); updateButtons(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); const button = event.shiftKey ? $('redoBtn') : $('undoBtn'); if (!button.disabled) button.click();
    }
  });

  async function refreshOfflineStatus() {
    const controller = navigator.serviceWorker?.controller;
    if (!controller) { $('offlineStatus').textContent = navigator.onLine ? 'オフライン準備中' : 'オフライン'; return; }
    try {
      const answer = await new Promise(resolve => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, 2000);
        channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
        controller.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
      });
      const ready = answer?.version === '20260924-3.0.0';
      $('offlineStatus').classList.toggle('ready', ready);
      $('offlineStatus').textContent = ready ? (navigator.onLine ? 'オフライン準備OK' : 'オフラインで使用中') : '再起動して更新';
    } catch { $('offlineStatus').textContent = 'オフライン準備中'; }
  }
  async function registerWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) {
      $('offlineStatus').textContent = 'オンラインで使用中'; return;
    }
    refreshOfflineStatus();
    navigator.serviceWorker.addEventListener('controllerchange', () => { $('updateNotice').hidden = true; refreshOfflineStatus(); });
    try {
      registration = await navigator.serviceWorker.register('./service-worker.js', { updateViaCache: 'none' });
      const showUpdate = () => { if (registration.waiting) $('updateNotice').hidden = false; };
      showUpdate();
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => { if (worker.state === 'installed') { showUpdate(); refreshOfflineStatus(); } });
      });
      navigator.serviceWorker.ready.then(refreshOfflineStatus);
      refreshOfflineStatus();
      registration.update().catch(() => {});
    } catch {
      if (navigator.serviceWorker.controller) refreshOfflineStatus();
      else $('offlineStatus').textContent = 'オフライン準備未完了';
    }
  }
  $('updateBtn').onclick = async () => {
    if (!registration?.waiting) return;
    if (!await confirmAction('新しいバージョンに更新', 'アプリを再読み込みします。必要な画像は先に保存してください。', '更新する')) return;
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  };
  window.addEventListener('online', refreshOfflineStatus); window.addEventListener('offline', refreshOfflineStatus);
  window.addEventListener('pagehide', () => { if (exportUrl) discardExport(); });
  new ResizeObserver(resize).observe(stage);
  updateButtons(); resize(); registerWorker();
})();
