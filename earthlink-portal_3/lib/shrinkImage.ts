// Phone photos run 5–12 MB; job sites run on bad signal. Downscale to a
// still-sharp size before uploading — falls back to the original file if the
// browser can't decode it (odd formats) or shrinking wouldn't help.
// 1400px @ 0.72 keeps before/after evidence perfectly readable (and prints fine
// in the invoice packages) at roughly half the bytes of the old 1600 @ 0.82.
export async function shrinkImage(file: File, maxDim = 1400, quality = 0.72): Promise<File> {
  if (!/^image\//i.test(file.type) || /gif/i.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    if (scale >= 1 && file.size < 500_000) return file;
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}
