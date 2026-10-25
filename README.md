# Image Generation Clone

A SillyTavern extension for generating images and editing or reimagining an existing image with an optional reference image. It supports the host's `/sd` workflow and OpenRouter image generation/editing.

## Memory improvements in 1.2.0

Image dimensions are read from PNG, JPEG, or WebP headers before a browser image is decoded. JPEG orientation is considered when choosing an aspect ratio. The ordinary upload path keeps the source image at its original quality and avoids creating a canvas solely to measure it.

The edit dialog has an optional **Resize large input images to 2048 px** checkbox. It starts unchecked. When selected, an input whose longer side exceeds 2048 pixels is resized before upload. The base image and reference image are processed in sequence; temporary object URLs, image handlers, and canvas buffers are released after use.

Limits are enforced while downloading, even when a server omits `Content-Length`:

| Resource | Limit |
| --- | --- |
| Each input image | 10 MiB |
| Each generated image | 20 MiB |
| JSON image response | 32 MiB |
| Error response inspected | 64 KiB |
| Image dimensions before decoding | 40 million pixels; at most 16,384 pixels on either side |

An image beyond the dimension limit must be resized externally before use. Remote image downloads time out after 30 seconds. Large or malformed responses fail with an error instead of retaining an unbounded download. Only one image generation, edit, or regeneration operation runs at a time, preventing overlapping copies of large requests.

The extension remains standalone and does not require Runtime Signal Bus. The host's standard `/sd` generation behavior is preserved. These bounds apply to this extension's input handling and OpenRouter response handling; SillyTavern still owns the saved chat images and their display.

## Development

The extension loads `index.js` and `image-memory.js` directly; no build is required. Host imports are supplied by SillyTavern.

Run the focused memory and image-header regression tests with:

```sh
node tests/image-memory.test.mjs
```

Tests cover byte limits with and without declared lengths, cancellation, PNG/JPEG/WebP dimension parsing, base64 validation, and resizing cleanup. Provider calls and live browser decoding require testing inside SillyTavern.
