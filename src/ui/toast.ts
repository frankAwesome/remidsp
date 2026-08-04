let timer = 0;
export function toast(html: string, ms = 2600) {
  const el = document.getElementById('toast')!;
  el.innerHTML = html;
  el.classList.add('on');
  clearTimeout(timer);
  timer = window.setTimeout(() => el.classList.remove('on'), ms);
}
