// Shared helpers for chat/refine attachment previews used across meal, session, and AI chat tabs.

export function attachFilesTo(arr, input, renderFn) {
  const files = Array.from(input.files);
  input.value = '';
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = e => { arr.push({ dataUrl: e.target.result, mimeType: file.type }); renderFn(); };
    reader.readAsDataURL(file);
  });
}

export function renderAttachPreview(wrapId, arr, removeFn) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  if (arr.length === 0) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
  wrap.style.display = 'flex';
  wrap.innerHTML = arr.map((img, i) =>
    `<div style="position:relative; display:inline-block;">
      <img src="${img.dataUrl}" style="height:60px; width:60px; object-fit:cover; border-radius:8px; border:1px solid var(--line);">
      <button onclick="${removeFn}(${i})" style="position:absolute;top:-6px;right:-6px;background:var(--danger);color:#fff;border:none;border-radius:50%;width:18px;height:18px;font-size:11px;padding:0;cursor:pointer;line-height:18px;">✕</button>
    </div>`
  ).join('');
}
