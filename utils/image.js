const ALLOWED_IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.avif', '.bmp', '.tiff', '.heic', '.heif', '.svg',
]);

function checkImageMagicBytes(buffer, ext) {
  if (ext === '.svg') return true; // text format — no binary magic bytes
  if (buffer.length < 4) return false;
  const b = buffer;
  switch (ext) {
    case '.jpg': case '.jpeg':
      return b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
    case '.png':
      return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
    case '.gif':
      return b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38;
    case '.webp':
      return b.length >= 12 &&
        b.toString('ascii', 0, 4) === 'RIFF' &&
        b.toString('ascii', 8, 12) === 'WEBP';
    case '.bmp':
      return b[0] === 0x42 && b[1] === 0x4D;
    case '.tiff':
      return (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A && b[3] === 0x00) ||
             (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0x00 && b[3] === 0x2A);
    case '.avif': case '.heic': case '.heif':
      return b.length >= 8 && b.toString('ascii', 4, 8) === 'ftyp';
    default:
      return false;
  }
}

module.exports = { ALLOWED_IMAGE_EXTS, checkImageMagicBytes };
