// No SillyTavern or runtime-bus dependency: these limits belong to this extension.
export const INPUT_IMAGE_BYTES = 10 * 1024 * 1024;
export const OUTPUT_IMAGE_BYTES = 20 * 1024 * 1024;
export const IMAGE_REPLY_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;

/** Consume our own response with an enforced limit, including chunked replies. */
export async function boundedBlob(response, maxBytes, label = 'Image', signal) {
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`${label} exceeds the ${Math.round(maxBytes / 1048576)} MiB download limit.`);
    }
    if (!response.body) return new Blob([], { type: response.headers.get('content-type') || '' });
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
        while (true) {
            signal?.throwIfAborted();
            const { done, value } = await reader.read();
            signal?.throwIfAborted();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > maxBytes) {
                void reader.cancel().catch(() => {});
                throw new Error(`${label} exceeds the ${Math.round(maxBytes / 1048576)} MiB download limit.`);
            }
            chunks.push(value);
        }
        return new Blob(chunks, { type: response.headers.get('content-type') || '' });
    } catch (error) {
        void reader.cancel(error).catch(() => {});
        throw error;
    } finally {
        chunks.length = 0;
        signal?.removeEventListener('abort', abort);
        reader.releaseLock();
    }
}

export async function boundedJson(response, maxBytes = IMAGE_REPLY_BYTES, signal) {
    return JSON.parse(await (await boundedBlob(response, maxBytes, 'Image response', signal)).text());
}

export async function fetchImageBlob(url, maxBytes = INPUT_IMAGE_BYTES, label = 'Image') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${label} download timed out.`)), 30000);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`${label}: download failed (${response.status}).`);
        return await boundedBlob(response, maxBytes, label, controller.signal);
    } finally { clearTimeout(timer); }
}

const ascii = (bytes, offset, count) => String.fromCharCode(...bytes.subarray(offset, offset + count));
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u24 = (bytes, offset) => bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;

function exifOrientation(bytes) {
    try {
        if (ascii(bytes, 0, 6) !== 'Exif\0\0') return null;
        const tiff = view(bytes.subarray(6));
        const little = tiff.getUint16(0) === 0x4949;
        if (!little && tiff.getUint16(0) !== 0x4d4d || tiff.getUint16(2, little) !== 42) return null;
        const offset = tiff.getUint32(4, little), count = tiff.getUint16(offset, little);
        for (let i = 0; i < count && i < 1024; i++) {
            const pos = offset + 2 + i * 12;
            if (tiff.getUint16(pos, little) === 0x112 && tiff.getUint16(pos + 2, little) === 3
                && tiff.getUint32(pos + 4, little) === 1) return tiff.getUint16(pos + 8, little);
        }
    } catch { /* Malformed optional metadata cannot authorize a larger image. */ }
    return null;
}

/** Read PNG/JPEG/WebP dimensions from headers, without decoding a raster. */
export async function imageDimensions(blob) {
    const read = async (start, size) => new Uint8Array(await blob.slice(start, start + size).arrayBuffer());
    const first = await read(0, 32);
    if (first.length >= 24 && ascii(first, 0, 8) === '\x89PNG\r\n\x1a\n' && ascii(first, 12, 4) === 'IHDR') {
        return { width: view(first).getUint32(16), height: view(first).getUint32(20) };
    }
    if (first[0] === 0xff && first[1] === 0xd8) {
        let offset = 2, orientation = 1, dimensions;
        for (let markers = 0; offset + 4 <= blob.size && markers < 2048; markers++) {
            const header = await read(offset, 12);
            if (header[0] !== 0xff) break;
            if (header[1] === 0xff) { offset++; continue; }
            const marker = header[1];
            if (marker === 0xda || marker === 0xd9) break;
            if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) { offset += 2; continue; }
            const length = view(header).getUint16(2);
            if (length < 2 || offset + 2 + length > blob.size) throw new Error('Truncated JPEG header.');
            if (marker === 0xe1) orientation = exifOrientation(await read(offset + 4, length - 2)) ?? orientation;
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
                if (length < 8 || header.length < 9) throw new Error('Truncated JPEG dimensions.');
                dimensions = { width: view(header).getUint16(7), height: view(header).getUint16(5) };
            }
            offset += 2 + length;
        }
        if (dimensions) return orientation >= 5 && orientation <= 8
            ? { width: dimensions.height, height: dimensions.width } : dimensions;
    }
    if (ascii(first, 0, 4) === 'RIFF' && ascii(first, 8, 4) === 'WEBP') {
        let offset = 12;
        for (let chunks = 0; offset + 8 <= blob.size && chunks < 2048; chunks++) {
            const header = await read(offset, 18), tag = ascii(header, 0, 4);
            const size = view(header).getUint32(4, true);
            if (offset + 8 + size > blob.size) throw new Error('Truncated WebP header.');
            if (tag === 'VP8X' && size >= 10) return { width: 1 + u24(header, 12), height: 1 + u24(header, 15) };
            if (tag === 'VP8 ' && size >= 10 && header[11] === 0x9d && header[12] === 0x01 && header[13] === 0x2a) {
                return { width: view(header).getUint16(14, true) & 0x3fff, height: view(header).getUint16(16, true) & 0x3fff };
            }
            if (tag === 'VP8L' && size >= 5 && header[8] === 0x2f) {
                const bits = view(header).getUint32(9, true);
                return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
            }
            offset += 8 + size + (size % 2);
        }
    }
    throw new Error('Could not read PNG, JPEG, or WebP image dimensions.');
}

export function validateDimensions({ width, height }) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
        || width > 16384 || height > 16384 || width * height > MAX_IMAGE_PIXELS) {
        throw new Error('Image dimensions exceed the 40 megapixel / 16384 px limit. Resize the source image first.');
    }
}

export function dataUrlBlob(dataUrl, maxBytes = INPUT_IMAGE_BYTES) {
    const comma = dataUrl.indexOf(',');
    const header = comma >= 0 ? dataUrl.slice(0, comma) : '';
    if (!/^data:image\/(png|jpe?g|webp);base64$/i.test(header)) throw new Error('Unsupported image data URL.');
    const content = dataUrl.slice(comma + 1);
    const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
    // Providers may omit the final padding; atob accepts two- or three-character
    // final groups. Keep the original string and decode the final chunk directly.
    if (content.length % 4 === 1) throw new Error('Invalid image base64 data.');
    if (!content.length || Math.floor(content.length * 3 / 4) - padding > maxBytes) throw new Error('Image data exceeds its byte limit.');
    const parts = [];
    for (let i = 0; i < content.length; i += 32768) {
        const decoded = atob(content.slice(i, i + 32768));
        parts.push(Uint8Array.from(decoded, char => char.charCodeAt(0)));
    }
    return new Blob(parts, { type: header.slice(5, header.indexOf(';')).replace('image/jpg', 'image/jpeg') });
}

/** Resizing is opt-in. Object URLs, decoded pixels, and canvas buffers are released. */
export async function prepareImageBlob(blob, maxDimension = 0) {
    const dimensions = await imageDimensions(blob);
    validateDimensions(dimensions);
    if (!maxDimension || Math.max(dimensions.width, dimensions.height) <= maxDimension) return { blob, ...dimensions };
    const url = URL.createObjectURL(blob), img = new Image();
    const canvas = document.createElement('canvas');
    const scale = Math.min(maxDimension / dimensions.width, maxDimension / dimensions.height);
    const width = Math.max(1, Math.round(dimensions.width * scale)), height = Math.max(1, Math.round(dimensions.height * scale));
    let timer;
    try {
        await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Image decoding timed out.')), 30000);
            img.onload = resolve; img.onerror = () => reject(new Error('Could not decode source image.')); img.src = url;
        });
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Image resizing is unavailable.');
        context.drawImage(img, 0, 0, width, height);
        const resized = await new Promise((resolve, reject) => canvas.toBlob(result => result
            ? resolve(result) : reject(new Error('Could not resize source image.')), blob.type || 'image/png', 0.92));
        return { blob: resized, width, height };
    } finally {
        clearTimeout(timer); img.onload = null; img.onerror = null; img.src = '';
        URL.revokeObjectURL(url); canvas.width = 0; canvas.height = 0;
    }
}
