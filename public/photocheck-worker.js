'use strict';
// Проверка фото на карточку — в фоновом потоке (владелец 14.10: «загружаю фото — всё повисло»).
// Раньше нейросети работали в одном потоке с игрой: загрузка проверки ~20 с и поиск лица ~8 с полностью останавливали экран.
// Два отдельных потока: ?kind=face — «на фото есть лицо» (face-api), ?kind=nsfw — «нет обнажёнки» (nsfwjs).
const KIND = new URLSearchParams(self.location.search).get('kind');
// Считаем на процессоре, а не на видеокарте: видеокарта нужна игре — иначе экран всё равно замирал (замер 14.10: 11 с).
// Нейросети выбирают видеокарту, если видят OffscreenCanvas, поэтому прячем его от них, а сами рисуем через OC.
const OC = self.OffscreenCanvas;
try { self.OffscreenCanvas = undefined; } catch (e) {}
let ready = null;

function load() {
  if (ready) return ready;
  ready = (async () => {
    if (KIND === 'face') {
      importScripts('vendor/face/face-api.js');
      // face-api ждёт браузерную страницу — подсказываем, чем рисовать в фоновом потоке
      faceapi.env.setEnv({ // в фоновом потоке face-api не узнаёт окружение сам — описываем его целиком
        Canvas: OC, CanvasRenderingContext2D: self.OffscreenCanvasRenderingContext2D, Image: class {}, ImageData: ImageData, Video: class {},
        createCanvasElement: () => new OC(1, 1), createImageElement: () => ({}), fetch: (...a) => fetch(...a), readFile: () => Promise.reject(new Error('no fs')),
      });
      try { await faceapi.tf.setBackend('cpu'); } catch (e) {}
      await faceapi.nets.tinyFaceDetector.loadFromUri('vendor/face');
      return null;
    }
    importScripts('vendor/nsfw/model.min.js', 'vendor/nsfw/group1-shard1of1.min.js', 'vendor/nsfw/nsfwjs.min.js');
    return nsfwjs.load('MobileNetV2');
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

// Те же правила, что были в игре: мягкий поиск лица (3 размера, обычное и зеркальное фото, низкий порог)
async function hasFace(bmp) {
  await load();
  const k = Math.min(1, 640 / Math.max(bmp.width, bmp.height)), w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const c = new OC(w, h), g = c.getContext('2d');
  for (const flip of [false, true]) {
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, w, h); if (flip) { g.translate(w, 0); g.scale(-1, 1); }
    g.drawImage(bmp, 0, 0, w, h);
    const t = faceapi.tf.browser.fromPixels(g.getImageData(0, 0, w, h));
    try {
      for (const size of [320, 512, 224]) {
        const r = await faceapi.detectAllFaces(t, new faceapi.TinyFaceDetectorOptions({ inputSize: size, scoreThreshold: 0.15 }));
        if (r.length) return true;
      }
    } finally { t.dispose(); }
  }
  return false;
}
const NSFW_REJECT = { Porn: 0.5, Hentai: 0.5 };
async function isClean(bmp) {
  const model = await load();
  const c = new OC(224, 224), g = c.getContext('2d'); g.drawImage(bmp, 0, 0, 224, 224);
  const p = {}; for (const { className, probability } of await model.classify(g.getImageData(0, 0, 224, 224))) p[className] = probability;
  return !Object.keys(NSFW_REJECT).some(k => (p[k] || 0) >= NSFW_REJECT[k]);
}

self.onmessage = async e => {
  const { id, bmp, warm } = e.data || {};
  if (warm) { load().catch(() => {}); return; } // заранее, пока человек выбирает снимок
  try {
    const ok = KIND === 'face' ? await hasFace(bmp) : await isClean(bmp);
    self.postMessage({ id, ok });
  } catch (err) {
    self.postMessage({ id, err: String((err && err.message) || err) });
  } finally { try { bmp && bmp.close && bmp.close(); } catch (e2) {} }
};
