// services/wfsServices.js – SIAP PAKAI
const moment = require("moment-timezone");
const { Perangkat, LimitEnergi, KapasitasDaya } = require("../models");
const { Op } = require("sequelize");

const TZ = "Asia/Jakarta";
const toNum = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

async function hitungWFSHybrid(targetDate = new Date()) {
  try {
    const today = moment(targetDate).tz(TZ).format("YYYY-MM-DD");
    console.log(`\n🧮 Hybrid WFS (lokal) untuk: ${today}`);

    // Info kapasitas (opsional logging)
    const kapasitas = await KapasitasDaya.findOne({ order: [["id", "DESC"]] });
    console.log("⚡ Kapasitas sistem:", toNum(kapasitas?.kapasitas_daya, 0), "Watt");

    // Hanya jalankan kalau ada limit aktif
    const limit = await LimitEnergi.findOne({
      where: {
        tanggal_mulai: { [Op.lte]: today },
        tanggal_selesai: { [Op.gte]: today },
      },
      order: [["id", "DESC"]],
    });

    if (!limit) {
      console.log("ℹ  Tidak ada limit aktif. Kuota tidak diubah.\n");
      return true;
    }

    const limitWh = toNum(limit.batas_kwh, 0) * 1000;
    console.log("🔋 Limit energi (hari ini):", `${limitWh} Wh`);

    const perangkatList = await Perangkat.findAll();
    const isNI = (t = "") => /non\s*interrupt/i.test((t || "").toString());
    const isI  = (t = "") =>
      /(^|\s)interrupt/i.test((t || "").toString()) &&
      !/non\s*interrupt/i.test((t || "").toString());

    const niDevices = perangkatList.filter((p) => isNI(p.tipe));
    const iDevices  = perangkatList.filter((p) => isI(p.tipe));

    // Energi NI (kuota penuh = durasi_jam)
    const totalEnergiNI = niDevices.reduce((sum, p) => {
      const daya = toNum(p.daya_watt);
      const dur  = toNum(p.durasi_jam);
      return sum + daya * dur;
    }, 0);
    console.log("📦 Total energi NI:", `${totalEnergiNI} Wh`);

    // Sisa energi untuk I
    let sisaEnergi = Math.max(0, limitWh - totalEnergiNI);
    console.log("🟢 Sisa energi global:", `${sisaEnergi} Wh`);

    // Set kuota NI = durasi_jam
    for (const p of niDevices) {
      const kuota = toNum(p.durasi_jam);
      await p.update({ kuota_durasi: kuota });
      console.log(`🟢 ${p.nama_perangkat} (NI) -> Kuota: ${kuota} jam`);
    }

    // I → alokasi proporsional skor_prioritas
    const kandidatI = iDevices.filter((p) => toNum(p.skor_prioritas) > 0 && toNum(p.daya_watt) > 0);
    const totalSkorI = kandidatI.reduce((s, p) => s + toNum(p.skor_prioritas), 0);
    console.log("➡ Total Skor Prioritas I:", totalSkorI.toFixed(2));

    for (const p of iDevices) {
      const skor = toNum(p.skor_prioritas);
      const daya = toNum(p.daya_watt);
      let kuotaBaru = 0;

      if (sisaEnergi > 0 && totalSkorI > 0 && skor > 0 && daya > 0) {
        const alokasiWh = (skor / totalSkorI) * sisaEnergi;
        kuotaBaru = Number((alokasiWh / daya).toFixed(2));
        await p.update({ kuota_durasi: kuotaBaru });
        console.log(`🟡 ${p.nama_perangkat} (I) -> Kuota: ${kuotaBaru} jam`);
      } else {
        await p.update({ kuota_durasi: 0 });
        console.log(`🟡 ${p.nama_perangkat} (I) -> Kuota: 0 jam`);
      }
    }

    console.log("✅ Hybrid WFS selesai.\n");
    return true;
  } catch (err) {
    console.error("❌ Error Hybrid WFS:", err);
    return false;
  }
}

module.exports = { hitungWFSHybrid };
