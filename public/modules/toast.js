// Tiny transient banner in the top-right corner. Used everywhere; no deps
// other than the #toast-container element in index.html.
//
// `options.image` puts a small rounded preview left of the text (save /
// block confirmations). A preview that fails to load is dropped rather than
// left as a broken-image box.

export function showToast(message, options = {}) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    if (options.image) {
        const img = document.createElement('img');
        img.className = 'toast-thumb';
        img.alt = '';
        img.decoding = 'async';
        img.addEventListener('error', () => img.remove());
        img.src = options.image;
        toast.appendChild(img);
        toast.classList.add('has-thumb');
    }
    const text = document.createElement('span');
    text.className = 'toast-text';
    text.innerText = message;
    toast.appendChild(text);
    container.appendChild(toast);
    const duration = Number(options.duration) > 0 ? Number(options.duration) : (options.image ? 4000 : 3000);
    setTimeout(() => toast.classList.add('show'), 100);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}
