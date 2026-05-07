// Pick the visually-busiest 3x3 cell of an image so the Ken Burns zoom
// origins on something interesting. Uses the global `Sobel` from sobel.js
// (loaded via a non-module <script> tag in index.html).
//
// We downscale aggressively before running Sobel: at 1920x1080 the full-res
// path stalled the main thread long enough on a Pi 3 to freeze the clock
// for several seconds per image switch. A 200px-wide thumbnail gives an
// indistinguishable 3x3 hotspot at ~1% of the pixel work.

const ANALYSIS_MAX_DIM = 200;

export async function findSobelFocus(img, grid = 3) {
    const canvas = document.getElementById('analysisCanvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const srcW = img.naturalWidth;
    const srcH = img.naturalHeight;
    const scale = Math.min(1, ANALYSIS_MAX_DIM / Math.max(srcW, srcH));
    const width = Math.max(grid, Math.round(srcW * scale));
    const height = Math.max(grid, Math.round(srcH * scale));
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(img, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);

    const sobelImageData = window.Sobel(imageData).toImageData();
    const mag = sobelImageData.data;

    const cellWidth = Math.floor(width / grid);
    const cellHeight = Math.floor(height / grid);

    let bestGx = 0;
    let bestGy = 0;
    let maxSum = -Infinity;
    for (let gy = 0; gy < grid; gy++) {
        const y0 = gy * cellHeight;
        const y1 = y0 + cellHeight;
        for (let gx = 0; gx < grid; gx++) {
            const x0 = gx * cellWidth;
            const x1 = x0 + cellWidth;
            let sum = 0;
            for (let y = y0; y < y1; y++) {
                const row = y * width;
                for (let x = x0; x < x1; x++) {
                    sum += mag[(row + x) * 4];
                }
            }
            if (sum > maxSum) {
                maxSum = sum;
                bestGx = gx;
                bestGy = gy;
            }
        }
    }
    return {
        focusX: (bestGx + 0.5) / grid,
        focusY: (bestGy + 0.5) / grid,
    };
}
