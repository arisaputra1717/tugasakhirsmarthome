// services/DashboardService.js
const {
  Perangkat,
  KapasitasDaya,
  LimitEnergi,
  Penjadwalan,
} = require("../models");
const moment = require("moment");
const { Op } = require("sequelize");

/**
 * Ambil kapasitas daya terbaru
 */
async function getKapasitasDaya() {
  const kapasitas = await KapasitasDaya.findOne({
    order: [["created_at", "DESC"]],
  });
  return kapasitas ? parseFloat(kapasitas.kapasitas_daya) : 1300; // default 1300VA
}

/**
 * Ambil limit energi hari ini
 */
async function getLimitHariIni() {
  const today = moment().format("YYYY-MM-DD");
  const limit = await LimitEnergi.findOne({
    where: {
      tanggal_mulai: { [Op.lte]: today },
      tanggal_selesai: { [Op.gte]: today },
    },
    order: [["tanggal_mulai", "DESC"]],
  });

  return limit ? parseFloat(limit.batas_kwh) * 1000 : null; // kWh ke Wh
}

/**
 * Hitung total beban perangkat yang sedang ON
 */
async function hitungBebanPerangkatAktif() {
  const perangkatOn = await Perangkat.findAll({
    where: { status: "ON" },
    include: [
      {
        model: Penjadwalan,
        where: { aktif: true },
        required: false, // biar tetap ambil perangkat tanpa penjadwalan aktif
      },
    ],
  });

  let totalBeban = 0;
  const perangkatAktif = [];

  for (const p of perangkatOn) {
    totalBeban += parseFloat(p.daya_watt || 0);
    perangkatAktif.push({
      id: p.id,
      nama: p.nama_perangkat,
      daya: parseFloat(p.daya_watt || 0),
      tipe: p.tipe,
      skor_prioritas: parseFloat(p.skor_prioritas || 0),
      penjadwalanAktif: p.Penjadwalans.length > 0, // true jika ada penjadwalan aktif
    });
  }

  return { totalBeban, perangkatAktif };
}

/**
 * Buat rekomendasi: pause perangkat prioritas rendah (Interrupt)
 */
function rekomendasiWaktu(
  dayaPerangkat,
  perangkatAktif,
  bebanPuncak,
  totalBeban
) {
  const sisaDaya = bebanPuncak - totalBeban;

  const rekomendasi = {
    bisaLangsung: false,
    sisaDaya,
    perangkatPause: [],
    durasiPilihan: [15, 30, 45, 60],
    error: null,
  };

  if (sisaDaya >= dayaPerangkat) {
    rekomendasi.bisaLangsung = true;
    return rekomendasi;
  }

  // 🔹 Hanya Interrupt, status ON, dan penjadwalanAktif false
  const interruptAktif = perangkatAktif
    .filter((p) => p.tipe === "Interrupt" && !p.penjadwalanAktif)
    .sort((a, b) => a.skor_prioritas - b.skor_prioritas);

  let dayaTambahan = 0;
  const pauseList = [];

  for (const p of interruptAktif) {
    pauseList.push(p);
    dayaTambahan += p.daya;
    if (sisaDaya + dayaTambahan >= dayaPerangkat) break;
  }

  if (sisaDaya + dayaTambahan < dayaPerangkat) {
    rekomendasi.error =
      "Tidak bisa menyalakan perangkat baru: daya tidak mencukupi meskipun semua Interrupt tanpa penjadwalan dipause.";
    return rekomendasi;
  }

  rekomendasi.perangkatPause = pauseList;
  return rekomendasi;
}

/**
 * Fungsi utama: cek beban puncak dan buat rekomendasi
 */
async function cekBebanPuncak(dayaPerangkat) {
  const kapasitas = await getKapasitasDaya();
  const bebanPuncak = kapasitas; // langsung pakai kapasitas, bisa juga 0.8 * kapasitas
  const limitEnergi = await getLimitHariIni();

  const { totalBeban, perangkatAktif } = await hitungBebanPerangkatAktif();

  const rekomendasi = rekomendasiWaktu(
    dayaPerangkat,
    perangkatAktif,
    bebanPuncak,
    totalBeban
  );

  const response = {
    kapasitas,
    bebanPuncak,
    limitEnergi,
    totalBebanAktif: totalBeban,
    jumlahPerangkatAktif: perangkatAktif.length,
    perangkatAktif,
    rekomendasi,
  };

  console.log("📌 Cek Beban Puncak:");
  console.log(JSON.stringify(response, null, 2));

  return response;
}

module.exports = { cekBebanPuncak };
