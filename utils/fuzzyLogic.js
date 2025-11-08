// FUZZY LOGIC MAMDANI (versi mendekati MATLAB)

// Fungsi trimf (triangular membership function)
function trimf(x, [a, b, c]) {
  if (x <= a || x >= c) return 0;
  if (x <= b) return (x - a) / (b - a);
  return (c - x) / (c - b);
}

// Fungsi trapmf (trapezoidal membership function)
function trapmf(x, [a, b, c, d]) {
  if (a === b && x <= b) return 1; // handle plateau kiri
  if (c === d && x >= c) return 1; // handle plateau kanan
  if (x <= a) return 0;
  if (x >= d) return 0;
  if (x >= b && x <= c) return 1;
  if (x > a && x < b) return (x - a) / (b - a || 1e-6);
  if (x > c && x < d) return (d - x) / (d - c || 1e-6);
  return 0;
}

// Membership Durasi
function durasiSingkat(x) {
  return trapmf(x, [0, 0, 2, 4]);
}
function durasiSedang(x) {
  return trimf(x, [3, 6, 10]);
}
function durasiPanjang(x) {
  return trimf(x, [8, 12, 16]);
}
function durasiSangatPanjang(x) {
  return trapmf(x, [15, 18, 24, 24]);
}

// Membership Daya
function dayaSangatRendah(x) {
  return trapmf(x, [0, 0, 30, 50]);
}
function dayaRendah(x) {
  return trapmf(x, [30, 50, 120, 150]);
}
function dayaSedang(x) {
  return trapmf(x, [120, 150, 300, 350]);
}
function dayaTinggi(x) {
  return trapmf(x, [300, 350, 550, 600]);
}
function dayaSangatTinggi(x) {
  return trapmf(x, [550, 600, 900, 900]);
}

// Membership Output Skor (0–1)
function skorRendah(x) {
  return trapmf(x, [0, 0, 0.2, 0.4]);
}
function skorSedang(x) {
  return trimf(x, [0.3, 0.55, 0.75]);
}
function skorTinggi(x) {
  return trapmf(x, [0.65, 0.85, 1, 1]);
}

// Fuzzy Inference (Mamdani)
function fuzzyPrioritas(durasiInput, dayaInput) {
  const durasiVal = {
    singkat: durasiSingkat(durasiInput),
    sedang: durasiSedang(durasiInput),
    panjang: durasiPanjang(durasiInput),
    sangatPanjang: durasiSangatPanjang(durasiInput),
  };

  const dayaVal = {
    sangatRendah: dayaSangatRendah(dayaInput),
    rendah: dayaRendah(dayaInput),
    sedang: dayaSedang(dayaInput),
    tinggi: dayaTinggi(dayaInput),
    sangatTinggi: dayaSangatTinggi(dayaInput),
  };

  // Aturan Fuzzy (contoh rule base)
  const rules = [
    { out: "rendah", c: Math.min(durasiVal.singkat, dayaVal.sangatRendah) },
    { out: "rendah", c: Math.min(durasiVal.singkat, dayaVal.rendah) },
    { out: "sedang", c: Math.min(durasiVal.singkat, dayaVal.sedang) },
    { out: "tinggi", c: Math.min(durasiVal.singkat, dayaVal.tinggi) },

    { out: "rendah", c: Math.min(durasiVal.sedang, dayaVal.sangatRendah) },
    { out: "sedang", c: Math.min(durasiVal.sedang, dayaVal.rendah) },
    { out: "sedang", c: Math.min(durasiVal.sedang, dayaVal.sedang) },
    { out: "tinggi", c: Math.min(durasiVal.sedang, dayaVal.tinggi) },
    { out: "tinggi", c: Math.min(durasiVal.sedang, dayaVal.sangatTinggi) },

    { out: "sedang", c: Math.min(durasiVal.panjang, dayaVal.rendah) },
    { out: "sedang", c: Math.min(durasiVal.panjang, dayaVal.sedang) },
    { out: "tinggi", c: Math.min(durasiVal.panjang, dayaVal.tinggi) },
    { out: "tinggi", c: Math.min(durasiVal.panjang, dayaVal.sangatTinggi) },

    { out: "sedang", c: Math.min(durasiVal.sangatPanjang, dayaVal.rendah) },
    { out: "tinggi", c: Math.min(durasiVal.sangatPanjang, dayaVal.sedang) },
    { out: "tinggi", c: Math.min(durasiVal.sangatPanjang, dayaVal.tinggi) },
    {
      out: "tinggi",
      c: Math.min(durasiVal.sangatPanjang, dayaVal.sangatTinggi),
    },
  ];

  // Agregasi rule output
  let mu = { rendah: 0, sedang: 0, tinggi: 0 };
  for (const r of rules) {
    mu[r.out] = Math.max(mu[r.out], r.c);
  }

  // Defuzzifikasi (centroid)
  const steps = 1000;
  let num = 0,
    den = 0;
  for (let i = 0; i <= steps; i++) {
    const x = i / steps;
    const low = Math.min(mu.rendah, skorRendah(x));
    const mid = Math.min(mu.sedang, skorSedang(x));
    const high = Math.min(mu.tinggi, skorTinggi(x));
    const y = Math.max(low, mid, high);
    num += x * y;
    den += y;
  }

  const skorPrioritas = den === 0 ? 0 : num / den;
  const kategori =
    skorPrioritas <= 0.4
      ? "Rendah"
      : skorPrioritas <= 0.7
      ? "Sedang"
      : "Tinggi";

  return { skorPrioritas, kategori, detail: { durasiVal, dayaVal, mu } };
}

module.exports = { fuzzyPrioritas };
