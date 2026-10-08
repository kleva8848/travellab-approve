// Зменшуємо фото на телефоні перед відправкою: довша сторона ≤ 2048, JPEG 0.88.
// Заодно знімаємо HEIC/PNG-проблеми — на сервер завжди йде JPEG
const MAX_SIDE = 2048

export type PreparedPhoto = { blob: Blob; width: number; height: number; preview: string }

export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null)
  const src = bitmap ?? (await loadImage(file))
  const w0 = 'naturalWidth' in src ? src.naturalWidth : src.width
  const h0 = 'naturalHeight' in src ? src.naturalHeight : src.height
  const k = Math.min(1, MAX_SIDE / Math.max(w0, h0))
  const width = Math.round(w0 * k)
  const height = Math.round(h0 * k)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')!.drawImage(src, 0, 0, width, height)
  bitmap?.close()
  const blob = await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('Не вдалося підготувати фото'))), 'image/jpeg', 0.88))
  return { blob, width, height, preview: URL.createObjectURL(blob) }
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const img = new Image()
    img.onload = () => ok(img)
    img.onerror = () => fail(new Error('Цей формат фото не відкривається — спробуй інше фото'))
    img.src = URL.createObjectURL(file)
  })
}

// Пряме завантаження в Supabase Storage за підписаним посиланням (як uploadToSignedUrl у supabase-js)
export async function putToSignedUrl(signedUrl: string, blob: Blob) {
  const form = new FormData()
  form.append('cacheControl', '3600')
  form.append('', blob, 'photo.jpg')
  const r = await fetch(signedUrl, { method: 'PUT', body: form, headers: { 'x-upsert': 'false' } })
  if (!r.ok) throw new Error('Фото не завантажилось — перевір інтернет і спробуй ще раз')
}
