// Phone photos run 5–12 MB; job sites run on bad signal. Downscale to a
// still-sharp size before uploading — falls back to the original file if the
// browser can't decode it (odd formats) or shrinking wouldn't help.
// 1400px @ 0.72 keeps before/after evidence perfectly readable (and prints fine
// in the invoice packages) at roughly half the bytes of the old 1600 @ 0.82.
// `always` redraws the picture even when that wouldn't save a byte: the browser
// bakes the phone's EXIF orientation into the pixels and turns HEIC, WEBP or
// GIF into a JPEG where it can read them. That is what a PDF needs, since
// pdf-lib takes only JPEG and PNG and ignores the orientation tag.
export async function shrinkImage(file: File, maxDim = 1400, quality = 0.72, always = false): Promise<File> {
  if (!always && (!/^image\//i.test(file.type) || /gif/i.test(file.type))) return file;
  try {
    // (the browser applies the EXIF orientation while decoding, so the pixels drawn below are already upright)
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    if (!always && scale >= 1 && file.size < 500_000) { bmp.close(); return file; }
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
    if (!blob || (!always && blob.size >= file.size)) return file;
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}
