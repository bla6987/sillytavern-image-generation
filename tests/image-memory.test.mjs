import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedBlob, boundedJson, imageDimensions, validateDimensions, dataUrlBlob, prepareImageBlob } from '../image-memory.js';

function png(width, height) {
    const data = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
    data.writeUInt32BE(13, 8); data.write('IHDR', 12);
    data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20);
    return data;
}
function webp(tag, payload) {
    const data = Buffer.alloc(20 + payload.length + payload.length % 2);
    data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WEBP', 8);
    data.write(tag, 12); data.writeUInt32LE(payload.length, 16); payload.copy(data, 20);
    return data;
}
test('reads PNG dimensions without allocating an image or canvas; unresized blobs are reused', async () => {
    const blob = new Blob([png(4096, 2048)], { type: 'image/png' });
    assert.deepEqual(await imageDimensions(blob), { width: 4096, height: 2048 });
    assert.equal((await prepareImageBlob(blob)).blob, blob);
    assert.throws(() => validateDimensions({ width: 16384, height: 16384 }), /40 megapixel/);
    await assert.rejects(prepareImageBlob(new Blob([png(100000, 100000)])), /40 megapixel/);
});
test('reads lossy, lossless and extended WebP headers', async () => {
    const extended = Buffer.alloc(10); extended.writeUIntLE(1599, 4, 3); extended.writeUIntLE(899, 7, 3);
    const lossy = Buffer.from([0, 0, 0, 0x9d, 1, 0x2a, 0x40, 6, 0x84, 3]);
    const lossless = Buffer.alloc(5); lossless[0] = 0x2f; lossless.writeUInt32LE(1599 | 899 << 14, 1);
    for (const [tag, payload] of [['VP8X', extended], ['VP8 ', lossy], ['VP8L', lossless]]) {
        assert.deepEqual(await imageDimensions(new Blob([webp(tag, payload)])), { width: 1600, height: 900 });
    }
});
test('JPEG dimensions honor EXIF rotation and reject truncated segments', async () => {
    const exif = Buffer.alloc(32);
    exif.set([0xff, 0xe1, 0, 30]); exif.write('Exif\0\0', 4); exif.write('II', 10);
    exif.writeUInt16LE(42, 12); exif.writeUInt32LE(8, 14); exif.writeUInt16LE(1, 18);
    exif.writeUInt16LE(0x112, 20); exif.writeUInt16LE(3, 22); exif.writeUInt32LE(1, 24); exif.writeUInt16LE(6, 28);
    const sof = Buffer.from([0xff, 0xc2, 0, 11, 8, 3, 0x84, 6, 0x40, 1, 1, 0x11, 0]);
    const blob = new Blob([Buffer.from([0xff, 0xd8]), exif, sof, Buffer.from([0xff, 0xda, 0, 2])]);
    assert.deepEqual(await imageDimensions(blob), { width: 900, height: 1600 });
    await assert.rejects(imageDimensions(new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff])])), /Truncated/);
});
test('chunked downloads stop at the byte limit and cancel their own stream', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(8)); },
        cancel() { cancelled = true; },
    }));
    await assert.rejects(boundedBlob(response, 10), /download limit/);
    assert.equal(cancelled, true);
});
test('oversized declared downloads are rejected without reading the body', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': '99999' } });
    await assert.rejects(boundedBlob(response, 10), /download limit/);
    assert.equal(cancelled, true);
});
test('aborting an inspection cancels a stalled response and releases its reader', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const controller = new AbortController();
    const pending = boundedBlob(response, 100, 'Image', controller.signal);
    controller.abort();
    await assert.rejects(pending, /abort/i);
    assert.equal(cancelled, true); assert.equal(response.body.locked, false);
});
test('finite JSON responses and base64 data URLs obey limits', async () => {
    assert.deepEqual(await boundedJson(new Response('{"ok":true}'), 100), { ok: true });
    const data = png(10, 20), url = `data:image/png;base64,${data.toString('base64')}`;
    assert.deepEqual(await imageDimensions(dataUrlBlob(url, 100)), { width: 10, height: 20 });
    assert.throws(() => dataUrlBlob(url, 10), /byte limit/);
    assert.throws(() => dataUrlBlob('data:image/png;base64,?==='), /Invalid character/);
});
test('unpadded base64 accepts both final group sizes while enforcing decoded byte limits', async () => {
    for (const size of [34, 35, 24577, 24578]) {
        const source = Buffer.concat([png(10, 20), Buffer.alloc(size - 33, 123)]);
        const padded = source.toString('base64');
        const unpadded = padded.replace(/=+$/, '');
        const url = `data:image/png;base64,${unpadded}`;
        const blob = dataUrlBlob(url, size);
        assert.deepEqual(Buffer.from(await blob.arrayBuffer()), source);
        assert.deepEqual(await imageDimensions(blob), { width: 10, height: 20 });
        assert.throws(() => dataUrlBlob(url, size - 1), /byte limit/);
        assert.equal(dataUrlBlob(`data:image/png;base64,${padded}`, size).size, size);
    }
    assert.throws(() => dataUrlBlob('data:image/png;base64,A'), /Invalid.*base64/);
    assert.throws(() => dataUrlBlob('data:image/png;base64,A?'), /Invalid character/);
});
test('opt-in resizing frees object URLs, image handlers, and canvas buffers', async () => {
    const original = { Image: globalThis.Image, document: globalThis.document,
        create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    let revoked, image, drawn = false;
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: () => { drawn = true; } }),
        toBlob: callback => callback(new Blob([png(2048, 1024)], { type: 'image/png' })) };
    globalThis.Image = class {
        constructor() { image = this; }
        set src(value) { this.source = value; if (value) queueMicrotask(() => this.onload?.()); }
    };
    globalThis.document = { createElement: () => canvas };
    URL.createObjectURL = () => 'blob:test'; URL.revokeObjectURL = value => { revoked = value; };
    try {
        const result = await prepareImageBlob(new Blob([png(4096, 2048)], { type: 'image/png' }), 2048);
        assert.deepEqual({ width: result.width, height: result.height }, { width: 2048, height: 1024 });
        assert.equal(drawn, true); assert.equal(revoked, 'blob:test');
        assert.equal(canvas.width, 0); assert.equal(canvas.height, 0); assert.equal(image.source, '');
        assert.equal(image.onload, null); assert.equal(image.onerror, null);
    } finally {
        globalThis.Image = original.Image; globalThis.document = original.document;
        URL.createObjectURL = original.create; URL.revokeObjectURL = original.revoke;
    }
});
