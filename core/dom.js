export function autoResizeTA(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

export function toast(msg, opts = {}) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  if (toast._timer) { clearTimeout(toast._timer); toast._timer = null; }
  if (!opts.persistent) {
    toast._timer = setTimeout(() => el.classList.remove('show'), opts.duration || 2400);
  }
}

export function hideToast() {
  if (toast._timer) { clearTimeout(toast._timer); toast._timer = null; }
  document.getElementById('toast').classList.remove('show');
}
